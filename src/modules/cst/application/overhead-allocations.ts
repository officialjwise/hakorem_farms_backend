import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { Stock, StockUnits } from '../../inv';
import type { Animals } from '../../liv';
import type { MasterDataRefs } from '../../mdm';
import { headDaysOf, judgePost, spreadOverhead, treatmentOf } from '../domain/allocation';
import type { AllocationBasis, CostElementRun, CostingStore, LineRecord, RunRecord } from './costing-store';
import { probe } from './counting';
import { AllocationInvalidError, MakerCannotCheckError, type CstRule } from './errors';

export const OVERHEAD_ALLOCATION = 'OVERHEAD_ALLOCATION';
export const OVERHEAD_CAPITALISE = 'OVERHEAD_CAPITALISE';
export const ALLOCATION_READ = 'cst.allocation.read';
export const ALLOCATION_MANAGE = 'cst.allocation.manage';
export const ALLOCATION_POST = 'cst.allocation.post';

/** Locations that hold no animals to carry a share: a whole site, stock on the road (virtual ones are refused too). */
const NOT_A_PEN: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

export interface OverheadAllocationCreate {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly costElement: CostElementRun;
  readonly basis: AllocationBasis;
  readonly scopeLocationId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly totalPesewas: bigint;
}

export interface OverheadAllocationLineView {
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
  readonly weight: number;
  readonly amountPesewas: number;
  readonly treatment: 'CAPITALISED' | 'EXPENSED';
  readonly movementId: string | null;
}

export interface OverheadAllocationRunView {
  readonly id: string;
  readonly status: 'DRAFT' | 'POSTED';
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly costElement: CostElementRun;
  readonly basis: AllocationBasis;
  readonly scopeLocation: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | null;
  readonly totalPesewas: number;
  readonly lines: OverheadAllocationLineView[];
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
  readonly postedBy: { readonly id: string; readonly displayName: string } | null;
  readonly postedAt: string | null;
}

export interface Page<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/**
 * Labour and overhead allocation (FR-CST-002, ADR-0018, ADR-0102). The Accountant creates a run for a period, a cost
 * element and a scope (a pen, or the whole branch): the amount is spread by `allocate` over the livestock that stood in
 * scope, by head-days (each day's whole head on hand at the day's end) or equally, and kept as a DRAFT with its lines,
 * which sum to the amount exactly (checked by the database at commit). A growing animal's share is CAPITALISED; a
 * breeding or laying one's, or one no longer on hand, is EXPENSED and stays in the period's cost. A different person
 * holding `cst.allocation.post` (the Owner or the Manager) posts it with step-up: each capitalised share becomes a
 * value-only OVERHEAD_CAPITALISE movement through inventory, which publishes ◆ inv.OverheadAbsorbed (Dr inventory,
 * Cr 5220) in the same serializable transaction. One posted run per branch, element, scope and period.
 */
export class OverheadAllocations {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CostingStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly animals: Animals,
    private readonly authoriser: Authoriser,
    private readonly names: PrincipalNames,
    private readonly registry: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** createOverheadAllocation: a DRAFT run with its lines (201); nothing is posted. */
  create(actor: Actor | undefined, request: OverheadAllocationCreate, key: string): Promise<StoredResponse<OverheadAllocationRunView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const scope = request.scopeLocationId === undefined ? null : ((await this.refs.locationsIn(tx, [request.scopeLocationId])).get(request.scopeLocationId) ?? null);
      const branchId = scope?.branchId ?? request.branchId ?? null;
      if (branchId === null) {
        // A run needs its branch: from the pen, or named. Authorise anywhere first, so a refusal is the same for all.
        await this.authoriser.authorise(tx, actor, ALLOCATION_MANAGE);
        throw new AllocationInvalidError([{ field: '/branchId', rule: 'BRANCH_REQUIRED' }]);
      }
      await this.authoriser.authorise(tx, actor, ALLOCATION_MANAGE, { branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createOverheadAllocation', principalId: actor!.principalId, key, request: { ...request, totalPesewas: request.totalPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<OverheadAllocationRunView>;
      const broken: CstRule[] = [];
      const today = toBusinessDate(this.clock.now());
      if (request.periodEnd < request.periodStart || request.periodEnd > today) broken.push({ field: '/periodEnd', rule: 'PERIOD_INVALID' });
      if (request.scopeLocationId !== undefined && (scope === null || scope.isVirtual || NOT_A_PEN.has(scope.kind) || (request.branchId !== undefined && request.branchId !== scope.branchId))) {
        broken.push({ field: '/scopeLocationId', rule: 'SCOPE_NOT_A_PEN' });
      }
      if (request.basis === 'WEIGHT_GAIN') broken.push({ field: '/basis', rule: 'BASIS_NOT_SUPPORTED' });
      if (broken.length > 0) throw new AllocationInvalidError(broken);

      const heads = await this.store.dailyHeads(tx, { branchId, locationId: scope?.id ?? null, from: request.periodStart, to: request.periodEnd });
      const facts = await this.units.factsIn(tx, [...new Set(heads.map((h) => h.stockUnitId))], this.clock.now());
      const byUnit = new Map<string, string[]>();
      for (const h of heads) byUnit.set(h.stockUnitId, [...(byUnit.get(h.stockUnitId) ?? []), h.onHandQty]);
      const shares = [...byUnit.entries()].flatMap(([id, days]) => {
        const unit = facts.get(id);
        const headDays = unit === undefined ? 0n : headDaysOf(unit.tracking, days);
        if (unit === undefined || headDays === 0n) return [];
        return [{ stockUnitId: id, identifier: unit.identifier, weight: request.basis === 'EQUAL' ? 1n : headDays }];
      });
      const parts = spreadOverhead(Money.ofPesewas(request.totalPesewas), shares);
      if (!parts.ok) throw new AllocationInvalidError([{ field: request.scopeLocationId === undefined ? '/branchId' : '/scopeLocationId', rule: parts.error }]);
      const ids = parts.value.map((p) => p.stockUnitId);
      const purposes = await this.animals.purposesIn(tx, ids);
      const places = await this.store.placesNow(tx, ids);
      const id = this.nextId();
      const at = this.clock.now();
      await this.registry.register(tx, { id, docType: OVERHEAD_ALLOCATION, ownerModule: 'cst', branchId, actorId: actor!.principalId });
      const lines = parts.value.map((p) => ({
        runId: id,
        stockUnitId: p.stockUnitId,
        weight: p.weight,
        amountPesewas: p.amount.pesewas,
        treatment: facts.get(p.stockUnitId)!.status === 'ACTIVE' && places.has(p.stockUnitId) ? treatmentOf(purposes.get(p.stockUnitId) ?? 'GROWING') : ('EXPENSED' as const),
      }));
      await this.store.insertRun(
        tx,
        {
          id,
          branchId,
          periodStart: request.periodStart,
          periodEnd: request.periodEnd,
          costElement: request.costElement,
          basis: request.basis,
          scopeLocationId: scope?.id ?? null,
          totalPesewas: request.totalPesewas,
          createdAt: at,
          createdBy: actor!.principalId,
        },
        lines,
      );
      const view = await this.viewIn(tx, (await this.store.run(tx, id, false))!);
      await this.audit.record(tx, { module: 'cst', action: 'CREATE', entityType: 'OverheadAllocationRun', entityId: id, branchId, after: { ...view } });
      const response: StoredResponse<OverheadAllocationRunView> = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** postOverheadAllocation: each capitalised share moved onto its animal, by someone other than the maker (200). */
  post(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<OverheadAllocationRunView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const run = await this.authorisedIn(tx, actor, ALLOCATION_POST, id, true);
      const claim = await this.idempotency.claim(tx, { operationId: 'postOverheadAllocation', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<OverheadAllocationRunView>;
      const refusal = judgePost(run, actor!.principalId);
      if (refusal === 'MAKER_CANNOT_CHECK') throw new MakerCannotCheckError('the person who created the allocation cannot post it');
      if (refusal === 'ALREADY_POSTED') throw new AllocationInvalidError([{ field: null, rule: refusal }]);
      if (await this.store.postedRunExists(tx, run)) throw new AllocationInvalidError([{ field: null, rule: 'PERIOD_ALREADY_POSTED' }]);
      const before = await this.viewIn(tx, run);
      const lines = (await this.store.lines(tx, [run.id])).filter((l) => l.treatment === 'CAPITALISED' && l.amountPesewas > 0n);
      const facts = await this.units.factsIn(tx, lines.map((l) => l.stockUnitId), this.clock.now());
      const places = await this.store.placesNow(tx, lines.map((l) => l.stockUnitId));
      const gone = lines.filter((l) => facts.get(l.stockUnitId)?.status !== 'ACTIVE' || !places.has(l.stockUnitId));
      if (gone.length > 0) throw new AllocationInvalidError(gone.map((l) => ({ field: `/lines/${l.stockUnitId}`, rule: 'UNIT_NOT_ON_HAND' })));
      const consumption = await this.refs.virtualLocationIn(tx, run.branchId, 'CONSUMPTION');
      if (consumption === null) throw new Error(`branch ${run.branchId} has no virtual CONSUMPTION location; every branch is created with one (ADR-0042)`);
      const at = this.clock.now();
      const movements = new Map<string, string>();
      for (const line of lines) {
        const unit = facts.get(line.stockUnitId)!;
        const posted = await this.stock.postIn(tx, actor!.principalId, {
          movementType: OVERHEAD_CAPITALISE,
          productId: unit.productId,
          stockUnitId: unit.id,
          branchId: run.branchId,
          fromLocationId: consumption,
          toLocationId: places.get(line.stockUnitId)!,
          qty: Quantity.zero(),
          value: Money.ofPesewas(line.amountPesewas),
          costElement: run.costElement,
          sourceDocumentId: run.id,
          sourceLineRef: unit.id,
          occurredAt: at,
        });
        movements.set(line.stockUnitId, posted.id);
      }
      await this.store.markPosted(tx, run.id, actor!.principalId, at, movements);
      const view = await this.viewIn(tx, (await this.store.run(tx, run.id, false))!);
      await this.audit.record(tx, { module: 'cst', action: 'POST', entityType: 'OverheadAllocationRun', entityId: run.id, branchId: run.branchId, before: { ...before }, after: { ...view } });
      const response: StoredResponse<OverheadAllocationRunView> = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** getOverheadAllocation: a run of a branch the caller reads in full; another branch's, or none, is 404. */
  get(actor: Actor | undefined, id: string): Promise<OverheadAllocationRunView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => this.viewIn(tx, await this.authorisedIn(tx, actor, ALLOCATION_READ, id, false)));
  }

  /** listOverheadAllocations: the runs of every branch the caller reads in full, newest first. */
  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<OverheadAllocationRunView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ALLOCATION_READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, ALLOCATION_READ)).filter((g) => g.locationId === null).map((g) => g.branchId))];
      const binding = { operationId: 'listOverheadAllocations', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding) as { createdAt: string; id: string });
      const rows = await this.store.listRuns(tx, branchIds, after, probe(limit));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const hasMore = rows.length > limit && last !== undefined;
      return {
        data: await Promise.all(page.map((r) => this.viewIn(tx, r))),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { createdAt: last.createdAt.toISOString(), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  /**
   * A run the caller may act on: the permission held somewhere (with its step-up), then the run's branch among the
   * caller's whole-branch grants. A run of another branch answers exactly as one that does not exist: 404.
   */
  private async authorisedIn(tx: Transaction, actor: Actor | undefined, permission: string, id: string, forUpdate: boolean): Promise<RunRecord> {
    await this.authoriser.authorise(tx, actor, permission);
    const run = await this.store.run(tx, id, forUpdate);
    const branchIds = (await this.authoriser.scopes(tx, actor!, permission)).filter((g) => g.locationId === null).map((g) => g.branchId);
    if (run === null || !branchIds.includes(run.branchId)) throw new NotFoundError(`no allocation run ${id}`);
    return run;
  }

  private async viewIn(tx: Transaction, run: RunRecord): Promise<OverheadAllocationRunView> {
    const lines: LineRecord[] = await this.store.lines(tx, [run.id]);
    const facts = await this.units.factsIn(tx, lines.map((l) => l.stockUnitId), this.clock.now());
    const location = run.scopeLocationId === null ? null : (await this.refs.locationsIn(tx, [run.scopeLocationId])).get(run.scopeLocationId)!;
    const people = await this.names.refs(tx, [run.createdBy, ...(run.postedBy === null ? [] : [run.postedBy])]);
    const person = (id: string) => people.get(id) ?? { id, displayName: 'Unknown' };
    return {
      id: run.id,
      status: run.status,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      costElement: run.costElement,
      basis: run.basis,
      scopeLocation: location === null ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
      totalPesewas: Money.ofPesewas(run.totalPesewas).toJsonInteger(),
      lines: lines
        .map((l) => {
          const unit = facts.get(l.stockUnitId)!;
          return {
            stockUnit: { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
            weight: Number(l.weight),
            amountPesewas: Money.ofPesewas(l.amountPesewas).toJsonInteger(),
            treatment: l.treatment,
            movementId: l.movementRef,
          };
        })
        .sort((a, b) => (a.stockUnit.identifier === b.stockUnit.identifier ? (a.stockUnit.id < b.stockUnit.id ? -1 : 1) : a.stockUnit.identifier < b.stockUnit.identifier ? -1 : 1)),
      currency: 'GHS',
      branchId: run.branchId,
      version: run.version,
      createdAt: run.createdAt.toISOString(),
      createdBy: person(run.createdBy),
      postedBy: run.postedBy === null ? null : person(run.postedBy),
      postedAt: run.postedAt?.toISOString() ?? null,
    };
  }
}
