import { createUuidV7Generator, Quantity, type Clock, type Weight } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgeReservation } from '../domain/reservation';
import type { ReservationEnded } from '../events';
import { pageProbe } from './counting';
import { InvReferenceNotFoundError, StockUnitNotAvailableError, translateStockRefusal } from './errors';
import type { PostedMovement, Stock } from './stock';
import { locationRef, productRef, readScopes, runStockCommand, unitRef, type LocationRefView, type Page, type StockUnitRefView } from './stock-command';
import type { StockDocumentsStore } from './stock-documents-store';
import type { ReservationStatus, StockReservationFilters, StockReservationRecord, StockReservationStore } from './stock-reservation-store';
import type { WeightSource } from './stock-store';

/**
 * The lock a reserving module names in `seriesLocks` for each balance its transaction reserves from (FR-INV-025,
 * ADR-0005, A-060): taken before BEGIN, so concurrent reservations of the last units queue and each starts with a
 * fresh snapshot, instead of all aborting on the one balance row. The database refuses an over-reservation whether
 * or not the lock is taken; the lock only turns retries into a queue.
 */
export function reservationLockKey(productId: string, stockUnitId: string | null, locationId: string): string {
  return `inv.reservation:${productId}:${stockUnitId ?? '-'}:${locationId}`;
}

/** What a module in the same process asks to promise (the `Reservations` interface: SHP checkout, ORD, QUO). */
export interface ReservationRequest {
  readonly productId: string;
  readonly stockUnitId?: string | null;
  readonly locationId: string;
  readonly qty: Quantity;
  /** The checkout, order or quote the stock is promised to: a registered business document. */
  readonly holderDocumentId: string;
  /** Null until fulfilment (a confirmed order); otherwise the holder's lifetime (checkout 15 minutes, A-045). */
  readonly expiresAt: Date | null;
}

/** The movement that consumes a reservation whole (A-134 (f)): where the stock goes and the document that sends it. */
export interface ConsumeRequest {
  readonly movementType: string;
  readonly toLocationId: string;
  readonly sourceDocumentId: string;
  readonly sourceLineRef?: string | null;
  readonly weight?: { readonly kg: Weight; readonly source: WeightSource } | null;
  readonly occurredAt: Date;
}

/** The contract's `StockReservation`. */
export interface StockReservationView {
  readonly id: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: StockUnitRefView | null;
  readonly location: LocationRefView;
  readonly qty: string;
  readonly isExclusive: boolean;
  readonly holderDocument: DocumentRefRecord;
  readonly status: ReservationStatus;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

/**
 * Reservations (FR-INV-021, FR-INV-025, ADR-0019): stock promised to a checkout, order or quote. The `Reservations`
 * interface reserves, consumes and releases in the caller's serializable transaction; the database refuses a
 * reservation above what is available, a second active one of an animal, stock in transit and a unit under hold
 * (migrations 0044 and 0060), whoever writes. A movement that names its reservation consumes it whole; the expiry
 * job (`ReservationExpiry`) ends what has lapsed. Over HTTP a manager lists reservations and releases one by hand
 * with a reason. Every end publishes its event through the outbox for the holder to react to.
 */
export class Reservations {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockReservationStore,
    private readonly documentsStore: StockDocumentsStore,
    private readonly refs: MasterDataRefs,
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

  /** Promises stock in the caller's serializable transaction (ADR-0005); answers the reservation's id. */
  async reserveIn(tx: Transaction, actorId: string, request: ReservationRequest): Promise<string> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    const location = (await this.refs.locationsIn(tx, [request.locationId])).get(request.locationId);
    if (location === undefined) throw new InvReferenceNotFoundError(['/locationId']);
    const unitId = request.stockUnitId ?? null;
    const unit = unitId === null ? null : ((await this.documentsStore.units(tx, [unitId])).get(unitId) ?? null);
    if (unitId !== null && unit === null) throw new InvReferenceNotFoundError(['/stockUnitId']);
    const judged = judgeReservation({ qty: request.qty, location, unit, locationId: location.id, expiresAt: request.expiresAt, at: this.clock.now() });
    if (judged.refusal === 'INVALID_REQUEST') throw new Error(`reservation request refused: ${judged.reason}`);
    if (judged.refusal === 'NOT_AVAILABLE') throw new StockUnitNotAvailableError(judged.reason!);
    const id = this.nextId();
    await this.store
      .insert(
        tx,
        {
          id,
          productId: request.productId,
          stockUnitId: unitId,
          locationId: location.id,
          qty: request.qty.toDecimalString(),
          isExclusive: unit?.tracking === 'SERIAL',
          holderDocumentId: request.holderDocumentId,
          expiresAt: request.expiresAt,
          branchId: location.branchId,
        },
        actorId,
      )
      .catch(translateStockRefusal);
    await this.audit.record(tx, { module: 'inv', action: 'RESERVE', entityType: 'StockReservation', entityId: id, branchId: location.branchId, before: null, after: { ...(await this.store.reservation(tx, id))! } });
    await this.stock.availabilityChangedIn(tx, actorId, [request.productId]);
    return id;
  }

  /**
   * A reservation as its consumer checks it before issuing (B9a: a sale names the checkout's reservation), under the
   * reservation's row lock; null if there is none. It authorises nothing.
   */
  async heldIn(tx: Transaction, reservationId: string): Promise<StockReservationRecord | null> {
    return this.store.lock(tx, reservationId);
  }

  /** Issues the reserved stock whole through `Stock.postIn`, naming the reservation so the trigger consumes it. */
  async consumeIn(tx: Transaction, actorId: string, reservationId: string, request: ConsumeRequest): Promise<PostedMovement> {
    const reservation = await this.store.lock(tx, reservationId);
    if (reservation === null) throw new NotFoundError(`no stock reservation ${reservationId}`);
    return this.stock.postIn(tx, actorId, {
      movementType: request.movementType,
      productId: reservation.productId,
      stockUnitId: reservation.stockUnitId,
      branchId: reservation.branchId,
      fromLocationId: reservation.locationId,
      toLocationId: request.toLocationId,
      qty: Quantity.parse(reservation.qty),
      weight: request.weight ?? null,
      sourceDocumentId: request.sourceDocumentId,
      sourceLineRef: request.sourceLineRef ?? null,
      reservationId,
      occurredAt: request.occurredAt,
    });
  }

  /** Releases an active reservation in the caller's transaction (a checkout abandoned, a quote withdrawn). */
  async releaseIn(tx: Transaction, actorId: string, reservationId: string, reason: string): Promise<void> {
    await this.endIn(tx, actorId, reservationId, 'RELEASED', reason);
  }

  /**
   * Ends one active reservation, once: the trigger gives back exactly the quantity it promised, and the end is
   * audited and published as `inv.ReservationReleased` or `inv.ReservationExpired`.
   */
  async endIn(tx: Transaction, actorId: string, reservationId: string, status: 'RELEASED' | 'EXPIRED', reason: string): Promise<StockReservationRecord> {
    const before = await this.store.lock(tx, reservationId);
    if (before === null) throw new NotFoundError(`no stock reservation ${reservationId}`);
    if (before.status !== 'ACTIVE') throw new InvalidStateTransitionError(`stock reservation ${reservationId} is ${before.status}`);
    await this.store.end(tx, reservationId, status, reason, actorId);
    const after = (await this.store.reservation(tx, reservationId))!;
    await this.audit.record(tx, { module: 'inv', action: status === 'EXPIRED' ? 'EXPIRE' : 'RELEASE', entityType: 'StockReservation', entityId: reservationId, branchId: before.branchId, before: { ...before }, after: { ...after } });
    await this.events.publish<ReservationEnded>(tx, {
      type: status === 'EXPIRED' ? 'inv.ReservationExpired' : 'inv.ReservationReleased',
      subjectType: 'StockReservation',
      subjectId: reservationId,
      branchId: before.branchId,
      payload: {
        reservationId,
        holderDocumentId: before.holderDocumentId,
        productId: before.productId,
        stockUnitId: before.stockUnitId,
        locationId: before.locationId,
        qty: before.qty,
        expiresAt: before.expiresAt?.toISOString() ?? null,
        reason,
      },
    });
    await this.stock.availabilityChangedIn(tx, actorId, [before.productId]);
    return after;
  }

  list(actor: Actor | undefined, filters: StockReservationFilters, cursor: string | undefined, limit: number): Promise<Page<StockReservationView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'inv.reservation.read');
      const scopes = readScopes(await this.authoriser.scopes(tx, actor!, 'inv.reservation.read'));
      const binding = { operationId: 'listStockReservations', principalId: actor!.principalId, filters: { ...filters } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.reservations(tx, filters, scopes, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  release(actor: Actor | undefined, id: string, body: { readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<StockReservationView>> {
    return runStockCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      'inv.reservation.release',
      'releaseStockReservation',
      { id, ...body },
      idempotencyKey,
      async (tx) => {
        const record = await this.store.reservation(tx, id);
        return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
      },
      async (tx) => {
        const after = await this.endIn(tx, actor!.principalId, id, 'RELEASED', body.reason);
        return { status: 200, body: (await this.views(tx, [after]))[0]! };
      },
    );
  }

  private async views(tx: Transaction, records: readonly StockReservationRecord[]): Promise<StockReservationView[]> {
    const products = await this.refs.productsIn(tx, records.map((r) => r.productId));
    const locations = await this.refs.locationsIn(tx, records.map((r) => r.locationId));
    const units = await this.documentsStore.units(tx, records.flatMap((r) => (r.stockUnitId === null ? [] : [r.stockUnitId])));
    const docs = await this.documents.refs(tx, records.map((r) => r.holderDocumentId));
    return records.map((r) => ({
      id: r.id,
      product: productRef(products.get(r.productId)!),
      stockUnit: r.stockUnitId === null ? null : unitRef(units.get(r.stockUnitId)),
      location: locationRef(locations.get(r.locationId)!),
      qty: r.qty,
      isExclusive: r.isExclusive,
      holderDocument: docs.get(r.holderDocumentId) ?? { id: r.holderDocumentId, docType: 'UNKNOWN', number: null },
      status: r.status,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}

/** Reservations the expiry job ends in one run; the next run, a minute later, takes the rest. */
const EXPIRY_BATCH = 500;

/**
 * The scheduled reservation expiry (FR-INV-021, ADR-0019, docs/OPERATIONS.md "reservation-expiry", every minute):
 * every active reservation past its expiry is ended `EXPIRED`, giving back exactly what it promised, and
 * `inv.ReservationExpired` is published through the outbox in the same transaction. Serializable with retry; rows a
 * concurrent run holds are skipped, so each reservation expires once. Runs as a SYSTEM principal only.
 */
export class ReservationExpiry {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StockReservationStore,
    private readonly reservations: Reservations,
    private readonly clock: Clock,
  ) {}

  run(system: Pick<Actor, 'kind' | 'principalId'>): Promise<readonly string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the reservation expiry runs as a SYSTEM principal only');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const now = this.clock.now();
      const expired: string[] = [];
      for (const due of await this.store.lockDue(tx, now, EXPIRY_BATCH)) {
        await this.reservations.endIn(tx, system.principalId, due.id, 'EXPIRED', `Expired at ${due.expiresAt!.toISOString()}`);
        expired.push(due.id);
      }
      return expired;
    });
  }
}
