import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Billing, BillingDocumentView } from '../../bil';
import type { Authoriser, PrincipalNames } from '../../iam';
import {
  InsufficientStockError,
  reservationLockKey,
  StockUnitNotAvailableError,
  StockUnitOnHoldError,
  StockUnitReservedError,
  type PromisableStock,
  type Reservations,
  type StockExceptions,
  type StockQueries,
  type StockUnits,
} from '../../inv';
import { extendPrice, type MasterDataRefs, type PriceBasis, type PricingService, type ProductFacts, type DeliveryZoneFacts, type Storefront } from '../../mdm';
import type { Payments, PaymentView } from '../../pay';
import { judgeConfirmation, planLineReservation, receivedForOrder } from '../domain/confirmation';
import { quotedLinePricing, quotedOrderEstimate } from '../domain/quoted-line';
import { inWeightBand } from '../domain/backorder-hold';
import { zoneFee, type BackorderLine } from '../domain/dispatch';
import { judgeOverride } from '../domain/price-override';
import { lineNumber } from '../domain/line-numbers';
import { paymentStatusOf, type OrderStatus, type PaymentStatus } from '../domain/order';
import { pageProbe, windowAfter } from '../domain/paging';
import type { OrderConfirmed, OrderPlaced } from '../events';
import { CreditRefusedError, OrderInvalidError, OrderStockShortError, PriceOverrideNeedsApprovalError, QuoteRequiredError, type SaleRule } from './errors';
import type { CreditOrder, CreditOverridePending, CreditPolicyAnswer, OrderConfirmationPolicy } from './order-confirmation-policy';
import type { ApprovalPendingView } from './order-reversals';
import type { FlaggedLine, PriceOverrides } from './price-overrides';
import type { FulfilmentStore } from './fulfilment-store';
import { orderFulfilmentExtrasIn, type OrderFulfilmentExtras } from './order-extras';
import type { Deliveries, DeliverySummaryView } from '../../del';
import type { NewOrderLine, OrderHeaderRecord, OrderLineRecord, OrderRecord, OrderStore, ShiftSalesSummary } from './order-store';

const READ = 'ord.order.read';
const CREATE = 'ord.order.create';
const CONFIRM = 'ord.order.confirm';
/** The store's narrower read of an order (the owner, 2026-11-23, A-335): lines, quantities and delivery, no money. */
const STORE_READ = 'ord.order.read.fulfilment';
const PROFORMA = 'bil.proforma.create';
export const ORDER_PLACED = 'ord.OrderPlaced';
export const ORDER_CONFIRMED = 'ord.OrderConfirmed';

/** An order line as staff enter it (the contract's `OrderLineInput`): the quantity in `uom`, the base unit by default. */
export interface OrderLineInput {
  readonly productId: string;
  readonly stockUnitId?: string | null;
  readonly quantity: string;
  /** The unit sold (B09e): a crate of eggs, priced by the crate's own entry and reserved as 30 eggs. */
  readonly uom?: string | null;
  readonly gradeId?: string | null;
  readonly weightKg?: string | null;
  readonly agreedUnitPricePesewas?: bigint | null;
  readonly varianceReasonCode?: string | null;
}

/** The contract's `OrderCreate`. */
export interface OrderCreateRequest {
  readonly channel: 'WHOLESALE' | 'ONLINE';
  readonly customerId: string;
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly paymentTerms: 'PREPAID' | 'COD' | 'CREDIT';
  readonly deliveryAddressId?: string | null;
  readonly deliverySlotId?: string | null;
  readonly lines: readonly OrderLineInput[];
  readonly couponCode?: string | null;
  readonly notes?: string | null;
}

/** A staff delivery order's address snapshot and zone (B11 continued 8). */
interface StaffDelivery {
  readonly zone: DeliveryZoneFacts;
  readonly snapshot: Readonly<Record<string, string | null>>;
}

/** A line of an accepted quote, as QUO converts it (FR-QUO-011): priced by the quote line it names. */
export interface QuoteOrderLine {
  readonly quoteLineId: string;
  readonly productId: string;
  readonly stockUnitId: string | null;
  /** The quote line's weight band, for a line of animals naming none (B11u continued, BL-124): its animals are of it. */
  readonly weightBandId: string | null;
  /** In `uom`: a crate, a single egg or the base unit (CR-045). */
  readonly quantity: string;
  readonly uom: string;
  readonly priceBasis: PriceBasis;
  /** The quoted price: what the buyer agreed and pays. */
  readonly unitPricePesewas: bigint;
  /**
   * The list price the quote line recorded at issue for its unit, and the engine's floor beside it (B11u, A-350); null
   * where the engine did not price the line. The order line keeps it as its resolved price, the difference a variance.
   */
  readonly listUnitPricePesewas: bigint | null;
  readonly engineFloorUnitPricePesewas: bigint | null;
}

/** An accepted quote converted to its one order (FR-QUO-011): the quote is the order's source document. */
export interface QuoteOrderRequest {
  readonly quoteId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly salespersonId: string;
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly paymentTerms: 'PREPAID' | 'COD' | 'CREDIT';
  /** A delivery's address: one of the customer's own saved ones, as createOrder takes it (B11u continued, BL-123). */
  readonly deliveryAddressId: string | null;
  readonly deliverySlotId: string | null;
  /** The fee the buyer accepted on the quote, in its pricing mode, charged once on the first dispatch (A-331 (b)). */
  readonly deliveryFeePesewas: bigint;
  /** The tax the accepted version worked out on its lines and fee by the invoice's rule (A-352 (a)); counted when tax-exclusive. */
  readonly taxPesewas: bigint;
  readonly taxInclusive: boolean;
  readonly lines: readonly QuoteOrderLine[];
}

export interface OrderQuery {
  readonly channel: OrderHeaderRecord['channel'] | null;
  readonly status: OrderStatus | null;
  readonly customerId: string | null;
  readonly shiftId: string | null;
  readonly salespersonId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly q: string | null;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The contract's `OrderLine`: staff only, with the full pricing record. */
export interface OrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly qtyOrdered: string;
  readonly uom: string;
  readonly estimatedWeightKg: string | null;
  readonly tolerancePercent: string | null;
  readonly qtyFulfilled: string;
  readonly fulfilledWeightKg: string | null;
  readonly weightSource: OrderLineRecord['weightSource'];
  readonly qtyBackordered: string;
  readonly priceSource: OrderLineRecord['priceSource'];
  readonly priceBasis: PriceBasis;
  readonly priceListEntryId: string | null;
  readonly quoteLineId: string | null;
  /** The quote line's weight band a converted line's animals are of (B11u continued, BL-124); null otherwise. */
  readonly weightBandId: string | null;
  readonly resolvedUnitPricePesewas: number;
  readonly floorUnitPricePesewas: number;
  readonly ceilingUnitPricePesewas: number;
  readonly agreedUnitPricePesewas: number;
  readonly variancePesewas: number;
  readonly varianceDirection: 'BELOW' | 'ABOVE' | null;
  readonly varianceReasonCode: string | null;
  readonly varianceApprovalRequestId: string | null;
  readonly discountPesewas: number;
  readonly estimatedLineTotalPesewas: number;
  readonly finalLineTotalPesewas: number | null;
  readonly lineStatus: OrderLineRecord['lineStatus'];
  readonly stockException: { readonly id: string; readonly kind: string } | null;
}

/** The contract's `SalesOrder`. */
export interface SalesOrderView {
  readonly id: string;
  readonly orderNo: string | null;
  readonly channel: OrderHeaderRecord['channel'];
  readonly status: OrderStatus;
  readonly paymentStatus: PaymentStatus;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly paymentTerms: OrderHeaderRecord['paymentTerms'];
  readonly fulfilmentMode: OrderHeaderRecord['fulfilmentMode'];
  readonly source: DocumentRefRecord | null;
  readonly parentOrderId: string | null;
  readonly shiftId: string | null;
  readonly salesperson: { readonly id: string; readonly displayName: string } | null;
  readonly deliveryAddress: unknown;
  readonly deliveryZone: null;
  readonly deliveryFeePesewas: number;
  /** The order's live delivery once dispatched (B11 continued); null before. */
  readonly delivery: DeliverySummaryView | null;
  readonly taxInclusive: boolean;
  readonly estimatedTotalPesewas: number;
  readonly maximumTotalPesewas: number;
  readonly finalTotalPesewas: number | null;
  readonly paidPesewas: number;
  readonly outstandingPesewas: number;
  readonly currency: 'GHS';
  readonly billingDocument: DocumentRefRecord | null;
  readonly creditCheck: OrderHeaderRecord['creditCheck'];
  readonly isOffline: boolean;
  readonly placedAt: string;
  readonly completedAt: string | null;
  readonly recordedAt: string;
  readonly lines: readonly OrderLineView[];
  readonly adjustments: readonly never[];
  readonly notes: string | null;
  readonly branchId: string;
  readonly version: number;
  /** The order's pick lists, oldest first (CR-053 point 1). */
  readonly fulfilments: OrderFulfilmentExtras['fulfilments'];
  /** What the order waits for its customer to answer, or null (CR-053 point 2). */
  readonly pendingConsent: OrderFulfilmentExtras['pendingConsent'];
}

/** A line as the store reads it (`OrderFulfilmentViewLine`): what to pick and what was picked, never a price. */
export interface OrderFulfilmentViewLine {
  readonly id: string;
  readonly lineNo: number;
  readonly product: OrderLineView['product'];
  readonly stockUnit: OrderLineView['stockUnit'];
  readonly qtyOrdered: string;
  readonly uom: string;
  readonly estimatedWeightKg: string | null;
  readonly tolerancePercent: string | null;
  readonly qtyFulfilled: string;
  readonly fulfilledWeightKg: string | null;
  readonly weightSource: OrderLineView['weightSource'];
  readonly qtyBackordered: string;
  readonly lineStatus: OrderLineView['lineStatus'];
}

/**
 * The contract's `OrderFulfilmentView` (the owner, 2026-11-23, A-335): an order as the Storekeeper reads it at their own
 * branch: its lines, quantities and delivery details, and never a payment, credit, price or total. Built by allow-list.
 */
export interface OrderFulfilmentView {
  readonly id: string;
  readonly orderNo: string | null;
  readonly branchId: string;
  readonly channel: SalesOrderView['channel'];
  readonly status: OrderStatus;
  readonly fulfilmentMode: SalesOrderView['fulfilmentMode'];
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly deliveryAddress: unknown;
  readonly delivery: SalesOrderView['delivery'];
  readonly notes: string | null;
  readonly placedAt: string;
  readonly fulfilments: SalesOrderView['fulfilments'];
  readonly lines: readonly OrderFulfilmentViewLine[];
}

/** The store's fields of an order, by allow-list: a field added to `SalesOrderView` never reaches the store unnamed. */
export function fulfilmentViewOf(o: SalesOrderView): OrderFulfilmentView {
  return {
    id: o.id,
    orderNo: o.orderNo,
    branchId: o.branchId,
    channel: o.channel,
    status: o.status,
    fulfilmentMode: o.fulfilmentMode,
    customer: o.customer === null ? null : { id: o.customer.id, publicId: o.customer.publicId, name: o.customer.name },
    contactName: o.contactName,
    contactPhone: o.contactPhone,
    deliveryAddress: o.deliveryAddress,
    delivery: o.delivery === null ? null : { id: o.delivery.id, deliveryNo: o.delivery.deliveryNo, status: o.delivery.status, slotDate: o.delivery.slotDate, slotStartsAt: o.delivery.slotStartsAt, slotEndsAt: o.delivery.slotEndsAt },
    notes: o.notes,
    placedAt: o.placedAt,
    fulfilments: o.fulfilments.map((f) => ({ id: f.id, docType: f.docType, number: f.number })),
    lines: o.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      product: { id: l.product.id, sku: l.product.sku, name: l.product.name },
      stockUnit: l.stockUnit === null ? null : { id: l.stockUnit.id, identifier: l.stockUnit.identifier, tracking: l.stockUnit.tracking },
      qtyOrdered: l.qtyOrdered,
      uom: l.uom,
      estimatedWeightKg: l.estimatedWeightKg,
      tolerancePercent: l.tolerancePercent,
      qtyFulfilled: l.qtyFulfilled,
      fulfilledWeightKg: l.fulfilledWeightKg,
      weightSource: l.weightSource,
      qtyBackordered: l.qtyBackordered,
      lineStatus: l.lineStatus,
    })),
  };
}

/** The contract's `OrderStatusChange`. */
export interface OrderStatusChangeView {
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus;
  readonly reason: string | null;
  readonly actor: { readonly id: string; readonly displayName: string };
  readonly occurredAt: string;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const lineField = (i: number, name: string) => `/lines/${i}/${name}`;
const isSet = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;
const creditOrderOf = (o: OrderHeaderRecord): CreditOrder => ({ id: o.id, orderNo: o.orderNo, customerId: o.customerId, branchId: o.branchId, estimatedTotalPesewas: o.estimatedTotalPesewas });

/** An order's own contact, as a customer message is addressed (`Orders.messageContactsIn`). */
export interface MessageContact {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly contactName: string | null;
  readonly phoneE164: string | null;
}

/**
 * Orders (FR-ORD-001, FR-ORD-002, FR-ORD-003, FR-ORD-005, FR-ORD-016): the one order record of every channel as staff
 * read it, enter it for a phone, WhatsApp or wholesale customer, and confirm it. Each handler authorises in the
 * application layer at the order's branch (ADR-0035): `ord.order.read`, `ord.order.create`, `ord.order.confirm`.
 * An order is entered PLACED, every line priced by MDM's engine at its time with the pricing record the line keeps; it
 * is confirmed only after its payment or credit check passes, reserving every line through INV or nothing, in one
 * serializable transaction. Completing an order posts through `SalePosting.postIn`, the one sale path (B11's
 * fulfilment, B9b's till); cancellation, voids, returns and price override approvals are B09a continued 2c (A-225).
 */
export class Orders {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: OrderStore,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly units: StockUnits,
    private readonly stock: StockQueries,
    private readonly reservations: Reservations,
    private readonly exceptions: StockExceptions,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly policies: readonly OrderConfirmationPolicy[],
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly overrides: PriceOverrides,
    private readonly fulfilmentStore: FulfilmentStore,
    private readonly deliveries: Deliveries,
    private readonly storefront: Storefront,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** getOrder: at the order's branch; another branch's order is refused as any other, never named. */
  get(actor: Actor | undefined, id: string): Promise<SalesOrderView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, READ, { branchId: order.branchId });
      return (await this.viewsIn(tx, [order]))[0]!;
    });
  }

  /**
   * getOrderFulfilmentView (the owner, 2026-11-23, A-335): the order as the store reads it, under its own permission
   * `ord.order.read.fulfilment`, authorised here (ADR-0035), never `ord.order.read` with fields dropped. Only at a
   * branch the caller holds it for whole: an order elsewhere answers 404 as an unknown one does, so the store cannot
   * learn another branch's orders exist (A-344).
   */
  getForFulfilment(actor: Actor | undefined, id: string): Promise<OrderFulfilmentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, STORE_READ);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined || !(await this.wholeBranches(tx, actor!, STORE_READ)).includes(order.branchId)) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, STORE_READ, { branchId: order.branchId });
      return fulfilmentViewOf((await this.viewsIn(tx, [order]))[0]!);
    });
  }

  /** listOrders: every channel at the branches the caller reads whole, newest first (FR-ORD-001). */
  list(actor: Actor | undefined, query: OrderQuery, cursor: string | undefined, limit: number): Promise<Page<SalesOrderView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = await this.wholeBranches(tx, actor!, READ);
      const binding = { operationId: 'listOrders', principalId: actor!.principalId, filters: { ...query, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { ...query, branchIds }, beforeId, pageProbe(limit));
      const orders = (await this.store.orders(tx, found.slice(0, limit))).sort((a, b) => (a.id < b.id ? 1 : -1));
      const data = await this.viewsIn(tx, orders);
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /** listOrderHistory: every status change once, oldest first, with who and when (FR-ORD-002). */
  history(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<OrderStatusChangeView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, READ, { branchId: order.branchId });
      const changes = await this.store.history(tx, id);
      const binding = { operationId: 'listOrderHistory', principalId: actor!.principalId, filters: { id } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const { rows: slice, hasMore } = windowAfter(changes, after, limit);
      const names = await this.principals.refs(
        tx,
        slice.map((c) => c.actorId),
      );
      const data = slice.map((c) => ({
        fromStatus: c.fromStatus,
        toStatus: c.toStatus,
        reason: c.reason,
        actor: names.get(c.actorId) ?? { id: c.actorId, displayName: c.actorId },
        occurredAt: c.occurredAt.toISOString(),
      }));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: slice.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /**
   * createOrder (FR-ORD-001, FR-ORD-003, FR-ORD-004, A-224): an order for a customer at the one branch the caller enters
   * orders for, PLACED with its number, every line priced by the engine now; nothing is reserved or charged yet. A line
   * the engine cannot price is QUOTE_REQUIRED. A price outside the band, or below list beyond the seller's per-line
   * limit, makes the order wait for a different user's approval: it is entered PLACED with those lines flagged and a
   * `PRICE_OVERRIDE` approval asked for, and the answer is 202 `ApprovalPending`; it cannot be confirmed until approved
   * (A-230). Replayed by its Idempotency-Key.
   */
  async create(actor: Actor | undefined, request: OrderCreateRequest, key: string): Promise<StoredResponse<SalesOrderView | ApprovalPendingView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const branches = await this.wholeBranches(tx, actor!, CREATE);
      if (branches.length !== 1) throw new OrderInvalidError([{ field: '', rule: 'BRANCH_REQUIRED' }]);
      return branches[0]!;
    });
    const now = this.clock.now();
    const locks = [`SALES_ORDER:${toBusinessDate(now).slice(0, 4)}:${branchId}`];
    return this.uow.run({ isolation: 'serializable', seriesLocks: locks }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE, { branchId });
      const claim = await this.idempotency.claim(tx, {
        operationId: 'createOrder',
        principalId: actor!.principalId,
        key,
        request: { ...request, lines: request.lines.map((l) => ({ ...l, agreedUnitPricePesewas: l.agreedUnitPricePesewas?.toString() ?? null })) },
      });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView | ApprovalPendingView>;

      const at = this.clock.now();
      const broken: SaleRule[] = [];
      if (request.fulfilmentMode === 'DELIVERY' && !isSet(request.deliveryAddressId)) broken.push({ field: '/deliveryAddressId', rule: 'DELIVERY_ADDRESS_REQUIRED' });
      // A slot is booked from the checkout's choice at dispatch (A-362 (e)); a staff order's slot is not built (A-368 (a)).
      if (request.fulfilmentMode === 'DELIVERY' && isSet(request.deliverySlotId)) broken.push({ field: '/deliverySlotId', rule: 'SLOT_NOT_AVAILABLE' });
      if (request.fulfilmentMode === 'COLLECTION' && isSet(request.deliveryAddressId)) broken.push({ field: '/deliveryAddressId', rule: 'NOT_FOR_COLLECTION' });
      if (request.fulfilmentMode === 'COLLECTION' && isSet(request.deliverySlotId)) broken.push({ field: '/deliverySlotId', rule: 'NOT_FOR_COLLECTION' });
      if (isSet(request.couponCode)) broken.push({ field: '/couponCode', rule: 'COUPON_NOT_AVAILABLE' });
      if (request.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
      const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
      if (customer === undefined || !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
      const delivery = request.fulfilmentMode === 'DELIVERY' && isSet(request.deliveryAddressId) ? await this.staffDeliveryIn(tx, branchId, request.customerId, request.deliveryAddressId, broken) : null;
      if (broken.length > 0) throw new OrderInvalidError(broken);

      const limit = await this.overrides.lineLimitIn(tx, actor!, branchId);
      const { view, approval } = await this.placeIn(tx, actor!, { branchId, request, at, limit, salespersonId: actor!.principalId, sourceDocumentId: null, delivery });
      const response: StoredResponse<SalesOrderView | ApprovalPendingView> =
        approval === null ? { status: 201, body: view } : { status: 202, body: this.overrides.pendingView(approval, { id: view.id, number: view.orderNo! }) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * An order entered PLACED, its lines priced by the engine now, numbered, published and audited, in the caller's
   * transaction under its series lock: `createOrder`'s and a standing order's run's (FR-WHL-004) one way in. A line priced
   * outside the band or below list beyond `limit` asks for a `PRICE_OVERRIDE` approval (answered as `approval`).
   */
  private async placeIn(
    tx: Transaction,
    actor: Actor,
    p: { readonly branchId: string; readonly request: OrderCreateRequest; readonly at: Date; readonly limit: bigint; readonly salespersonId: string; readonly sourceDocumentId: string | null; readonly delivery?: StaffDelivery | null },
  ): Promise<{ readonly view: SalesOrderView; readonly approval: Awaited<ReturnType<PriceOverrides['requestIn']>> | null }> {
    const { branchId, request, at, limit } = p;
    const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
    const orderId = this.nextId();
    const { lines: priced, flagged } = await this.priceLines(tx, orderId, branchId, request, at, limit);
    await this.documents.register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId, actorId: actor.principalId });
    const orderNo = await this.numbers.allocateIn(tx, { docType: 'SALES_ORDER', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId, branchCode: branch.code, documentId: orderId });
    const approval =
      flagged.length === 0
        ? null
        : await this.overrides.requestIn(tx, actor, { orderId, orderNo, branchId, customerId: request.customerId, salespersonId: p.salespersonId, lines: flagged });
    const lines = priced.map((l) => (l.varianceRequiresApproval ? { ...l, varianceApprovalRequestId: approval!.id } : l));
    const goods = Money.sum(lines.map((l) => Money.ofPesewas(l.estimatedLineTotalPesewas)));
    // A staff delivery order pays its zone's own fee, waived over the zone's threshold, as at the checkout (B11 continued 8).
    const fee = p.delivery === undefined || p.delivery === null ? Money.zero() : zoneFee(p.delivery.zone, goods);
    const estimated = goods.plus(fee);
    await this.store.insertOrder(tx, {
      id: orderId,
      orderNo,
      channel: request.channel,
      customerId: request.customerId,
      contactName: null,
      contactPhone: null,
      paymentTerms: request.paymentTerms,
      fulfilmentMode: request.fulfilmentMode,
      sourceDocumentId: p.sourceDocumentId,
      shiftDocumentId: null,
      salespersonId: p.salespersonId,
      taxInclusive: true,
      deliveryFeePesewas: fee.pesewas,
      estimatedTotalPesewas: estimated.pesewas,
      maximumTotalPesewas: estimated.pesewas,
      isOffline: false,
      placedAt: at,
      notes: request.notes ?? null,
      branchId,
      actorId: actor.principalId,
      deliveryAddressSnapshot: p.delivery?.snapshot ?? null,
      deliveryZoneId: p.delivery?.zone.id ?? null,
    });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: null, occurredAt: at, actorId: actor.principalId });
    await this.store.insertLines(tx, lines);
    const view = await this.viewOf(tx, orderId);
    const placed: OrderPlaced = {
      orderId,
      orderNo,
      channel: request.channel,
      branchId,
      customerId: request.customerId,
      paymentTerms: request.paymentTerms,
      estimatedTotalPesewas: estimated.toJsonInteger(),
      placedAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_PLACED, subjectType: 'SalesOrder', subjectId: orderId, branchId, payload: placed, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'CREATE', entityType: 'SalesOrder', entityId: orderId, branchId, before: null, after: { ...view } });
    return { view, approval };
  }

  /**
   * A standing order's run (FR-WHL-004, B10 continued 3): a credit order of the standing order's customer at its branch,
   * collected, entered PLACED by the Scheduler (`actor`, a SYSTEM principal) for its salesperson, every line priced by
   * the engine on the run date at the list price, the standing order its source document. Nothing is reserved or
   * confirmed: confirming it runs the credit check like any other order (CR-046). A line the engine cannot price is
   * `QuoteRequiredError`; anything else the order refuses is `OrderInvalidError`. It authorises nothing: WHL's job does.
   */
  async placeStandingIn(
    tx: Transaction,
    actor: Actor,
    request: { readonly standingOrderId: string; readonly branchId: string; readonly customerId: string; readonly salespersonId: string; readonly lines: readonly { readonly productId: string; readonly quantity: string; readonly uom: string }[] },
  ): Promise<SalesOrderView> {
    if (actor.kind !== 'SYSTEM') throw new Error('a standing order is placed by the Scheduler only');
    const order: OrderCreateRequest = {
      channel: 'WHOLESALE',
      customerId: request.customerId,
      fulfilmentMode: 'COLLECTION',
      paymentTerms: 'CREDIT',
      lines: request.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, uom: l.uom })),
      notes: null,
    };
    const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
    if (customer === undefined || !customer.isLive) throw new OrderInvalidError([{ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' }]);
    const { view, approval } = await this.placeIn(tx, actor, { branchId: request.branchId, request: order, at: this.clock.now(), limit: 0n, salespersonId: request.salespersonId, sourceDocumentId: request.standingOrderId });
    // At the list price no line differs from it, so no override is ever asked for here.
    if (approval !== null) throw new Error(`standing order ${request.standingOrderId}: a list-priced line asked for a price override`);
    return view;
  }

  /**
   * confirmOrder (FR-ORD-005, A-224): a PLACED order's payment or credit check (the `OrderConfirmationPolicy` port),
   * then every line reserved through INV from the stock a remote buyer may be promised, oldest first, held for the
   * order until fulfilment. If any line cannot be covered nothing is reserved, the order stays PLACED and the answer
   * names each short line (422 STOCK_UNAVAILABLE). The balances' locks are taken before BEGIN, so two confirmations of
   * the last crate queue and the second is refused, never both held (ADR-0005, A-060).
   */
  async confirm(actor: Actor | undefined, id: string, key: string, request: { readonly creditOverrideReason?: string | undefined } = {}): Promise<StoredResponse<SalesOrderView | CreditOverridePending>> {
    const locks = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CONFIRM);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, CONFIRM, { branchId: order.branchId });
      const balances = await this.stock.promisableIn(
        tx,
        order.branchId,
        order.lines.map((l) => l.productId),
      );
      return balances.map((b) => reservationLockKey(b.productId, b.stockUnitId, b.locationId));
    });
    return this.uow.run({ isolation: 'serializable', seriesLocks: locks }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CONFIRM);
      const overrideReason = request.creditOverrideReason ?? null;
      const claim = await this.idempotency.claim(tx, { operationId: 'confirmOrder', principalId: actor!.principalId, key, request: overrideReason === null ? { id } : { id, creditOverrideReason: overrideReason } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView | CreditOverridePending>;
      const header = await this.store.lock(tx, id);
      if (header === null) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, CONFIRM, { branchId: header.branchId });
      if (header.status !== 'PLACED')
        throw new InvalidStateTransitionError(`order ${id} is ${header.status}`, [{ field: null, code: header.status, message: translate('error.invalid_state_transition') }]);
      const before = await this.viewOf(tx, id);
      const waiting = await this.overrides.unapprovedIn(tx, (await this.store.orders(tx, [id]))[0]!);
      if (waiting.length > 0) throw new PriceOverrideNeedsApprovalError(waiting);

      const received = receivedForOrder(await this.payments.ofOrderIn(tx, id));
      const judged = header.paymentTerms === 'CREDIT' ? await this.creditFor(tx, header) : null;
      if (judged !== null && judged.answer.verdict === 'REFUSED') {
        // CR-046: an order over the limit, past the terms or on hold does not go through. With a written reason and none
        // waiting, the approval is asked for in place of a plain refusal (202) and the order stays PLACED until a
        // different person approves; without one, or while one waits, it is refused with the amounts in words.
        if (overrideReason === null || judged.answer.overridePending) throw new CreditRefusedError(judged.answer);
        const pending = await judged.policy.requestOverrideIn(tx, actor!, creditOrderOf(header), overrideReason);
        const asked: StoredResponse<CreditOverridePending> = { status: 202, body: pending };
        await this.idempotency.complete(tx, claim.id, asked);
        return asked;
      }
      const credit = judged === null ? null : judged.answer.verdict;
      const verdict = judgeConfirmation({ paymentTerms: header.paymentTerms, estimated: Money.ofPesewas(header.estimatedTotalPesewas), received, credit });
      if (!verdict.ok) throw new OrderInvalidError([{ field: '/paymentTerms', rule: verdict.rule }]);

      const [order] = await this.store.orders(tx, [id]);
      const open = order!.lines.filter((l) => l.lineStatus === 'OPEN');
      const balances = await this.stock.promisableIn(
        tx,
        header.branchId,
        open.map((l) => l.productId),
      );
      const left = new Map<number, Quantity>(balances.map((b, i) => [i, b.availableQty]));
      const short: { lineNo: number; wanted: string; short: string }[] = [];
      const planned: { line: OrderLineRecord; wanted: string; pieces: { balance: PromisableStock; qty: Quantity; index: number }[] }[] = [];
      // Stock the order already holds (a quote's hold handed to its order at conversion, B10) is promised already: each
      // line takes what is held of its product (and animal) first and reserves only the rest.
      const alreadyHeld = await this.reservations.activeOfHolderIn(tx, id);
      const heldLeft = alreadyHeld.map((r) => ({ productId: r.productId, stockUnitId: r.stockUnitId, qty: Quantity.parse(r.qty) }));
      // A converted line of a weight band reserves only animals weighed in it (the owner, 2026-11-24, BL-124, A-359).
      const ofBand = await this.bandFilterIn(tx, open, balances);
      for (const line of open) {
        const offered = balances.map((b, index) => ({ b, index })).filter(({ b }) => b.productId === line.productId && (line.stockUnitId === null || b.stockUnitId === line.stockUnitId) && ofBand(line, b));
        // Stock is reserved in the base unit: a line of 4 crates holds 120 eggs (B09e). The shortfall is in the base unit too.
        const base = await this.refs.toBaseIn(tx, line.productId, line.uom, Quantity.parse(line.qtyOrdered));
        if (!base.ok) throw new Error(`order line ${line.id} in ${line.uom} has no exact base quantity (${base.error})`);
        let wantedBase = base.value;
        for (const h of heldLeft) {
          if (wantedBase.isZero() || h.productId !== line.productId || (line.stockUnitId !== null && h.stockUnitId !== line.stockUnitId)) continue;
          const take = h.qty.compareTo(wantedBase) >= 0 ? wantedBase : h.qty;
          h.qty = h.qty.minus(take);
          wantedBase = wantedBase.minus(take);
        }
        if (wantedBase.isZero()) continue;
        const plan = planLineReservation(
          wantedBase,
          offered.map(({ index }) => ({ availableQty: left.get(index)! })),
        );
        if (plan.kind === 'SHORT') {
          short.push({ lineNo: line.lineNo, wanted: base.value.toDecimalString(), short: plan.short.toDecimalString() });
          continue;
        }
        const pieces = plan.pieces.map((p) => ({ balance: offered[p.index]!.b, qty: p.qty, index: offered[p.index]!.index }));
        for (const piece of pieces) left.set(piece.index, left.get(piece.index)!.minus(piece.qty));
        planned.push({ line, wanted: base.value.toDecimalString(), pieces });
      }
      if (short.length > 0) throw new OrderStockShortError(short);

      const reservationIds: string[] = alreadyHeld.map((r) => r.id);
      for (const { line, wanted, pieces } of planned) {
        const held: string[] = [];
        for (const piece of pieces) {
          try {
            held.push(
              await this.reservations.reserveIn(tx, actor!.principalId, {
                productId: line.productId,
                stockUnitId: piece.balance.stockUnitId,
                locationId: piece.balance.locationId,
                qty: piece.qty,
                holderDocumentId: id,
                expiresAt: null,
              }),
            );
          } catch (error) {
            if (error instanceof InsufficientStockError || error instanceof StockUnitNotAvailableError || error instanceof StockUnitReservedError || error instanceof StockUnitOnHoldError) {
              throw new OrderStockShortError([{ lineNo: line.lineNo, wanted, short: piece.qty.toDecimalString() }]);
            }
            throw error;
          }
        }
        if (held.length === 1) await this.store.holdLine(tx, line.id, held[0]!);
        reservationIds.push(...held);
      }

      const at = this.clock.now();
      await this.store.confirm(tx, id, { creditCheck: verdict.creditCheck, at, actorId: actor!.principalId });
      await this.store.recordStatus(tx, id, { id: this.nextId(), fromStatus: 'PLACED', toStatus: 'CONFIRMED', reason: null, occurredAt: at, actorId: actor!.principalId });
      const view = await this.viewOf(tx, id);
      const confirmed: OrderConfirmed = {
        orderId: id,
        orderNo: header.orderNo!,
        branchId: header.branchId,
        customerId: header.customerId,
        creditCheck: verdict.creditCheck,
        reservationIds,
        confirmedAt: at.toISOString(),
      };
      await this.events.publish(tx, { type: ORDER_CONFIRMED, subjectType: 'SalesOrder', subjectId: id, branchId: header.branchId, payload: confirmed, occurredAt: at });
      await this.audit.record(tx, { module: 'ord', action: 'CONFIRM', entityType: 'SalesOrder', entityId: id, branchId: header.branchId, before: { ...before }, after: { ...view } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * issueProforma (A-201): the order's proforma through BIL's `Billing.issueIn`, numbered from its `PROFORMA` series, at
   * the prices the order's lines keep (agreed, with the resolved price beside it), posting nothing to the ledger. Only a
   * PLACED or CONFIRMED order, once, with every override approved: an unapproved price is never offered on paper. A
   * second copy is a reprint (`reprintBillingDocument`). Authorised at the order's branch with `bil.proforma.create`.
   */
  async issueProforma(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<BillingDocumentView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PROFORMA);
      const [order] = await this.store.orders(tx, [id]);
      if (order === undefined) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, PROFORMA, { branchId: order.branchId });
      return order.branchId;
    });
    return this.uow.run({ isolation: 'serializable', seriesLocks: this.billing.seriesLocksFor('PROFORMA', branchId) }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PROFORMA);
      const claim = await this.idempotency.claim(tx, { operationId: 'issueProforma', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BillingDocumentView>;
      const header = await this.store.lock(tx, id);
      if (header === null) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, PROFORMA, { branchId: header.branchId });
      if (header.status !== 'PLACED' && header.status !== 'CONFIRMED') {
        throw new InvalidStateTransitionError(`order ${id} is ${header.status}`, [{ field: null, code: header.status, message: translate('error.invalid_state_transition') }]);
      }
      if (header.proformaDocumentId !== null) throw new OrderInvalidError([{ field: '', rule: 'PROFORMA_ISSUED' }]);
      const [order] = await this.store.orders(tx, [id]);
      const waiting = await this.overrides.unapprovedIn(tx, order!);
      if (waiting.length > 0) throw new PriceOverrideNeedsApprovalError(waiting);
      const open = order!.lines.filter((l) => l.lineStatus !== 'CANCELLED');
      const units = await this.units.factsIn(
        tx,
        open.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
        this.clock.now(),
      );
      const proforma = await this.billing.issueIn(tx, actor, {
        kind: 'PROFORMA',
        branchId: header.branchId,
        customerId: header.customerId,
        orderDocumentId: id,
        taxInclusive: header.taxInclusive,
        lines: open.map((l) => {
          const unit = l.stockUnitId === null ? undefined : units.get(l.stockUnitId);
          return {
            lineKind: 'PRODUCT' as const,
            productId: l.productId,
            stockUnit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
            orderLineRef: l.id,
            quantity: l.qtyOrdered,
            uom: l.uom,
            unitPricePesewas: l.agreedUnitPricePesewas,
            resolvedUnitPricePesewas: l.resolvedUnitPricePesewas,
          };
        }),
      });
      const at = this.clock.now();
      await this.store.setProforma(tx, id, { documentId: proforma.id, at, actorId: actor!.principalId });
      await this.audit.record(tx, {
        module: 'ord',
        action: 'ISSUE_PROFORMA',
        entityType: 'SalesOrder',
        entityId: id,
        branchId: header.branchId,
        before: { proformaDocumentId: null },
        after: { proformaDocumentId: proforma.id, documentNo: proforma.documentNo, grossPesewas: proforma.grossPesewas },
      });
      const response = { status: 201, body: proforma };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** The series lock an order entered at a branch takes before BEGIN (A-186): QUO's conversion holds it. */
  locksFor(branchId: string): string[] {
    return [`SALES_ORDER:${toBusinessDate(this.clock.now()).slice(0, 4)}:${branchId}`];
  }

  /**
   * The backorder a dispatch or a collection leaves (FR-ORD-012, ADR-0094), in the caller's serializable transaction,
   * which holds `locksFor`: an order of its own number naming the order it completes (`parent_order_id`, always the first
   * order, so a backorder's own backorder names the same parent), with the parent's branch, customer, contact, terms,
   * fulfilment mode and delivery address, **no delivery fee** (charged once, on the first dispatch: A-331 (b), and the
   * database refuses one, `ck_sales_order_backorder`), and one line per line short at packing: what was not sent, at the
   * price agreed on the order and its pricing record, extended once. It is written PLACED and confirmed at once with the
   * parent's credit check (an order on account is checked again at its own dispatch). It keeps what the first order
   * held of the stock not sent (the owner, 2026-11-24, BL-123; A-366 (a) amended): the caller hands it over in the same
   * transaction (`Dispatches.endPromisesIn`); what nothing held waits for stock. The caller has authorised the dispatch.
   */
  async backorderIn(tx: Transaction, actor: Actor, parent: OrderRecord, lines: readonly BackorderLine[], at: Date): Promise<{ readonly id: string; readonly orderNo: string }> {
    const rootId = parent.parentOrderId ?? parent.id;
    const branch = (await this.refs.branchesIn(tx, [parent.branchId])).get(parent.branchId)!;
    const orderId = this.nextId();
    await this.documents.register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId: parent.branchId, actorId: actor.principalId });
    const orderNo = await this.numbers.allocateIn(tx, { docType: 'SALES_ORDER', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId: parent.branchId, branchCode: branch.code, documentId: orderId });
    const newLines: NewOrderLine[] = lines.map((b, i) => {
      const from = parent.lines.find((l) => l.id === b.fromLineId)!;
      return {
        ...from,
        id: this.nextId(),
        salesOrderId: orderId,
        lineNo: lineNumber(i),
        qtyOrdered: b.qty,
        qtyFulfilled: '0.000',
        fulfilledWeightKg: null,
        weightSource: null,
        estimatedLineTotalPesewas: b.estimatedLineTotalPesewas,
        finalLineTotalPesewas: null,
        reservationId: null,
        stockMovementId: null,
        stockExceptionId: null,
        estimatedWeightKg: null,
        tolerancePercent: null,
        lineStatus: 'OPEN',
      };
    });
    const estimated = Money.sum(newLines.map((l) => Money.ofPesewas(l.estimatedLineTotalPesewas)));
    await this.store.insertOrder(tx, {
      id: orderId,
      orderNo,
      channel: parent.channel,
      customerId: parent.customerId,
      contactName: parent.contactName,
      contactPhone: parent.contactPhone,
      paymentTerms: parent.paymentTerms,
      fulfilmentMode: parent.fulfilmentMode,
      sourceDocumentId: null,
      shiftDocumentId: null,
      salespersonId: parent.salespersonId,
      taxInclusive: parent.taxInclusive,
      deliveryFeePesewas: 0n,
      estimatedTotalPesewas: estimated.pesewas,
      maximumTotalPesewas: estimated.pesewas,
      isOffline: false,
      placedAt: at,
      notes: `Backorder of ${parent.orderNo!}`,
      branchId: parent.branchId,
      actorId: actor.principalId,
      deliveryAddressSnapshot: parent.deliveryAddressSnapshot,
      deliveryZoneId: parent.deliveryZoneId,
      parentOrderId: rootId,
    });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: `Backorder of ${parent.orderNo!}`, occurredAt: at, actorId: actor.principalId });
    await this.store.insertLines(tx, newLines);
    await this.store.confirm(tx, orderId, { creditCheck: parent.creditCheck ?? 'NOT_REQUIRED', at, actorId: actor.principalId });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: 'PLACED', toStatus: 'CONFIRMED', reason: `Backorder of ${parent.orderNo!}, waiting for stock`, occurredAt: at, actorId: actor.principalId });
    await this.audit.record(tx, { module: 'ord', action: 'BACKORDER', entityType: 'SalesOrder', entityId: orderId, branchId: parent.branchId, before: null, after: { parentOrderId: rootId, fromOrderId: parent.id, orderNo, lines: lines.map((l) => ({ ...l, estimatedLineTotalPesewas: l.estimatedLineTotalPesewas.toString() })) } });
    return { id: orderId, orderNo };
  }

  /**
   * An accepted quote's one order (FR-QUO-011, A-310), in QUO's serializable transaction, which holds `locksFor`: entered
   * PLACED on channel QUOTE with the quote as its source document, each line priced `QUOTE` at the quoted price and
   * naming its quote line, nothing re-priced by the engine (the quote's price was the one agreed, approved below the
   * margin floor where it had to be). The owner, 2026-11-23 (B11u, A-350; A-310 (a) reversed in the booking only): the
   * line keeps as its resolved price the list price the quote line recorded at issue, and the difference from the
   * quoted price is its variance under `QUOTED_PRICE`, so the invoice credits sales at list and 4210 with the difference;
   * the customer still pays the quoted price. A line the engine did not price keeps its quoted price as list. The quote's hold on its stock is handed to the order by QUO; the confirmation counts it as promised. The
   * caller has authorised the conversion; this checks the order's own rules as createOrder does.
   */
  async createFromQuoteIn(tx: Transaction, actor: Actor, request: QuoteOrderRequest): Promise<SalesOrderView> {
    const broken: SaleRule[] = [];
    // Delivery from a quote (the owner, 2026-11-24, BL-123; A-310 (e) lifted, A-356) as createOrder takes it (A-368 (a)):
    // the customer's own saved address and its zone, no slot (it is booked at dispatch), never an address to collect.
    if (request.fulfilmentMode === 'DELIVERY' && request.customerId === null) broken.push({ field: '/fulfilmentMode', rule: 'CUSTOMER_REQUIRED' });
    else if (request.fulfilmentMode === 'DELIVERY' && request.deliveryAddressId === null) broken.push({ field: '/deliveryAddressId', rule: 'DELIVERY_ADDRESS_REQUIRED' });
    if (request.fulfilmentMode === 'DELIVERY' && request.deliverySlotId !== null) broken.push({ field: '/deliverySlotId', rule: 'SLOT_NOT_AVAILABLE' });
    if (request.fulfilmentMode === 'COLLECTION' && request.deliveryAddressId !== null) broken.push({ field: '/deliveryAddressId', rule: 'NOT_FOR_COLLECTION' });
    if (request.fulfilmentMode === 'COLLECTION' && request.deliverySlotId !== null) broken.push({ field: '/deliverySlotId', rule: 'NOT_FOR_COLLECTION' });
    if (request.paymentTerms === 'CREDIT' && request.customerId === null) broken.push({ field: '/paymentTerms', rule: 'CUSTOMER_REQUIRED' });
    if (request.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    if (request.customerId !== null) {
      const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
      if (customer === undefined || !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
    }
    const products = await this.refs.productsIn(
      tx,
      request.lines.map((l) => l.productId),
    );
    const units = await this.units.factsIn(
      tx,
      request.lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
      this.clock.now(),
    );
    for (const [i, line] of request.lines.entries()) {
      const product = products.get(line.productId);
      if (product === undefined || !product.isLive) {
        broken.push({ field: lineField(i, 'productId'), rule: 'PRODUCT_NOT_ACTIVE' });
        continue;
      }
      if (line.priceBasis === 'PER_KG') broken.push({ field: lineField(i, 'productId'), rule: 'CATCH_WEIGHT_NOT_AVAILABLE' });
      // A line of animals may name none: its animal is named at picking (the owner, 2026-11-23, B11u, A-351); one head a line.
      if (product.tracking === 'SERIAL' && !Quantity.parse(line.quantity).equals(Quantity.ofUnits(1n))) broken.push({ field: lineField(i, 'quantity'), rule: 'ONE_ANIMAL_PER_LINE' });
      const unit = line.stockUnitId === null ? undefined : units.get(line.stockUnitId);
      if (line.stockUnitId !== null && (unit === undefined || unit.productId !== product.id)) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
      else if (unit !== undefined && (unit.status !== 'ACTIVE' || unit.branchId !== request.branchId)) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_NOT_AVAILABLE' });
    }
    const delivery =
      request.fulfilmentMode === 'DELIVERY' && request.customerId !== null && request.deliveryAddressId !== null ? await this.staffDeliveryIn(tx, request.branchId, request.customerId, request.deliveryAddressId, broken) : null;
    if (broken.length > 0) throw new OrderInvalidError(broken);

    const at = this.clock.now();
    const branch = (await this.refs.branchesIn(tx, [request.branchId])).get(request.branchId)!;
    const orderId = this.nextId();
    const lines: NewOrderLine[] = request.lines.map((l, i) => {
      const total = Money.ofPesewas(l.unitPricePesewas).timesQuantity(Quantity.parse(l.quantity)).pesewas;
      const priced = quotedLinePricing({ quotedUnitPricePesewas: l.unitPricePesewas, listUnitPricePesewas: l.listUnitPricePesewas, engineFloorUnitPricePesewas: l.engineFloorUnitPricePesewas, quantity: Quantity.parse(l.quantity) });
      return {
        id: this.nextId(),
        salesOrderId: orderId,
        lineNo: lineNumber(i),
        productId: l.productId,
        stockUnitId: l.stockUnitId,
        qtyOrdered: Quantity.parse(l.quantity).toDecimalString(),
        uom: l.uom,
        qtyFulfilled: '0.000',
        fulfilledWeightKg: null,
        weightSource: null,
        priceSource: 'QUOTE',
        priceBasis: l.priceBasis,
        priceListEntryId: null,
        quoteLineRef: l.quoteLineId,
        weightBandId: l.weightBandId,
        resolvedUnitPricePesewas: priced.resolvedUnitPricePesewas,
        floorUnitPricePesewas: priced.floorUnitPricePesewas,
        ceilingUnitPricePesewas: priced.ceilingUnitPricePesewas,
        agreedUnitPricePesewas: priced.agreedUnitPricePesewas,
        variancePesewas: priced.variancePesewas,
        varianceDirection: priced.varianceDirection,
        varianceReasonCode: priced.varianceReasonCode,
        varianceRequiresApproval: false,
        varianceApprovalRequestId: null,
        varianceApprovedBy: null,
        varianceApprovedAt: null,
        discountPesewas: 0n,
        estimatedLineTotalPesewas: total,
        finalLineTotalPesewas: null,
        reservationId: null,
        stockMovementId: null,
        lineStatus: 'OPEN',
      };
    });
    await this.documents.register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId: request.branchId, actorId: actor.principalId });
    const orderNo = await this.numbers.allocateIn(tx, { docType: 'SALES_ORDER', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId: request.branchId, branchCode: branch.code, documentId: orderId });
    // The credit check counts what will be invoiced: the lines, the fee and, tax-exclusive, their tax (A-357).
    const estimated = Money.ofPesewas(quotedOrderEstimate({ lineTotalsPesewas: lines.map((l) => l.estimatedLineTotalPesewas), deliveryFeePesewas: request.deliveryFeePesewas, taxPesewas: request.taxPesewas, taxInclusive: request.taxInclusive }));
    await this.store.insertOrder(tx, {
      id: orderId,
      orderNo,
      channel: 'QUOTE',
      customerId: request.customerId,
      contactName: request.contactName,
      contactPhone: request.contactPhone,
      paymentTerms: request.paymentTerms,
      fulfilmentMode: request.fulfilmentMode,
      sourceDocumentId: request.quoteId,
      shiftDocumentId: null,
      salespersonId: request.salespersonId,
      taxInclusive: request.taxInclusive,
      deliveryFeePesewas: request.deliveryFeePesewas,
      estimatedTotalPesewas: estimated.pesewas,
      maximumTotalPesewas: estimated.pesewas,
      isOffline: false,
      placedAt: at,
      notes: null,
      branchId: request.branchId,
      actorId: actor.principalId,
      deliveryAddressSnapshot: delivery?.snapshot ?? null,
      deliveryZoneId: delivery?.zone.id ?? null,
    });
    await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: null, occurredAt: at, actorId: actor.principalId });
    await this.store.insertLines(tx, lines);
    const view = await this.viewOf(tx, orderId);
    const placed: OrderPlaced = {
      orderId,
      orderNo,
      channel: 'QUOTE',
      branchId: request.branchId,
      customerId: request.customerId,
      paymentTerms: request.paymentTerms,
      estimatedTotalPesewas: estimated.toJsonInteger(),
      placedAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_PLACED, subjectType: 'SalesOrder', subjectId: orderId, branchId: request.branchId, payload: placed, occurredAt: at });
    await this.audit.record(tx, { module: 'ord', action: 'CREATE_FROM_QUOTE', entityType: 'SalesOrder', entityId: orderId, branchId: request.branchId, before: null, after: { ...view } });
    return view;
  }

  /**
   * Whether a balance may be reserved for a line (B11u continued, BL-124, A-359): any of its product's, except that a
   * line of a weight band takes only an animal whose last weighing is in the band, half-open (`inWeightBand`); an animal
   * never weighed is not of it.
   */
  private async bandFilterIn(tx: Transaction, lines: readonly OrderLineRecord[], balances: readonly PromisableStock[]): Promise<(line: OrderLineRecord, balance: PromisableStock) => boolean> {
    const banded = lines.filter((l) => l.weightBandId !== null);
    if (banded.length === 0) return () => true;
    const bands = await this.refs.weightBandsIn(
      tx,
      banded.map((l) => l.weightBandId!),
    );
    const animals = await this.units.factsIn(
      tx,
      balances.flatMap((b) => (b.stockUnitId === null ? [] : [b.stockUnitId])),
      this.clock.now(),
    );
    return (line, balance) => line.weightBandId === null || (balance.stockUnitId !== null && inWeightBand(animals.get(balance.stockUnitId)?.lastWeightKg ?? null, bands.get(line.weightBandId) ?? null));
  }

  /** Holds an order line on a reservation handed to the order (a quote's hold at conversion, B10). */
  holdLineIn(tx: Transaction, lineId: string, reservationId: string): Promise<void> {
    return this.store.holdLine(tx, lineId, reservationId);
  }

  /**
   * A staff delivery order's delivery (B11 continued 8): the customer's own saved, live address, snapshotted as the
   * checkout snapshots one, and its zone (the one it is filed under, else the zone delivering to its area or city), which
   * must deliver from the order's branch. Every rule broken is added to `broken`.
   */
  private async staffDeliveryIn(tx: Transaction, branchId: string, customerId: string, addressId: string, broken: SaleRule[]): Promise<StaffDelivery | null> {
    const address = await this.refs.customerAddressIn(tx, addressId);
    if (address === null || !address.isLive || address.customerId !== customerId) {
      broken.push({ field: '/deliveryAddressId', rule: 'ADDRESS_NOT_OF_CUSTOMER' });
      return null;
    }
    const zone = address.deliveryZoneId === null ? await this.storefront.deliveryZoneForIn(tx, address) : ((await this.storefront.deliveryZonesIn(tx, [address.deliveryZoneId])).get(address.deliveryZoneId) ?? null);
    if (zone === null || zone.branchId !== branchId) {
      broken.push({ field: '/deliveryAddressId', rule: 'NO_DELIVERY_ZONE' });
      return null;
    }
    return {
      zone,
      snapshot: {
        recipientName: address.recipientName,
        recipientPhone: address.recipientPhone,
        line1: address.line1,
        area: address.area,
        city: address.city,
        region: address.region,
        digitalAddress: address.digitalAddress,
        directions: address.directions,
      },
    };
  }

  /** The branches where the caller holds the permission for the whole branch; a grant at one location adds none. */
  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  /**
   * An order on account at its dispatch or hand-over (B11 continued 8, the owner, 2026-11-23): the registered policies'
   * judgement of the gross of what is sent (WHL's credit control, through the port: ORD sits below WHL), the order's own
   * estimate never counted beside it. Null when no policy answers, which the caller refuses, never waves through.
   */
  async creditAtDispatchIn(tx: Transaction, order: OrderHeaderRecord, grossPesewas: bigint, documentId: string): Promise<{ readonly policy: OrderConfirmationPolicy; readonly answer: CreditPolicyAnswer } | null> {
    for (const policy of this.policies) {
      const answer = await policy.creditAtDispatchFor(tx, { ...creditOrderOf(order), estimatedTotalPesewas: grossPesewas }, documentId);
      if (answer !== null) return { policy, answer };
    }
    return null;
  }

  /** The due date of an invoice issued today to an order on account, from the customer's terms (WHL), or null. */
  async dueDateIn(tx: Transaction, customerId: string): Promise<string | null> {
    for (const policy of this.policies) {
      const due = await policy.dueDateFor(tx, customerId);
      if (due !== null) return due;
    }
    return null;
  }

  /** A credit override asked at dispatch or hand-over, bound to the gross of what is sent, in the caller's transaction. */
  requestDispatchOverrideIn(tx: Transaction, actor: Actor, policy: OrderConfirmationPolicy, order: OrderHeaderRecord, grossPesewas: bigint, reason: string): Promise<CreditOverridePending> {
    return policy.requestOverrideIn(tx, actor, { ...creditOrderOf(order), estimatedTotalPesewas: grossPesewas }, reason);
  }

  private async creditFor(tx: Transaction, order: OrderHeaderRecord): Promise<{ readonly policy: OrderConfirmationPolicy; readonly answer: CreditPolicyAnswer } | null> {
    for (const policy of this.policies) {
      const answer = await policy.creditFor(tx, creditOrderOf(order));
      if (answer !== null) return { policy, answer };
    }
    return null;
  }

  /**
   * Every line checked and priced by the engine at `at` (ADR-0004, ADR-0001: extended once at the line), as the sale
   * posting prices a sale. A line priced by the kilogram waits for catch weight (B11): its estimate, tolerance and
   * re-pricing at the scale are not built, so it is refused rather than estimated here (A-224).
   */
  private async priceLines(
    tx: Transaction,
    orderId: string,
    branchId: string,
    request: OrderCreateRequest,
    at: Date,
    lineLimit: bigint,
  ): Promise<{ readonly lines: NewOrderLine[]; readonly flagged: FlaggedLine[] }> {
    const products = await this.refs.productsIn(
      tx,
      request.lines.map((l) => l.productId),
    );
    const unitIds = request.lines.flatMap((l) => (isSet(l.stockUnitId) ? [l.stockUnitId] : []));
    const units = await this.units.factsIn(tx, unitIds, at);
    const reasons = await this.refs.reasonCodesIn(
      tx,
      request.lines.flatMap((l) => (isSet(l.varianceReasonCode) ? [l.varianceReasonCode] : [])),
    );
    const broken: SaleRule[] = [];
    const seen = new Set<string>();
    const checked: { index: number; product: ProductFacts; qty: Quantity; uom: string; unitId: string | null; gradeId: string | undefined; weightKg: string | undefined }[] = [];
    for (const [i, line] of request.lines.entries()) {
      const product = products.get(line.productId);
      if (product === undefined || !product.isLive) {
        broken.push({ field: lineField(i, 'productId'), rule: 'PRODUCT_NOT_ACTIVE' });
        continue;
      }
      if (product.stockPolicy === 'NON_STOCK') broken.push({ field: lineField(i, 'productId'), rule: 'PRODUCT_NOT_STOCKED' });
      const unitId = line.stockUnitId ?? null;
      const unit = unitId === null ? undefined : units.get(unitId);
      const sameLine = `${product.id}:${unitId ?? '-'}`;
      if (seen.has(sameLine)) broken.push({ field: lineField(i, 'productId'), rule: 'PRODUCT_REPEATED' });
      seen.add(sameLine);
      if (product.tracking === 'SERIAL' && unitId === null) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_REQUIRED' });
      if (unitId !== null && (unit === undefined || unit.productId !== product.id)) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
      else if (unit !== undefined && (unit.status !== 'ACTIVE' || unit.branchId !== branchId)) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_NOT_AVAILABLE' });
      const qty = Quantity.parse(line.quantity);
      // A line in another unit (a crate) converts through MDM's exact factor, never one of ORD's own (B09e, B06u).
      const uom = line.uom ?? product.baseUom;
      if (uom !== product.baseUom) {
        const converted = await this.refs.toBaseIn(tx, product.id, uom, qty);
        if (!converted.ok) broken.push({ field: lineField(i, 'uom'), rule: converted.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'NO_CONVERSION' });
      }
      if (product.tracking === 'SERIAL' && !qty.equals(Quantity.ofUnits(1n))) broken.push({ field: lineField(i, 'quantity'), rule: 'ONE_ANIMAL_PER_LINE' });
      checked.push({ index: i, product, qty, uom, unitId, gradeId: line.gradeId ?? unit?.gradeId ?? undefined, weightKg: line.weightKg ?? unit?.lastWeightKg ?? undefined });
    }
    if (broken.length > 0) throw new OrderInvalidError(broken);

    const resolved = await this.pricing.resolveIn(tx, {
      channel: request.channel,
      branchId,
      customerId: request.customerId,
      at,
      lines: checked.map((c) => ({
        lineRef: String(c.index),
        productId: c.product.id,
        quantity: c.qty.toDecimalString(),
        ...(c.uom === c.product.baseUom ? {} : { uom: c.uom }),
        ...(c.gradeId === undefined ? {} : { gradeId: c.gradeId }),
        ...(c.weightKg === undefined ? {} : { weightKg: c.weightKg }),
      })),
    });
    const unpriced = resolved.lines.filter((l) => l.outcome !== 'RESOLVED' || l.resolved === null);
    if (unpriced.length > 0) throw new QuoteRequiredError(unpriced.map((l) => ({ field: `/lines/${l.lineRef}`, reason: l.quoteRequiredReason ?? 'NO_RULE' })));

    const lines: NewOrderLine[] = [];
    const flagged: FlaggedLine[] = [];
    for (const c of checked) {
      const line = request.lines[c.index]!;
      const band = resolved.lines.find((l) => l.lineRef === String(c.index))!.resolved!;
      if (band.basis === 'PER_KG') {
        broken.push({ field: lineField(c.index, 'productId'), rule: 'CATCH_WEIGHT_NOT_AVAILABLE' });
        continue;
      }
      const list = BigInt(band.listPricePesewas);
      const agreed = line.agreedUnitPricePesewas ?? list;
      const measure = { quantity: c.qty, weight: null };
      const agreedTotal = extendPrice(agreed, band.basis, measure);
      const resolvedTotal = extendPrice(list, band.basis, measure);
      if (!agreedTotal.ok || !resolvedTotal.ok) throw new Error(`a ${band.basis} line extends without a weight`);
      const variance = resolvedTotal.value > agreedTotal.value ? resolvedTotal.value - agreedTotal.value : agreedTotal.value - resolvedTotal.value;
      const verdict = judgeOverride(
        { listPricePesewas: list, floorPricePesewas: BigInt(band.floorPricePesewas), ceilingPricePesewas: BigInt(band.ceilingPricePesewas) },
        agreed,
        variance,
        lineLimit,
      );
      const reasonCode = line.varianceReasonCode ?? null;
      if (verdict.kind === 'VARIANCE') {
        const reason = reasonCode === null ? undefined : reasons.get(reasonCode);
        if (reasonCode === null) broken.push({ field: lineField(c.index, 'varianceReasonCode'), rule: 'VARIANCE_REASON_REQUIRED' });
        else if (reason === undefined || reason.domain !== 'PRICE_OVERRIDE') broken.push({ field: lineField(c.index, 'varianceReasonCode'), rule: 'VARIANCE_REASON_INVALID' });
        else if (reason.requiresNote) broken.push({ field: lineField(c.index, 'varianceReasonCode'), rule: 'VARIANCE_NOTE_REQUIRED' });
      }
      const record: NewOrderLine = {
        id: this.nextId(),
        salesOrderId: orderId,
        lineNo: lineNumber(c.index),
        productId: c.product.id,
        stockUnitId: c.unitId,
        qtyOrdered: c.qty.toDecimalString(),
        uom: c.uom,
        qtyFulfilled: '0.000',
        fulfilledWeightKg: null,
        weightSource: null,
        priceSource: 'ENGINE',
        priceBasis: band.basis,
        priceListEntryId: band.priceListEntryId,
        resolvedUnitPricePesewas: list,
        floorUnitPricePesewas: BigInt(band.floorPricePesewas),
        ceilingUnitPricePesewas: BigInt(band.ceilingPricePesewas),
        agreedUnitPricePesewas: agreed,
        variancePesewas: verdict.kind === 'VARIANCE' ? variance : 0n,
        varianceDirection: verdict.kind === 'VARIANCE' ? verdict.direction : null,
        varianceReasonCode: verdict.kind === 'VARIANCE' ? reasonCode : null,
        varianceRequiresApproval: verdict.kind === 'VARIANCE' && verdict.approval !== null,
        varianceApprovalRequestId: null,
        varianceApprovedBy: null,
        varianceApprovedAt: null,
        discountPesewas: 0n,
        estimatedLineTotalPesewas: agreedTotal.value,
        finalLineTotalPesewas: null,
        reservationId: null,
        stockMovementId: null,
        lineStatus: 'OPEN',
      };
      lines.push(record);
      if (verdict.kind === 'VARIANCE' && verdict.approval !== null) flagged.push({ ...record, approval: verdict.approval });
    }
    if (broken.length > 0) throw new OrderInvalidError(broken);
    return { lines, flagged };
  }

  /** What a till shift sold, voided and gave away below list (FR-POS-017), for POS's X and Z reports. Read-only. */
  /**
   * The order as a credit policy judges it, in the caller's transaction, locked when `lock` is set; null when there is
   * no such order. With its status and terms, for WHL's credit check and override (CR-046). It authorises nothing.
   */
  async creditOrderIn(tx: Transaction, id: string, lock: boolean): Promise<(CreditOrder & { readonly status: OrderStatus; readonly paymentTerms: OrderHeaderRecord['paymentTerms'] }) | null> {
    const header = lock ? await this.store.lock(tx, id) : ((await this.store.orders(tx, [id]))[0] ?? null);
    return header === null ? null : { ...creditOrderOf(header), status: header.status, paymentTerms: header.paymentTerms };
  }

  /**
   * The customer's confirmed credit orders not yet invoiced, summed at their estimates (SA-21), in the caller's
   * transaction, leaving out `excludingOrderId` (the order being judged, never counted twice: B11 continued 8).
   */
  uninvoicedCreditIn(tx: Transaction, customerId: string, excludingOrderId: string | null = null): Promise<bigint> {
    return this.store.uninvoicedCreditTotal(tx, customerId, excludingOrderId);
  }

  async shiftSalesIn(tx: Transaction, shiftDocumentId: string): Promise<ShiftSalesSummary> {
    return this.store.shiftSales(tx, shiftDocumentId);
  }

  /**
   * The order's own contact for a customer message (NTF, B11 continued 10, A-374 (b)), in the caller's transaction: the
   * number the order was placed with, else its delivery's recipient, as dispatch addressed it; null for an order that does
   * not exist. NTF reads it by the order's id when it queues and again when it sends, never from an event, so a message
   * reaches only the order's own contact. It authorises nothing: NTF sends from the outbox as the system.
   */
  async messageContactsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, MessageContact>> {
    const found = new Map<string, MessageContact>();
    for (const order of await this.store.orders(tx, [...new Set(ids)])) {
      const delivery = order.contactPhone === null ? await this.deliveries.ofOrderIn(tx, order.id) : null;
      found.set(order.id, {
        orderId: order.id,
        orderNo: order.orderNo ?? '',
        branchId: order.branchId,
        customerId: order.customerId,
        contactName: order.contactName ?? delivery?.recipientName ?? null,
        phoneE164: order.contactPhone ?? delivery?.recipientPhone ?? null,
      });
    }
    return found;
  }

  /** The order as the contract reads it, in the caller's transaction (ORD's own reversals answer with it). */
  async viewOf(tx: Transaction, id: string): Promise<SalesOrderView> {
    return (await this.viewsIn(tx, await this.store.orders(tx, [id])))[0]!;
  }

  /** Orders as the contract shows them, every reference named through its module's interface, in the order given. */
  private async viewsIn(tx: Transaction, orders: readonly OrderRecord[]): Promise<SalesOrderView[]> {
    const lines = orders.flatMap((o) => o.lines);
    // One query at a time on the transaction's connection.
    const customers = await this.refs.customersIn(
      tx,
      orders.flatMap((o) => (o.customerId === null ? [] : [o.customerId])),
    );
    const people = await this.principals.refs(
      tx,
      orders.flatMap((o) => (o.salespersonId === null ? [] : [o.salespersonId])),
    );
    const products = await this.refs.productsIn(
      tx,
      lines.map((l) => l.productId),
    );
    const units = await this.units.factsIn(
      tx,
      lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
      this.clock.now(),
    );
    const docs = await this.documents.numberedRefs(
      tx,
      orders.flatMap((o) => [o.billingDocumentId, o.sourceDocumentId].filter(isSet)),
    );
    const exceptions = await this.exceptions.refsIn(
      tx,
      lines.flatMap((l) => (l.stockExceptionId === null ? [] : [l.stockExceptionId])),
    );
    const bills = await this.billing.viewsIn(
      tx,
      orders.flatMap((o) => (o.billingDocumentId === null ? [] : [o.billingDocumentId])),
    );
    const extras = await orderFulfilmentExtrasIn(tx, this.fulfilmentStore, this.refs, orders);
    const deliveries = await this.deliveries.summariesOfOrdersIn(tx, orders.map((o) => o.id));
    const views: SalesOrderView[] = [];
    for (const o of orders) {
      const customer = o.customerId === null ? undefined : customers.get(o.customerId);
      const bill = bills.find((b) => b.id === o.billingDocumentId);
      const money = this.figures(o, bill, await this.payments.ofOrderIn(tx, o.id));
      views.push({
        id: o.id,
        orderNo: o.orderNo,
        channel: o.channel,
        status: o.status,
        paymentStatus: money.paymentStatus,
        customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
        contactName: o.contactName,
        contactPhone: o.contactPhone,
        paymentTerms: o.paymentTerms,
        fulfilmentMode: o.fulfilmentMode,
        source: o.sourceDocumentId === null ? null : (docs.get(o.sourceDocumentId) ?? null),
        parentOrderId: o.parentOrderId,
        shiftId: o.shiftDocumentId,
        salesperson: o.salespersonId === null ? null : (people.get(o.salespersonId) ?? { id: o.salespersonId, displayName: o.salespersonId }),
        deliveryAddress: o.deliveryAddressSnapshot,
        deliveryZone: null,
        deliveryFeePesewas: json(o.deliveryFeePesewas),
        delivery: deliveries.get(o.id) ?? null,
        taxInclusive: o.taxInclusive,
        estimatedTotalPesewas: json(o.estimatedTotalPesewas),
        maximumTotalPesewas: json(o.maximumTotalPesewas),
        finalTotalPesewas: o.finalTotalPesewas === null ? null : json(o.finalTotalPesewas),
        paidPesewas: money.paid,
        outstandingPesewas: money.outstanding,
        currency: 'GHS',
        billingDocument: o.billingDocumentId === null ? null : (docs.get(o.billingDocumentId) ?? null),
        creditCheck: o.creditCheck,
        isOffline: o.isOffline,
        placedAt: o.placedAt.toISOString(),
        completedAt: o.completedAt?.toISOString() ?? null,
        recordedAt: o.recordedAt.toISOString(),
        lines: o.lines.map((l) => {
          const product = products.get(l.productId);
          const unit = l.stockUnitId === null ? undefined : units.get(l.stockUnitId);
          return {
            id: l.id,
            lineNo: l.lineNo,
            product: { id: l.productId, sku: product?.sku ?? '', name: product?.name ?? '' },
            stockUnit: l.stockUnitId === null ? null : { id: l.stockUnitId, identifier: unit?.identifier ?? '', tracking: unit?.tracking ?? 'LOT' },
            qtyOrdered: l.qtyOrdered,
            uom: l.uom,
            estimatedWeightKg: l.estimatedWeightKg,
            tolerancePercent: l.tolerancePercent,
            qtyFulfilled: l.qtyFulfilled,
            fulfilledWeightKg: l.fulfilledWeightKg,
            weightSource: l.weightSource,
            qtyBackordered: l.qtyBackordered,
            priceSource: l.priceSource,
            priceBasis: l.priceBasis,
            priceListEntryId: l.priceListEntryId,
            quoteLineId: l.quoteLineRef,
            weightBandId: l.weightBandId,
            resolvedUnitPricePesewas: json(l.resolvedUnitPricePesewas),
            floorUnitPricePesewas: json(l.floorUnitPricePesewas),
            ceilingUnitPricePesewas: json(l.ceilingUnitPricePesewas),
            agreedUnitPricePesewas: json(l.agreedUnitPricePesewas),
            variancePesewas: json(l.variancePesewas),
            varianceDirection: l.varianceDirection,
            varianceReasonCode: l.varianceReasonCode,
            varianceApprovalRequestId: l.varianceApprovalRequestId,
            discountPesewas: json(l.discountPesewas),
            estimatedLineTotalPesewas: json(l.estimatedLineTotalPesewas),
            finalLineTotalPesewas: l.finalLineTotalPesewas === null ? null : json(l.finalLineTotalPesewas),
            lineStatus: l.lineStatus,
            stockException: l.stockExceptionId === null ? null : (exceptions.get(l.stockExceptionId) ?? null),
          };
        }),
        adjustments: [],
        notes: o.notes,
        branchId: o.branchId,
        version: o.version,
        fulfilments: extras.get(o.id)!.fulfilments,
        pendingConsent: extras.get(o.id)!.pendingConsent,
      });
    }
    return views;
  }

  /**
   * FR-ORD-016: paid, outstanding and the payment status, from the order's cleared payments and, once issued, its
   * billing document (gross less credits). Before the document, what is outstanding is the estimate less what was
   * received; a pending charge counts for nothing until it clears. Once issued, the document's own allocations are what
   * covers it, so a balance paid at the till against it counts as paid.
   */
  private figures(order: OrderRecord, bill: BillingDocumentView | undefined, all: readonly PaymentView[]): { paid: number; outstanding: number; paymentStatus: PaymentStatus } {
    const cleared = all.filter((p) => p.status === 'CLEARED');
    const sum = (pick: (p: PaymentView) => number) => Money.sum(cleared.map((p) => Money.fromJsonInteger(pick(p))));
    const own = sum((p) => p.allocatedPesewas);
    // Once the document is issued, what settled it is its own allocations, whoever paid them: a balance paid at the till
    // against it (B11 continued 7) names no order, and an order's deposit may also settle its backorder's document.
    const allocated = bill === undefined ? own : Money.fromJsonInteger(bill.settlement.allocatedPesewas);
    const beyond = allocated.compareTo(own) > 0 ? allocated.minus(own) : Money.zero();
    const paid = sum((p) => p.amountPesewas).plus(beyond);
    const refunded = sum((p) => p.refundedPesewas);
    const due = bill === undefined ? null : Money.fromJsonInteger(bill.grossPesewas).minus(Money.fromJsonInteger(bill.settlement.creditedPesewas));
    const paymentStatus = paymentStatusOf({ documentDue: due, allocated, deposits: sum((p) => p.unallocatedPesewas), paid, refunded });
    const owed = due === null ? Money.ofPesewas(order.estimatedTotalPesewas) : due;
    const covered = due === null ? receivedForOrder(cleared) : allocated;
    return { paid: paid.toJsonInteger(), outstanding: owed.compareTo(covered) > 0 ? owed.minus(covered).toJsonInteger() : 0, paymentStatus };
  }
}
