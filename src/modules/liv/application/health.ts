import { createUuidV7Generator, Money, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { AuthoriseScope, Authoriser, PrincipalNames } from '../../iam';
import type { Stock, StockHolds, StockUnits } from '../../inv';
import type { LocationFacts, MasterDataRefs, ProductFacts } from '../../mdm';
import { checkHealthEvent, withdrawalDaysFor, withdrawalEndsAt } from '../domain/health';
import type { HealthEventRecorded, WithdrawalStarted } from '../events';
import { LivestockRecordInvalidError, LivReferenceNotFoundError } from './errors';
import type { HealthEventRecord, HealthFilters, HealthKind, LivestockStore } from './livestock-store';
import type { CostSpreader, ServedUnit } from './spread';
import { afterOf, pageOf, pageProbe, placesOf, readScopeOf, runWrite, type Page } from './support';

export interface HealthEventCreateRequest {
  readonly id?: string | undefined;
  readonly kind: HealthKind;
  readonly stockUnitId?: string | undefined;
  readonly locationId?: string | undefined;
  readonly productId?: string | undefined;
  readonly dose?: string | undefined;
  readonly qtyUsed?: string | undefined;
  readonly withdrawalDays?: number | undefined;
  readonly costPesewas?: bigint | undefined;
  readonly administeredBy?: string | undefined;
  readonly notes?: string | undefined;
  readonly occurredAt: Date;
}

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/** The contract's `HealthEvent`. */
export interface HealthEventView {
  readonly id: string;
  readonly kind: HealthKind;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly location: Ref | null;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly dose: string | null;
  readonly qtyUsed: string | null;
  readonly withdrawalDays: number;
  readonly withdrawalEndsAt: string | null;
  readonly holdsPlaced: number;
  readonly costPesewas: number;
  readonly currency: 'GHS';
  readonly administeredBy: string | null;
  readonly notes: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: { readonly id: string; readonly displayName: string };
}

/** Medication is held in the branch's store: a physical location of this kind (FR-LIV-007). */
const MEDICINE_STORE_KIND = 'STORE';
const UNKNOWN_PRINCIPAL = { id: '', displayName: 'Unknown' };

/**
 * Health events (FR-LIV-007 to FR-LIV-009, ADR-0019). A vaccination, treatment, check or deworming of one animal or
 * flock, or of every one standing in a pen, recorded in one serializable transaction with all its effects: the
 * medication used is issued from the branch's store by a MEDICATION_ISSUE movement that inventory values; a product
 * with withdrawal days places a WITHDRAWAL hold on every unit treated through INV's `StockHolds.placeIn`, which the
 * movement trigger enforces against sale, processing and dispatch until it ends, and which nobody may release early;
 * and the cost (the medication's value plus any veterinary service charged) is spread across the units treated by
 * head-days with the kernel's `allocate`, capitalised onto growing stock as VETERINARY value-only movements and
 * expensed for breeding stock. The database checks at commit that the spread sums exactly to the cost.
 */
export class HealthRecords {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly holds: StockHolds,
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

  record(actor: Actor | undefined, body: HealthEventCreateRequest, idempotencyKey: string): Promise<StoredResponse<HealthEventView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'liv.health.record',
      'recordHealthEvent',
      { ...body, costPesewas: body.costPesewas?.toString(), occurredAt: body.occurredAt.toISOString() },
      idempotencyKey,
      (tx) => this.scopeOf(tx, body),
      async (tx, who) => ({ status: 201, body: await this.recordIn(tx, who, body) }),
    );
  }

  /** Records a health event in the caller's serializable transaction, every rule applied; the caller authorised it. */
  async recordIn(tx: Transaction, actor: Actor, body: HealthEventCreateRequest): Promise<HealthEventView> {
    if (body.id !== undefined) {
      const existing = (await this.store.healthEvents(tx, [body.id]))[0];
      if (existing !== undefined) return (await this.views(tx, [existing]))[0]!;
    }
    const now = this.clock.now();
    const shape = checkHealthEvent({
      hasStockUnit: body.stockUnitId !== undefined,
      hasLocation: body.locationId !== undefined,
      hasProduct: body.productId !== undefined,
      hasQtyUsed: body.qtyUsed !== undefined,
      occurredAt: body.occurredAt,
      now,
    });
    if (shape.length > 0) throw new LivestockRecordInvalidError(shape);
    const { branchId, served, location } = await this.subject(tx, body, now);
    const product = body.productId === undefined ? null : await this.medication(tx, body.productId);
    const days = withdrawalDaysFor(body.withdrawalDays, product?.withdrawalDays ?? null);
    if (!days.ok) throw new LivestockRecordInvalidError([{ field: '/withdrawalDays', rule: days.error }]);
    const endsAt = withdrawalEndsAt(body.occurredAt, days.value);
    const id = body.id ?? this.nextId();
    await this.documents.register(tx, { id, docType: 'HEALTH_EVENT', ownerModule: 'liv', branchId, actorId: actor.principalId });

    // 1. The medication leaves the store, valued by inventory from its pool (ADR-0018).
    let medication = Money.zero();
    let issueMovementId: string | null = null;
    if (product !== null) {
      const store = await this.refs.physicalLocationOfKindIn(tx, branchId, MEDICINE_STORE_KIND);
      if (store === null) throw new LivestockRecordInvalidError([{ field: '/productId', rule: 'NO_STORE' }]);
      const consumption = (await this.spreader.virtualOf(tx, branchId, 'CONSUMPTION'));
      const issued = await this.stock.postIn(tx, actor.principalId, {
        movementType: 'MEDICATION_ISSUE',
        productId: product.id,
        branchId,
        fromLocationId: store,
        toLocationId: consumption,
        qty: Quantity.parse(body.qtyUsed!),
        sourceDocumentId: id,
        occurredAt: body.occurredAt,
      });
      medication = issued.value;
      issueMovementId = issued.id;
    }
    const cost = medication.plus(Money.ofPesewas(body.costPesewas ?? 0n));

    // 2. A withdrawal hold on every unit treated, in this transaction (FR-LIV-008).
    const holdIds: string[] = [];
    if (endsAt !== null) {
      for (const unit of served) {
        holdIds.push(await this.holds.placeIn(tx, actor.principalId, { stockUnitId: unit.id, kind: 'WITHDRAWAL', startsAt: body.occurredAt, endsAt, sourceDocumentId: id, note: `Withdrawal after ${body.kind.toLowerCase()} (${days.value} days)` }));
      }
    }
    await this.store.insertHealthEvent(tx, {
      id,
      kind: body.kind,
      branchId,
      stockUnitId: body.stockUnitId ?? null,
      locationId: location?.id ?? null,
      productId: product?.id ?? null,
      dose: body.dose ?? null,
      qtyUsed: body.qtyUsed === undefined ? null : Quantity.parse(body.qtyUsed).toDecimalString(),
      withdrawalDays: days.value,
      withdrawalEndsAt: endsAt,
      stockHoldId: body.stockUnitId !== undefined && holdIds.length > 0 ? holdIds[0]! : null,
      holdsPlaced: holdIds.length,
      costPesewas: cost.pesewas,
      medicationValuePesewas: medication.pesewas,
      issueMovementId,
      administeredBy: body.administeredBy ?? null,
      notes: body.notes ?? null,
      occurredAt: body.occurredAt,
      actorId: actor.principalId,
    });

    // 3. The cost spread by head-days, capitalised or expensed by each animal's purpose (FR-LIV-009).
    if (!cost.isZero()) {
      const parts = await this.spreader.spreadIn(tx, actor, { total: cost, served, branchId, costElement: 'VETERINARY', sourceDocumentId: id, occurredAt: body.occurredAt });
      for (const part of parts) await this.store.insertHealthAllocation(tx, id, part, actor.principalId);
    }

    const view = (await this.views(tx, (await this.store.healthEvents(tx, [id]))))[0]!;
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'HealthEvent', entityId: id, branchId, before: null, after: { ...view } });
    await this.events.publish<HealthEventRecorded>(tx, {
      type: 'liv.HealthEventRecorded',
      subjectType: 'HealthEvent',
      subjectId: id,
      branchId,
      occurredAt: body.occurredAt,
      payload: {
        healthEventId: id,
        kind: body.kind,
        branchId,
        stockUnitIds: served.map((u) => u.id),
        productId: product?.id ?? null,
        medicationValuePesewas: medication.toJsonInteger(),
        serviceCostPesewas: cost.minus(medication).toJsonInteger(),
        costPesewas: cost.toJsonInteger(),
        occurredAt: body.occurredAt.toISOString(),
      },
    });
    if (endsAt !== null) {
      await this.events.publish<WithdrawalStarted>(tx, {
        type: 'liv.WithdrawalStarted',
        subjectType: 'HealthEvent',
        subjectId: id,
        branchId,
        occurredAt: body.occurredAt,
        payload: { healthEventId: id, branchId, stockUnitIds: served.map((u) => u.id), withdrawalDays: days.value, endsAt: endsAt.toISOString() },
      });
    }
    return view;
  }

  list(actor: Actor | undefined, filters: HealthFilters, cursor: string | undefined, limit: number): Promise<Page<HealthEventView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.health.read');
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.health.read');
      const binding = { operationId: 'listHealthEvents', principalId: actor!.principalId, filters: { ...filters, from: filters.from?.toISOString(), to: filters.to?.toISOString() } };
      const rows = await this.store.listHealthEvents(tx, filters, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, await this.views(tx, rows.slice(0, limit)));
    });
  }

  get(actor: Actor | undefined, id: string): Promise<HealthEventView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = (await this.store.healthEvents(tx, [id]))[0];
      let scope: AuthoriseScope = {};
      if (record !== undefined) {
        const unit = record.stockUnitId === null ? undefined : (await this.units.factsIn(tx, [record.stockUnitId], this.clock.now())).get(record.stockUnitId);
        scope = { branchId: record.branchId, locationId: record.locationId ?? unit?.currentLocationId ?? null };
      }
      await this.authoriser.authorise(tx, actor, 'liv.health.read', scope);
      if (record === undefined) throw new NotFoundError(`no health event ${id}`);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  /** The branch and location a health event is authorised at: its animal's, or its pen's. Unknown ids leave it unscoped. */
  private async scopeOf(tx: Transaction, body: HealthEventCreateRequest): Promise<AuthoriseScope> {
    if (body.stockUnitId !== undefined) {
      const unit = (await this.units.factsIn(tx, [body.stockUnitId], this.clock.now())).get(body.stockUnitId);
      return unit === undefined ? {} : { branchId: unit.branchId, locationId: (await placesOf(tx, this.units, [unit])).get(unit.id) ?? null };
    }
    if (body.locationId !== undefined) {
      const location = (await this.refs.locationsIn(tx, [body.locationId])).get(body.locationId);
      return location === undefined ? {} : { branchId: location.branchId, locationId: location.id };
    }
    return {};
  }

  /** The units treated: the one named, alive, or every live animal and flock standing in the pen named. */
  private async subject(tx: Transaction, body: HealthEventCreateRequest, now: Date): Promise<{ branchId: string; served: ServedUnit[]; location: LocationFacts | null }> {
    if (body.stockUnitId !== undefined) {
      const served = await this.spreader.servedUnitsIn(tx, [body.stockUnitId], now);
      const unit = served.found.get(body.stockUnitId);
      if (unit === undefined) throw new LivReferenceNotFoundError(['/stockUnitId']);
      if (unit.problem !== null) throw new LivestockRecordInvalidError([{ field: '/stockUnitId', rule: unit.problem }]);
      return { branchId: unit.branchId, served: [unit], location: null };
    }
    const location = (await this.refs.locationsIn(tx, [body.locationId!])).get(body.locationId!);
    if (location === undefined || !location.isLive) throw new LivReferenceNotFoundError(['/locationId']);
    const served = await this.spreader.atPenIn(tx, location, now);
    return { branchId: location.branchId, served, location };
  }

  private async medication(tx: Transaction, productId: string): Promise<ProductFacts> {
    const product = (await this.refs.productsIn(tx, [productId])).get(productId);
    if (product === undefined) throw new LivReferenceNotFoundError(['/productId']);
    if (!product.isLive) throw new LivestockRecordInvalidError([{ field: '/productId', rule: 'PRODUCT_NOT_ACTIVE' }]);
    if (product.tracking !== 'NONE' || product.speciesId !== null) throw new LivestockRecordInvalidError([{ field: '/productId', rule: 'NOT_A_MEDICATION' }]);
    return product;
  }

  private async views(tx: Transaction, records: readonly HealthEventRecord[]): Promise<HealthEventView[]> {
    const units = await this.units.factsIn(tx, records.flatMap((r) => (r.stockUnitId === null ? [] : [r.stockUnitId])), this.clock.now());
    const locations = await this.refs.locationsIn(tx, records.flatMap((r) => (r.locationId === null ? [] : [r.locationId])));
    const products = await this.refs.productsIn(tx, records.flatMap((r) => (r.productId === null ? [] : [r.productId])));
    const people = await this.principals.refs(tx, records.map((r) => r.actorId));
    return records.map((r) => {
      const unit = r.stockUnitId === null ? null : units.get(r.stockUnitId)!;
      const location = r.locationId === null ? null : locations.get(r.locationId)!;
      const product = r.productId === null ? null : products.get(r.productId)!;
      return {
        id: r.id,
        kind: r.kind,
        stockUnit: unit === null ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
        location: location === null ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
        product: product === null ? null : { id: product.id, sku: product.sku, name: product.name },
        dose: r.dose,
        qtyUsed: r.qtyUsed,
        withdrawalDays: r.withdrawalDays,
        withdrawalEndsAt: r.withdrawalEndsAt?.toISOString() ?? null,
        holdsPlaced: r.holdsPlaced,
        costPesewas: Money.ofPesewas(r.costPesewas).toJsonInteger(),
        currency: 'GHS' as const,
        administeredBy: r.administeredBy,
        notes: r.notes,
        occurredAt: r.occurredAt.toISOString(),
        recordedAt: r.recordedAt.toISOString(),
        actor: people.get(r.actorId) ?? UNKNOWN_PRINCIPAL,
      };
    });
  }
}
