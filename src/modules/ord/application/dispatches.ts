import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing, IssueLineRequest } from '../../bil';
import { DeliveryInvalidError, type ContentsLine, type Deliveries, type DeliveryCompleted, type DeliveryFailed } from '../../del';
import type { Authoriser } from '../../iam';
import type { Reservations, Stock, StockUnits } from '../../inv';
import type { MasterDataRefs, Storefront } from '../../mdm';
import type { Payments, Refunds } from '../../pay';
import { backorderLines, feesAtDispatch, judgeExtraDeliveryFee, planSettlement, type FeeAtDispatch } from '../domain/dispatch';
import { canMove, type OrderStatus } from '../domain/order';
import type { OrderCollected, OrderDelivered, OrderDispatched } from '../events';
import { FulfilmentInvalidError, OrderInvalidError, type SaleRule } from './errors';
import type { FulfilmentStore, PickRecord } from './fulfilment-store';
import type { Fulfilments, FulfilmentView } from './fulfilments';
import type { OrderHeaderRecord, OrderLineRecord, OrderStore } from './order-store';
import type { Orders } from './orders';
import type { VanReturns } from './van-returns';

const DISPATCH = 'ord.fulfilment.dispatch';
/** An extra delivery the customer asked for (the owner, 2026-11-23): its own permission, the Manager's and the Owner's. */
const ADD_FEE = 'ord.delivery_fee.add';
/** A backorder still to be sent: what the order's deposits hold beyond its documents stays held for it (FR-ORD-012). */
const BEFORE_DISPATCH: ReadonlySet<OrderStatus> = new Set(['PLACED', 'CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED']);
export const ORDER_DISPATCHED = 'ord.OrderDispatched';
export const ORDER_DELIVERED = 'ord.OrderDelivered';
export const ORDER_COLLECTED = 'ord.OrderCollected';
/** Dispatch moves the picked goods onto the vehicle; they stay the farm's until delivered (FR-DEL-005, A-337). */
const ONTO_VEHICLE = 'TRANSFER_INTERNAL';
/** Delivered, they are issued for the sale from the vehicle (FR-DEL-008). */
const SALE_ISSUE = 'SALE_ISSUE';
/** ADR-0021: what was paid beyond the weighed total is asked back to the original method with this reason (migration 0302). */
const WEIGHED_BELOW_PAID = 'WEIGHED_BELOW_PAID';
/** What a part delivery's customer did not keep goes back from the vehicle into the returns hold (CR-055). */
const BACK_FROM_VEHICLE = 'TRANSFER_INTERNAL';

const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const activeOf = (picks: readonly PickRecord[]) => picks.filter((p) => p.withdrawnAt === null);
const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

export interface ExtraDeliveryFeeView {
  readonly id: string;
  readonly order: { readonly id: string; readonly docType: 'SALES_ORDER'; readonly number: string | null };
  readonly amountPesewas: number;
  readonly currency: 'GHS';
  readonly note: string;
  readonly addedAt: string;
}

export interface DispatchRequest {
  readonly driverId?: string | undefined;
  readonly vehicleLocationId?: string | undefined;
}

/** What a delivery address snapshot (SHP's checkout) carries that a delivery needs. */
interface AddressFields {
  readonly recipientName?: unknown;
  readonly recipientPhone?: unknown;
}

/**
 * Dispatch (FR-ORD-011, FR-BIL-005, FR-DEL-003, ADR-0021, ADR-0091, A-337 to A-341): `dispatchFulfilment` sends a packed
 * delivery order onto a vehicle with its driver, in one serializable transaction: the billing document is issued on the
 * weighed quantity with the delivery fee (once: an order is dispatched once in this part, A-331 (b)); the order's
 * deposits are allocated to it, oldest first, what they hold beyond it asked back (`WEIGHED_BELOW_PAID`) and what they do
 * not cover fixed as the cash due on delivery; the order's reservations end and each pick moves from the pick location
 * onto the vehicle (never below zero online, never another's promised stock: INV's trigger refuses it, ADR-0081); DEL's
 * delivery is made from the snapshot, and `ord.OrderDispatched` (the customer's message, through the outbox) is
 * published. When DEL records the proof (`del.DeliveryCompleted`, in DEL's transaction) each pick is issued for the sale
 * from the vehicle and the order moves to DELIVERED, then COMPLETED when nothing is left to pay. Authorised in the
 * application layer at the pick list's branch (ADR-0035): `ord.fulfilment.dispatch`.
 */
export class Dispatches {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: FulfilmentStore,
    private readonly orderStore: OrderStore,
    private readonly fulfilments: Fulfilments,
    private readonly refs: MasterDataRefs,
    private readonly storefront: Storefront,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly reservations: Reservations,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly refunds: Refunds,
    private readonly deliveries: Deliveries,
    private readonly vanReturns: VanReturns,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
    private readonly orders: Orders,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * addExtraDeliveryFee (the owner, 2026-11-23, A-331 (b)): an extra delivery the customer asked for, charged as its own
   * fee line on the dispatch of a backorder, never inferred from a second dispatch. Only by staff holding
   * `ord.delivery_fee.add` at the order's branch; only on a delivery backorder not yet dispatched, once, at its zone's own
   * fee (staff never type the amount). Audited; the database holds the same rules (`ck_order_extra_fee_order`).
   */
  addExtraFee(actor: Actor | undefined, orderId: string, body: { readonly note: string }, key: string): Promise<StoredResponse<ExtraDeliveryFeeView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ADD_FEE);
      const claim = await this.idempotency.claim(tx, { operationId: 'addExtraDeliveryFee', principalId: actor!.principalId, key, request: { orderId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ExtraDeliveryFeeView>;
      const header = await this.orderStore.lock(tx, orderId);
      if (header === null) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, ADD_FEE, { branchId: header.branchId });
      const zone = header.deliveryZoneId === null ? undefined : (await this.storefront.deliveryZonesIn(tx, [header.deliveryZoneId])).get(header.deliveryZoneId);
      const judged = judgeExtraDeliveryFee({
        fulfilmentMode: header.fulfilmentMode,
        isBackorder: header.parentOrderId !== null,
        status: header.status,
        alreadyAdded: (await this.orderStore.extraFeesOf(tx, [orderId])).length > 0,
        zoneFeePesewas: zone?.feePesewas ?? 0n,
      });
      if (!judged.ok) throw new OrderInvalidError([{ field: judged.error === 'NOT_BEFORE_DISPATCH' ? '/status' : '', rule: judged.error }]);
      const at = this.clock.now();
      const fee = { id: this.nextId(), salesOrderId: orderId, deliveryZoneId: header.deliveryZoneId!, amountPesewas: judged.value, note: body.note, branchId: header.branchId, actorId: actor!.principalId };
      await this.orderStore.insertExtraFee(tx, fee);
      const view: ExtraDeliveryFeeView = { id: fee.id, order: { id: orderId, docType: 'SALES_ORDER', number: header.orderNo }, amountPesewas: json(fee.amountPesewas), currency: 'GHS', note: fee.note, addedAt: at.toISOString() };
      await this.audit.record(tx, { module: 'ord', action: 'ADD_EXTRA_DELIVERY_FEE', entityType: 'SalesOrder', entityId: orderId, branchId: header.branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  dispatch(actor: Actor | undefined, id: string, body: DispatchRequest, key: string): Promise<StoredResponse<FulfilmentView>> {
    return this.uow
      .run({ isolation: 'read committed' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, DISPATCH);
        const [found] = await this.store.fulfilments(tx, [id]);
        if (found === undefined) throw new NotFoundError('no such pick list');
        await this.authoriser.authorise(tx, actor, DISPATCH, { branchId: found.branchId });
        return found.branchId;
      })
      .then((branchId) =>
        this.uow.run(
          {
            isolation: 'serializable',
            seriesLocks: [
              ...this.billing.seriesLocksFor('INVOICE', branchId),
              ...this.billing.seriesLocksFor('RECEIPT', branchId),
              ...this.deliveries.locksFor(branchId),
              ...this.orders.locksFor(branchId),
            ],
          },
          (tx) => this.dispatchIn(tx, actor, id, body, key),
        ),
      );
  }

  private async dispatchIn(tx: Transaction, actor: Actor | undefined, id: string, body: DispatchRequest, key: string): Promise<StoredResponse<FulfilmentView>> {
    await this.authoriser.authorise(tx, actor, DISPATCH);
    const claim = await this.idempotency.claim(tx, { operationId: 'dispatchFulfilment', principalId: actor!.principalId, key, request: { id, ...body } });
    if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
    const f = await this.store.lock(tx, id);
    if (f === null) throw new NotFoundError('no such pick list');
    await this.authoriser.authorise(tx, actor, DISPATCH, { branchId: f.branchId });
    if (f.status !== 'PACKED') throw invalidState(`pick list ${id}`, f.status);
    const header = await this.orderStore.lock(tx, f.salesOrderId);
    if (header === null) throw new NotFoundError('no such order');
    if (header.status !== 'PACKED') throw invalidState(`order ${header.id}`, header.status);
    const address = (header.deliveryAddressSnapshot ?? null) as (AddressFields & Record<string, unknown>) | null;

    const broken: SaleRule[] = [];
    if (header.fulfilmentMode !== 'DELIVERY') broken.push({ field: '', rule: 'NOT_A_DELIVERY' });
    // An order on account takes its due date from the customer's terms (WHL); its dispatch is B11 continued 2's (A-341).
    if (header.paymentTerms === 'CREDIT') broken.push({ field: '', rule: 'CREDIT_DISPATCH_NOT_AVAILABLE' });
    if (header.fulfilmentMode === 'DELIVERY' && (header.deliveryZoneId === null || address === null || typeof address.recipientName !== 'string' || typeof address.recipientPhone !== 'string')) {
      broken.push({ field: '', rule: 'DELIVERY_ADDRESS_REQUIRED' });
    }
    if (body.driverId === undefined) broken.push({ field: '/driverId', rule: 'DRIVER_REQUIRED' });
    if (body.vehicleLocationId === undefined) broken.push({ field: '/vehicleLocationId', rule: 'VEHICLE_REQUIRED' });
    if (broken.length > 0) throw new FulfilmentInvalidError(broken);
    await this.deliveries.assertAssignableIn(tx, header.branchId, body.driverId!, body.vehicleLocationId!);

    const at = this.clock.now();
    const actorId = actor!.principalId;
    const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
    // Every packed pick list of the order goes on the one dispatch; an order with lines still unpacked is not PACKED.
    const lists = (await this.store.fulfilments(tx, (await this.store.ofOrders(tx, [header.id])).map((x) => x.id))).filter((x) => x.status === 'PACKED');
    const picks = lists.flatMap((x) => activeOf(x.picks).map((p) => ({ pick: p, list: x })));
    const open = order.lines.filter((l) => l.lineStatus === 'OPEN');
    // A line back-ordered whole sends nothing now (FR-ORD-012); the rest of a short line goes on the backorder.
    const sent = open.filter((l) => !Quantity.parse(l.qtyFulfilled).isZero());
    const backorder = backorderLines(open);
    const rootId = header.parentOrderId ?? header.id;
    const before = await this.fulfilments.viewIn(tx, id);
    const fees = feesAtDispatch({ deliveryFeePesewas: header.deliveryFeePesewas, isBackorder: header.parentOrderId !== null, extraFees: await this.orderStore.extraFeesOf(tx, [header.id]) });

    // The billing document on the weighed quantity (FR-BIL-005), with the delivery fee once (A-331 (b)) and an extra
    // delivery the customer asked for as its own line.
    const document = await this.billing.issueIn(tx, actor, {
      kind: header.customerId === null ? 'RECEIPT' : 'INVOICE',
      branchId: header.branchId,
      customerId: header.customerId,
      orderDocumentId: header.id,
      taxInclusive: header.taxInclusive,
      occurredAt: at,
      lines: [...(await this.billedLines(tx, sent, picks.map((p) => p.pick), at)), ...(await this.feeLines(tx, fees))],
    });
    const gross = Money.fromJsonInteger(document.grossPesewas);

    // The deposits applied oldest first, what is left due on delivery (ADR-0021); what they hold beyond the document is
    // refunded, unless a backorder of the order is still to be sent: then it stays held for it (FR-ORD-012). The
    // deposits of a backorder are its first order's.
    const paid = (await this.payments.ofOrderIn(tx, rootId)).filter((p) => p.status === 'CLEARED');
    const waiting = (await this.orderStore.backordersOf(tx, rootId)).some((b) => b.id !== header.id && BEFORE_DISPATCH.has(b.status));
    const settlement = planSettlement(
      gross,
      paid.map((p) => ({ paymentId: p.id, unallocated: Money.fromJsonInteger(p.unallocatedPesewas) })),
      { holdForBackorder: backorder.length > 0 || waiting },
    );
    for (const a of settlement.allocations) await this.payments.allocateIn(tx, actor!, a.paymentId, [{ billingDocumentId: document.id, amountPesewas: a.amount.pesewas }]);
    const refundIds: string[] = [];
    for (const r of settlement.refunds) {
      const asked = await this.refunds.requestIn(tx, actor!, {
        originalPaymentId: r.paymentId,
        amountPesewas: r.amount.pesewas,
        destination: 'ORIGINAL_METHOD',
        reasonCode: WEIGHED_BELOW_PAID,
        creditNoteId: null,
        note: `Order ${header.orderNo!} weighed at ${document.documentNo ?? document.id}`,
      });
      refundIds.push(asked.subject.id);
    }

    // The goods move from where they were picked onto the vehicle, once each; the order's promises end with them.
    await this.reservations.releaseHeldByIn(tx, actorId, header.id, `Order ${header.orderNo!} dispatched`);
    for (const { pick, list } of picks) {
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: ONTO_VEHICLE,
        productId: order.lines.find((l) => l.id === pick.salesOrderLineId)!.productId,
        stockUnitId: pick.stockUnitId,
        branchId: header.branchId,
        fromLocationId: list.pickLocationId,
        toLocationId: body.vehicleLocationId!,
        qty: Quantity.parse(pick.qtyBase),
        weight: pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! },
        sourceDocumentId: list.id,
        sourceLineRef: pick.id,
        occurredAt: at,
      });
      await this.store.setPickMovement(tx, pick.id, posted.id, at, actorId);
    }
    for (const line of open) {
      const back = backorder.find((b) => b.fromLineId === line.id);
      await this.store.fixLine(tx, line.id, back !== undefined ? back.status : Quantity.parse(line.qtyFulfilled).compareTo(Quantity.parse(line.qtyOrdered)) < 0 && line.priceBasis !== 'PER_KG' ? 'PARTIAL' : 'FULFILLED');
    }
    for (const list of lists) await this.store.dispatch(tx, list.id, { at, actorId });
    await this.store.invoiceOrder(tx, header.id, { billingDocumentId: document.id, finalTotalPesewas: gross.pesewas, at, actorId });
    const backordered = backorder.length === 0 ? null : await this.orders.backorderIn(tx, actor!, order, backorder, at);

    const delivery = await this.deliveries.scheduleIn(tx, actor!, {
      orderDocumentId: header.id,
      billingDocumentId: document.id,
      customerId: header.customerId,
      branchId: header.branchId,
      deliveryZoneId: header.deliveryZoneId!,
      recipientName: address!.recipientName as string,
      recipientPhoneE164: address!.recipientPhone as string,
      address: address!,
      contents: await this.contentsOf(tx, sent),
      driverId: body.driverId!,
      vehicleLocationId: body.vehicleLocationId!,
      codDuePesewas: settlement.due.pesewas,
      dispatchedAt: at,
    });
    await this.moveIn(tx, header, 'DISPATCHED', `Dispatched on ${delivery.deliveryNo!}`, at, actorId);

    const dispatched: OrderDispatched = {
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      contactPhone: header.contactPhone ?? (address!.recipientPhone as string),
      billingDocumentId: document.id,
      billingDocumentNo: document.documentNo ?? '',
      finalTotalPesewas: gross.toJsonInteger(),
      allocatedPesewas: Money.sum(settlement.allocations.map((a) => a.amount)).toJsonInteger(),
      refundRequestedPesewas: Money.sum(settlement.refunds.map((r) => r.amount)).toJsonInteger(),
      codDuePesewas: settlement.due.toJsonInteger(),
      deliveryId: delivery.id,
      deliveryNo: delivery.deliveryNo!,
      lines: delivery.contents.map((c) => ({ orderLineId: c.orderLineId, name: c.name, quantity: c.quantity, uom: c.uom, weightKg: c.weightKg })),
      backorderId: backordered?.id ?? null,
      backorderNo: backordered?.orderNo ?? null,
      dispatchedAt: at.toISOString(),
    };
    await this.events.publish<OrderDispatched>(tx, { type: ORDER_DISPATCHED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: dispatched, occurredAt: at });
    const view = await this.fulfilments.viewIn(tx, id);
    await this.audit.record(tx, {
      module: 'ord',
      action: 'DISPATCH',
      entityType: 'Fulfilment',
      entityId: id,
      branchId: f.branchId,
      before: { ...before },
      after: { ...view, billingDocumentId: document.id, deliveryId: delivery.id, codDuePesewas: settlement.due.toJsonInteger(), refundIds, backorderId: backordered?.id ?? null, fees: fees.map((f) => ({ ...f, amountPesewas: json(f.amountPesewas) })) },
    });
    const response = { status: 200, body: view };
    await this.idempotency.complete(tx, claim.id, response);
    return response;
  }

  /**
   * collectFulfilment (FR-ORD-011, B11 continued 7): a packed collection order handed to the customer, in one serializable
   * transaction: the billing document on the weighed quantity (an `INVOICE` for a customer with an account, a `RECEIPT`
   * for a guest), the order's deposits allocated oldest first (what they hold beyond it refunded, unless a backorder of it
   * is still to be sent), each pick issued for the sale from where it was picked to the customer (never below zero
   * online), the order's reservations ended, a short line's rest back-ordered (FR-ORD-012), the pick lists `COLLECTED`
   * and the order `READY_FOR_COLLECTION`. Nothing left to pay completes it at once; what is left is **paid at the till**
   * (`payInvoiceAtTill`, a guest's receipt included) and the order completes when its document is settled (BL-097). An
   * order on account is B11 continued 8's (`CREDIT_DISPATCH_NOT_AVAILABLE`). `ord.fulfilment.dispatch` at the branch.
   */
  collect(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<FulfilmentView>> {
    return this.uow
      .run({ isolation: 'read committed' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, DISPATCH);
        const [found] = await this.store.fulfilments(tx, [id]);
        if (found === undefined) throw new NotFoundError('no such pick list');
        await this.authoriser.authorise(tx, actor, DISPATCH, { branchId: found.branchId });
        return found.branchId;
      })
      .then((branchId) =>
        this.uow.run(
          { isolation: 'serializable', seriesLocks: [...this.billing.seriesLocksFor('INVOICE', branchId), ...this.billing.seriesLocksFor('RECEIPT', branchId), ...this.orders.locksFor(branchId)] },
          (tx) => this.collectIn(tx, actor, id, key),
        ),
      );
  }

  private async collectIn(tx: Transaction, actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<FulfilmentView>> {
    await this.authoriser.authorise(tx, actor, DISPATCH);
    const claim = await this.idempotency.claim(tx, { operationId: 'collectFulfilment', principalId: actor!.principalId, key, request: { id } });
    if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
    const f = await this.store.lock(tx, id);
    if (f === null) throw new NotFoundError('no such pick list');
    await this.authoriser.authorise(tx, actor, DISPATCH, { branchId: f.branchId });
    if (f.status !== 'PACKED') throw invalidState(`pick list ${id}`, f.status);
    const header = await this.orderStore.lock(tx, f.salesOrderId);
    if (header === null) throw new NotFoundError('no such order');
    if (header.status !== 'PACKED') throw invalidState(`order ${header.id}`, header.status);
    const broken: SaleRule[] = [];
    if (header.fulfilmentMode !== 'COLLECTION') broken.push({ field: '', rule: 'NOT_A_COLLECTION' });
    // An order on account is credit-checked at its hand-over and invoiced with its terms' due date: B11 continued 8.
    if (header.paymentTerms === 'CREDIT') broken.push({ field: '', rule: 'CREDIT_DISPATCH_NOT_AVAILABLE' });
    if (broken.length > 0) throw new FulfilmentInvalidError(broken);

    const at = this.clock.now();
    const actorId = actor!.principalId;
    const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
    const lists = (await this.store.fulfilments(tx, (await this.store.ofOrders(tx, [header.id])).map((x) => x.id))).filter((x) => x.status === 'PACKED');
    const picks = lists.flatMap((x) => activeOf(x.picks).map((p) => ({ pick: p, list: x })));
    const open = order.lines.filter((l) => l.lineStatus === 'OPEN');
    const sent = open.filter((l) => !Quantity.parse(l.qtyFulfilled).isZero());
    const backorder = backorderLines(open);
    const rootId = header.parentOrderId ?? header.id;
    const before = await this.fulfilments.viewIn(tx, id);

    const document = await this.billing.issueIn(tx, actor, {
      kind: header.customerId === null ? 'RECEIPT' : 'INVOICE',
      branchId: header.branchId,
      customerId: header.customerId,
      orderDocumentId: header.id,
      taxInclusive: header.taxInclusive,
      occurredAt: at,
      lines: await this.billedLines(tx, sent, picks.map((p) => p.pick), at),
    });
    const gross = Money.fromJsonInteger(document.grossPesewas);
    const paid = (await this.payments.ofOrderIn(tx, rootId)).filter((p) => p.status === 'CLEARED');
    const waiting = (await this.orderStore.backordersOf(tx, rootId)).some((b) => b.id !== header.id && BEFORE_DISPATCH.has(b.status));
    const settlement = planSettlement(
      gross,
      paid.map((p) => ({ paymentId: p.id, unallocated: Money.fromJsonInteger(p.unallocatedPesewas) })),
      { holdForBackorder: backorder.length > 0 || waiting },
    );
    for (const a of settlement.allocations) await this.payments.allocateIn(tx, actor!, a.paymentId, [{ billingDocumentId: document.id, amountPesewas: a.amount.pesewas }]);
    const refundIds: string[] = [];
    for (const r of settlement.refunds) {
      const asked = await this.refunds.requestIn(tx, actor!, {
        originalPaymentId: r.paymentId,
        amountPesewas: r.amount.pesewas,
        destination: 'ORIGINAL_METHOD',
        reasonCode: WEIGHED_BELOW_PAID,
        creditNoteId: null,
        note: `Order ${header.orderNo!} weighed at ${document.documentNo ?? document.id}`,
      });
      refundIds.push(asked.subject.id);
    }

    // The goods go from where they were picked to the customer, once each; the order's promises end with them.
    await this.reservations.releaseHeldByIn(tx, actorId, header.id, `Order ${header.orderNo!} collected`);
    const customer = await this.refs.virtualLocationIn(tx, header.branchId, 'CUSTOMER');
    if (customer === null) throw new Error(`branch ${header.branchId} has no CUSTOMER location`);
    const lineMovement = new Map<string, string>();
    for (const { pick, list } of picks) {
      const line = order.lines.find((l) => l.id === pick.salesOrderLineId)!;
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: SALE_ISSUE,
        productId: line.productId,
        stockUnitId: pick.stockUnitId,
        branchId: header.branchId,
        fromLocationId: list.pickLocationId,
        toLocationId: customer,
        qty: Quantity.parse(pick.qtyBase),
        weight: pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! },
        sourceDocumentId: header.id,
        sourceLineRef: line.id,
        occurredAt: at,
      });
      await this.store.setPickMovement(tx, pick.id, posted.id, at, actorId);
      await this.store.insertIssue(tx, { pickId: pick.id, movementId: posted.id, at, actorId });
      if (!lineMovement.has(line.id)) lineMovement.set(line.id, posted.id);
    }
    for (const line of open) {
      const back = backorder.find((b) => b.fromLineId === line.id);
      await this.store.fixLine(tx, line.id, back !== undefined ? back.status : Quantity.parse(line.qtyFulfilled).compareTo(Quantity.parse(line.qtyOrdered)) < 0 && line.priceBasis !== 'PER_KG' ? 'PARTIAL' : 'FULFILLED');
    }
    for (const [lineId, movementId] of lineMovement) await this.store.setLineMovement(tx, lineId, movementId);
    for (const list of lists) await this.store.collect(tx, list.id, { at, actorId });
    await this.store.invoiceOrder(tx, header.id, { billingDocumentId: document.id, finalTotalPesewas: gross.pesewas, at, actorId });
    const backordered = backorder.length === 0 ? null : await this.orders.backorderIn(tx, actor!, order, backorder, at);
    await this.moveIn(tx, header, 'READY_FOR_COLLECTION', `Handed over on ${document.documentNo ?? document.id}`, at, actorId);
    const completed = settlement.due.isZero();
    if (completed) {
      await this.moveIn(tx, header, 'COMPLETED', 'Collected and paid', at, actorId, async () =>
        this.orderStore.complete(tx, header.id, { billingDocumentId: document.id, finalTotalPesewas: gross.pesewas, completedAt: at, actorId }),
      );
    }
    const collected: OrderCollected = {
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      contactPhone: header.contactPhone,
      billingDocumentId: document.id,
      billingDocumentNo: document.documentNo ?? '',
      finalTotalPesewas: gross.toJsonInteger(),
      allocatedPesewas: Money.sum(settlement.allocations.map((a) => a.amount)).toJsonInteger(),
      refundRequestedPesewas: Money.sum(settlement.refunds.map((r) => r.amount)).toJsonInteger(),
      dueAtTillPesewas: settlement.due.toJsonInteger(),
      completed,
      backorderId: backordered?.id ?? null,
      collectedAt: at.toISOString(),
    };
    await this.events.publish<OrderCollected>(tx, { type: ORDER_COLLECTED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: collected, occurredAt: at });
    const view = await this.fulfilments.viewIn(tx, id);
    await this.audit.record(tx, {
      module: 'ord',
      action: 'COLLECT',
      entityType: 'Fulfilment',
      entityId: id,
      branchId: f.branchId,
      before: { ...before },
      after: { ...view, billingDocumentId: document.id, dueAtTillPesewas: settlement.due.toJsonInteger(), refundIds, backorderId: backordered?.id ?? null },
    });
    const response = { status: 200, body: view };
    await this.idempotency.complete(tx, claim.id, response);
    return response;
  }

  /**
   * A delivered or handed-over order completed once its document is settled later (BL-097, B11 continued 7): on a payment
   * allocated to the document (`pay.PaymentCleared`, `pay.DepositAllocated`) or a credit note against it
   * (`bil.CreditNoteIssued`, a part delivery's credit issued after the proof), in that transaction, the order moves
   * DELIVERED, or READY_FOR_COLLECTION once collected, to COMPLETED when nothing is outstanding. Any other order waits.
   */
  async settledIn(tx: Transaction, event: EventEnvelope, documentIds: readonly string[]): Promise<void> {
    for (const documentId of [...new Set(documentIds)]) {
      const orderId = await this.orderStore.orderOfBillingDocument(tx, documentId);
      if (orderId === null) continue;
      const header = await this.orderStore.lock(tx, orderId);
      if (header === null || (header.status !== 'DELIVERED' && header.status !== 'READY_FOR_COLLECTION')) continue;
      const outstanding = (await this.billing.settleableIn(tx, [documentId])).get(documentId)?.outstandingPesewas ?? null;
      if (outstanding === null || outstanding > 0n) continue;
      const at = event.occurredAt;
      const from = header.status;
      await this.moveIn(tx, header, 'COMPLETED', from === 'DELIVERED' ? 'Delivered and paid' : 'Collected and paid', at, event.actorId, async () =>
        this.orderStore.complete(tx, header.id, { billingDocumentId: documentId, finalTotalPesewas: header.finalTotalPesewas!, completedAt: at, actorId: event.actorId }),
      );
      await this.audit.record(tx, { module: 'ord', action: 'COMPLETE', entityType: 'SalesOrder', entityId: header.id, branchId: header.branchId, before: { status: from }, after: { status: 'COMPLETED', billingDocumentId: documentId, settledBy: event.type } });
    }
  }

  /**
   * `del.DeliveryCompleted`, in DEL's transaction (ADR-0010): each dispatched pick of the order is issued for the sale
   * from the vehicle to the customer, once (`ord.fulfilment_issue`), each line names its first issue, and the order moves
   * DISPATCHED to DELIVERED, and on to COMPLETED when its billing document has nothing outstanding.
   */
  async deliveredIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const done = event.payload as unknown as DeliveryCompleted;
    const header = await this.orderStore.lock(tx, done.orderDocumentId);
    if (header === null) return;
    if (header.status !== 'DISPATCHED') throw invalidState(`order ${header.id}`, header.status);
    const at = new Date(done.deliveredAt);
    const actorId = event.actorId;
    const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
    const lists = (await this.store.fulfilments(tx, (await this.store.ofOrders(tx, [header.id])).map((x) => x.id))).filter((x) => x.status === 'DISPATCHED');
    const picks = lists.flatMap((x) => activeOf(x.picks));
    const issued = await this.store.issuesOf(
      tx,
      picks.map((p) => p.id),
    );
    const customer = await this.refs.virtualLocationIn(tx, header.branchId, 'CUSTOMER');
    if (customer === null) throw new Error(`branch ${header.branchId} has no CUSTOMER location`);
    // A part delivery (CR-055): what came back of each line, in base units, taken from its last picks first.
    const returned = done.returnedLines ?? [];
    const backOf = splitReturned(picks, returned, order.lines);
    const hold = returned.length === 0 ? null : await this.refs.physicalLocationOfKindIn(tx, header.branchId, 'RETURNS_HOLD');
    if (returned.length > 0 && hold === null) throw new DeliveryInvalidError([{ field: '/lines', rule: 'NO_RETURNS_HOLD' }]);
    const lineMovement = new Map<string, string>();
    for (const pick of picks) {
      if (issued.has(pick.id)) continue;
      const line = order.lines.find((l) => l.id === pick.salesOrderLineId)!;
      const whole = Quantity.parse(pick.qtyBase);
      const back = backOf.get(pick.id) ?? Quantity.zero();
      const kept = whole.minus(back);
      const weight = pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! };
      if (!kept.isZero()) {
        const posted = await this.stock.postIn(tx, actorId, {
          movementType: SALE_ISSUE,
          productId: line.productId,
          stockUnitId: pick.stockUnitId,
          branchId: header.branchId,
          fromLocationId: done.vehicleLocationId,
          toLocationId: customer,
          qty: kept,
          weight: back.isZero() ? weight : null,
          sourceDocumentId: header.id,
          sourceLineRef: line.id,
          occurredAt: at,
        });
        await this.store.insertIssue(tx, { pickId: pick.id, movementId: posted.id, at, actorId });
        lineMovement.set(line.id, lineMovement.get(line.id) ?? posted.id);
      }
      if (!back.isZero()) {
        const moved = await this.stock.postIn(tx, actorId, {
          movementType: BACK_FROM_VEHICLE,
          productId: line.productId,
          stockUnitId: pick.stockUnitId,
          branchId: header.branchId,
          fromLocationId: done.vehicleLocationId,
          toLocationId: hold!,
          qty: back,
          weight: kept.isZero() ? weight : null,
          sourceDocumentId: done.deliveryId,
          sourceLineRef: pick.id,
          occurredAt: at,
        });
        // A line that came back whole names its way back, so the order's lines each name a movement.
        if (!lineMovement.has(line.id)) lineMovement.set(line.id, moved.id);
      }
    }
    for (const [lineId, movementId] of lineMovement) await this.store.setLineMovement(tx, lineId, movementId);
    if (returned.length > 0) await this.creditReturnedIn(tx, event, done, header, hold!, at);
    await this.moveIn(tx, header, 'DELIVERED', `Delivered on ${done.deliveryNo}`, at, actorId);
    const outstanding = (await this.billing.settleableIn(tx, [done.billingDocumentId])).get(done.billingDocumentId)?.outstandingPesewas ?? null;
    const completed = outstanding === 0n;
    if (completed) {
      await this.moveIn(tx, header, 'COMPLETED', 'Delivered and paid', at, actorId, async () =>
        this.orderStore.complete(tx, header.id, { billingDocumentId: done.billingDocumentId, finalTotalPesewas: header.finalTotalPesewas!, completedAt: at, actorId }),
      );
    }
    const delivered: OrderDelivered = {
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      contactPhone: header.contactPhone,
      deliveryId: done.deliveryId,
      deliveryNo: done.deliveryNo,
      billingDocumentId: done.billingDocumentId,
      codCollectedPesewas: done.codCollectedPesewas,
      outstandingPesewas: outstanding === null ? 0 : json(outstanding),
      completed,
      deliveredAt: done.deliveredAt,
    };
    await this.events.publish<OrderDelivered>(tx, { type: ORDER_DELIVERED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: delivered, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'DELIVER', entityType: 'SalesOrder', entityId: header.id, branchId: header.branchId, before: { status: 'DISPATCHED' }, after: { status: completed ? 'COMPLETED' : 'DELIVERED', deliveryId: done.deliveryId } });
  }

  /**
   * `del.DeliveryFailed`, in DEL's transaction (ADR-0010, FR-DEL-011): the order moves DISPATCHED to DELIVERY_FAILED with
   * the attempt's reason. Nothing moves: the goods stay on the van, the farm's, until a reattempt or a return to stock.
   */
  async failedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const failed = event.payload as unknown as DeliveryFailed;
    const header = await this.orderStore.lock(tx, failed.orderDocumentId);
    if (header === null) return;
    if (header.status !== 'DISPATCHED') throw invalidState(`order ${header.id}`, header.status);
    const at = new Date(failed.occurredAt);
    await this.moveIn(tx, header, 'DELIVERY_FAILED', `Attempt ${failed.attemptNo} on ${failed.deliveryNo} failed: ${failed.failureReasonCode}`, at, event.actorId);
    await this.audit.record(tx, {
      module: 'ord',
      action: 'DELIVERY_FAILED',
      entityType: 'SalesOrder',
      entityId: header.id,
      branchId: header.branchId,
      before: { status: 'DISPATCHED' },
      after: { status: 'DELIVERY_FAILED', deliveryId: failed.deliveryId, failureReasonCode: failed.failureReasonCode, nextAction: failed.nextAction },
    });
  }

  /**
   * What a part delivery's customer did not keep, credited (CR-055, ADR-0093): the returned quantity of each line in the
   * document's own unit, a weighed line whole, the driver the credit note's maker; the delivery fee is never credited.
   */
  private async creditReturnedIn(tx: Transaction, event: EventEnvelope, done: DeliveryCompleted, header: OrderHeaderRecord, hold: string, at: Date): Promise<void> {
    const byOrderLine = await this.billing.linesByOrderLineIn(tx, done.billingDocumentId);
    const [document] = await this.billing.viewsIn(tx, [done.billingDocumentId]);
    const lines = done.returnedLines.map((r) => {
      const lineId = byOrderLine.get(r.orderLineId)!;
      return { lineId, quantity: r.weighed ? document!.lines.find((l) => l.id === lineId)!.quantity : r.returnedQty };
    });
    const maker: Actor = { principalId: event.actorId, kind: 'USER', displayName: '', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    const note = `Part delivery ${done.deliveryNo}: ${done.returnedReasonCode ?? 'returned'}`;
    const credit = await this.vanReturns.partReturnedIn(tx, maker, { deliveryId: done.deliveryId, salesOrderId: header.id, billingDocumentId: done.billingDocumentId, branchId: header.branchId, returnsLocationId: hold, note }, lines, at);
    await this.audit.record(tx, {
      module: 'ord',
      action: 'PART_DELIVERY',
      entityType: 'SalesOrder',
      entityId: header.id,
      branchId: header.branchId,
      before: null,
      after: { deliveryId: done.deliveryId, returnedLines: [...done.returnedLines], returnedReasonCode: done.returnedReasonCode, returnedCreditPesewas: done.returnedCreditPesewas, creditNoteId: credit.creditNoteId, creditApprovalRequestId: credit.approvalRequestId, returnsLocationId: hold },
    });
  }

  /** Each open line as weighed and picked: a catch-weight line in kilograms, any other in its sold unit (FR-BIL-005). */
  private async billedLines(tx: Transaction, open: readonly OrderLineRecord[], picks: readonly PickRecord[], at: Date): Promise<IssueLineRequest[]> {
    const unitIds = [...new Set(picks.flatMap((p) => (p.stockUnitId === null ? [] : [p.stockUnitId])))];
    const units = await this.units.factsIn(tx, unitIds, at);
    return open.map((line) => {
      const mine = [...new Set(picks.filter((p) => p.salesOrderLineId === line.id).map((p) => p.stockUnitId))];
      const unit = mine.length === 1 && mine[0] !== null ? units.get(mine[0]!) : undefined;
      const perKg = line.priceBasis === 'PER_KG';
      return {
        lineKind: 'PRODUCT' as const,
        productId: line.productId,
        stockUnit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
        orderLineRef: line.id,
        quantity: perKg ? line.fulfilledWeightKg! : line.qtyFulfilled,
        uom: perKg ? 'KG' : line.uom,
        weightKg: line.fulfilledWeightKg,
        unitPricePesewas: line.agreedUnitPricePesewas,
        resolvedUnitPricePesewas: line.resolvedUnitPricePesewas,
        discountPesewas: line.discountPesewas,
      };
    });
  }

  /** Each fee of the dispatch as a line of its own, taxed as a delivery service (A-331 (b)). */
  private async feeLines(tx: Transaction, fees: readonly FeeAtDispatch[]): Promise<IssueLineRequest[]> {
    if (fees.length === 0) return [];
    const taxCategoryId = await this.storefront.deliveryTaxCategoryIdIn(tx);
    return fees.map((f) => ({
      lineKind: 'DELIVERY_FEE' as const,
      description: translate(f.kind === 'DELIVERY' ? 'ord.delivery_fee' : 'ord.extra_delivery_fee'),
      quantity: '1.000',
      unitPricePesewas: f.amountPesewas,
      taxCategoryId,
    }));
  }

  /** What the delivery carries, line by line, for the driver and the delivery note (CR-055 point 1). */
  private async contentsOf(tx: Transaction, open: readonly OrderLineRecord[]): Promise<ContentsLine[]> {
    const products = await this.refs.productsIn(
      tx,
      open.map((l) => l.productId),
    );
    return open.map((l) => ({ orderLineId: l.id, name: products.get(l.productId)?.name ?? l.productId, quantity: l.qtyFulfilled, uom: l.uom, weightKg: l.fulfilledWeightKg }));
  }

  private async moveIn(tx: Transaction, header: OrderHeaderRecord, to: OrderStatus, reason: string, at: Date, actorId: string, write?: () => Promise<void>): Promise<void> {
    const from = (await this.orderStore.lock(tx, header.id))!.status;
    if (!canMove(from, to)) throw invalidState(`order ${header.id}`, from);
    if (write === undefined) await this.store.moveOrder(tx, header.id, to, at, actorId);
    else await write();
    await this.orderStore.recordStatus(tx, header.id, { id: this.nextId(), fromStatus: from, toStatus: to, reason, occurredAt: at, actorId });
  }
}

/**
 * Each pick's part that came back (CR-055), in base units: a line's returned quantity in its own unit is converted by
 * the line's own picked ratio (base picked over the line's quantity), exactly or not at all (`UNIT_SPLIT`), and taken
 * from the line's last picks first, so the first picks are kept whole. A weighed line comes back whole.
 */
export function splitReturned(
  picks: readonly PickRecord[],
  returned: readonly { readonly orderLineId: string; readonly dispatchedQty: string; readonly returnedQty: string; readonly weighed: boolean }[],
  lines: readonly OrderLineRecord[],
): Map<string, Quantity> {
  const back = new Map<string, Quantity>();
  for (const r of returned) {
    const mine = picks.filter((p) => p.salesOrderLineId === r.orderLineId);
    if (lines.every((l) => l.id !== r.orderLineId) || mine.length === 0) throw new DeliveryInvalidError([{ field: '/lines', rule: 'LINE_UNKNOWN' }]);
    const base = Quantity.sum(mine.map((p) => Quantity.parse(p.qtyBase)));
    const dispatched = Quantity.parse(r.dispatchedQty).thousandths;
    const product = base.thousandths * Quantity.parse(r.returnedQty).thousandths;
    if (product % dispatched !== 0n) throw new DeliveryInvalidError([{ field: '/lines', rule: 'UNIT_SPLIT' }]);
    let remaining = r.weighed ? base : Quantity.ofThousandths(product / dispatched);
    for (const pick of [...mine].reverse()) {
      if (remaining.isZero()) break;
      const whole = Quantity.parse(pick.qtyBase);
      const take = whole.compareTo(remaining) <= 0 ? whole : remaining;
      // A weighed pick (a pack priced by its weight) is never split at the door.
      if (!take.equals(whole) && pick.weightKg !== null) throw new DeliveryInvalidError([{ field: '/lines', rule: 'UNIT_SPLIT' }]);
      back.set(pick.id, take);
      remaining = remaining.minus(take);
    }
  }
  return back;
}
