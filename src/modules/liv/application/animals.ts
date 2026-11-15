import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser } from '../../iam';
import type { StockPostingPayload, StockUnitFacts, StockUnitRegistered, StockUnits } from '../../inv';
import type { MasterDataRefs, PricingService } from '../../mdm';
import { sourceOfArrival, statusAfterMovement, type AnimalStatus } from '../domain/animal';
import { headOf } from '../domain/cost-spread';
import type { AnimalRegistered, BatchStarted } from '../events';
import { LivestockRecordInvalidError } from './errors';
import type { HerdStore } from './herd-store';
import type { AnimalFilters, AnimalRecord, LivestockStore, Purpose, Sex } from './livestock-store';
import { afterOf, pageOf, pageProbe, readScopeOf, type Page, type ReadDoor } from './support';

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `Animal`. */
export interface AnimalView {
  readonly id: string;
  readonly tagNo: string;
  readonly species: Ref;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly breed: string | null;
  readonly sex: Sex;
  readonly dateOfBirth: string | null;
  readonly acquiredOn: string;
  readonly source: AnimalRecord['source'];
  readonly supplier: { readonly id: string; readonly supplierNo: string; readonly name: string } | null;
  readonly dam: { readonly id: string; readonly tagNo: string } | null;
  readonly sire: { readonly id: string; readonly tagNo: string } | null;
  readonly batch: { readonly id: string; readonly batchNo: string } | null;
  readonly purpose: Purpose;
  readonly status: AnimalStatus;
  readonly currentLocation: (Ref & { readonly kind: string }) | null;
  readonly grade: Ref | null;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: string | null;
  readonly weightBand: { readonly id: string; readonly code: string; readonly minKg: string; readonly maxKg: string } | null;
  readonly accumulatedCostPesewas: number;
  readonly currency: 'GHS';
  readonly withdrawalUntil: string | null;
  readonly sellable: boolean;
  readonly priceBand: { readonly listPricePesewas: number; readonly floorPricePesewas: number; readonly ceilingPricePesewas: number; readonly basis: string } | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface AnimalListFilters {
  readonly q?: string | undefined;
  readonly speciesId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly status?: AnimalStatus | undefined;
  readonly sellable?: boolean | undefined;
  readonly purpose?: Purpose | undefined;
  readonly weightBandId?: string | undefined;
}

/** The movements that open or close an animal, as INV's ledger events (ADR-0003); LIV follows each in its transaction. */
export const FOLLOWED_EVENTS = ['inv.StockIssuedForSale', 'inv.StockConsumedInProcessing', 'inv.StockWrittenOff', 'inv.SaleReturnReceived', 'inv.SupplierReturnIssued'] as const;

/** The channel an animal's price band is read at: the counter, at its branch, before promotions (as A-153 for PRC). */
const BAND_CHANNEL = 'POS' as const;
/** A list filtered by what only inventory and pricing know is read in chunks of this many animals. */
const FILTER_CHUNK = 100;
const HEAD = '1.000';

/** The latest of some instants, or undefined if there are none. */
function latest(instants: readonly Date[]): Date | undefined {
  return instants.reduce<Date | undefined>((found, at) => (found === undefined || at > found ? at : found), undefined);
}

/**
 * The animal register (FR-LIV-001, FR-LIV-017; ADR-0018). An animal exists only through its serialised stock unit:
 * a goods receipt, opening stock or (B06 continued 2) a birth registers the unit, and inventory's
 * `inv.StockUnitRegistered` opens the animal here in the same transaction, at the cost the receipt carried. Its pen,
 * cost, holds and reservation stay inventory's and are read through `StockUnits`; its status follows every movement
 * that sells, slaughters, writes off or returns its unit, in that movement's transaction. Reads authorise first,
 * scoped to the animal's branch and the location it stands at.
 */
export class Animals {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly herd: HerdStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly pricing: PricingService,
    private readonly authoriser: Authoriser,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Transactional subscriber to `inv.StockUnitRegistered`: a serialised unit received becomes an animal (FR-LIV-001),
   * and a flock received as a lot of a livestock product opens its batch (FR-LIV-006, A-159).
   */
  readonly register = async (tx: Transaction, event: EventEnvelope): Promise<void> => {
    const unit = event.payload as unknown as StockUnitRegistered;
    if (unit.tracking === 'LOT') return this.openFlock(tx, event, unit);
    if (unit.animal === null) return;
    const product = (await this.refs.productsIn(tx, [unit.productId])).get(unit.productId)!;
    if (product.speciesId === null) {
      throw new Error(`product ${product.sku} is serialised without a species, which mdm.product's check forbids`);
    }
    if ((await this.store.liveAnimalByTag(tx, unit.identifier)) !== null) {
      throw new LivestockRecordInvalidError([{ field: '/lines', rule: 'TAG_IN_USE' }]);
    }
    const facts = (await this.units.factsIn(tx, [unit.stockUnitId], event.occurredAt)).get(unit.stockUnitId)!;
    const source = sourceOfArrival(unit.supplierId);
    await this.store.insertAnimal(
      tx,
      {
        stockUnitId: unit.stockUnitId,
        tagNo: unit.identifier,
        speciesId: product.speciesId,
        productId: unit.productId,
        branchId: facts.branchId,
        breed: unit.animal.breed,
        sex: unit.animal.sex,
        dateOfBirth: unit.animal.dateOfBirth,
        acquiredOn: toBusinessDate(event.occurredAt),
        source,
        supplierId: unit.supplierId,
        acquisitionCostPesewas: facts.poolValuePesewas,
        damId: null,
        sireId: null,
        purpose: unit.animal.purpose,
      },
      event.actorId,
    );
    if (unit.animal.weightKg !== null && unit.animal.weightSource !== null) {
      await this.store.insertWeight(tx, {
        id: this.nextId(),
        stockUnitId: unit.stockUnitId,
        branchId: facts.branchId,
        weightKg: unit.animal.weightKg,
        weightSource: unit.animal.weightSource,
        headWeighed: 1,
        measuredAt: event.occurredAt,
        actorId: event.actorId,
      });
    }
    const view = (await this.viewsIn(tx, (await this.store.animals(tx, [unit.stockUnitId])), event.occurredAt))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'Animal', entityId: unit.stockUnitId, branchId: facts.branchId, before: null, after: { ...view } });
    await this.events.publish<AnimalRegistered>(tx, {
      type: 'liv.AnimalRegistered',
      subjectType: 'Animal',
      subjectId: unit.stockUnitId,
      branchId: facts.branchId,
      occurredAt: event.occurredAt,
      causationId: event.id,
      payload: {
        stockUnitId: unit.stockUnitId,
        tagNo: unit.identifier,
        speciesId: product.speciesId,
        productId: unit.productId,
        branchId: facts.branchId,
        source,
        supplierId: unit.supplierId,
        acquisitionCostPesewas: Money.ofPesewas(facts.poolValuePesewas).toJsonInteger(),
        purpose: unit.animal.purpose,
      },
    });
  };

  /**
   * A received flock's batch (FR-LIV-006, A-159): numbered as its lot, started on the day it arrived with the head
   * received, GROWING until someone changes its purpose. A lot of anything that is not livestock opens nothing; a lot
   * whose number another batch already carries is refused, and the receipt with it.
   */
  private async openFlock(tx: Transaction, event: EventEnvelope, unit: StockUnitRegistered): Promise<void> {
    const product = (await this.refs.productsIn(tx, [unit.productId])).get(unit.productId)!;
    if (product.speciesId === null) return;
    if (await this.herd.batchNoTaken(tx, unit.identifier)) throw new LivestockRecordInvalidError([{ field: '/lines', rule: 'BATCH_NO_TAKEN' }]);
    const facts = (await this.units.factsIn(tx, [unit.stockUnitId], event.occurredAt)).get(unit.stockUnitId)!;
    const batch = {
      id: this.nextId(),
      stockUnitId: unit.stockUnitId,
      batchNo: unit.identifier,
      speciesId: product.speciesId,
      branchId: facts.branchId,
      locationId: unit.locationId,
      startedOn: toBusinessDate(event.occurredAt),
      initialHead: Number(headOf('LOT', facts.poolQty)),
      purpose: 'GROWING' as const,
    };
    await this.herd.insertBatch(tx, batch, event.actorId);
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'Batch', entityId: batch.id, branchId: batch.branchId, before: null, after: { ...batch } });
    await this.events.publish<BatchStarted>(tx, {
      type: 'liv.BatchStarted',
      subjectType: 'Batch',
      subjectId: batch.id,
      branchId: batch.branchId,
      occurredAt: event.occurredAt,
      causationId: event.id,
      payload: { batchId: batch.id, batchNo: batch.batchNo, stockUnitId: batch.stockUnitId, speciesId: batch.speciesId, branchId: batch.branchId, initialHead: batch.initialHead, purpose: batch.purpose, startedOn: batch.startedOn },
    });
  }

  /**
   * Transactional subscriber to the movements that close or reopen a unit (FR-LIV-017): the animal becomes SOLD,
   * SLAUGHTERED, DEAD or CULLED in the movement's own transaction, keeping the cost the movement carried out, and
   * ALIVE again on a return or a reversal. A movement of anything that is not an animal changes nothing.
   */
  readonly follow = async (tx: Transaction, event: EventEnvelope): Promise<void> => {
    const movement = event.payload as unknown as StockPostingPayload;
    if (movement.stockUnitId === null) return;
    const before = await this.store.lockAnimal(tx, movement.stockUnitId);
    if (before === null) return;
    const next = statusAfterMovement(movement.movementType, movement.reversesMovementId !== null);
    if (next === null || next === before.status || (next !== 'ALIVE' && before.status !== 'ALIVE')) return;
    const exitValue = next === 'ALIVE' ? null : Money.fromJsonInteger(movement.valuePesewas).pesewas;
    await this.store.setAnimalStatus(tx, before.stockUnitId, next, exitValue, event.occurredAt, event.actorId);
    await this.audit.record(tx, {
      module: 'liv',
      action: 'STATUS',
      entityType: 'Animal',
      entityId: before.stockUnitId,
      branchId: before.branchId,
      before: { status: before.status },
      after: { status: next, movementId: movement.movementId, movementType: movement.movementType, exitValuePesewas: exitValue === null ? null : movement.valuePesewas },
    });
  };

  list(actor: Actor | undefined, filters: AnimalListFilters, cursor: string | undefined, limit: number, door: ReadDoor = { operationId: 'listAnimals', permission: 'liv.animal.read' }): Promise<Page<AnimalView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, door.permission);
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, door.permission);
      const binding = { operationId: door.operationId, principalId: actor!.principalId, filters: { ...filters } };
      let after = afterOf(this.cursors, binding, cursor);
      const query: AnimalFilters = {
        q: filters.q,
        speciesId: filters.speciesId,
        status: filters.status,
        purpose: filters.purpose,
        unitIds: filters.locationId === undefined ? undefined : (await this.units.onHandAtIn(tx, [filters.locationId])).filter((u) => u.tracking === 'SERIAL').map((u) => u.id),
      };
      const now = this.clock.now();
      if (filters.sellable === undefined && filters.weightBandId === undefined) {
        const rows = await this.store.listAnimals(tx, query, scope, after, pageProbe(limit));
        return pageOf(this.cursors, binding, rows, limit, (r) => r.stockUnitId, await this.viewsIn(tx, rows.slice(0, limit), now));
      }
      // Sellability and the weight band are inventory's and pricing's answers, so the filter reads on in chunks.
      const kept: Array<{ record: AnimalRecord; view: AnimalView }> = [];
      for (;;) {
        const chunk = await this.store.listAnimals(tx, query, scope, after, FILTER_CHUNK);
        const views = await this.viewsIn(tx, chunk, now);
        chunk.forEach((record, index) => {
          const view = views[index]!;
          if (filters.sellable !== undefined && view.sellable !== filters.sellable) return;
          if (filters.weightBandId !== undefined && view.weightBand?.id !== filters.weightBandId) return;
          kept.push({ record, view });
        });
        if (kept.length > limit || chunk.length < FILTER_CHUNK) break;
        after = chunk.at(-1)!.stockUnitId;
      }
      return pageOf(this.cursors, binding, kept.map((k) => k.record), limit, (r) => r.stockUnitId, kept.slice(0, limit).map((k) => k.view));
    });
  }

  get(actor: Actor | undefined, id: string, door: ReadDoor = { operationId: 'getAnimal', permission: 'liv.animal.read' }): Promise<AnimalView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = (await this.store.animals(tx, [id]))[0];
      const facts = record === undefined ? undefined : (await this.units.factsIn(tx, [id], this.clock.now())).get(id);
      await this.authoriser.authorise(tx, actor, door.permission, record === undefined ? {} : { branchId: record.branchId, locationId: facts?.currentLocationId ?? null });
      if (record === undefined) throw new NotFoundError(`no animal ${id}`);
      return (await this.viewsIn(tx, [record], this.clock.now()))[0]!;
    });
  }

  /** The contract's `Animal` for each record, read with its stock unit, its references and its band at the counter. */
  async viewsIn(tx: Transaction, records: readonly AnimalRecord[], at: Date): Promise<AnimalView[]> {
    if (records.length === 0) return [];
    const ids = records.map((r) => r.stockUnitId);
    const facts = await this.units.factsIn(tx, ids, at);
    const alive = (r: AnimalRecord) => r.status === 'ALIVE';
    const batches = new Map((await this.herd.batches(tx, records.flatMap((r) => (r.batchId === null ? [] : [r.batchId])))).map((b) => [b.id, b] as const));
    const [products, species, suppliers, grades, locations, parents] = [
      await this.refs.productsIn(tx, records.map((r) => r.productId)),
      await this.refs.speciesIn(tx, records.map((r) => r.speciesId)),
      await this.refs.suppliersIn(tx, records.flatMap((r) => (r.supplierId === null ? [] : [r.supplierId]))),
      await this.refs.gradesIn(tx, [...facts.values()].flatMap((f) => (f.gradeId === null ? [] : [f.gradeId]))),
      await this.refs.locationsIn(tx, records.filter(alive).flatMap((r) => (facts.get(r.stockUnitId)?.currentLocationId ? [facts.get(r.stockUnitId)!.currentLocationId!] : []))),
      new Map((await this.store.animals(tx, records.flatMap((r) => [r.damId, r.sireId].filter((p): p is string => p !== null)))).map((a) => [a.stockUnitId, a.tagNo] as const)),
    ];
    const bands = await this.bandsOf(tx, records.filter(alive), facts, at);
    return records.map((r) => {
      const unit = facts.get(r.stockUnitId)!;
      const product = products.get(r.productId)!;
      const supplier = r.supplierId === null ? null : suppliers.get(r.supplierId)!;
      const grade = unit.gradeId === null ? null : grades.get(unit.gradeId)!;
      const location = alive(r) && unit.currentLocationId !== null ? locations.get(unit.currentLocationId)! : null;
      const withdrawal = unit.holds.filter((h) => h.kind === 'WITHDRAWAL');
      const withdrawalUntil = withdrawal.some((h) => h.endsAt === null) ? null : latest(withdrawal.map((h) => h.endsAt!));
      const band = bands.get(r.stockUnitId) ?? null;
      const parent = (id: string | null) => (id === null ? null : { id, tagNo: parents.get(id)! });
      return {
        id: r.stockUnitId,
        tagNo: r.tagNo,
        species: { ...species.get(r.speciesId)! },
        product: { id: product.id, sku: product.sku, name: product.name },
        breed: r.breed,
        sex: r.sex,
        dateOfBirth: r.dateOfBirth,
        acquiredOn: r.acquiredOn,
        source: r.source,
        supplier: supplier === null ? null : { id: supplier.id, supplierNo: supplier.supplierNo, name: supplier.name },
        dam: parent(r.damId),
        sire: parent(r.sireId),
        batch: r.batchId === null ? null : { id: r.batchId, batchNo: batches.get(r.batchId)!.batchNo },
        purpose: r.purpose,
        status: r.status,
        currentLocation: location === null ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
        grade: grade === null ? null : { id: grade.id, code: grade.code, name: grade.name },
        lastWeightKg: unit.lastWeightKg,
        lastWeighedAt: unit.lastWeighedAt?.toISOString() ?? null,
        weightBand: band?.weightBand ?? null,
        // While alive, the pool as it stands; once closed, what the closing movement carried out of it.
        accumulatedCostPesewas: Money.ofPesewas(alive(r) ? unit.poolValuePesewas : (r.exitValuePesewas ?? 0n)).toJsonInteger(),
        currency: 'GHS' as const,
        withdrawalUntil: withdrawalUntil?.toISOString() ?? null,
        sellable: alive(r) && unit.status === 'ACTIVE' && unit.holds.length === 0 && !unit.reserved,
        priceBand: band?.priceBand ?? null,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  /** Each live animal's band at the counter of its branch: what the engine resolves for it now, by weight and grade. */
  private async bandsOf(
    tx: Transaction,
    records: readonly AnimalRecord[],
    facts: ReadonlyMap<string, StockUnitFacts>,
    at: Date,
  ): Promise<ReadonlyMap<string, { weightBand: AnimalView['weightBand']; priceBand: AnimalView['priceBand'] }>> {
    const bands = new Map<string, { weightBand: AnimalView['weightBand']; priceBand: AnimalView['priceBand'] }>();
    for (const branchId of new Set(records.map((r) => r.branchId))) {
      const lines = records
        .filter((r) => r.branchId === branchId)
        .map((r) => {
          const unit = facts.get(r.stockUnitId)!;
          return { lineRef: r.stockUnitId, productId: r.productId, gradeId: unit.gradeId ?? undefined, weightKg: unit.lastWeightKg ?? undefined, quantity: HEAD };
        });
      const resolved = await this.pricing.resolveIn(tx, { channel: BAND_CHANNEL, branchId, at, lines });
      for (const line of resolved.lines) {
        if (line.outcome !== 'RESOLVED' || line.resolved === null) continue;
        const r = line.resolved;
        bands.set(line.lineRef, {
          weightBand: r.weightBand === null ? null : { id: r.weightBand.id, code: r.weightBand.code, minKg: r.weightBand.minKg, maxKg: r.weightBand.maxKg },
          priceBand: { listPricePesewas: r.listPricePesewas, floorPricePesewas: r.floorPricePesewas, ceilingPricePesewas: r.ceilingPricePesewas, basis: r.basis },
        });
      }
    }
    return bands;
  }
}
