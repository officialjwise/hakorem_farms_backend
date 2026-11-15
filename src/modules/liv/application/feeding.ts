import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { Stock, StockUnits } from '../../inv';
import type { LocationFacts, MasterDataRefs, ProductFacts } from '../../mdm';
import type { FeedConsumed } from '../events';
import { LivestockRecordInvalidError, LivReferenceNotFoundError, RationInvalidError } from './errors';
import type { FeedConsumptionRecord, FeedFilters, LivestockStore, RationRecord } from './livestock-store';
import type { CostSpreader } from './spread';
import { afterOf, pageOf, pageProbe, readScopeOf, runWrite, writePermissions, type Page, type ReadDoor, type WriteDoor } from './support';

export interface RationCreateRequest {
  readonly name: string;
  readonly speciesId: string;
  readonly feedProductId: string;
  readonly qtyPerHeadPerDay: string;
  readonly stage?: string | undefined;
}

export interface RationUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly qtyPerHeadPerDay?: string | undefined;
  readonly stage?: string | undefined;
}

export interface FeedConsumptionCreateRequest {
  readonly id?: string | undefined;
  readonly locationId: string;
  readonly feedProductId: string;
  readonly qty: string;
  readonly consumedOn: string;
  readonly rationId?: string | undefined;
  readonly fromLocationId?: string | undefined;
}

/** The contract's `Ration`. */
export interface RationView {
  readonly id: string;
  readonly name: string;
  readonly species: { readonly id: string; readonly code: string; readonly name: string };
  readonly feedProduct: { readonly id: string; readonly sku: string; readonly name: string };
  readonly qtyPerHeadPerDay: string;
  readonly uom: string;
  readonly stage: string | null;
  readonly version: number;
}

/** The contract's `FeedConsumption`. */
export interface FeedConsumptionView {
  readonly id: string;
  readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly feedProduct: { readonly id: string; readonly sku: string; readonly name: string };
  readonly qty: string;
  readonly uom: string;
  readonly consumedOn: string;
  readonly ration: { readonly id: string; readonly name: string } | null;
  readonly valuePesewas: number | null;
  readonly currency: 'GHS';
  readonly status: 'DRAFT' | 'POSTED';
  readonly allocations: ReadonlyArray<{
    readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
    readonly headDays: number;
    readonly amountPesewas: number;
    readonly treatment: 'CAPITALISED' | 'EXPENSED';
  }>;
  readonly postedAt: string | null;
  readonly actor: { readonly id: string; readonly displayName: string };
}

/** Feed is held in the branch's store unless the record names another physical location (FR-LIV-015). */
const FEED_STORE_KIND = 'STORE';
const UNKNOWN_PRINCIPAL = { id: '', displayName: 'Unknown' };

/**
 * Rations and feed (FR-LIV-014 to FR-LIV-016; ADR-0018). A ration is planning data: so much of a feed per head per day
 * for a species and stage, managed by a person holding `liv.feed.manage`. A feed consumption is feed issued from a
 * store to a pen on a date, posted in one serializable transaction: inventory issues the feed with a FEED_ISSUE
 * movement and values it at the store's weighted average cost; that value is spread across the live animals and
 * flocks standing in the pen by head-days with the kernel's `allocate`, capitalised onto growing stock as FEED
 * value-only movements and expensed for breeding stock; the database checks at commit that the allocations sum
 * exactly to the value issued.
 */
export class Feeding {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly spreader: CostSpreader,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // Rations.

  listRations(actor: Actor | undefined, speciesId: string | undefined, cursor: string | undefined, limit: number, door: ReadDoor = { operationId: 'listRations', permission: 'liv.feed.read' }): Promise<Page<RationView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, door.permission);
      const binding = { operationId: door.operationId, principalId: actor!.principalId, filters: { speciesId: speciesId ?? null } };
      const rows = await this.store.listRations(tx, speciesId, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.rationViews(tx, rows.slice(0, limit)));
    });
  }

  createRation(actor: Actor | undefined, body: RationCreateRequest, idempotencyKey: string): Promise<StoredResponse<RationView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.feed.manage', 'createRation', body, idempotencyKey, async () => ({}), async (tx, who) => ({
      status: 201,
      body: await this.createRationIn(tx, who, body),
    }));
  }

  /** Creates a ration in the caller's transaction, every rule applied and audited; the caller authorised it. */
  async createRationIn(tx: Transaction, actor: Actor, body: RationCreateRequest): Promise<RationView> {
    const species = (await this.refs.speciesIn(tx, [body.speciesId])).get(body.speciesId);
    const feed = (await this.refs.productsIn(tx, [body.feedProductId])).get(body.feedProductId);
    const missing = [...(species === undefined ? ['/speciesId'] : []), ...(feed === undefined ? ['/feedProductId'] : [])];
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    this.checkFeed(feed!, '/feedProductId', (rules) => new RationInvalidError(rules));
    if (Quantity.parse(body.qtyPerHeadPerDay).isZero()) throw new RationInvalidError([{ field: '/qtyPerHeadPerDay', rule: 'QTY_ZERO' }]);
    const id = this.nextId();
    await this.named(() => this.store.insertRation(tx, { id, name: body.name, speciesId: body.speciesId, feedProductId: body.feedProductId, qtyPerHeadPerDay: Quantity.parse(body.qtyPerHeadPerDay).toDecimalString(), stage: body.stage ?? null }, actor.principalId));
    const view = (await this.rationViews(tx, [(await this.store.ration(tx, id))!]))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'Ration', entityId: id, before: null, after: { ...view } });
    return view;
  }

  updateRation(actor: Actor | undefined, id: string, body: RationUpdateRequest, idempotencyKey: string): Promise<StoredResponse<RationView>> {
    return runWrite(this.uow, this.authoriser, this.idempotency, actor, 'liv.feed.manage', 'updateRation', { id, ...body }, idempotencyKey, async () => ({}), async (tx, who) => {
      const before = await this.store.ration(tx, id);
      if (before === null) throw new NotFoundError(`no ration ${id}`);
      if (before.version !== body.version) throw new VersionConflictError(`ration ${id} is at version ${before.version}, not ${body.version}`);
      if (body.qtyPerHeadPerDay !== undefined && Quantity.parse(body.qtyPerHeadPerDay).isZero()) throw new RationInvalidError([{ field: '/qtyPerHeadPerDay', rule: 'QTY_ZERO' }]);
      const set: Record<string, unknown> = {};
      if (body.name !== undefined) set['name'] = body.name;
      if (body.qtyPerHeadPerDay !== undefined) set['qty_per_head_per_day'] = Quantity.parse(body.qtyPerHeadPerDay).toDecimalString();
      if (body.stage !== undefined) set['stage'] = body.stage;
      const changed = Object.keys(set).length === 0 || (await this.named(() => this.store.updateRation(tx, id, body.version, set, who.principalId)));
      if (!changed) throw new VersionConflictError(`ration ${id} changed while it was updated`);
      const [beforeView, view] = await this.rationViews(tx, [before, (await this.store.ration(tx, id))!]);
      await this.audit.record(tx, { module: 'liv', action: 'UPDATE', entityType: 'Ration', entityId: id, before: { ...beforeView! }, after: { ...view! } });
      return { status: 200, body: view! };
    });
  }

  // Feed consumption.

  record(
    actor: Actor | undefined,
    body: FeedConsumptionCreateRequest,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'recordFeedConsumption', answerPermission: 'liv.feed.read' },
  ): Promise<StoredResponse<FeedConsumptionView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      writePermissions('liv.feed.record', door),
      door.operationId,
      body,
      idempotencyKey,
      async (tx) => {
        const pen = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
        return pen === undefined ? {} : { branchId: pen.branchId, locationId: pen.id };
      },
      async (tx, who) => ({ status: 201, body: await this.recordIn(tx, who, body) }),
    );
  }

  /** Issues feed to a pen and spreads its value, in the caller's serializable transaction; the caller authorised it. */
  async recordIn(tx: Transaction, actor: Actor, body: FeedConsumptionCreateRequest): Promise<FeedConsumptionView> {
    if (body.id !== undefined) {
      const existing = (await this.store.feedConsumptions(tx, [body.id]))[0];
      if (existing !== undefined) return (await this.feedViews(tx, [existing]))[0]!;
    }
    const now = this.clock.now();
    const pen = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
    const feed = (await this.refs.productsIn(tx, [body.feedProductId])).get(body.feedProductId);
    const ration = body.rationId === undefined ? null : await this.store.ration(tx, body.rationId);
    const missing = [...(pen === undefined || !pen.isLive ? ['/locationId'] : []), ...(feed === undefined ? ['/feedProductId'] : []), ...(body.rationId !== undefined && ration === null ? ['/rationId'] : [])];
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    this.checkFeed(feed!, '/feedProductId', (rules) => new LivestockRecordInvalidError(rules));
    const broken: Array<{ field: string; rule: string }> = [];
    if (Quantity.parse(body.qty).isZero()) broken.push({ field: '/qty', rule: 'QTY_ZERO' });
    if (body.consumedOn > toBusinessDate(now)) broken.push({ field: '/consumedOn', rule: 'IN_THE_FUTURE' });
    if (ration !== null && ration.feedProductId !== body.feedProductId) broken.push({ field: '/rationId', rule: 'RATION_OF_ANOTHER_FEED' });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const from = await this.storeOf(tx, pen!, body.fromLocationId);
    const served = await this.spreader.atPenIn(tx, pen!, now);

    const id = body.id ?? this.nextId();
    await this.documents.register(tx, { id, docType: 'FEED_CONSUMPTION', ownerModule: 'liv', branchId: pen!.branchId, actorId: actor.principalId });
    const consumption = await this.spreader.virtualOf(tx, pen!.branchId, 'CONSUMPTION');
    const issued = await this.stock.postIn(tx, actor.principalId, {
      movementType: 'FEED_ISSUE',
      productId: feed!.id,
      branchId: pen!.branchId,
      fromLocationId: from.id,
      toLocationId: consumption,
      qty: Quantity.parse(body.qty),
      sourceDocumentId: id,
      occurredAt: now,
    });
    await this.store.insertFeedConsumption(
      tx,
      {
        id,
        locationId: pen!.id,
        fromLocationId: from.id,
        feedProductId: feed!.id,
        qty: Quantity.parse(body.qty).toDecimalString(),
        consumedOn: body.consumedOn,
        rationId: ration?.id ?? null,
        valuePesewas: issued.value.pesewas,
        issueMovementId: issued.id,
        status: 'POSTED',
        branchId: pen!.branchId,
        postedAt: now,
      },
      actor.principalId,
    );
    const allocations = await this.spreader.spreadIn(tx, actor, { total: issued.value, served, branchId: pen!.branchId, costElement: 'FEED', sourceDocumentId: id, occurredAt: now });
    for (const allocation of allocations) await this.store.insertFeedAllocation(tx, id, allocation, actor.principalId);

    const view = (await this.feedViews(tx, await this.store.feedConsumptions(tx, [id])))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'POST', entityType: 'FeedConsumption', entityId: id, branchId: pen!.branchId, before: null, after: { ...view } });
    await this.events.publish<FeedConsumed>(tx, {
      type: 'liv.FeedConsumed',
      subjectType: 'FeedConsumption',
      subjectId: id,
      branchId: pen!.branchId,
      occurredAt: now,
      payload: {
        feedConsumptionId: id,
        branchId: pen!.branchId,
        locationId: pen!.id,
        feedProductId: feed!.id,
        qty: view.qty,
        consumedOn: body.consumedOn,
        valuePesewas: issued.value.toJsonInteger(),
        allocations: allocations.map((a) => ({ stockUnitId: a.stockUnitId, headDays: Number(a.headDays), amountPesewas: Money.ofPesewas(a.amountPesewas).toJsonInteger(), treatment: a.treatment })),
      },
    });
    return view;
  }

  list(actor: Actor | undefined, filters: FeedFilters, cursor: string | undefined, limit: number): Promise<Page<FeedConsumptionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.feed.read');
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.feed.read');
      const binding = { operationId: 'listFeedConsumption', principalId: actor!.principalId, filters: { ...filters } };
      const rows = await this.store.listFeedConsumptions(tx, filters, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.feedViews(tx, rows.slice(0, limit)));
    });
  }

  get(actor: Actor | undefined, id: string): Promise<FeedConsumptionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = (await this.store.feedConsumptions(tx, [id]))[0];
      await this.authoriser.authorise(tx, actor, 'liv.feed.read', record === undefined ? {} : { branchId: record.branchId, locationId: record.locationId });
      if (record === undefined) throw new NotFoundError(`no feed consumption ${id}`);
      return (await this.feedViews(tx, [record]))[0]!;
    });
  }

  /** Feed is a stocked product in its own unit, not an animal, and tracked by product rather than by lot (A-158). */
  private checkFeed(product: ProductFacts, field: string, refuse: (rules: Array<{ field: string; rule: string }>) => Error): void {
    if (!product.isLive) throw refuse([{ field, rule: 'PRODUCT_NOT_ACTIVE' }]);
    if (product.tracking !== 'NONE' || product.speciesId !== null || product.stockPolicy === 'NON_STOCK') throw refuse([{ field, rule: 'NOT_FEED' }]);
  }

  /** The store feed comes from: the one named, a physical location of the pen's branch, or the branch's STORE. */
  private async storeOf(tx: Transaction, pen: LocationFacts, fromLocationId: string | undefined): Promise<LocationFacts> {
    const id = fromLocationId ?? (await this.refs.physicalLocationOfKindIn(tx, pen.branchId, FEED_STORE_KIND));
    if (id === null) throw new LivestockRecordInvalidError([{ field: '/fromLocationId', rule: 'NO_STORE' }]);
    const from = (await this.refs.locationsIn(tx, [id])).get(id);
    if (from === undefined || !from.isLive) throw new LivReferenceNotFoundError(['/fromLocationId']);
    if (from.isVirtual || from.branchId !== pen.branchId || from.id === pen.id) throw new LivestockRecordInvalidError([{ field: '/fromLocationId', rule: 'NOT_A_STORE_OF_THIS_BRANCH' }]);
    return from;
  }

  /** Runs a ration write and answers a second live ration of the same name for the species as NAME_TAKEN. */
  private async named<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (databaseErrorOf(error)?.constraint === 'uq_ration_name') throw new RationInvalidError([{ field: '/name', rule: 'NAME_TAKEN' }]);
      throw error;
    }
  }

  private async rationViews(tx: Transaction, records: readonly RationRecord[]): Promise<RationView[]> {
    const species = await this.refs.speciesIn(tx, records.map((r) => r.speciesId));
    const products = await this.refs.productsIn(tx, records.map((r) => r.feedProductId));
    return records.map((r) => {
      const feed = products.get(r.feedProductId)!;
      return {
        id: r.id,
        name: r.name,
        species: { ...species.get(r.speciesId)! },
        feedProduct: { id: feed.id, sku: feed.sku, name: feed.name },
        qtyPerHeadPerDay: r.qtyPerHeadPerDay,
        uom: feed.baseUom,
        stage: r.stage,
        version: r.version,
      };
    });
  }

  private async feedViews(tx: Transaction, records: readonly FeedConsumptionRecord[]): Promise<FeedConsumptionView[]> {
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const products = await this.refs.productsIn(tx, records.map((r) => r.feedProductId));
    const rations = new Map<string, RationRecord>();
    for (const r of records) {
      if (r.rationId !== null && !rations.has(r.rationId)) rations.set(r.rationId, (await this.store.ration(tx, r.rationId))!);
    }
    const units = await this.units.factsIn(tx, records.flatMap((r) => r.allocations.map((a) => a.stockUnitId)), this.clock.now());
    const people = await this.principals.refs(tx, records.map((r) => r.createdBy));
    return records.map((r) => {
      const location = locations.get(r.locationId)!;
      const feed = products.get(r.feedProductId)!;
      const ration = r.rationId === null ? null : rations.get(r.rationId)!;
      return {
        id: r.id,
        location: { id: location.id, code: location.code, name: location.name, kind: location.kind },
        feedProduct: { id: feed.id, sku: feed.sku, name: feed.name },
        qty: r.qty,
        uom: feed.baseUom,
        consumedOn: r.consumedOn,
        ration: ration === null ? null : { id: ration.id, name: ration.name },
        valuePesewas: r.valuePesewas === null ? null : Money.ofPesewas(r.valuePesewas).toJsonInteger(),
        currency: 'GHS' as const,
        status: r.status,
        allocations: [...r.allocations]
          .map((a) => ({ a, unit: units.get(a.stockUnitId)! }))
          .sort((x, y) => (x.unit.identifier < y.unit.identifier ? -1 : x.unit.identifier > y.unit.identifier ? 1 : 0))
          .map(({ a, unit }) => ({
            stockUnit: { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
            headDays: Number(a.headDays),
            amountPesewas: Money.ofPesewas(a.amountPesewas).toJsonInteger(),
            treatment: a.treatment,
          })),
        postedAt: r.postedAt?.toISOString() ?? null,
        actor: people.get(r.createdBy) ?? UNKNOWN_PRINCIPAL,
      };
    });
  }
}
