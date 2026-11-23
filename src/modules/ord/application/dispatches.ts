import { createUuidV7Generator, Money, Quantity, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import { translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing, IssueLineRequest } from '../../bil';
import type { ContentsLine, Deliveries, DeliveryCompleted, DeliveryFailed } from '../../del';
import type { Authoriser } from '../../iam';
import type { Reservations, Stock, StockUnits } from '../../inv';
import type { MasterDataRefs, Storefront } from '../../mdm';
import type { Payments, Refunds } from '../../pay';
import { planSettlement } from '../domain/dispatch';
import { canMove, type OrderStatus } from '../domain/order';
import type { OrderDelivered, OrderDispatched } from '../events';
import { FulfilmentInvalidError, type SaleRule } from './errors';
import type { FulfilmentStore, PickRecord } from './fulfilment-store';
import type { Fulfilments, FulfilmentView } from './fulfilments';
import type { OrderHeaderRecord, OrderLineRecord, OrderStore } from './order-store';

const DISPATCH = 'ord.fulfilment.dispatch';
export const ORDER_DISPATCHED = 'ord.OrderDispatched';
export const ORDER_DELIVERED = 'ord.OrderDelivered';
/** Dispatch moves the picked goods onto the vehicle; they stay the farm's until delivered (FR-DEL-005, A-337). */
const ONTO_VEHICLE = 'TRANSFER_INTERNAL';
/** Delivered, they are issued for the sale from the vehicle (FR-DEL-008). */
const SALE_ISSUE = 'SALE_ISSUE';
/** ADR-0021: what was paid beyond the weighed total is asked back to the original method with this reason (migration 0302). */
const WEIGHED_BELOW_PAID = 'WEIGHED_BELOW_PAID';

const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const activeOf = (picks: readonly PickRecord[]) => picks.filter((p) => p.withdrawnAt === null);
const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

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
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
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
            seriesLocks: [...this.billing.seriesLocksFor('INVOICE', branchId), ...this.billing.seriesLocksFor('RECEIPT', branchId), ...this.deliveries.locksFor(branchId)],
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
    const before = await this.fulfilments.viewIn(tx, id);

    // The billing document on the weighed quantity (FR-BIL-005), with the delivery fee once (A-331 (b)).
    const document = await this.billing.issueIn(tx, actor, {
      kind: header.customerId === null ? 'RECEIPT' : 'INVOICE',
      branchId: header.branchId,
      customerId: header.customerId,
      orderDocumentId: header.id,
      taxInclusive: header.taxInclusive,
      occurredAt: at,
      lines: [...(await this.billedLines(tx, open, picks.map((p) => p.pick), at)), ...(await this.feeLine(tx, header))],
    });
    const gross = Money.fromJsonInteger(document.grossPesewas);

    // The deposits applied oldest first, the rest refunded, what is left due on delivery (ADR-0021).
    const paid = (await this.payments.ofOrderIn(tx, header.id)).filter((p) => p.status === 'CLEARED');
    const settlement = planSettlement(
      gross,
      paid.map((p) => ({ paymentId: p.id, unallocated: Money.fromJsonInteger(p.unallocatedPesewas) })),
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
    for (const line of open) await this.store.fixLine(tx, line.id, Quantity.parse(line.qtyFulfilled).compareTo(Quantity.parse(line.qtyOrdered)) < 0 && line.priceBasis !== 'PER_KG' ? 'PARTIAL' : 'FULFILLED');
    for (const list of lists) await this.store.dispatch(tx, list.id, { at, actorId });
    await this.store.invoiceOrder(tx, header.id, { billingDocumentId: document.id, finalTotalPesewas: gross.pesewas, at, actorId });

    const delivery = await this.deliveries.scheduleIn(tx, actor!, {
      orderDocumentId: header.id,
      billingDocumentId: document.id,
      customerId: header.customerId,
      branchId: header.branchId,
      deliveryZoneId: header.deliveryZoneId!,
      recipientName: address!.recipientName as string,
      recipientPhoneE164: address!.recipientPhone as string,
      address: address!,
      contents: await this.contentsOf(tx, open),
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
      after: { ...view, billingDocumentId: document.id, deliveryId: delivery.id, codDuePesewas: settlement.due.toJsonInteger(), refundIds },
    });
    const response = { status: 200, body: view };
    await this.idempotency.complete(tx, claim.id, response);
    return response;
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
    for (const pick of picks) {
      if (issued.has(pick.id)) continue;
      const line = order.lines.find((l) => l.id === pick.salesOrderLineId)!;
      const posted = await this.stock.postIn(tx, actorId, {
        movementType: SALE_ISSUE,
        productId: line.productId,
        stockUnitId: pick.stockUnitId,
        branchId: header.branchId,
        fromLocationId: done.vehicleLocationId,
        toLocationId: customer,
        qty: Quantity.parse(pick.qtyBase),
        weight: pick.weightKg === null ? null : { kg: Weight.parseKg(pick.weightKg), source: pick.weightSource! },
        sourceDocumentId: header.id,
        sourceLineRef: line.id,
        occurredAt: at,
      });
      await this.store.insertIssue(tx, { pickId: pick.id, movementId: posted.id, at, actorId });
      await this.store.setLineMovement(tx, line.id, posted.id);
    }
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

  /** The order's delivery fee as a line of its own, taxed as a delivery service, when it has one. */
  private async feeLine(tx: Transaction, header: OrderHeaderRecord): Promise<IssueLineRequest[]> {
    if (header.deliveryFeePesewas === 0n) return [];
    return [{ lineKind: 'DELIVERY_FEE', description: translate('ord.delivery_fee'), quantity: '1.000', unitPricePesewas: header.deliveryFeePesewas, taxCategoryId: await this.storefront.deliveryTaxCategoryIdIn(tx) }];
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
