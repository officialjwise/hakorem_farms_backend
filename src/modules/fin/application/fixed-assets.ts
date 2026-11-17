import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { jsonPesewas } from '../domain/balance';
import {
  checkDisposal,
  checkEstimateChange,
  checkNewAsset,
  depreciationCharge,
  disposalAmounts,
  judgeRunPost,
  type AssetCategory,
  type AssetStatus,
  type DepreciationState,
  type ProceedsMethod,
} from '../domain/fixed-asset';
import type { DepreciationRunPosted, FixedAssetDisposed } from '../events';
import type { BankAccounts } from './bank-accounts';
import type { ChartStore } from './chart-store';
import { DepreciationRunExistsError, DepreciationRunInvalidError, FinReferenceNotFoundError, FinStateError, FixedAssetInvalidError, LedgerPostingRefusedError, MakerIsCheckerError } from './errors';
import type { DepreciationLineRow, DepreciationRunRow, FixedAssetRow, FixedAssetStore } from './fixed-asset-store';
import type { Page } from './periods';

import { readableBranches } from './read-scope';
import { pageProbe } from './page-probe';

export const DEPRECIATION_RUN = 'fin.DepreciationRun';
export const FIXED_ASSET_DISPOSED = 'fin.FixedAssetDisposed';
export const DEPRECIATION_RUN_DOCUMENT = 'DEPRECIATION_RUN';
export const DISPOSAL_DOCUMENT = 'FIXED_ASSET_DISPOSAL';
/** THREAT_MODEL section 4, case 30: a fixed asset disposed of below its worth (A-199). */
export const ASSET_DISPOSAL_ABUSE_CASE = 30;
const READ = 'fin.fixed_asset.read';
const MANAGE = 'fin.fixed_asset.manage';

type BranchRef = { readonly id: string; readonly code: string; readonly name: string };

/** The contract's `FixedAsset`. */
export interface FixedAssetView {
  readonly id: string;
  readonly assetNo: string;
  readonly name: string;
  readonly category: AssetCategory;
  readonly branch: BranchRef;
  readonly acquiredOn: string;
  readonly costPesewas: number;
  readonly residualPesewas: number;
  readonly usefulLifeMonths: number;
  readonly method: 'STRAIGHT_LINE';
  readonly accumulatedPesewas: number;
  readonly netBookValuePesewas: number;
  readonly status: AssetStatus;
  readonly disposedOn: string | null;
  readonly currency: 'GHS';
  readonly version: number;
}

/** The contract's `DepreciationRun`. */
export interface DepreciationRunView {
  readonly id: string;
  readonly period: { readonly id: string; readonly fiscalYear: number; readonly periodNo: number };
  readonly status: 'DRAFT' | 'POSTED';
  readonly totalPesewas: number;
  readonly currency: 'GHS';
  readonly journalEntryId: string | null;
  readonly lines: readonly { readonly fixedAsset: { readonly id: string; readonly assetNo: string; readonly name: string }; readonly amountPesewas: number }[];
  readonly createdAt: string;
}

export interface FixedAssetCreateRequest {
  readonly name: string;
  readonly category: AssetCategory;
  readonly branchId: string;
  readonly acquiredOn: string;
  readonly costPesewas: number;
  readonly residualPesewas?: number | undefined;
  readonly usefulLifeMonths: number;
}

export interface FixedAssetUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly usefulLifeMonths?: number | undefined;
  readonly residualPesewas?: number | undefined;
}

export interface FixedAssetDisposalRequest {
  readonly disposedOn: string;
  readonly proceedsPesewas: number;
  readonly bankAccountId?: string | undefined;
  readonly note: string;
}

const stateOf = (row: FixedAssetRow): DepreciationState => ({
  cost: Money.ofPesewas(row.costPesewas),
  residual: Money.ofPesewas(row.residualPesewas),
  usefulLifeMonths: row.usefulLifeMonths,
  accumulated: Money.ofPesewas(row.accumulatedPesewas),
  depreciatedMonths: row.depreciatedMonths,
  acquiredOn: row.acquiredOn,
  status: row.status,
});

/**
 * The fixed asset register and its depreciation runs (FR-FIN-014, FR-FIN-015, ADR-0059, A-199). Every command
 * authorises first in its handler, deny by default, at the asset's branch for an asset; only the Owner and the
 * Accountant hold the permissions. Registering an asset posts nothing (its cost reaches 1510 to 1540 the way the money
 * left, and the nightly reconciliation compares the two). A run is calculated by one person and posted by another: the
 * post publishes `fin.DepreciationRun` per branch in its serializable transaction and the ledger posts each as that
 * branch's entry on the period's last day; a disposal publishes `fin.FixedAssetDisposed`, posted on its date with the
 * exact gain or loss. Every change is audited with before and after values.
 */
export class FixedAssets {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: FixedAssetStore,
    private readonly chart: ChartStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly refs: MasterDataRefs,
    private readonly bankAccounts: BankAccounts,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly category?: AssetCategory | undefined; readonly status?: AssetStatus | undefined }, cursor: string | undefined, limit: number): Promise<Page<FixedAssetView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { category: query.category ?? null, status: query.status ?? null };
      const binding = { operationId: 'listFixedAssets', principalId: actor!.principalId, filters };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { assetNo: position['assetNo'] ?? '', id: position['id'] ?? '' };
      const found = await this.store.assets(tx, filters, after, pageProbe(limit), await readableBranches(this.authoriser, tx, actor!, READ));
      const data = await this.views(tx, found.slice(0, limit));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { assetNo: last.assetNo, id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<FixedAssetView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const asset = await this.assetOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, { branchId: asset.branchId });
      return (await this.views(tx, [asset]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: FixedAssetCreateRequest, idempotencyKey: string): Promise<StoredResponse<FixedAssetView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: body.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createFixedAsset', principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FixedAssetView>;
      if (!(await this.refs.branchesIn(tx, [body.branchId])).has(body.branchId)) throw new FinReferenceNotFoundError(['/branchId']);
      const residualPesewas = body.residualPesewas ?? 0;
      const rules = checkNewAsset({ costPesewas: body.costPesewas, residualPesewas, usefulLifeMonths: body.usefulLifeMonths, acquiredOn: body.acquiredOn }, this.today());
      if (rules.length > 0) throw new FixedAssetInvalidError(rules);
      const id = this.nextId();
      await this.store.insertAsset(
        tx,
        {
          id,
          name: body.name.trim(),
          category: body.category,
          branchId: body.branchId,
          acquiredOn: body.acquiredOn,
          costPesewas: BigInt(body.costPesewas),
          residualPesewas: BigInt(residualPesewas),
          usefulLifeMonths: body.usefulLifeMonths,
        },
        actor!.principalId,
      );
      const [view] = await this.views(tx, [(await this.store.asset(tx, id, false))!]);
      await this.audit.record(tx, { module: 'fin', action: 'CREATE', entityType: 'FixedAsset', entityId: id, branchId: body.branchId, before: null, after: { ...view! } });
      const response = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A change of name or of estimate (useful life, residual): prospective, refused while a draft run carries the asset. */
  update(actor: Actor | undefined, id: string, body: FixedAssetUpdateRequest, idempotencyKey: string): Promise<StoredResponse<FixedAssetView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'updateFixedAsset', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FixedAssetView>;
      const before = await this.assetOf(tx, id, true);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: before.branchId });
      if (before.version !== body.version) throw new VersionConflictError(`fixed asset ${id} is at version ${before.version}`);
      const change = {
        name: body.name?.trim() ?? before.name,
        usefulLifeMonths: body.usefulLifeMonths ?? before.usefulLifeMonths,
        residualPesewas: body.residualPesewas === undefined ? before.residualPesewas : BigInt(body.residualPesewas),
      };
      const rules = checkEstimateChange(stateOf(before), { usefulLifeMonths: change.usefulLifeMonths, residualPesewas: jsonPesewas(change.residualPesewas) });
      if (rules.length > 0) throw new FixedAssetInvalidError(rules);
      const estimateChanged = change.usefulLifeMonths !== before.usefulLifeMonths || change.residualPesewas !== before.residualPesewas;
      if (estimateChanged && (await this.store.onPendingRun(tx, id))) throw new FixedAssetInvalidError([{ field: null, rule: 'DEPRECIATION_RUN_PENDING' }]);
      const [beforeView] = await this.views(tx, [before]);
      await this.store.updateAsset(tx, id, change, actor!.principalId);
      const [view] = await this.views(tx, [(await this.store.asset(tx, id, false))!]);
      await this.audit.record(tx, { module: 'fin', action: 'UPDATE', entityType: 'FixedAsset', entityId: id, branchId: before.branchId, before: { ...beforeView! }, after: { ...view! } });
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * A disposal (FR-FIN-014): posts the cost and accumulated depreciation out, the proceeds in and the exact gain or loss
   * through the ledger on its own date, in this serializable transaction; a refused posting disposes of nothing.
   */
  dispose(actor: Actor | undefined, id: string, body: FixedAssetDisposalRequest, idempotencyKey: string): Promise<StoredResponse<FixedAssetView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'disposeFixedAsset', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FixedAssetView>;
      const before = await this.assetOf(tx, id, true);
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: before.branchId });
      const rules = checkDisposal(stateOf(before), body.disposedOn, this.today());
      if (rules.length > 0) throw new FixedAssetInvalidError(rules);
      if (await this.store.onPendingRun(tx, id)) throw new FixedAssetInvalidError([{ field: null, rule: 'DEPRECIATION_RUN_PENDING' }]);
      let method: ProceedsMethod = 'CASH';
      if (body.bankAccountId !== undefined) {
        const account = (await this.bankAccounts.payoutAccountsIn(tx, [body.bankAccountId])).get(body.bankAccountId);
        if (account === undefined) throw new FinReferenceNotFoundError(['/bankAccountId']);
        if (!account.isActive) throw new FixedAssetInvalidError([{ field: '/bankAccountId', rule: 'BANK_ACCOUNT_NOT_AVAILABLE' }]);
        method = account.kind;
      }
      const cost = Money.ofPesewas(before.costPesewas);
      const accumulated = Money.ofPesewas(before.accumulatedPesewas);
      const proceeds = Money.fromJsonInteger(body.proceedsPesewas);
      const { netBookValue, gain, loss } = disposalAmounts(cost, accumulated, proceeds);
      const disposalId = this.nextId();
      await this.documents.register(tx, { id: disposalId, docType: DISPOSAL_DOCUMENT, ownerModule: 'fin', branchId: before.branchId, actorId: actor!.principalId });
      await this.events.publish<FixedAssetDisposed>(tx, {
        type: FIXED_ASSET_DISPOSED,
        subjectType: 'FixedAsset',
        subjectId: id,
        branchId: before.branchId,
        payload: {
          fixedAssetId: id,
          disposalId,
          assetNo: before.assetNo,
          category: before.category,
          disposedOn: body.disposedOn,
          costPesewas: cost.toJsonInteger(),
          accumulatedPesewas: accumulated.toJsonInteger(),
          proceedsPesewas: proceeds.toJsonInteger(),
          gainPesewas: gain.toJsonInteger(),
          lossPesewas: loss.toJsonInteger(),
          proceedsMethod: method,
          bankAccountId: body.bankAccountId ?? null,
          abuseCases: [ASSET_DISPOSAL_ABUSE_CASE],
        },
      });
      const [entry] = await this.store.entriesOf(tx, disposalId);
      if (entry === undefined) throw new Error(`disposal of fixed asset ${id} was published but the ledger posted no entry`);
      const [beforeView] = await this.views(tx, [before]);
      await this.store.disposeAsset(tx, id, { disposedOn: body.disposedOn, documentId: disposalId, proceedsPesewas: proceeds.pesewas, note: body.note.trim(), journalEntryId: entry.entryId }, actor!.principalId);
      const [view] = await this.views(tx, [(await this.store.asset(tx, id, false))!]);
      await this.audit.record(tx, {
        module: 'fin',
        action: 'DISPOSE',
        entityType: 'FixedAsset',
        entityId: id,
        branchId: before.branchId,
        before: { ...beforeView! },
        after: {
          ...view!,
          disposalId,
          journalEntryId: entry.entryId,
          netBookValuePesewas: netBookValue.toJsonInteger(),
          proceedsPesewas: proceeds.toJsonInteger(),
          gainPesewas: gain.toJsonInteger(),
          lossPesewas: loss.toJsonInteger(),
          bankAccountId: body.bankAccountId ?? null,
          note: body.note.trim(),
        },
      });
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  listRuns(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<DepreciationRunView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listDepreciationRuns', principalId: actor!.principalId, filters: {} };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.runs(tx, before, pageProbe(limit), await readableBranches(this.authoriser, tx, actor!, READ));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.runViews(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  getRun(actor: Actor | undefined, id: string): Promise<DepreciationRunView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const run = await this.runOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, { branchId: run.branchId });
      return (await this.runViews(tx, [run]))[0]!;
    });
  }

  /**
   * Calculates the run of one period that has ended (the maker): every asset in service with months to charge, each
   * spread exactly with `allocate`. Posts nothing. One run per period, held by the database
   * (`uq_depreciation_run_period`): a second, concurrent or not, is 422 `DEPRECIATION_RUN_EXISTS`.
   */
  async createRun(actor: Actor | undefined, body: { readonly periodId: string }, idempotencyKey: string): Promise<StoredResponse<DepreciationRunView>> {
    try {
      return await this.uow.run({ isolation: 'read committed' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, MANAGE);
        const claim = await this.idempotency.claim(tx, { operationId: 'createDepreciationRun', principalId: actor!.principalId, key: idempotencyKey, request: body });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DepreciationRunView>;
        const period = await this.chart.period(tx, body.periodId, false);
        if (period === null) throw new FinReferenceNotFoundError(['/periodId']);
        if (period.endDate > this.today()) throw new DepreciationRunInvalidError('PERIOD_NOT_ENDED', '/periodId');
        if (period.status !== 'OPEN') throw new LedgerPostingRefusedError(DEPRECIATION_RUN, { rule: 'PERIOD_NOT_OPEN', date: period.endDate });
        if ((await this.store.runOfPeriod(tx, period.id)) !== null) throw new DepreciationRunExistsError(period.id);
        const lines = (await this.store.assetsInServiceOn(tx, period.endDate)).flatMap((asset) => {
          const charge = depreciationCharge(stateOf(asset), period.endDate);
          return charge === null ? [] : [{ fixedAssetId: asset.id, fromMonth: charge.fromMonth, months: charge.months, amountPesewas: charge.amount.pesewas }];
        });
        if (lines.length === 0) throw new DepreciationRunInvalidError('NOTHING_TO_DEPRECIATE', '/periodId');
        const branchId = await this.refs.headOfficeBranchIn(tx);
        if (branchId === null) throw new Error('no active branch to hold the depreciation run');
        const id = this.nextId();
        const total = Money.sum(lines.map((l) => Money.ofPesewas(l.amountPesewas)));
        await this.documents.register(tx, { id, docType: DEPRECIATION_RUN_DOCUMENT, ownerModule: 'fin', branchId, actorId: actor!.principalId });
        await this.store.insertRun(tx, { id, periodId: period.id, branchId, totalPesewas: total.pesewas }, actor!.principalId);
        await this.store.insertLines(tx, id, lines, actor!.principalId);
        const [view] = await this.runViews(tx, [(await this.store.run(tx, id, false))!]);
        await this.audit.record(tx, { module: 'fin', action: 'CREATE', entityType: 'DepreciationRun', entityId: id, branchId, before: null, after: auditShape(view!) });
        const response = { status: 201, body: view! };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      // Two makers of one period racing past the check meet the unique key of migration 0142.
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === 'uq_depreciation_run_period') throw new DepreciationRunExistsError(body.periodId);
      throw error;
    }
  }

  /**
   * Posts a draft run (the checker, never its maker): each line recomputed from the asset as it stands must be what
   * was calculated (else 422 `DEPRECIATION_RUN_INVALID` `RUN_STALE`); then `fin.DepreciationRun` per branch, which the
   * ledger posts on the period's last day or refuses (`PERIOD_NOT_OPEN`), and the database applies each line to its
   * asset in the same transaction.
   */
  postRun(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<DepreciationRunView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'postDepreciationRun', principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DepreciationRunView>;
      const run = await this.runOf(tx, id, true);
      const verdict = judgeRunPost(run, actor!.principalId);
      if (!verdict.ok) {
        if (verdict.error === 'MAKER_IS_CHECKER') throw new MakerIsCheckerError(`depreciation run ${id} was calculated by the person posting it`);
        throw new FinStateError(`depreciation run ${id}`, run.status);
      }
      const period = (await this.chart.period(tx, run.periodId, false))!;
      const lines = (await this.store.linesOf(tx, [id])).get(id)!;
      for (const line of lines) {
        const asset = (await this.store.asset(tx, line.fixedAssetId, true))!;
        const charge = depreciationCharge(stateOf(asset), period.endDate);
        if (charge === null || charge.fromMonth !== line.fromMonth || charge.months !== line.months || charge.amount.pesewas !== line.amountPesewas) {
          throw new DepreciationRunInvalidError('RUN_STALE', null);
        }
      }
      const byBranch = new Map<string, DepreciationLineRow[]>();
      for (const line of lines) byBranch.set(line.branchId, [...(byBranch.get(line.branchId) ?? []), line]);
      for (const [branchId, own] of [...byBranch].sort(([a], [b]) => a.localeCompare(b))) {
        await this.events.publish<DepreciationRunPosted>(tx, {
          type: DEPRECIATION_RUN,
          subjectType: 'DepreciationRun',
          subjectId: id,
          branchId,
          payload: {
            depreciationRunId: id,
            periodId: period.id,
            postingDate: period.endDate,
            lines: own.map((l) => ({ fixedAssetId: l.fixedAssetId, assetNo: l.assetNo, category: l.category, months: l.months, amountPesewas: jsonPesewas(l.amountPesewas) })),
          },
        });
      }
      const entries = await this.store.entriesOf(tx, id);
      if (entries.length !== byBranch.size) throw new Error(`depreciation run ${id} was published for ${byBranch.size} branches but the ledger posted ${entries.length} entries`);
      await this.store.markRunPosted(tx, id, entries[0]!.entryId, actor!.principalId, this.clock.now());
      const [view] = await this.runViews(tx, [(await this.store.run(tx, id, false))!]);
      await this.audit.record(tx, {
        module: 'fin',
        action: 'POST',
        entityType: 'DepreciationRun',
        entityId: id,
        branchId: run.branchId,
        before: { status: run.status },
        after: { ...auditShape(view!), journalEntryIds: entries.map((e) => e.entryId) },
        metadata: { calculatedBy: run.createdBy },
      });
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private today(): string {
    return toBusinessDate(this.clock.now());
  }

  private async assetOf(tx: Transaction, id: string, forUpdate: boolean): Promise<FixedAssetRow> {
    const asset = await this.store.asset(tx, id, forUpdate);
    if (asset === null) throw new NotFoundError(`no fixed asset ${id}`);
    return asset;
  }

  private async runOf(tx: Transaction, id: string, forUpdate: boolean): Promise<DepreciationRunRow> {
    const run = await this.store.run(tx, id, forUpdate);
    if (run === null) throw new NotFoundError(`no depreciation run ${id}`);
    return run;
  }

  private async views(tx: Transaction, rows: readonly FixedAssetRow[]): Promise<FixedAssetView[]> {
    const branches = rows.length === 0 ? new Map() : await this.refs.branchesIn(tx, [...new Set(rows.map((r) => r.branchId))]);
    return rows.map((r) => {
      const branch = branches.get(r.branchId)!;
      return {
        id: r.id,
        assetNo: r.assetNo,
        name: r.name,
        category: r.category,
        branch: { id: branch.id, code: branch.code, name: branch.name },
        acquiredOn: r.acquiredOn,
        costPesewas: jsonPesewas(r.costPesewas),
        residualPesewas: jsonPesewas(r.residualPesewas),
        usefulLifeMonths: r.usefulLifeMonths,
        method: 'STRAIGHT_LINE',
        accumulatedPesewas: jsonPesewas(r.accumulatedPesewas),
        netBookValuePesewas: Money.ofPesewas(r.costPesewas).minus(Money.ofPesewas(r.accumulatedPesewas)).toJsonInteger(),
        status: r.status,
        disposedOn: r.disposedOn,
        currency: 'GHS',
        version: r.version,
      };
    });
  }

  private async runViews(tx: Transaction, rows: readonly DepreciationRunRow[]): Promise<DepreciationRunView[]> {
    const lines = await this.store.linesOf(tx, rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      period: { id: r.periodId, fiscalYear: r.fiscalYear, periodNo: r.periodNo },
      status: r.status,
      totalPesewas: jsonPesewas(r.totalPesewas),
      currency: 'GHS',
      journalEntryId: r.journalEntryId,
      lines: lines.get(r.id)!.map((l) => ({ fixedAsset: { id: l.fixedAssetId, assetNo: l.assetNo, name: l.name }, amountPesewas: jsonPesewas(l.amountPesewas) })),
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

function auditShape(view: DepreciationRunView): Record<string, unknown> {
  return {
    periodId: view.period.id,
    fiscalYear: view.period.fiscalYear,
    periodNo: view.period.periodNo,
    status: view.status,
    totalPesewas: view.totalPesewas,
    lines: view.lines.map((l) => ({ fixedAssetId: l.fixedAsset.id, assetNo: l.fixedAsset.assetNo, amountPesewas: l.amountPesewas })),
  };
}
