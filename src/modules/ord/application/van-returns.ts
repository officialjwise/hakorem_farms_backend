import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { EventEnvelope } from '../../../platform/events/domain-events';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import { DeliveryInvalidError, type Deliveries, type DeliveryReassigned, type DeliveryRescheduled, type DeliveryView, type VanDelivery } from '../../del';
import type { Authoriser } from '../../iam';
import type { Stock, StockAdjustments } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import type { Payments, Refunds } from '../../pay';
import { canMove, type OrderStatus } from '../domain/order';
import { planReturnRefund } from '../domain/order-return';
import { judgeWayOut, type WayOutFacts } from '../domain/van-return';
import type { FulfilmentStore, PickRecord } from './fulfilment-store';
import type { ApprovalPendingView } from './order-reversals';
import type { OrderHeaderRecord, OrderStore } from './order-store';
import type { VanRefundDestination, VanReturnRecord, VanReturnStore } from './van-return-store';

const RETURN = 'del.delivery.return';
const WRITE_OFF = 'del.delivery.write_off';
/** The goods move from the vehicle into the returns hold as any move between two of the branch's own locations. */
const OFF_THE_VEHICLE = 'TRANSFER_INTERNAL';
/** The credit note's reason: a failed delivery whose goods came back or were written off (migration 0321). */
const CREDIT_REASON = 'DELIVERY_RETURNED';
/** The refund's reason, as a completed return's (migration 0198). */
const REFUND_REASON = 'ORDER_RETURNED';
const STOCK_WRITE_OFF_KIND = 'STOCK_WRITE_OFF';
const CREDIT_NOTE_KIND = 'CREDIT_NOTE';

/** The contract's `ReturnToStock`. */
export interface ReturnToStockRequest {
  readonly returnsLocationId: string;
  readonly note: string;
  readonly refundDestination: VanRefundDestination;
}

/** The contract's `DeliveryWriteOff`. */
export interface WriteOffRequest {
  readonly reasonCode: string;
  readonly note: string | null;
  readonly refundDestination: VanRefundDestination;
}

/** IAM's `iam.ApprovalDecided` v1, as this module reads it. */
interface ApprovalDecided {
  readonly kind: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decidedBy: string;
  readonly subjectDocumentId: string;
}

const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const activeOf = (picks: readonly PickRecord[]) => picks.filter((p) => p.withdrawnAt === null);
const staffActor = (principalId: string): Actor => ({ principalId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null });

/**
 * The van's two other ways out (FR-DEL-011; the owner, 2026-11-23: "a run can't be closed while goods remain on the van.
 * Every item is delivered, returned to stock or written off with a reason, and anything unaccounted for goes on the
 * driver variance report"; ADR-0092, A-360). Each takes a FAILED delivery's goods, still the farm's on the vehicle, off
 * it, in one serializable transaction, authorised in the application layer at the delivery's branch (ADR-0035):
 *
 * - `returnDeliveryToStock` (`del.delivery.return`): each dispatched pick moved from the vehicle into the branch's
 *   returns hold, not sellable until inspected (the location kind is never promised or picked from); the delivery
 *   RETURNED; the order RETURNED.
 * - `writeOffDelivery` (`del.delivery.write_off`): INV's adjustment at the vehicle, each pick a loss at cost, with its
 *   reason (`WASTAGE`, or `UNACCOUNTED_ON_VAN` for the driver variance report), through INV's own path and its
 *   `STOCK_WRITE_OFF` approval: below the threshold it posts at once and the delivery is WRITTEN_OFF; at or above it the
 *   goods stay on the van until a different person approves, when the delivery is WRITTEN_OFF in the approval's
 *   transaction (a refusal leaves them aboard). A write-off never takes the van below zero (INV's trigger).
 *
 * Either way the customer is not charged for goods they never received: the whole document is credited through BIL's
 * `CREDIT_NOTE` approval, and once that credit note is issued what the customer paid beyond what the document still asks
 * is asked back through PAY's `REFUND` approval, to the original method or to store credit as the Manager chose, the
 * Manager its maker so neither approval can be theirs (ADR-0066).
 */
export class VanReturns {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: VanReturnStore,
    private readonly orderStore: OrderStore,
    private readonly fulfilments: FulfilmentStore,
    private readonly refs: MasterDataRefs,
    private readonly stock: Stock,
    private readonly adjustments: StockAdjustments,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly refunds: Refunds,
    private readonly deliveries: Deliveries,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** returnDeliveryToStock (FR-DEL-011): a failed delivery's goods from the vehicle into the returns hold, the document credited. */
  returnToStock(actor: Actor | undefined, id: string, body: ReturnToStockRequest, key: string): Promise<StoredResponse<DeliveryView>> {
    return this.command(actor, RETURN, 'returnDeliveryToStock', id, body, key, async (tx, delivery, header) => {
      const location = (await this.refs.locationsIn(tx, [body.returnsLocationId])).get(body.returnsLocationId);
      await this.judge(tx, delivery, header, {
        wayOut: 'RETURN_TO_STOCK',
        returnsLocation: location === undefined ? 'MISSING' : { kind: location.isVirtual ? 'VIRTUAL' : location.kind, branchId: location.branchId, isLive: location.isLive },
        reason: null,
        note: body.note,
        refundDestination: body.refundDestination,
      });
      const at = this.clock.now();
      const actorId = actor!.principalId;
      for (const { pick, productId } of await this.picksOf(tx, header.id)) {
        await this.stock.postIn(tx, actorId, {
          movementType: OFF_THE_VEHICLE,
          productId,
          stockUnitId: pick.stockUnitId,
          branchId: delivery.branchId,
          fromLocationId: delivery.vehicleLocationId!,
          toLocationId: body.returnsLocationId,
          qty: Quantity.parse(pick.qtyBase),
          weight: pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! },
          sourceDocumentId: delivery.id,
          sourceLineRef: pick.id,
          occurredAt: at,
        });
      }
      const view = await this.deliveries.returnedIn(tx, actorId, delivery.id, body.returnsLocationId, at);
      await this.postIn(tx, actor!, delivery, header, { wayOut: 'RETURN_TO_STOCK', returnsLocationId: body.returnsLocationId, reasonCode: null, stockAdjustmentId: null, note: body.note, refundDestination: body.refundDestination }, at);
      return { status: 200, body: view };
    });
  }

  /** writeOffDelivery (FR-DEL-011): a failed delivery's goods written off the van with a reason, through INV's adjustment and its approval. */
  writeOff(actor: Actor | undefined, id: string, body: WriteOffRequest, key: string): Promise<StoredResponse<DeliveryView | ApprovalPendingView>> {
    return this.command<DeliveryView | ApprovalPendingView>(actor, WRITE_OFF, 'writeOffDelivery', id, body, key, async (tx, delivery, header) => {
      const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
      await this.judge(tx, delivery, header, {
        wayOut: 'WRITE_OFF',
        returnsLocation: null,
        reason: reason === undefined ? 'UNKNOWN' : { code: reason.code, domain: reason.domain, requiresNote: reason.requiresNote },
        note: body.note,
        refundDestination: body.refundDestination,
      });
      const picks = await this.picksOf(tx, header.id);
      const drafted = await this.adjustments.createIn(tx, actor!, {
        locationId: delivery.vehicleLocationId!,
        reasonCode: body.reasonCode,
        note: body.note ?? undefined,
        lines: picks.map(({ pick, productId }) => ({ productId, stockUnitId: pick.stockUnitId ?? undefined, direction: 'LOSS' as const, qty: pick.qtyBase, weightKg: pick.weightKg ?? undefined })),
      });
      const submitted = await this.adjustments.submitIn(tx, actor!, drafted.id);
      const asked = { wayOut: 'WRITE_OFF' as const, returnsLocationId: null, reasonCode: body.reasonCode, stockAdjustmentId: drafted.id, note: body.note, refundDestination: body.refundDestination };
      const at = this.clock.now();
      if (submitted.status === 202) {
        await this.store.insertPending(tx, { id: this.nextId(), deliveryId: delivery.id, salesOrderId: header.id, originalBillingDocumentId: delivery.billingDocumentId, branchId: delivery.branchId, createdBy: actor!.principalId, at, ...asked });
        await this.audit.record(tx, { module: 'ord', action: 'WRITE_OFF_REQUEST', entityType: 'SalesOrder', entityId: header.id, branchId: header.branchId, before: null, after: { deliveryId: delivery.id, stockAdjustmentId: drafted.id, reasonCode: body.reasonCode } });
        return { status: 202, body: submitted.body as ApprovalPendingView };
      }
      const view = await this.writtenOffIn(tx, actor!.principalId, delivery, drafted.id, body.reasonCode, at);
      await this.postIn(tx, actor!, delivery, header, asked, at);
      return { status: 200, body: view };
    });
  }

  /**
   * `iam.ApprovalDecided`, in the approval's transaction (ADR-0010): a van write-off's `STOCK_WRITE_OFF` approved (INV has
   * just posted the loss) makes the delivery WRITTEN_OFF, the order RETURNED and the credit note asked for; refused, the
   * goods are still on the van and the write-off is REJECTED. A van return's `CREDIT_NOTE` approved (BIL has just issued
   * it) asks for the refund of what the customer paid. Any other decision is not this module's.
   */
  async decidedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const decided = event.payload as unknown as ApprovalDecided;
    if (decided.kind === STOCK_WRITE_OFF_KIND) {
      const record = await this.store.ofAdjustment(tx, decided.subjectDocumentId);
      if (record === null || record.status !== 'PENDING_APPROVAL') return;
      const at = this.clock.now();
      if (decided.decision !== 'APPROVED') {
        await this.store.reject(tx, record.id, { at, actorId: decided.decidedBy });
        await this.audit.record(tx, { module: 'ord', action: 'WRITE_OFF_REJECTED', entityType: 'SalesOrder', entityId: record.salesOrderId, branchId: record.branchId, before: { status: 'PENDING_APPROVAL' }, after: { status: 'REJECTED', deliveryId: record.deliveryId } });
        return;
      }
      const delivery = (await this.deliveries.vanDeliveryIn(tx, record.deliveryId))!;
      const header = (await this.orderStore.lock(tx, record.salesOrderId))!;
      await this.writtenOffIn(tx, decided.decidedBy, delivery, record.stockAdjustmentId!, record.reasonCode!, at);
      // The credit note and the refund are the write-off's maker's, as they would have been had it posted at once.
      await this.postIn(tx, staffActor(record.createdBy), delivery, header, record, at, record.id);
      return;
    }
    if (decided.kind === CREDIT_NOTE_KIND && decided.decision === 'APPROVED') {
      const record = await this.store.ofCreditNote(tx, decided.subjectDocumentId);
      if (record === null || record.refundId !== null) return;
      await this.refundIn(tx, record, this.clock.now());
    }
  }

  /**
   * `del.DeliveryReassigned`, in DEL's transaction (FR-DEL-004, A-362): when the vehicle changed, each dispatched pick
   * moves from the one van to the other (`TRANSFER_INTERNAL`, still the farm's; INV's trigger refuses a van below zero),
   * so the goods follow the delivery. Refused while a write-off of the same goods waits for its approval: that adjustment
   * names the first van.
   */
  async reassignedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const moved = event.payload as unknown as DeliveryReassigned;
    await this.assertNoPendingWriteOff(tx, moved.deliveryId);
    if (moved.fromVehicleLocationId === moved.toVehicleLocationId || moved.fromVehicleLocationId === null) return;
    const header = await this.orderStore.lock(tx, moved.orderDocumentId);
    if (header === null) return;
    const at = new Date(moved.reassignedAt);
    const picks = await this.picksOf(tx, header.id);
    for (const { pick, productId } of picks) {
      await this.stock.postIn(tx, event.actorId, {
        movementType: OFF_THE_VEHICLE,
        productId,
        stockUnitId: pick.stockUnitId,
        branchId: moved.branchId,
        fromLocationId: moved.fromVehicleLocationId,
        toLocationId: moved.toVehicleLocationId,
        qty: Quantity.parse(pick.qtyBase),
        weight: pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! },
        sourceDocumentId: moved.deliveryId,
        sourceLineRef: pick.id,
        occurredAt: at,
      });
    }
    await this.audit.record(tx, {
      module: 'ord',
      action: 'VAN_TO_VAN',
      entityType: 'SalesOrder',
      entityId: header.id,
      branchId: header.branchId,
      before: { vehicleLocationId: moved.fromVehicleLocationId },
      after: { vehicleLocationId: moved.toVehicleLocationId, deliveryId: moved.deliveryId, picks: picks.map((p) => p.pick.id) },
    });
  }

  /**
   * `del.DeliveryRescheduled`, in DEL's transaction (FR-DEL-011, A-362): a reattempt moves the order DELIVERY_FAILED back
   * to DISPATCHED (the goods never left the van). Refused while a write-off of the same goods waits for its approval.
   */
  async rescheduledIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const moved = event.payload as unknown as DeliveryRescheduled;
    if (!moved.reattempt) return;
    await this.assertNoPendingWriteOff(tx, moved.deliveryId);
    const header = await this.orderStore.lock(tx, moved.orderDocumentId);
    if (header === null) return;
    if (header.status !== 'DELIVERY_FAILED') throw invalidState(`order ${header.id}`, header.status);
    await this.moveIn(tx, header, 'DISPATCHED', `Reattempt of ${moved.deliveryNo} on ${moved.slotDate} ${moved.slotStartsAt}: ${moved.reason}`, new Date(moved.rescheduledAt), event.actorId);
    await this.audit.record(tx, { module: 'ord', action: 'REATTEMPT', entityType: 'SalesOrder', entityId: header.id, branchId: header.branchId, before: { status: 'DELIVERY_FAILED' }, after: { status: 'DISPATCHED', deliveryId: moved.deliveryId, slotId: moved.toSlotId } });
  }

  private async assertNoPendingWriteOff(tx: Transaction, deliveryId: string): Promise<void> {
    if ((await this.store.liveOfDelivery(tx, deliveryId))?.status === 'PENDING_APPROVAL') throw new DeliveryInvalidError([{ field: '', rule: 'WRITE_OFF_PENDING' }]);
  }

  /** The command's frame: the permission, the key, the delivery and its order under their locks, at the delivery's branch. */
  private command<R>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    id: string,
    body: object,
    key: string,
    work: (tx: Transaction, delivery: VanDelivery, header: OrderHeaderRecord) => Promise<StoredResponse<R>>,
  ): Promise<StoredResponse<R>> {
    return this.uow
      .run({ isolation: 'read committed' }, async (tx) => (await this.deliveries.vanDeliveryIn(tx, id))?.branchId ?? null)
      .then((branchId) =>
        this.uow.run({ isolation: 'serializable', seriesLocks: branchId === null ? [] : this.billing.seriesLocksFor('CREDIT_NOTE', branchId) }, async (tx) => {
          await this.authoriser.authorise(tx, actor, permission);
          const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { id, ...body } });
          if (claim.kind === 'REPLAY') return claim.response as StoredResponse<R>;
          const delivery = await this.deliveries.vanDeliveryIn(tx, id);
          if (delivery === null) throw new NotFoundError('no such delivery');
          await this.authoriser.authorise(tx, actor, permission, { branchId: delivery.branchId });
          const header = await this.orderStore.lock(tx, delivery.orderDocumentId);
          if (header === null) throw new NotFoundError('no such order');
          const response = await work(tx, delivery, header);
          await this.idempotency.complete(tx, claim.id, response);
          return response;
        }),
      );
  }

  private async judge(tx: Transaction, delivery: VanDelivery, header: OrderHeaderRecord, asked: Omit<WayOutFacts, 'deliveryStatus' | 'pendingWriteOff' | 'branchId' | 'hasCustomer'>): Promise<void> {
    const pending = (await this.store.liveOfDelivery(tx, delivery.id))?.status === 'PENDING_APPROVAL';
    const broken = judgeWayOut({ ...asked, deliveryStatus: delivery.status, pendingWriteOff: pending, branchId: delivery.branchId, hasCustomer: header.customerId !== null });
    if (broken.some((b) => b.rule === 'INVALID_STATE_TRANSITION')) throw invalidState(`delivery ${delivery.id}`, delivery.status);
    if (broken.length > 0) throw new DeliveryInvalidError(broken);
    if (header.status !== 'DELIVERY_FAILED') throw invalidState(`order ${header.id}`, header.status);
  }

  /** Each pick dispatched onto the vehicle for the order, with its product. */
  private async picksOf(tx: Transaction, orderId: string): Promise<{ readonly pick: PickRecord; readonly productId: string }[]> {
    const order = (await this.orderStore.orders(tx, [orderId]))[0]!;
    const lists = (await this.fulfilments.fulfilments(tx, (await this.fulfilments.ofOrders(tx, [orderId])).map((x) => x.id))).filter((x) => x.status === 'DISPATCHED');
    return lists.flatMap((x) => activeOf(x.picks)).map((pick) => ({ pick, productId: order.lines.find((l) => l.id === pick.salesOrderLineId)!.productId }));
  }

  /** The delivery WRITTEN_OFF at the posted adjustment's value at cost. */
  private async writtenOffIn(tx: Transaction, actorId: string, delivery: VanDelivery, stockAdjustmentId: string, reasonCode: string, at: Date): Promise<DeliveryView> {
    const adjustment = (await this.adjustments.viewIn(tx, stockAdjustmentId))!;
    if (adjustment.status !== 'POSTED') throw new Error(`stock adjustment ${stockAdjustmentId} is ${adjustment.status}, not POSTED`);
    return this.deliveries.writtenOffIn(tx, actorId, delivery.id, { reasonCode, valuePesewas: Money.fromJsonInteger(adjustment.totalValuePesewas).pesewas, stockAdjustmentId }, at);
  }

  /**
   * The goods are off the van: the order RETURNED, the whole document's credit note asked for, the way out recorded
   * POSTED with it (or a pending write-off posted), and, when the credit note was issued at once, the refund asked for.
   */
  private async postIn(
    tx: Transaction,
    maker: Actor,
    delivery: VanDelivery,
    header: OrderHeaderRecord,
    asked: Pick<VanReturnRecord, 'wayOut' | 'returnsLocationId' | 'reasonCode' | 'stockAdjustmentId' | 'note' | 'refundDestination'>,
    at: Date,
    pendingId?: string,
  ): Promise<void> {
    await this.moveIn(tx, header, 'RETURNED', asked.wayOut === 'RETURN_TO_STOCK' ? `Returned to stock from ${delivery.deliveryNo}` : `Written off ${delivery.deliveryNo} (${asked.reasonCode!})`, at, maker.principalId);
    const credit = await this.billing.requestWholeCreditIn(tx, maker, delivery.billingDocumentId, { reasonCode: CREDIT_REASON, note: asked.note ?? undefined });
    const id = pendingId ?? this.nextId();
    if (pendingId === undefined) {
      await this.store.insertPosted(tx, { id, deliveryId: delivery.id, salesOrderId: header.id, originalBillingDocumentId: delivery.billingDocumentId, branchId: delivery.branchId, createdBy: maker.principalId, at, creditNoteId: credit.creditNoteId, ...asked });
    } else {
      await this.store.post(tx, id, { creditNoteId: credit.creditNoteId, at, actorId: maker.principalId });
    }
    const record = (await this.store.ofCreditNote(tx, credit.creditNoteId))!;
    if (credit.approvalRequestId === null) await this.refundIn(tx, record, at);
    await this.audit.record(tx, {
      module: 'ord',
      action: asked.wayOut,
      entityType: 'SalesOrder',
      entityId: header.id,
      branchId: header.branchId,
      before: { status: 'DELIVERY_FAILED' },
      after: { status: 'RETURNED', deliveryId: delivery.id, creditNoteId: credit.creditNoteId, creditPesewas: Money.ofPesewas(credit.grossPesewas).toJsonInteger(), creditApprovalRequestId: credit.approvalRequestId, ...asked },
    });
  }

  /** What the customer paid beyond what the credited document still asks, asked back against the credit note, once. */
  private async refundIn(tx: Transaction, record: VanReturnRecord, at: Date): Promise<void> {
    const [credit] = await this.billing.viewsIn(tx, [record.creditNoteId!]);
    const original = (await this.billing.settleableIn(tx, [record.originalBillingDocumentId])).get(record.originalBillingDocumentId)!;
    const plan = planReturnRefund(Money.fromJsonInteger(credit!.grossPesewas), Money.ofPesewas(original.refundablePesewas), await this.payments.ofOrderIn(tx, record.salesOrderId));
    if (plan === null) return;
    const asked = await this.refunds.requestIn(tx, staffActor(record.createdBy), {
      originalPaymentId: plan.paymentId,
      amountPesewas: plan.amount.pesewas,
      destination: record.refundDestination,
      reasonCode: REFUND_REASON,
      creditNoteId: record.creditNoteId,
      note: `Delivery ${record.wayOut === 'RETURN_TO_STOCK' ? 'returned to stock' : 'written off'}`,
    });
    await this.store.setRefund(tx, record.id, { refundId: asked.subject.id, at, actorId: record.createdBy });
  }

  private async moveIn(tx: Transaction, header: OrderHeaderRecord, to: OrderStatus, reason: string, at: Date, actorId: string): Promise<void> {
    const from = (await this.orderStore.lock(tx, header.id))!.status;
    if (!canMove(from, to)) throw invalidState(`order ${header.id}`, from);
    await this.fulfilments.moveOrder(tx, header.id, to, at, actorId);
    await this.orderStore.recordStatus(tx, header.id, { id: this.nextId(), fromStatus: from, toStatus: to, reason, occurredAt: at, actorId });
  }
}
