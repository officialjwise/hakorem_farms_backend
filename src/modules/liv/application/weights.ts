import { Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { StockUnitFacts, StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { checkWeighing } from '../domain/animal';
import { headOf } from '../domain/cost-spread';
import type { AnimalWeighed } from '../events';
import { LivestockRecordInvalidError, LivReferenceNotFoundError } from './errors';
import type { LivestockStore, WeightFilters, WeightRecord, WeightSource } from './livestock-store';
import { afterOf, pageOf, pageProbe, readScopeOf, runWrite, type Page } from './support';

export interface WeightInput {
  readonly id: string;
  readonly stockUnitId: string;
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly headWeighed?: number | undefined;
  readonly measuredAt: Date;
}

/** The contract's `WeightRecord`. */
export interface WeightRecordView {
  readonly id: string;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
  readonly weightKg: string;
  readonly weightSource: WeightSource;
  readonly headWeighed: number;
  readonly measuredAt: string;
  readonly actor: { readonly id: string; readonly displayName: string };
}

/** The contract's `WeightRecordBatchResult`. */
export interface WeightBatchView {
  readonly accepted: number;
  readonly duplicates: number;
  readonly records: readonly WeightRecordView[];
}

/** The most weighings one call carries: a pen of goats at the scale, or a flock's samples. */
export const MAX_WEIGHINGS = 200;
const UNKNOWN_PRINCIPAL = { id: '', displayName: 'Unknown' };

function sameWeighing(stored: WeightRecord, input: WeightInput): boolean {
  return (
    stored.stockUnitId === input.stockUnitId &&
    Weight.parseKg(stored.weightKg).equals(Weight.parseKg(input.weightKg)) &&
    stored.weightSource === input.weightSource &&
    stored.headWeighed === (input.headWeighed ?? 1) &&
    stored.measuredAt.getTime() === input.measuredAt.getTime()
  );
}

/**
 * Weight capture (FR-LIV-004). A batch of weighings, each with its client's id (UUIDv7, so an offline queue can send it
 * again), its kilograms to three places and the source it was captured by. A weighing already recorded with the same
 * id and content counts as a duplicate and changes nothing; the same id with other content is refused. Each is of a
 * live animal or a sample of a live flock; a sold, slaughtered or dead animal takes no more. The latest weighing is
 * copied onto the stock unit through INV, so its label prints it. Authorised at every unit's branch and location.
 */
export class Weighing {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  record(actor: Actor | undefined, records: readonly WeightInput[], idempotencyKey: string): Promise<StoredResponse<WeightBatchView>> {
    const request = records.map((r) => ({ ...r, measuredAt: r.measuredAt.toISOString() }));
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'liv.weight.record',
      'recordWeights',
      { records: request },
      idempotencyKey,
      async (tx) => {
        const facts = await this.units.factsIn(tx, records.map((r) => r.stockUnitId), this.clock.now());
        return [...facts.values()].map((u) => ({ branchId: u.branchId, locationId: u.currentLocationId }));
      },
      async (tx, who) => ({ status: 200, body: await this.recordIn(tx, who, records) }),
    );
  }

  /**
   * Each unit's latest weighing (FR-LIV-004), by when it was measured, in the caller's transaction: the weight, its
   * source and its time, for a higher module that shows them beside a price (POS's offline pack, CR-052, A-286). A
   * unit never weighed is absent. Read only; the caller authorised what it shows.
   */
  async latestIn(tx: Transaction, stockUnitIds: readonly string[]): Promise<ReadonlyMap<string, { readonly weightKg: string; readonly weightSource: WeightSource; readonly measuredAt: Date }>> {
    const latest = await this.store.latestWeights(tx, stockUnitIds);
    return new Map([...latest].map(([unitId, r]) => [unitId, { weightKg: r.weightKg, weightSource: r.weightSource, measuredAt: r.measuredAt }] as const));
  }

  /** Records a batch of weighings in the caller's transaction, every rule applied; the caller authorised it. */
  async recordIn(tx: Transaction, actor: Actor, records: readonly WeightInput[]): Promise<WeightBatchView> {
    if (records.length === 0 || records.length > MAX_WEIGHINGS) throw new LivestockRecordInvalidError([{ field: '/records', rule: records.length === 0 ? 'NO_RECORDS' : 'TOO_MANY_RECORDS' }]);
    const now = this.clock.now();
    const facts = await this.units.factsIn(tx, records.map((r) => r.stockUnitId), now);
    const missing = records.flatMap((r, i) => (facts.has(r.stockUnitId) ? [] : [`/records/${i}/stockUnitId`]));
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    const stored = new Map((await this.store.weights(tx, records.map((r) => r.id))).map((w) => [w.id, w] as const));
    const products = await this.refs.productsIn(tx, [...facts.values()].map((u) => u.productId));
    const animals = new Map((await this.store.animals(tx, records.map((r) => r.stockUnitId))).map((a) => [a.stockUnitId, a] as const));
    const broken: Array<{ field: string; rule: string }> = [];
    const seen = new Set<string>();
    records.forEach((r, i) => {
      const previous = stored.get(r.id);
      if (seen.has(r.id)) broken.push({ field: `/records/${i}/id`, rule: 'RECORD_REPEATED' });
      seen.add(r.id);
      if (previous !== undefined) {
        if (!sameWeighing(previous, r)) broken.push({ field: `/records/${i}/id`, rule: 'ID_REUSED' });
        return;
      }
      const unit: StockUnitFacts = facts.get(r.stockUnitId)!;
      const animal = animals.get(r.stockUnitId);
      const alive = unit.tracking === 'SERIAL' ? animal?.status === 'ALIVE' : unit.status === 'ACTIVE';
      if (Weight.parseKg(r.weightKg).isZero()) broken.push({ field: `/records/${i}/weightKg`, rule: 'WEIGHT_ZERO' });
      for (const rule of checkWeighing({
        tracking: unit.tracking,
        alive,
        isLivestock: products.get(unit.productId)!.speciesId !== null && (unit.tracking === 'LOT' || animal !== undefined),
        headWeighed: r.headWeighed ?? 1,
        headOnHand: headOf(unit.tracking, unit.poolQty),
        measuredAt: r.measuredAt,
        now,
      })) {
        broken.push({ field: `/records/${i}`, rule: rule.rule });
      }
    });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);

    const fresh = records.filter((r) => !stored.has(r.id));
    for (const r of fresh) {
      const unit = facts.get(r.stockUnitId)!;
      const record: WeightRecord = {
        id: r.id,
        stockUnitId: r.stockUnitId,
        branchId: unit.branchId,
        weightKg: Weight.parseKg(r.weightKg).toKgString(),
        weightSource: r.weightSource,
        headWeighed: r.headWeighed ?? 1,
        measuredAt: r.measuredAt,
        actorId: actor.principalId,
      };
      await this.store.insertWeight(tx, record);
      await this.units.recordWeightIn(tx, actor.principalId, r.stockUnitId, record.weightKg, r.measuredAt);
      await this.events.publish<AnimalWeighed>(tx, {
        type: 'liv.AnimalWeighed',
        subjectType: 'WeightRecord',
        subjectId: r.id,
        branchId: unit.branchId,
        occurredAt: r.measuredAt,
        payload: { weightRecordId: r.id, stockUnitId: r.stockUnitId, branchId: unit.branchId, weightKg: record.weightKg, weightSource: r.weightSource, headWeighed: record.headWeighed, measuredAt: r.measuredAt.toISOString() },
      });
    }
    const views = await this.views(tx, await this.store.weights(tx, records.map((r) => r.id)));
    const byId = new Map(views.map((v) => [v.id, v] as const));
    if (fresh.length > 0) {
      await this.audit.record(tx, {
        module: 'liv',
        action: 'RECORD_WEIGHTS',
        entityType: 'WeightRecord',
        entityId: fresh[0]!.id,
        branchId: facts.get(fresh[0]!.stockUnitId)!.branchId,
        before: null,
        after: { records: fresh.map((r) => ({ ...byId.get(r.id)! })) },
      });
    }
    return { accepted: fresh.length, duplicates: records.length - fresh.length, records: records.map((r) => byId.get(r.id)!) };
  }

  list(actor: Actor | undefined, filters: { readonly stockUnitId?: string | undefined; readonly locationId?: string | undefined; readonly from?: Date | undefined; readonly to?: Date | undefined }, cursor: string | undefined, limit: number): Promise<Page<WeightRecordView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.weight.read');
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.weight.read');
      const binding = { operationId: 'listWeightRecords', principalId: actor!.principalId, filters: { ...filters, from: filters.from?.toISOString(), to: filters.to?.toISOString() } };
      const query: WeightFilters = {
        stockUnitId: filters.stockUnitId,
        from: filters.from,
        to: filters.to,
        unitIds: filters.locationId === undefined ? undefined : (await this.units.onHandAtIn(tx, [filters.locationId])).map((u) => u.id),
      };
      const rows = await this.store.listWeights(tx, query, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.views(tx, rows.slice(0, limit)));
    });
  }

  private async views(tx: Transaction, records: readonly WeightRecord[]): Promise<WeightRecordView[]> {
    const units = await this.units.factsIn(tx, records.map((r) => r.stockUnitId), this.clock.now());
    const people = await this.principals.refs(tx, records.map((r) => r.actorId));
    return records.map((r) => {
      const unit = units.get(r.stockUnitId)!;
      return {
        id: r.id,
        stockUnit: { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
        weightKg: r.weightKg,
        weightSource: r.weightSource,
        headWeighed: r.headWeighed,
        measuredAt: r.measuredAt.toISOString(),
        actor: people.get(r.actorId) ?? UNKNOWN_PRINCIPAL,
      };
    });
  }
}
