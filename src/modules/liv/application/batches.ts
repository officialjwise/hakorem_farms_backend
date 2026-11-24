import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { Stock, StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { headOf } from '../domain/cost-spread';
import { percentOf } from '../domain/growth';
import { checkBatchClose, holdsAnimals } from '../domain/herd';
import type { BatchClosed, BatchStarted } from '../events';
import { LivestockRecordInvalidError, LivReferenceNotFoundError } from './errors';
import type { BatchFilters, BatchPurpose, BatchRecord, HerdStore } from './herd-store';
import { afterOf, pageOf, pageProbe, placesOf, readScopeOf, runWrite, writePermissions, type Page, type ReadDoor, type WriteDoor } from './support';

export interface BatchCreateRequest {
  readonly batchNo: string;
  readonly speciesId: string;
  readonly startedOn: string;
  readonly initialHead: number;
  readonly purpose: BatchPurpose;
  readonly locationId: string;
}

export interface BatchUpdateRequest {
  readonly version: number;
  readonly purpose?: BatchPurpose | undefined;
}

/** The contract's `Batch`. */
export interface BatchView {
  readonly id: string;
  readonly batchNo: string;
  readonly species: { readonly id: string; readonly code: string; readonly name: string };
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly startedOn: string;
  readonly initialHead: number;
  readonly currentHead: number;
  readonly purpose: BatchPurpose;
  readonly status: 'ACTIVE' | 'CLOSED';
  readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | null;
  readonly mortalityPercent: string;
  readonly accumulatedCostPesewas: number;
  readonly currency: 'GHS';
  readonly version: number;
}

/**
 * Batches (FR-LIV-006; ADR-0018). A flock is a lot counted in head, and its batch shares nothing with the lot but the
 * lot's key: head, place and cost are inventory's, read through `StockUnits`. A flock received on a goods receipt opens
 * its batch from `inv.StockUnitRegistered` (`Animals.register`); one hatched on the farm is started here, which
 * registers its lot and brings its head in by a BIRTH movement at nil cost (A-159). A batch's purpose decides whether
 * the feed and veterinary cost spread onto its flock is capitalised (growing) or expensed (breeding, laying). It closes
 * only once no head is left, with its reason.
 */
export class Batches {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly herd: HerdStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filters: BatchFilters, cursor: string | undefined, limit: number, door: ReadDoor = { operationId: 'listBatches', permission: 'liv.batch.read' }): Promise<Page<BatchView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, door.permission);
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, door.permission);
      const binding = { operationId: door.operationId, principalId: actor!.principalId, filters: { ...filters } };
      const rows = await this.herd.listBatches(tx, filters, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.viewsIn(tx, rows.slice(0, limit)));
    });
  }

  get(actor: Actor | undefined, id: string, door: ReadDoor = { operationId: 'getBatch', permission: 'liv.batch.read' }): Promise<BatchView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const batch = (await this.herd.batches(tx, [id]))[0];
      await this.authoriser.authorise(tx, actor, door.permission, batch === undefined ? {} : await this.scopeOf(tx, batch));
      if (batch === undefined) throw new NotFoundError(`no batch ${id}`);
      return (await this.viewsIn(tx, [batch]))[0]!;
    });
  }

  create(
    actor: Actor | undefined,
    body: BatchCreateRequest,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'createBatch', answerPermission: 'liv.batch.read' },
  ): Promise<StoredResponse<BatchView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      writePermissions('liv.batch.create', door),
      door.operationId,
      body,
      idempotencyKey,
      async (tx) => {
        const pen = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return pen === undefined ? {} : { branchId: pen.branchId, locationId: pen.id };
      },
      async (tx, who) => ({ status: 201, body: await this.createIn(tx, who, body) }),
    );
  }

  /** Hatches a flock into a pen in the caller's serializable transaction; the caller authorised it. */
  async createIn(tx: Transaction, actor: Actor, body: BatchCreateRequest): Promise<BatchView> {
    const species = (await this.refs.speciesIn(tx, [body.speciesId])).get(body.speciesId);
    const pen = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
    const missing = [...(species === undefined ? ['/speciesId'] : []), ...(pen === undefined ? ['/locationId'] : [])];
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    const now = this.clock.now();
    const broken: Array<{ field: string; rule: string }> = holdsAnimals(pen!) ? [] : [{ field: '/locationId', rule: 'NOT_A_PEN' }];
    // A flock of a species is held as its one lot-tracked product; none, or more than one, leaves the hatch unplaced.
    const flocks = (await this.refs.productsOfSpeciesIn(tx, body.speciesId)).filter((p) => p.tracking === 'LOT');
    if (flocks.length !== 1) broken.push({ field: '/speciesId', rule: 'NO_FLOCK_PRODUCT' });
    if (body.initialHead <= 0) broken.push({ field: '/initialHead', rule: 'HEAD_ZERO' });
    if (body.startedOn > toBusinessDate(now)) broken.push({ field: '/startedOn', rule: 'IN_THE_FUTURE' });
    if (await this.herd.batchNoTaken(tx, body.batchNo)) broken.push({ field: '/batchNo', rule: 'BATCH_NO_TAKEN' });
    else if (flocks.length === 1 && (await this.units.activeIdentifiersIn(tx, flocks[0]!.id, [body.batchNo])).length > 0) broken.push({ field: '/batchNo', rule: 'BATCH_NO_TAKEN' });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const product = flocks[0]!;
    const id = this.nextId();
    await this.documents.register(tx, { id, docType: 'LIVESTOCK_BATCH', ownerModule: 'liv', branchId: pen!.branchId, actorId: actor.principalId });
    const stockUnitId = await this.units.registerLotIn(tx, actor.principalId, {
      productId: product.id,
      branchId: pen!.branchId,
      identifier: body.batchNo,
      producedOn: body.startedOn,
      expiresOn: null,
      storageTempClass: null,
      sourceDocumentId: id,
      weightKg: null,
      weighedAt: null,
    });
    const production = await this.refs.virtualLocationIn(tx, pen!.branchId, 'PRODUCTION');
    if (production === null) throw new Error(`branch ${pen!.branchId} has no virtual PRODUCTION location; every branch is created with one (ADR-0042)`);
    await this.stock.postIn(tx, actor.principalId, {
      movementType: 'BIRTH',
      productId: product.id,
      stockUnitId,
      branchId: pen!.branchId,
      fromLocationId: production,
      toLocationId: pen!.id,
      qty: Quantity.ofUnits(BigInt(body.initialHead)),
      sourceDocumentId: id,
      occurredAt: now,
    });
    const batch = { id, stockUnitId, batchNo: body.batchNo, speciesId: body.speciesId, branchId: pen!.branchId, locationId: pen!.id, startedOn: body.startedOn, initialHead: body.initialHead, purpose: body.purpose };
    await this.herd.insertBatch(tx, batch, actor.principalId);
    const view = (await this.viewsIn(tx, [(await this.herd.batches(tx, [id]))[0]!]))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'Batch', entityId: id, branchId: batch.branchId, before: null, after: { ...view } });
    await this.events.publish<BatchStarted>(tx, {
      type: 'liv.BatchStarted',
      subjectType: 'Batch',
      subjectId: id,
      branchId: batch.branchId,
      occurredAt: now,
      payload: { batchId: id, batchNo: batch.batchNo, stockUnitId, speciesId: batch.speciesId, branchId: batch.branchId, initialHead: batch.initialHead, purpose: batch.purpose, startedOn: batch.startedOn },
    });
    return view;
  }

  update(
    actor: Actor | undefined,
    id: string,
    body: BatchUpdateRequest,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'updateBatch', answerPermission: 'liv.batch.read' },
  ): Promise<StoredResponse<BatchView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, writePermissions('liv.batch.update', door), door.operationId, { id, ...body }, idempotencyKey, (tx) => this.scopeById(tx, id), async (tx, who) => {
      const before = await this.herd.lockBatch(tx, id);
      if (before === null) throw new NotFoundError(`no batch ${id}`);
      if (before.version !== body.version) throw new VersionConflictError(`batch ${id} is at version ${before.version}, not ${body.version}`);
      if (before.status === 'CLOSED') throw new LivestockRecordInvalidError([{ field: '/version', rule: 'BATCH_CLOSED' }]);
      const set = body.purpose === undefined ? {} : { purpose: body.purpose };
      if (!(await this.herd.updateBatch(tx, id, body.version, set, who.principalId))) throw new VersionConflictError(`batch ${id} changed while it was updated`);
      const [beforeView, view] = await this.viewsIn(tx, [before, (await this.herd.batches(tx, [id]))[0]!]);
      await this.audit.record(tx, { module: 'liv', action: 'UPDATE', entityType: 'Batch', entityId: id, branchId: before.branchId, before: { ...beforeView! }, after: { ...view! } });
      return { status: 200, body: view! };
    });
  }

  close(
    actor: Actor | undefined,
    id: string,
    reason: string,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'closeBatch', answerPermission: 'liv.batch.read' },
  ): Promise<StoredResponse<BatchView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, writePermissions('liv.batch.update', door), door.operationId, { id, reason }, idempotencyKey, (tx) => this.scopeById(tx, id), async (tx, who) => {
      const before = await this.herd.lockBatch(tx, id);
      if (before === null) throw new NotFoundError(`no batch ${id}`);
      const [beforeView] = await this.viewsIn(tx, [before]);
      const broken = checkBatchClose({ status: before.status, currentHead: BigInt(beforeView!.currentHead) });
      if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
      const now = this.clock.now();
      await this.herd.updateBatch(tx, id, before.version, { status: 'CLOSED', closed_at: now, closed_by: who.principalId, close_reason: reason }, who.principalId);
      const [view] = await this.viewsIn(tx, [(await this.herd.batches(tx, [id]))[0]!]);
      await this.audit.record(tx, { module: 'liv', action: 'CLOSE', entityType: 'Batch', entityId: id, branchId: before.branchId, before: { ...beforeView! }, after: { ...view! } });
      await this.events.publish<BatchClosed>(tx, {
        type: 'liv.BatchClosed',
        subjectType: 'Batch',
        subjectId: id,
        branchId: before.branchId,
        occurredAt: now,
        payload: { batchId: id, branchId: before.branchId, reason, mortalityPercent: view!.mortalityPercent },
      });
      return { status: 200, body: view! };
    });
  }

  /**
   * Each batch's stock unit, number and branch, in the caller's transaction (B12 continued 2, FR-CST-001: a batch's
   * accumulated cost is its flock's). A batch not found is left out. Additive: nothing else changes.
   */
  async stockUnitsOfIn(tx: Transaction, batchIds: readonly string[]): Promise<ReadonlyMap<string, { readonly stockUnitId: string | null; readonly batchNo: string; readonly branchId: string }>> {
    return new Map((await this.herd.batches(tx, batchIds)).map((b) => [b.id, { stockUnitId: b.stockUnitId, batchNo: b.batchNo, branchId: b.branchId }] as const));
  }

  /**
   * The contract's `Batch` for each record. A flock's head, place and cost are its lot's, as inventory holds them; a
   * closed batch shows the place it started in. Mortality is the head lost to posted deaths over the initial head.
   */
  async viewsIn(tx: Transaction, records: readonly BatchRecord[]): Promise<BatchView[]> {
    if (records.length === 0) return [];
    const lots = records.flatMap((r) => (r.stockUnitId === null ? [] : [r.stockUnitId]));
    const facts = await this.units.factsIn(tx, lots, this.clock.now());
    const places = await placesOf(tx, this.units, [...facts.values()]);
    const deaths = await this.herd.deathsOf(tx, lots);
    const species = await this.refs.speciesIn(tx, records.map((r) => r.speciesId));
    const locations = await this.refs.locationsIn(tx, [...records.flatMap((r) => (r.locationId === null ? [] : [r.locationId])), ...[...places.values()].filter((p): p is string => p !== null)]);
    return records.map((r) => {
      const unit = r.stockUnitId === null ? undefined : facts.get(r.stockUnitId);
      const head = unit === undefined || unit.status !== 'ACTIVE' ? 0n : headOf('LOT', unit.poolQty);
      const placeId = (unit === undefined ? null : places.get(unit.id)) ?? r.locationId;
      const place = placeId === null ? undefined : locations.get(placeId);
      const dead = deaths.filter((d) => d.stockUnitId === r.stockUnitId).reduce((sum, d) => sum + BigInt(d.head), 0n);
      return {
        id: r.id,
        batchNo: r.batchNo,
        species: { ...species.get(r.speciesId)! },
        stockUnit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
        startedOn: r.startedOn,
        initialHead: r.initialHead,
        currentHead: Number(head),
        purpose: r.purpose,
        status: r.status,
        location: place === undefined ? null : { id: place.id, code: place.code, name: place.name, kind: place.kind },
        mortalityPercent: percentOf(dead, BigInt(r.initialHead)),
        accumulatedCostPesewas: Money.ofPesewas(unit === undefined ? 0n : unit.poolValuePesewas).toJsonInteger(),
        currency: 'GHS' as const,
        version: r.version,
      };
    });
  }

  private async scopeOf(tx: Transaction, batch: BatchRecord): Promise<{ branchId: string; locationId: string | null }> {
    const lot = batch.stockUnitId === null ? undefined : (await this.units.factsIn(tx, [batch.stockUnitId], this.clock.now())).get(batch.stockUnitId);
    const place = lot === undefined ? null : ((await placesOf(tx, this.units, [lot])).get(lot.id) ?? null);
    return { branchId: batch.branchId, locationId: place ?? batch.locationId };
  }

  private async scopeById(tx: Transaction, id: string): Promise<{ branchId?: string; locationId?: string | null }> {
    const batch = (await this.herd.batches(tx, [id]))[0];
    return batch === undefined ? {} : this.scopeOf(tx, batch);
  }
}
