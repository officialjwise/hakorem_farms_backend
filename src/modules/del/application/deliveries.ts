import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore, StoredFileRecord } from '../../../platform/storage/file-store';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { MasterDataRefs, Storefront } from '../../mdm';
import type { DriverCash } from '../../pay';
import { codVariance, judgeProof, takesProof, type DeliveryStatus, type ProofFile, type VarianceReason } from '../domain/deliveries';
import { nextAttemptNo, pageProbe } from '../domain/numbering';
import { judgeFailure, judgeOnTheWay, takesFailure } from '../domain/routes';
import type { CodCollected, DeliveryCompleted, DeliveryFailed, DeliveryOnTheWay } from '../events';
import { DeliveryInvalidError } from './errors';
import type { ContentsLine, DeliveryRecord, DeliveryStore, ProofRecord } from './delivery-store';

const READ = 'del.delivery.read';
const READ_MINE = 'del.delivery.read.assigned';
const PROOF = 'del.proof.create';
const UPDATE_MINE = 'del.delivery.update.assigned';
export const DELIVERY_ON_THE_WAY = 'del.DeliveryOnTheWay';
export const DELIVERY_FAILED = 'del.DeliveryFailed';
/** Who may drive a delivery: a holder of the driver's proof permission at the delivery's branch (CR-056 item 1). */
const DRIVES = PROOF;
export const DELIVERY_COMPLETED = 'del.DeliveryCompleted';
export const COD_COLLECTED = 'del.CodCollected';
/** DEL's ◆ events (ADR-0003), declared for the ledger's boot assertion. */
export const DEL_LEDGER_EVENTS = [COD_COLLECTED, 'del.DriverCashRemitted'] as const;
/**
 * The ownership rule of a driver's delivery has no override (FR-DEL-004): no permission of this name is seeded, so the
 * Authoriser's owner check refuses every principal but the delivery's driver.
 */
const NO_OVERRIDE = 'del.delivery.any_driver';
/** The owner an unassigned delivery is held against: no principal has this id. */
const UNASSIGNED = '00000000-0000-0000-0000-000000000000';
/** A file the malware scan holds back is never proof (docs/security, SA-11). */
const QUARANTINED: ReadonlySet<string> = new Set(['INFECTED', 'FAILED']);

/** What ORD's dispatch gives DEL to deliver: DEL does not know orders (MODULE_BOUNDARIES, DEL card). */
export interface DeliveryRequest {
  readonly orderDocumentId: string;
  readonly billingDocumentId: string;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly deliveryZoneId: string;
  readonly recipientName: string;
  readonly recipientPhoneE164: string;
  readonly address: Readonly<Record<string, unknown>>;
  readonly contents: readonly ContentsLine[];
  readonly driverId: string | null;
  readonly vehicleLocationId: string | null;
  /** The cash due on delivery, fixed by the server at dispatch from the billing document on the weighed quantity. */
  readonly codDuePesewas: bigint;
  readonly dispatchedAt: Date;
}

export interface ProofRequest {
  readonly id: string;
  readonly recipientName: string;
  readonly signatureFileId?: string | undefined;
  readonly photoFileId?: string | undefined;
  readonly latitude?: string | undefined;
  readonly longitude?: string | undefined;
  readonly positionAccuracyM?: number | undefined;
  readonly codCollectedPesewas: bigint;
  readonly codVarianceReasonCode?: string | undefined;
  readonly codVarianceNote?: string | undefined;
  readonly capturedAt: Date;
}

/** The contract's `OnTheWay`. */
export interface OnTheWayRequest {
  readonly occurredAt: Date;
  readonly etaMinutes?: number | undefined;
}

/** The contract's `DeliveryFailure`: the attempt's id is the device's (an offline queue resends it). */
export interface FailureRequest {
  readonly id: string;
  readonly failureReasonCode: string;
  readonly nextAction: 'REATTEMPT' | 'RETURN_TO_STOCK';
  readonly latitude?: string | undefined;
  readonly longitude?: string | undefined;
  readonly occurredAt: Date;
}

export interface DeliveryQuery {
  readonly status: DeliveryStatus | null;
  readonly driverId: string | null;
  readonly orderId: string | null;
  readonly zoneId: string | null;
  /** An Africa/Accra calendar date the delivery was dispatched on. */
  readonly date: string | null;
}

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** The contract's `ProofOfDelivery`, with the reason for a short collection (B11 continued, additive). */
export interface ProofView {
  readonly id: string;
  readonly recipientName: string;
  readonly signatureFileId: string | null;
  readonly photoFileId: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly positionAccuracyM: number | null;
  readonly codCollectedPesewas: number;
  readonly codVarianceReasonCode: string | null;
  readonly codVarianceNote: string | null;
  readonly capturedAt: string;
}

/** The contract's `Delivery`. */
export interface DeliveryView {
  readonly id: string;
  readonly deliveryNo: string | null;
  readonly status: DeliveryStatus;
  readonly order: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly slot: null;
  readonly deliveryZone: Ref;
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly address: Readonly<Record<string, unknown>>;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly contents: readonly ContentsLine[];
  readonly driver: { readonly id: string; readonly displayName: string } | null;
  readonly vehicle: (Ref & { readonly kind: string }) | null;
  readonly codDuePesewas: number;
  readonly codCollectedPesewas: number | null;
  readonly attemptCount: number;
  readonly dispatchedAt: string | null;
  readonly deliveredAt: string | null;
  readonly proof: ProofView | null;
  readonly deliveryNoteDocumentId: string | null;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
}

/** The contract's `DeliverySummary`: what an order shows of its delivery. The slot is null until booking (B11 continued 2). */
export interface DeliverySummaryView {
  readonly id: string;
  readonly deliveryNo: string | null;
  readonly status: DeliveryStatus;
  readonly slotDate: null;
  readonly slotStartsAt: null;
  readonly slotEndsAt: null;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const coordinate = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number' ? String(value) : null);

/**
 * Deliveries (FR-DEL-003, FR-DEL-004, FR-DEL-008, FR-DEL-009, CR-055 point 1, CR-056, A-337 to A-341). `scheduleIn` is
 * the port ORD's dispatch calls in its own serializable transaction: a delivery numbered `DLV-...` from the snapshot ORD
 * gives (the recipient, address, contents and the cash due fixed from the invoice on the weighed quantity), assigned to a
 * driver of the branch and a vehicle of it. Over HTTP the Manager reads a branch's deliveries; a driver reads and records
 * only the deliveries assigned to them (the ownership rule, FR-DEL-004: another driver's is refused 403, by id or any
 * other way), and records the proof with the cash collected: a signature or a photograph the driver uploaded, never
 * more cash than is due, less only with a reason, the proof's id the device's so a retried upload is stored once. The
 * cash goes to PAY's `DriverCash` (held by the driver, allocated to the delivery's document); ◆ `del.CodCollected`
 * posts it and `del.DeliveryCompleted` tells ORD, in the same transaction. Each handler authorises in the application
 * layer, deny by default (ADR-0035).
 */
export class Deliveries {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DeliveryStore,
    private readonly refs: MasterDataRefs,
    private readonly storefront: Storefront,
    private readonly driverCash: DriverCash,
    private readonly files: FileStore,
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** The series lock a dispatch at the branch takes before BEGIN (A-186): the delivery's number. */
  locksFor(branchId: string): string[] {
    return [`DELIVERY:${toBusinessDate(this.clock.now()).slice(0, 4)}:${branchId}`];
  }

  /**
   * A delivery made at dispatch, in the caller's serializable transaction (FR-DEL-003): assigned when the dispatch names
   * a driver who drives for the branch and a live vehicle of it, scheduled otherwise. One live delivery per order. It
   * authorises nothing: ORD's dispatch has.
   */
  async scheduleIn(tx: Transaction, actor: Actor, request: DeliveryRequest): Promise<DeliveryView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    await this.assertAssignableIn(tx, request.branchId, request.driverId, request.vehicleLocationId);
    if ((await this.store.liveOfOrder(tx, request.orderDocumentId)) !== null) throw new DeliveryInvalidError([{ field: '', rule: 'DELIVERY_EXISTS' }]);

    const id = this.nextId();
    const branch = (await this.refs.branchesIn(tx, [request.branchId])).get(request.branchId)!;
    await this.documents.register(tx, { id, docType: 'DELIVERY', ownerModule: 'del', branchId: request.branchId, actorId: actor.principalId });
    const deliveryNo = await this.numbers.allocateIn(tx, { docType: 'DELIVERY', fiscalYear: Number(toBusinessDate(request.dispatchedAt).slice(0, 4)), branchId: request.branchId, branchCode: branch.code, documentId: id });
    await this.store.insert(tx, {
      id,
      deliveryNo,
      orderDocumentId: request.orderDocumentId,
      billingDocumentId: request.billingDocumentId,
      customerId: request.customerId,
      slotId: null,
      deliveryZoneId: request.deliveryZoneId,
      recipientName: request.recipientName,
      recipientPhoneE164: request.recipientPhoneE164,
      addressSnapshot: request.address,
      contents: request.contents,
      driverId: request.driverId,
      vehicleLocationId: request.vehicleLocationId,
      codDuePesewas: request.codDuePesewas,
      dispatchedAt: request.dispatchedAt,
      status: request.driverId === null ? 'SCHEDULED' : 'ASSIGNED',
      branchId: request.branchId,
      actorId: actor.principalId,
    });
    const view = (await this.viewsIn(tx, await this.store.deliveries(tx, [id])))[0]!;
    await this.audit.record(tx, { module: 'del', action: 'CREATE', entityType: 'Delivery', entityId: id, branchId: request.branchId, before: null, after: { ...view } });
    return view;
  }

  /**
   * Refuses a driver and vehicle a delivery of the branch cannot be given (422 DELIVERY_INVALID): both or neither; the
   * driver one who drives for the branch (holds `del.proof.create` there); the vehicle a live VEHICLE location of the
   * branch. ORD's dispatch asks before it moves anything; `scheduleIn` asks again. It authorises nothing.
   */
  async assertAssignableIn(tx: Transaction, branchId: string, driverId: string | null, vehicleLocationId: string | null): Promise<void> {
    const broken: { field: string; rule: string }[] = [];
    if ((driverId === null) !== (vehicleLocationId === null)) broken.push({ field: driverId === null ? '/driverId' : '/vehicleLocationId', rule: 'DRIVER_AND_VEHICLE' });
    if (driverId !== null && !(await this.authoriser.holdersIn(tx, DRIVES, branchId)).includes(driverId)) broken.push({ field: '/driverId', rule: 'NOT_A_DRIVER' });
    if (vehicleLocationId !== null) {
      const vehicle = (await this.refs.locationsIn(tx, [vehicleLocationId])).get(vehicleLocationId);
      if (vehicle === undefined || vehicle.kind !== 'VEHICLE' || !vehicle.isLive || vehicle.branchId !== branchId) broken.push({ field: '/vehicleLocationId', rule: 'NOT_A_VEHICLE' });
    }
    if (broken.length > 0) throw new DeliveryInvalidError(broken);
  }

  /** The order's live delivery, as ORD's views name it; null before dispatch. Read-only; it authorises nothing. */
  async ofOrderIn(tx: Transaction, orderDocumentId: string): Promise<DeliveryView | null> {
    const found = await this.store.liveOfOrder(tx, orderDocumentId);
    return found === null ? null : (await this.viewsIn(tx, [found]))[0]!;
  }

  /** Each order's live delivery as the contract's `DeliverySummary`, by order (ORD's order view). Read-only; it authorises nothing. */
  async summariesOfOrdersIn(tx: Transaction, orderIds: readonly string[]): Promise<Map<string, DeliverySummaryView>> {
    const found = new Map<string, DeliverySummaryView>();
    for (const orderId of new Set(orderIds)) {
      const d = await this.store.liveOfOrder(tx, orderId);
      if (d !== null) found.set(orderId, { id: d.id, deliveryNo: d.deliveryNo, status: d.status, slotDate: null, slotStartsAt: null, slotEndsAt: null });
    }
    return found;
  }

  /** getDelivery: at the delivery's branch; another branch's is refused as any other. */
  get(actor: Actor | undefined, id: string): Promise<DeliveryView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [found] = await this.store.deliveries(tx, [id]);
      if (found === undefined) throw new NotFoundError('no such delivery');
      await this.authoriser.authorise(tx, actor, READ, { branchId: found.branchId });
      return (await this.viewsIn(tx, [found]))[0]!;
    });
  }

  /** listDeliveries: the deliveries at the branches the caller reads whole, newest first, by status, driver or order. */
  list(actor: Actor | undefined, query: DeliveryQuery, cursor: string | undefined, limit: number): Promise<Page<DeliveryView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listDeliveries', principalId: actor!.principalId, filters: { ...query } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { branchIds, ...query }, beforeId, pageProbe(limit));
      const data = await this.viewsIn(tx, await this.store.deliveries(tx, found.slice(0, limit)));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** getMyDelivery: a delivery assigned to the caller; another driver's is refused (FR-DEL-004), an unknown one 404. */
  getMine(actor: Actor | undefined, id: string): Promise<DeliveryView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const found = await this.mineIn(tx, actor, READ_MINE, id, false);
      return (await this.viewsIn(tx, [found]))[0]!;
    });
  }

  /**
   * recordProofOfDelivery (FR-DEL-008, FR-DEL-009): on a delivery assigned to the caller and not finished, the recipient
   * and a signature or a photograph, the cash collected (never above the amount due; less only with a COD_VARIANCE
   * reason), in one serializable transaction with the cash recorded against the driver, the delivery DELIVERED and the
   * order told. The proof's id is the device's: sent again it answers the delivery as it stands and records nothing;
   * an id already used for another delivery is refused.
   */
  recordProof(actor: Actor | undefined, id: string, body: ProofRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PROOF);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordProofOfDelivery', principalId: actor!.principalId, key, request: { deliveryId: id, ...body, codCollectedPesewas: body.codCollectedPesewas.toString() } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeliveryView>;
      const response = await this.proofIn(tx, actor!, id, body);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The proof in the caller's serializable transaction, after its permission (the HTTP handler; the driver's sync, B11 continued 2). */
  private async proofIn(tx: Transaction, actor: Actor, id: string, body: ProofRequest): Promise<StoredResponse<DeliveryView>> {
    const earlier = await this.store.proofById(tx, body.id);
    if (earlier !== null && earlier.deliveryId !== id) throw new DeliveryInvalidError([{ field: '/id', rule: 'ID_IN_USE' }]);
    const delivery = await this.mineIn(tx, actor, PROOF, id, true);
    if (earlier !== null) return { status: 200, body: (await this.viewsIn(tx, [delivery]))[0]! };
    if (!takesProof(delivery.status)) throw invalidState(`delivery ${id}`, delivery.status);
    await this.assertRouteStartedIn(tx, id);

    const due = Money.ofPesewas(delivery.codDuePesewas);
    const collected = Money.ofPesewas(body.codCollectedPesewas);
    const reasonCode = body.codVarianceReasonCode ?? null;
    const reason = reasonCode === null ? undefined : (await this.refs.reasonCodesIn(tx, [reasonCode])).get(reasonCode);
    const broken = judgeProof({
      due,
      collected,
      reason: reasonCode === null ? null : reason === undefined ? 'UNKNOWN' : ({ domain: reason.domain, requiresNote: reason.requiresNote } satisfies VarianceReason),
      note: body.codVarianceNote ?? null,
      signature: await this.fileIn(tx, body.signatureFileId, actor),
      photo: await this.fileIn(tx, body.photoFileId, actor),
    });
    if (body.capturedAt.getTime() < delivery.dispatchedAt.getTime()) broken.push({ field: '/capturedAt', rule: 'CAPTURED_BEFORE_DISPATCH' });
    if ((body.latitude === undefined) !== (body.longitude === undefined)) broken.push({ field: body.latitude === undefined ? '/latitude' : '/longitude', rule: 'POSITION_INCOMPLETE' });
    if (broken.length > 0) throw new DeliveryInvalidError(broken);

    const before = (await this.viewsIn(tx, [delivery]))[0]!;
    const at = this.clock.now();
    const payment =
      collected.isZero()
        ? null
        : await this.driverCash.collectIn(tx, actor, {
            branchId: delivery.branchId,
            driverId: actor.principalId,
            customerId: delivery.customerId,
            orderDocumentId: delivery.orderDocumentId,
            billingDocumentId: delivery.billingDocumentId,
            amountPesewas: collected.pesewas,
            receivedAt: body.capturedAt,
          });
    await this.store.insertAttempt(tx, {
      id: this.nextId(),
      deliveryId: id,
      attemptNo: nextAttemptNo(delivery.attemptCount),
      outcome: 'DELIVERED',
      failureReasonCode: null,
      nextAction: null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      occurredAt: body.capturedAt,
      actorId: actor.principalId,
    });
    const proof: ProofRecord = {
      id: body.id,
      deliveryId: id,
      recipientName: body.recipientName.trim(),
      signatureFileId: body.signatureFileId ?? null,
      photoFileId: body.photoFileId ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      positionAccuracyM: body.positionAccuracyM ?? null,
      codCollectedPesewas: collected.pesewas,
      codVarianceReasonCode: reasonCode,
      codVarianceNote: body.codVarianceNote?.trim() ?? null,
      paymentId: payment?.id ?? null,
      capturedAt: body.capturedAt,
      createdBy: actor.principalId,
    };
    await this.store.insertProof(tx, proof);
    await this.store.markDelivered(tx, id, { collectedPesewas: collected.pesewas, at, actorId: actor.principalId });

    if (payment !== null) {
      const driverName = (await this.principals.refs(tx, [actor.principalId])).get(actor.principalId)?.displayName ?? actor.principalId;
      const cash: CodCollected = {
        proofId: proof.id,
        deliveryId: id,
        paymentId: payment.id,
        driverId: actor.principalId,
        driverName,
        customerId: delivery.customerId,
        branchId: delivery.branchId,
        collectedPesewas: collected.toJsonInteger(),
      };
      await this.events.publish<CodCollected>(tx, { type: COD_COLLECTED, subjectType: 'Delivery', subjectId: id, branchId: delivery.branchId, payload: cash, occurredAt: body.capturedAt });
    }
    const completed: DeliveryCompleted = {
      deliveryId: id,
      deliveryNo: delivery.deliveryNo,
      orderDocumentId: delivery.orderDocumentId,
      billingDocumentId: delivery.billingDocumentId,
      branchId: delivery.branchId,
      driverId: actor.principalId,
      vehicleLocationId: delivery.vehicleLocationId!,
      proofId: proof.id,
      codDuePesewas: json(delivery.codDuePesewas),
      codCollectedPesewas: collected.toJsonInteger(),
      codShortPesewas: codVariance(due, collected).toJsonInteger(),
      codVarianceReasonCode: reasonCode,
      deliveredAt: body.capturedAt.toISOString(),
    };
    await this.events.publish<DeliveryCompleted>(tx, { type: DELIVERY_COMPLETED, subjectType: 'Delivery', subjectId: id, branchId: delivery.branchId, payload: completed, occurredAt: body.capturedAt });
    const after = (await this.viewsIn(tx, await this.store.deliveries(tx, [id])))[0]!;
    await this.audit.record(tx, { module: 'del', action: 'DELIVER', entityType: 'Delivery', entityId: id, branchId: delivery.branchId, before: { ...before }, after: { ...after } });
    return { status: 200, body: after };
  }

  /**
   * markOnTheWay (FR-DEL-007, FR-DEL-012): the caller's own delivery waiting on the van sets off, its time recorded once
   * and the customer told through the outbox (`del.DeliveryOnTheWay`); one already on its way answers as it stands and
   * records nothing; a finished or failed one is refused 422. A delivery on a run that has not started is refused.
   */
  markOnTheWay(actor: Actor | undefined, id: string, body: OnTheWayRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, UPDATE_MINE);
      const claim = await this.idempotency.claim(tx, { operationId: 'markOnTheWay', principalId: actor!.principalId, key, request: { deliveryId: id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeliveryView>;
      const delivery = await this.mineIn(tx, actor, UPDATE_MINE, id, true);
      const judged = judgeOnTheWay(delivery.status);
      if (judged === 'REFUSE') throw invalidState(`delivery ${id}`, delivery.status);
      if (judged === 'RECORD') {
        await this.assertRouteStartedIn(tx, id);
        if (body.occurredAt.getTime() < delivery.dispatchedAt.getTime()) throw new DeliveryInvalidError([{ field: '/occurredAt', rule: 'OCCURRED_BEFORE_DISPATCH' }]);
        const before = (await this.viewsIn(tx, [delivery]))[0]!;
        await this.store.markOnTheWay(tx, id, { at: body.occurredAt, actorId: actor!.principalId });
        const event: DeliveryOnTheWay = {
          deliveryId: id,
          deliveryNo: delivery.deliveryNo,
          orderDocumentId: delivery.orderDocumentId,
          branchId: delivery.branchId,
          driverId: actor!.principalId,
          etaMinutes: body.etaMinutes ?? null,
          occurredAt: body.occurredAt.toISOString(),
        };
        await this.events.publish<DeliveryOnTheWay>(tx, { type: DELIVERY_ON_THE_WAY, subjectType: 'Delivery', subjectId: id, branchId: delivery.branchId, payload: event, occurredAt: body.occurredAt });
        const after = (await this.viewsIn(tx, await this.store.deliveries(tx, [id])))[0]!;
        await this.audit.record(tx, { module: 'del', action: 'ON_THE_WAY', entityType: 'Delivery', entityId: id, branchId: delivery.branchId, before: { ...before }, after: { ...after, etaMinutes: body.etaMinutes ?? null } });
      }
      const response = { status: 200, body: (await this.viewsIn(tx, await this.store.deliveries(tx, [id])))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * recordFailedDelivery (FR-DEL-011): on the caller's own delivery waiting on the van or on its way, an attempt that
   * failed with a DELIVERY_FAILURE reason and what the driver asks next (REATTEMPT or RETURN_TO_STOCK); the delivery is
   * FAILED, the goods stay on the van, and ORD moves the order to DELIVERY_FAILED (`del.DeliveryFailed`), in one
   * transaction. The attempt's id is the device's: sent again it answers the delivery as it stands and records nothing;
   * an id already used for another delivery is refused.
   */
  recordFailure(actor: Actor | undefined, id: string, body: FailureRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, UPDATE_MINE);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordFailedDelivery', principalId: actor!.principalId, key, request: { deliveryId: id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<DeliveryView>;
      const response = await this.failureIn(tx, actor!, id, body);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async failureIn(tx: Transaction, actor: Actor, id: string, body: FailureRequest): Promise<StoredResponse<DeliveryView>> {
    const earlier = await this.store.attemptById(tx, body.id);
    if (earlier !== null && earlier.deliveryId !== id) throw new DeliveryInvalidError([{ field: '/id', rule: 'ID_IN_USE' }]);
    const delivery = await this.mineIn(tx, actor, UPDATE_MINE, id, true);
    if (earlier !== null) return { status: 200, body: (await this.viewsIn(tx, [delivery]))[0]! };
    if (!takesFailure(delivery.status)) throw invalidState(`delivery ${id}`, delivery.status);
    await this.assertRouteStartedIn(tx, id);
    const reason = (await this.refs.reasonCodesIn(tx, [body.failureReasonCode])).get(body.failureReasonCode);
    const broken = judgeFailure({
      reason: reason === undefined ? 'UNKNOWN' : { domain: reason.domain, requiresNote: reason.requiresNote },
      occurredAt: body.occurredAt,
      dispatchedAt: delivery.dispatchedAt,
      latitude: body.latitude,
      longitude: body.longitude,
    });
    if (broken.length > 0) throw new DeliveryInvalidError(broken);

    const before = (await this.viewsIn(tx, [delivery]))[0]!;
    const attemptNo = nextAttemptNo(delivery.attemptCount);
    await this.store.insertAttempt(tx, {
      id: body.id,
      deliveryId: id,
      attemptNo,
      outcome: 'FAILED',
      failureReasonCode: body.failureReasonCode,
      nextAction: body.nextAction,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      occurredAt: body.occurredAt,
      actorId: actor.principalId,
    });
    await this.store.markFailed(tx, id, { at: this.clock.now(), actorId: actor.principalId });
    const failed: DeliveryFailed = {
      deliveryId: id,
      deliveryNo: delivery.deliveryNo,
      orderDocumentId: delivery.orderDocumentId,
      branchId: delivery.branchId,
      driverId: actor.principalId,
      attemptNo,
      failureReasonCode: body.failureReasonCode,
      nextAction: body.nextAction,
      occurredAt: body.occurredAt.toISOString(),
    };
    await this.events.publish<DeliveryFailed>(tx, { type: DELIVERY_FAILED, subjectType: 'Delivery', subjectId: id, branchId: delivery.branchId, payload: failed, occurredAt: body.occurredAt });
    const after = (await this.viewsIn(tx, await this.store.deliveries(tx, [id])))[0]!;
    await this.audit.record(tx, { module: 'del', action: 'FAIL', entityType: 'Delivery', entityId: id, branchId: delivery.branchId, before: { ...before }, after: { ...after, failureReasonCode: body.failureReasonCode, nextAction: body.nextAction } });
    return { status: 200, body: after };
  }

  /** A delivery on a run is acted on at the doorstep only once its run has started (422 ROUTE_NOT_STARTED); one on no run is not held back. */
  private async assertRouteStartedIn(tx: Transaction, id: string): Promise<void> {
    if ((await this.store.routeStatusOf(tx, id)) === 'PLANNED') throw new DeliveryInvalidError([{ field: '', rule: 'ROUTE_NOT_STARTED' }]);
  }

  /**
   * A delivery of the caller's, by its id: the permission first, then the delivery (404 if none), then that it is
   * assigned to the caller (403 otherwise, audited as any refusal; FR-DEL-004). `lock` takes its row lock.
   */
  private async mineIn(tx: Transaction, actor: Actor | undefined, permission: string, id: string, lock: boolean): Promise<DeliveryRecord> {
    await this.authoriser.authorise(tx, actor, permission);
    const found = lock ? await this.store.lock(tx, id) : (await this.store.deliveries(tx, [id]))[0];
    if (found === undefined || found === null) throw new NotFoundError('no such delivery');
    // A driver acts only on their own deliveries, whatever else they hold; an unassigned delivery is nobody's.
    await this.authoriser.authorise(tx, actor, permission, { branchId: found.branchId, owner: { principalId: found.driverId ?? UNASSIGNED, anyPermission: NO_OVERRIDE } });
    return found;
  }

  private async fileIn(tx: Transaction, id: string | undefined, actor: Actor): Promise<ProofFile> {
    if (id === undefined) return null;
    const file: StoredFileRecord | null = await this.files.find(tx, id);
    if (file === null) return 'MISSING';
    return { purpose: file.purpose, ownedByDriver: file.createdBy === actor.principalId, quarantined: QUARANTINED.has(file.scanStatus) };
  }

  private async viewsIn(tx: Transaction, records: readonly DeliveryRecord[]): Promise<DeliveryView[]> {
    if (records.length === 0) return [];
    const zones = await this.storefront.deliveryZonesIn(tx, [...new Set(records.map((r) => r.deliveryZoneId))]);
    const vehicles = await this.refs.locationsIn(tx, records.flatMap((r) => (r.vehicleLocationId === null ? [] : [r.vehicleLocationId])));
    const drivers = await this.principals.refs(tx, records.flatMap((r) => (r.driverId === null ? [] : [r.driverId])));
    const orders = await this.documents.numberedRefs(tx, records.map((r) => r.orderDocumentId));
    const proofs = new Map((await this.store.proofsOf(tx, records.map((r) => r.id))).map((p) => [p.deliveryId, p]));
    return records.map((r) => {
      const zone = zones.get(r.deliveryZoneId);
      const vehicle = r.vehicleLocationId === null ? undefined : vehicles.get(r.vehicleLocationId);
      const proof = proofs.get(r.id);
      return {
        id: r.id,
        deliveryNo: r.deliveryNo,
        status: r.status,
        order: orders.get(r.orderDocumentId) ?? { id: r.orderDocumentId, docType: 'SALES_ORDER', number: null },
        slot: null,
        deliveryZone: { id: r.deliveryZoneId, code: zone?.code ?? '', name: zone?.name ?? '' },
        recipientName: r.recipientName,
        recipientPhone: r.recipientPhoneE164,
        address: r.addressSnapshot,
        latitude: coordinate(r.addressSnapshot['latitude']),
        longitude: coordinate(r.addressSnapshot['longitude']),
        contents: r.contents,
        driver: r.driverId === null ? null : (drivers.get(r.driverId) ?? { id: r.driverId, displayName: r.driverId }),
        vehicle: vehicle === undefined ? null : { id: vehicle.id, code: vehicle.code, name: vehicle.name, kind: vehicle.kind },
        codDuePesewas: json(r.codDuePesewas),
        codCollectedPesewas: r.codCollectedPesewas === null ? null : json(r.codCollectedPesewas),
        attemptCount: r.attemptCount,
        dispatchedAt: r.dispatchedAt.toISOString(),
        deliveredAt: r.deliveredAt?.toISOString() ?? null,
        proof:
          proof === undefined
            ? null
            : {
                id: proof.id,
                recipientName: proof.recipientName,
                signatureFileId: proof.signatureFileId,
                photoFileId: proof.photoFileId,
                latitude: proof.latitude,
                longitude: proof.longitude,
                positionAccuracyM: proof.positionAccuracyM,
                codCollectedPesewas: json(proof.codCollectedPesewas),
                codVarianceReasonCode: proof.codVarianceReasonCode,
                codVarianceNote: proof.codVarianceNote,
                capturedAt: proof.capturedAt.toISOString(),
              },
        deliveryNoteDocumentId: r.deliveryNoteDocumentId,
        currency: 'GHS' as const,
        branchId: r.branchId,
        version: r.version,
      };
    });
  }
}
