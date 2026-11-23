import { createUuidV7Generator, Money, Quantity, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { ReservationEnded, Reservations } from '../../inv';
import { extendPrice, type MasterDataRefs, type PriceBasis, type PricingService } from '../../mdm';
import type { PaymentCleared, PaymentFailed, Payments } from '../../pay';
import { judgeConfirmation, receivedForOrder } from '../domain/confirmation';
import { lineNumber } from '../domain/line-numbers';
import { paymentConfirms, trackingSteps } from '../domain/online';
import type { OrderStatus, PaymentStatus } from '../domain/order';
import { pageProbe } from '../domain/paging';
import type { OrderConfirmed, OrderPlaced } from '../events';
import { OrderInvalidError, type SaleRule } from './errors';
import type { OrderReversals } from './order-reversals';
import type { NewOrderLine, OrderStore } from './order-store';
import { TrackingTokens } from './tracking-token';
import { ORDER_CONFIRMED, ORDER_PLACED, type Orders, type Page, type SalesOrderView } from './orders';
import type { Fulfilments } from './fulfilments';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';

registerMessages({
  'ord.track.PLACED': 'Order placed',
  'ord.track.CONFIRMED': 'Order confirmed',
  'ord.track.PACKED': 'Weighed and packed',
  'ord.track.DISPATCHED': 'On the way',
  'ord.track.DELIVERED': 'Delivered',
  'ord.track.READY_FOR_COLLECTION': 'Ready to collect',
  'ord.track.COMPLETED': 'Collected',
  'ord.track.CANCELLED': 'Cancelled',
  'ord.track.VOIDED': 'Cancelled',
});


/** One line of a checkout as the storefront priced and reserved it (SHP's `checkout_line`), handed down to be ordered. */
export interface OnlinePlacementLine {
  readonly productId: string;
  /** Whole sale units, as the customer chose them. */
  readonly quantity: string;
  readonly uom: string;
  readonly priceBasis: PriceBasis;
  readonly priceListEntryId: string;
  readonly unitPricePesewas: bigint;
  /** A catch-weight line's estimate: packs times the nominal pack (ADR-0021); null otherwise. */
  readonly estimatedWeightKg: string | null;
  readonly tolerancePercent: string | null;
  readonly estimatedLineTotalPesewas: bigint;
  readonly maximumLineTotalPesewas: bigint;
}

/** A checkout handed down to be placed (SHP's placeOrder, A-232). */
export interface OnlinePlacement {
  readonly checkoutId: string;
  readonly branchId: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly paymentTerms: 'PREPAID' | 'COD';
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly deliveryAddressSnapshot: unknown;
  readonly deliveryZoneId: string | null;
  readonly deliveryFeePesewas: bigint;
  readonly estimatedTotalPesewas: bigint;
  readonly maximumTotalPesewas: bigint;
  readonly lines: readonly OnlinePlacementLine[];
}

export interface PlacedOrder {
  readonly orderId: string;
  readonly orderNo: string;
  readonly trackingToken: string;
}

/** The contract's `TrackingLine`. */
interface TrackingLineView {
  readonly name: string;
  readonly quantity: string;
  readonly uom: string;
  readonly weightKg: string | null;
}

/** The contract's `OrderTracking`: no name, phone, address, cost or pricing record. */
export interface OrderTrackingView {
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly placedAt: string;
  readonly fulfilmentMode: string;
  readonly steps: readonly { readonly status: OrderStatus; readonly label: string; readonly at: string | null; readonly done: boolean }[];
  readonly delivery: null;
  readonly estimatedTotalPesewas: number;
  readonly finalTotalPesewas: number | null;
  readonly paidPesewas: number;
  readonly currency: 'GHS';
  readonly lines: readonly TrackingLineView[];
}

/** The contract's `CustomerOrderSummary`. */
export interface CustomerOrderSummaryView {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly placedAt: string;
  readonly itemCount: number;
  readonly totalPesewas: number;
  readonly currency: 'GHS';
}

/** The contract's `CustomerOrder`: no cost, floor, ceiling, variance or rule. */
export interface CustomerOrderView {
  readonly id: string;
  readonly orderNo: string;
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly placedAt: string;
  readonly fulfilmentMode: string;
  readonly deliveryAddress: unknown;
  readonly delivery: null;
  readonly lines: readonly (TrackingLineView & { readonly unitPricePesewas: number; readonly lineTotalPesewas: number; readonly status: string })[];
  readonly deliveryFeePesewas: number;
  readonly estimatedTotalPesewas: number;
  readonly finalTotalPesewas: number | null;
  readonly paidPesewas: number;
  readonly currency: 'GHS';
  readonly documents: readonly { readonly id: string; readonly docType: string; readonly documentNo: string; readonly issuedAt: string; readonly grossPesewas: number | null; readonly currency: 'GHS' }[];
  /** What the order waits for the customer to answer (B11), or null: never a price record beyond what they are asked to pay. */
  readonly pendingConsent: { readonly kind: 'HIGHER_TOTAL' | 'SUBSTITUTION' | 'SHORT_PICK'; readonly detail: string; readonly proposedTotalPesewas: number | null } | null;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/**
 * Online orders (FR-SHP-005, FR-ORD-001, FR-ORD-005, FR-ORD-014, FR-PAY-008, ADR-0010, ADR-0021, A-232).
 *
 * - `placeIn`: SHP's placeOrder hands a checkout down, in SHP's serializable transaction. The order is ONLINE and
 *   PLACED with its number, from the checkout (its source document), every line priced by MDM's engine now and
 *   refused if the engine no longer gives the checkout's price (`PRICE_CHANGED`): an online price is the engine's, so
 *   no override arises. The checkout keeps holding the stock until the order is confirmed. It authorises nothing: the
 *   guest's token proved the checkout theirs.
 * - `confirmFromCheckoutIn`: the checkout's hold handed to the order whole (INV's `transferHeldByIn`), the order
 *   CONFIRMED. A cash-on-delivery order is confirmed at placement; a prepaid one when `pay.PaymentCleared` names it with
 *   money that is its own (`paymentConfirms`), in the clearing's transaction.
 * - The order stops waiting, cancelled as `PAYMENT_NOT_RECEIVED`, when its checkout's hold ends first (expired or
 *   released) or its charge fails; its pending charge is released, so money paid later is held unmatched (A-210).
 * - `track`, `mine`, `mineOne`: the tracking link's read by its own random token (ADR-0074), and a signed-in customer's own orders only.
 */
export class OnlineOrders {
  private readonly nextId: () => string;
  private readonly tokens: TrackingTokens;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: OrderStore,
    private readonly orders: Orders,
    private readonly reversals: OrderReversals,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly reservations: Reservations,
    private readonly payments: Payments,
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly fulfilments: Fulfilments,
    private readonly idempotency: Idempotency,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.tokens = new TrackingTokens(store, clock);
  }

  /** The series lock a placement at a branch takes before BEGIN (A-186). */
  locksFor(branchId: string): string[] {
    return [`SALES_ORDER:${toBusinessDate(this.clock.now()).slice(0, 4)}:${branchId}`];
  }

  async placeIn(tx: Transaction, actorId: string, p: OnlinePlacement): Promise<PlacedOrder> {
    const at = this.clock.now();
    const broken: SaleRule[] = [];
    if (p.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    const resolved = await this.pricing.resolveIn(tx, {
      channel: 'ONLINE',
      branchId: p.branchId,
      at,
      // Each line priced in the unit it was put in the cart in (a crate, B09e); a catch-weight line by its estimated weight.
      lines: p.lines.map((l, i) => ({
        lineRef: String(i),
        productId: l.productId,
        quantity: l.quantity,
        ...(l.estimatedWeightKg === null ? { uom: l.uom } : { weightKg: l.estimatedWeightKg }),
      })),
    });
    const orderId = this.nextId();
    const lines: NewOrderLine[] = [];
    for (const [i, line] of p.lines.entries()) {
      const band = resolved.lines.find((r) => r.lineRef === String(i))?.resolved ?? null;
      const list = band === null ? null : BigInt(band.listPricePesewas);
      const weight = line.estimatedWeightKg === null ? null : Weight.parseKg(line.estimatedWeightKg);
      const extended = list === null ? null : extendPrice(list, band!.basis, { quantity: Quantity.parse(line.quantity), weight });
      if (band === null || list !== line.unitPricePesewas || band.priceListEntryId !== line.priceListEntryId || band.basis !== line.priceBasis || extended?.ok !== true || extended.value !== line.estimatedLineTotalPesewas) {
        broken.push({ field: `/lines/${i}`, rule: 'PRICE_CHANGED' });
        continue;
      }
      lines.push({
        id: this.nextId(),
        salesOrderId: orderId,
        lineNo: lineNumber(i),
        productId: line.productId,
        stockUnitId: null,
        qtyOrdered: Quantity.parse(line.quantity).toDecimalString(),
        uom: line.uom,
        qtyFulfilled: '0.000',
        fulfilledWeightKg: null,
        weightSource: null,
        priceSource: 'ENGINE',
        priceBasis: band.basis,
        priceListEntryId: band.priceListEntryId,
        resolvedUnitPricePesewas: list,
        floorUnitPricePesewas: BigInt(band.floorPricePesewas),
        ceilingUnitPricePesewas: BigInt(band.ceilingPricePesewas),
        agreedUnitPricePesewas: list,
        variancePesewas: 0n,
        varianceDirection: null,
        varianceReasonCode: null,
        varianceRequiresApproval: false,
        varianceApprovalRequestId: null,
        varianceApprovedBy: null,
        varianceApprovedAt: null,
        discountPesewas: 0n,
        estimatedLineTotalPesewas: extended.value,
        finalLineTotalPesewas: null,
        reservationId: null,
        stockMovementId: null,
        lineStatus: 'OPEN',
        estimatedWeightKg: weight?.toKgString() ?? null,
        tolerancePercent: line.tolerancePercent,
      });
    }
    const goods = Money.sum(lines.map((l) => Money.ofPesewas(l.estimatedLineTotalPesewas)));
    const maximum = Money.sum(p.lines.map((l) => Money.ofPesewas(l.maximumLineTotalPesewas))).plus(Money.ofPesewas(p.deliveryFeePesewas));
    if (broken.length === 0 && (goods.plus(Money.ofPesewas(p.deliveryFeePesewas)).pesewas !== p.estimatedTotalPesewas || maximum.pesewas !== p.maximumTotalPesewas)) {
      broken.push({ field: '/estimatedTotalPesewas', rule: 'PRICE_CHANGED' });
    }
    if (broken.length > 0) throw new OrderInvalidError(broken);

    const branch = (await this.refs.branchesIn(tx, [p.branchId])).get(p.branchId)!;
    await this.documents.register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId: p.branchId, actorId });
    const orderNo = await this.numbers.allocateIn(tx, { docType: 'SALES_ORDER', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId: p.branchId, branchCode: branch.code, documentId: orderId });
    await this.store.insertOrder(tx, {
      id: orderId,
      orderNo,
      channel: 'ONLINE',
      customerId: null,
      contactName: p.contactName,
      contactPhone: p.contactPhone,
      paymentTerms: p.paymentTerms,
      fulfilmentMode: p.fulfilmentMode,
      sourceDocumentId: p.checkoutId,
      shiftDocumentId: null,
      salespersonId: null,
      taxInclusive: true,
      deliveryFeePesewas: p.deliveryFeePesewas,
      estimatedTotalPesewas: p.estimatedTotalPesewas,
      maximumTotalPesewas: p.maximumTotalPesewas,
      isOffline: false,
      placedAt: at,
      notes: null,
      branchId: p.branchId,
      actorId,
      deliveryAddressSnapshot: p.deliveryAddressSnapshot,
      deliveryZoneId: p.deliveryZoneId,
    });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: null, occurredAt: at, actorId });
    await this.store.insertLines(tx, lines);
    const placed: OrderPlaced = {
      orderId,
      orderNo,
      channel: 'ONLINE',
      branchId: p.branchId,
      customerId: null,
      paymentTerms: p.paymentTerms,
      estimatedTotalPesewas: json(p.estimatedTotalPesewas),
      placedAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_PLACED, subjectType: 'SalesOrder', subjectId: orderId, branchId: p.branchId, payload: placed, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'CREATE', entityType: 'SalesOrder', entityId: orderId, branchId: p.branchId, before: null, after: { ...(await this.orders.viewOf(tx, orderId)) } });
    return { orderId, orderNo, trackingToken: await this.tokens.issueIn(tx, orderId, actorId) };
  }

  /**
   * A fresh tracking token for an online order already placed, for the replay of its placement: the stored answer
   * keeps no token (only its hash is ever stored), so the replay gets a link of its own and the first stays valid.
   */
  reissueTrackingIn(tx: Transaction, orderId: string, actorId: string): Promise<string> {
    return this.tokens.issueIn(tx, orderId, actorId);
  }

  /**
   * A PLACED online order takes over its checkout's hold and is CONFIRMED (FR-ORD-005), its payment check judged as
   * `confirmOrder` judges it. Answers false, changing nothing, when the check does not pass or the checkout holds
   * nothing any more: the order then waits, and is cancelled when its hold ends.
   */
  async confirmFromCheckoutIn(tx: Transaction, orderId: string, actorId: string): Promise<boolean> {
    const header = await this.store.lock(tx, orderId);
    if (header === null || header.sourceDocumentId === null || header.status !== 'PLACED') return false;
    const verdict = judgeConfirmation({ paymentTerms: header.paymentTerms, estimated: Money.ofPesewas(header.estimatedTotalPesewas), received: receivedForOrder(await this.payments.ofOrderIn(tx, orderId)), credit: null });
    if (!verdict.ok) return false;
    const before = await this.orders.viewOf(tx, orderId);
    const moved = await this.reservations.transferHeldByIn(tx, actorId, header.sourceDocumentId, orderId, `Order ${header.orderNo!} confirmed: its checkout’s hold passes to the order`);
    if (moved.length === 0) return false;
    const [order] = await this.store.orders(tx, [orderId]);
    for (const line of order!.lines) {
      const held = moved.filter((r) => r.productId === line.productId);
      if (held.length === 1) await this.store.holdLine(tx, line.id, held[0]!.id);
    }
    const at = this.clock.now();
    await this.store.confirm(tx, orderId, { creditCheck: verdict.creditCheck, at, actorId });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: 'PLACED', toStatus: 'CONFIRMED', reason: null, occurredAt: at, actorId });
    const confirmed: OrderConfirmed = {
      orderId,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      creditCheck: verdict.creditCheck,
      reservationIds: moved.map((r) => r.id),
      confirmedAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_CONFIRMED, subjectType: 'SalesOrder', subjectId: orderId, branchId: header.branchId, payload: confirmed, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'CONFIRM', entityType: 'SalesOrder', entityId: orderId, branchId: header.branchId, before: { ...before }, after: { ...(await this.orders.viewOf(tx, orderId)) } });
    return true;
  }

  /** `pay.PaymentCleared`, in the clearing's transaction: the order's own money confirms an online order waiting for it. */
  async paymentClearedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const cleared = event.payload as unknown as PaymentCleared;
    if (cleared.orderDocumentId === null) return;
    const header = await this.store.lock(tx, cleared.orderDocumentId);
    if (header === null) return;
    if (!paymentConfirms({ ...header, fromCheckout: header.sourceDocumentId !== null }, cleared.heldAsUnmatched === true)) return;
    await this.confirmFromCheckoutIn(tx, header.id, event.actorId);
  }

  /** `pay.PaymentFailed`, in the failure's transaction: an online order waiting for that money stops waiting. */
  async paymentFailedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const failed = event.payload as unknown as PaymentFailed;
    if (failed.orderDocumentId === null) return;
    const header = await this.store.lock(tx, failed.orderDocumentId);
    if (header === null || header.channel !== 'ONLINE' || header.sourceDocumentId === null) return;
    await this.reversals.stopWaitingIn(tx, header, 'PAYMENT_FAILED', event.actorId);
  }

  /** `inv.ReservationExpired` and `inv.ReservationReleased`: a checkout's hold that ends, unless handed to its order. */
  async holdEndedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const ended = event.payload as unknown as ReservationEnded;
    if (ended.transferredToDocumentId !== null) return;
    const header = await this.store.lockOnlineBySource(tx, ended.holderDocumentId);
    if (header === null) return;
    await this.reversals.stopWaitingIn(tx, header, 'HOLD_ENDED', event.actorId);
  }

  /** trackOrder: whoever holds a live link's token; anything else is "no such order". */
  track(token: string): Promise<OrderTrackingView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const id = await this.tokens.orderOfIn(tx, token);
      const [order] = id === null ? [] : await this.store.orders(tx, [id]);
      if (order === undefined || order.orderNo === null) throw new NotFoundError('no such order');
      const view = await this.orders.viewOf(tx, order.id);
      const mode = order.fulfilmentMode === 'DELIVERY' ? 'DELIVERY' : 'COLLECTION';
      const steps = trackingSteps(mode, await this.store.history(tx, order.id));
      return {
        orderNo: order.orderNo,
        status: order.status,
        placedAt: view.placedAt,
        fulfilmentMode: order.fulfilmentMode,
        steps: steps.map((s) => ({ status: s.status, label: translate(`ord.track.${s.status}`), at: s.at?.toISOString() ?? null, done: s.done })),
        delivery: null,
        estimatedTotalPesewas: view.estimatedTotalPesewas,
        finalTotalPesewas: view.finalTotalPesewas,
        paidPesewas: view.paidPesewas,
        currency: 'GHS',
        lines: view.lines.map((l) => ({ name: l.product.name, quantity: l.qtyOrdered, uom: l.uom, weightKg: l.fulfilledWeightKg })),
      };
    });
  }

  /** listMyOrders: a signed-in customer's own orders, at every branch, newest first; nobody else's. */
  mine(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<CustomerOrderSummaryView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const customerId = await this.customerOf(tx, actor);
      const binding = { operationId: 'listMyOrders', principalId: actor!.principalId, filters: {} };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.ofCustomer(tx, customerId, beforeId, pageProbe(limit));
      const page = found.slice(0, limit);
      const data: CustomerOrderSummaryView[] = [];
      for (const id of page) {
        const view = await this.orders.viewOf(tx, id);
        data.push({
          id: view.id,
          orderNo: view.orderNo ?? '',
          status: view.status,
          paymentStatus: view.paymentStatus,
          placedAt: view.placedAt,
          itemCount: view.lines.length,
          totalPesewas: view.finalTotalPesewas ?? view.estimatedTotalPesewas,
          currency: 'GHS',
        });
      }
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** getMyOrder: one of the signed-in customer's own orders; another customer's is "no such order". */
  mineOne(actor: Actor | undefined, id: string): Promise<CustomerOrderView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const customerId = await this.customerOf(tx, actor);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined || order.customerId !== customerId) throw new NotFoundError('no such order');
      return this.customerView(await this.orders.viewOf(tx, id));
    });
  }

  /**
   * answerMyOrderConsent (FR-ORD-013, B11): the signed-in customer answers what their own order waits for; another
   * customer's order is "no such order". Idempotent by its key.
   */
  answerMine(actor: Actor | undefined, id: string, body: { readonly accepted: boolean }, key: string): Promise<StoredResponse<CustomerOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const customerId = await this.customerOf(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'answerMyOrderConsent', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CustomerOrderView>;
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined || order.customerId !== customerId) throw new NotFoundError('no such order');
      await this.fulfilments.answerMineIn(tx, actor!, id, body.accepted);
      const response = { status: 200, body: this.customerView(await this.orders.viewOf(tx, id)) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The customer a customer-realm session belongs to (as `getMyStoreCredit`); a staff session never reaches here. */
  private async customerOf(tx: Transaction, actor: Actor | undefined): Promise<string> {
    if (actor === undefined) throw new UnauthenticatedError('sign in to see your orders');
    if (actor.realm !== 'CUSTOMER') throw new ForbiddenError('orders are read here by the customer they belong to');
    const customer = await this.refs.customerOfPrincipalIn(tx, actor.principalId);
    if (customer === null) throw new NotFoundError('no customer account is linked to this sign-in');
    return customer.id;
  }

  private customerView(view: SalesOrderView): CustomerOrderView {
    return {
      id: view.id,
      orderNo: view.orderNo ?? '',
      status: view.status,
      paymentStatus: view.paymentStatus,
      placedAt: view.placedAt,
      fulfilmentMode: view.fulfilmentMode,
      deliveryAddress: view.deliveryAddress ?? null,
      delivery: null,
      lines: view.lines.map((l) => ({
        name: l.product.name,
        quantity: l.qtyOrdered,
        uom: l.uom,
        weightKg: l.fulfilledWeightKg,
        unitPricePesewas: l.agreedUnitPricePesewas,
        lineTotalPesewas: l.finalLineTotalPesewas ?? l.estimatedLineTotalPesewas,
        status: l.lineStatus,
      })),
      deliveryFeePesewas: view.deliveryFeePesewas,
      estimatedTotalPesewas: view.estimatedTotalPesewas,
      finalTotalPesewas: view.finalTotalPesewas,
      paidPesewas: view.paidPesewas,
      currency: 'GHS',
      documents:
        view.billingDocument === null || view.billingDocument.number === null || view.completedAt === null
          ? []
          : [{ id: view.billingDocument.id, docType: view.billingDocument.docType, documentNo: view.billingDocument.number, issuedAt: view.completedAt, grossPesewas: view.finalTotalPesewas, currency: 'GHS' }],
      pendingConsent: view.pendingConsent === null ? null : customerConsentOf(view),
    };
  }
}

/** What the customer is asked, in words, with the total they would pay for the line (FR-ORD-013, CR-053). */
function customerConsentOf(view: SalesOrderView): NonNullable<CustomerOrderView['pendingConsent']> {
  const c = view.pendingConsent!;
  const line = view.lines.find((l) => l.id === c.lineId);
  const name = line?.product.name ?? '';
  if (c.kind === 'HIGHER_TOTAL') return { kind: c.kind, detail: `${name}: weighed at ${line?.fulfilledWeightKg ?? ''} kg, above what you were shown`, proposedTotalPesewas: c.weighedTotalPesewas };
  if (c.kind === 'SUBSTITUTION') return { kind: c.kind, detail: `${name}: we can send ${c.proposed!.quantity} ${c.proposed!.uom} of ${c.proposed!.productName} instead`, proposedTotalPesewas: c.proposedTotalPesewas };
  return { kind: c.kind, detail: `${name}: we can send ${c.proposed!.quantity} ${c.proposed!.uom} of the ${line?.qtyOrdered ?? ''} you ordered`, proposedTotalPesewas: null };
}

