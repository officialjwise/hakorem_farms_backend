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
import { extendPrice, type MasterDataRefs, type PriceBasis, type PricingService, type ProductFacts } from '../../mdm';
import type { Payments, PaymentView } from '../../pay';
import { judgeConfirmation, planLineReservation, receivedForOrder, type CreditAnswer } from '../domain/confirmation';
import { judgeOverride } from '../domain/price-override';
import { lineNumber } from '../domain/line-numbers';
import { paymentStatusOf, type OrderStatus, type PaymentStatus } from '../domain/order';
import { pageProbe, windowAfter } from '../domain/paging';
import type { OrderConfirmed, OrderPlaced } from '../events';
import { OrderInvalidError, OrderStockShortError, PriceOverrideNeedsApprovalError, QuoteRequiredError, type SaleRule } from './errors';
import type { OrderConfirmationPolicy } from './order-confirmation-policy';
import type { ApprovalPendingView } from './order-reversals';
import type { FlaggedLine, PriceOverrides } from './price-overrides';
import type { NewOrderLine, OrderHeaderRecord, OrderLineRecord, OrderRecord, OrderStore } from './order-store';

const READ = 'ord.order.read';
const CREATE = 'ord.order.create';
const CONFIRM = 'ord.order.confirm';
const PROFORMA = 'bil.proforma.create';
export const ORDER_PLACED = 'ord.OrderPlaced';
export const ORDER_CONFIRMED = 'ord.OrderConfirmed';

/** An order line as staff enter it (the contract's `OrderLineInput`): quantities in the product's base unit. */
export interface OrderLineInput {
  readonly productId: string;
  readonly stockUnitId?: string | null;
  readonly quantity: string;
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
  readonly customer: { readonly id: string; readonly customerNo: string; readonly name: string } | null;
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
  readonly delivery: null;
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
      if (request.fulfilmentMode === 'DELIVERY') broken.push({ field: '/fulfilmentMode', rule: 'FULFILMENT_NOT_AVAILABLE' });
      if (request.fulfilmentMode === 'COLLECTION' && isSet(request.deliveryAddressId)) broken.push({ field: '/deliveryAddressId', rule: 'NOT_FOR_COLLECTION' });
      if (request.fulfilmentMode === 'COLLECTION' && isSet(request.deliverySlotId)) broken.push({ field: '/deliverySlotId', rule: 'NOT_FOR_COLLECTION' });
      if (isSet(request.couponCode)) broken.push({ field: '/couponCode', rule: 'COUPON_NOT_AVAILABLE' });
      if (request.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
      const customer = (await this.refs.customersIn(tx, [request.customerId])).get(request.customerId);
      if (customer === undefined || !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
      if (broken.length > 0) throw new OrderInvalidError(broken);

      const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
      const orderId = this.nextId();
      const limit = await this.overrides.lineLimitIn(tx, actor!, branchId);
      const { lines: priced, flagged } = await this.priceLines(tx, orderId, branchId, request, at, limit);
      await this.documents.register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId, actorId: actor!.principalId });
      const orderNo = await this.numbers.allocateIn(tx, { docType: 'SALES_ORDER', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId, branchCode: branch.code, documentId: orderId });
      const approval =
        flagged.length === 0
          ? null
          : await this.overrides.requestIn(tx, actor!, { orderId, orderNo, branchId, customerId: request.customerId, salespersonId: actor!.principalId, lines: flagged });
      const lines = priced.map((l) => (l.varianceRequiresApproval ? { ...l, varianceApprovalRequestId: approval!.id } : l));
      const estimated = Money.sum(lines.map((l) => Money.ofPesewas(l.estimatedLineTotalPesewas)));
      await this.store.insertOrder(tx, {
        id: orderId,
        orderNo,
        channel: request.channel,
        customerId: request.customerId,
        contactName: null,
        contactPhone: null,
        paymentTerms: request.paymentTerms,
        fulfilmentMode: request.fulfilmentMode,
        sourceDocumentId: null,
        shiftDocumentId: null,
        salespersonId: actor!.principalId,
        taxInclusive: true,
        deliveryFeePesewas: 0n,
        estimatedTotalPesewas: estimated.pesewas,
        maximumTotalPesewas: estimated.pesewas,
        isOffline: false,
        placedAt: at,
        notes: request.notes ?? null,
        branchId,
        actorId: actor!.principalId,
      });
      await this.store.recordStatus(tx, orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: null, occurredAt: at, actorId: actor!.principalId });
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
      const response: StoredResponse<SalesOrderView | ApprovalPendingView> =
        approval === null ? { status: 201, body: view } : { status: 202, body: this.overrides.pendingView(approval, { id: orderId, number: orderNo }) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * confirmOrder (FR-ORD-005, A-224): a PLACED order's payment or credit check (the `OrderConfirmationPolicy` port),
   * then every line reserved through INV from the stock a remote buyer may be promised, oldest first, held for the
   * order until fulfilment. If any line cannot be covered nothing is reserved, the order stays PLACED and the answer
   * names each short line (422 STOCK_UNAVAILABLE). The balances' locks are taken before BEGIN, so two confirmations of
   * the last crate queue and the second is refused, never both held (ADR-0005, A-060).
   */
  async confirm(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<SalesOrderView>> {
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
      const claim = await this.idempotency.claim(tx, { operationId: 'confirmOrder', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView>;
      const header = await this.store.lock(tx, id);
      if (header === null) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, CONFIRM, { branchId: header.branchId });
      if (header.status !== 'PLACED')
        throw new InvalidStateTransitionError(`order ${id} is ${header.status}`, [{ field: null, code: header.status, message: translate('error.invalid_state_transition') }]);
      const before = await this.viewOf(tx, id);
      const waiting = await this.overrides.unapprovedIn(tx, (await this.store.orders(tx, [id]))[0]!);
      if (waiting.length > 0) throw new PriceOverrideNeedsApprovalError(waiting);

      const received = receivedForOrder(await this.payments.ofOrderIn(tx, id));
      const credit = header.paymentTerms === 'CREDIT' ? await this.creditFor(tx, header) : null;
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
      const planned: { line: OrderLineRecord; pieces: { balance: PromisableStock; qty: Quantity; index: number }[] }[] = [];
      for (const line of open) {
        const offered = balances.map((b, index) => ({ b, index })).filter(({ b }) => b.productId === line.productId && (line.stockUnitId === null || b.stockUnitId === line.stockUnitId));
        const plan = planLineReservation(
          Quantity.parse(line.qtyOrdered),
          offered.map(({ index }) => ({ availableQty: left.get(index)! })),
        );
        if (plan.kind === 'SHORT') {
          short.push({ lineNo: line.lineNo, wanted: line.qtyOrdered, short: plan.short.toDecimalString() });
          continue;
        }
        const pieces = plan.pieces.map((p) => ({ balance: offered[p.index]!.b, qty: p.qty, index: offered[p.index]!.index }));
        for (const piece of pieces) left.set(piece.index, left.get(piece.index)!.minus(piece.qty));
        planned.push({ line, pieces });
      }
      if (short.length > 0) throw new OrderStockShortError(short);

      const reservationIds: string[] = [];
      for (const { line, pieces } of planned) {
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
              throw new OrderStockShortError([{ lineNo: line.lineNo, wanted: line.qtyOrdered, short: piece.qty.toDecimalString() }]);
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

  /** The branches where the caller holds the permission for the whole branch; a grant at one location adds none. */
  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  private async creditFor(tx: Transaction, order: OrderHeaderRecord): Promise<CreditAnswer> {
    for (const policy of this.policies) {
      const answer = await policy.creditFor(tx, { id: order.id, customerId: order.customerId, branchId: order.branchId, estimatedTotalPesewas: order.estimatedTotalPesewas });
      if (answer !== null) return answer;
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
    const checked: { index: number; product: ProductFacts; qty: Quantity; unitId: string | null; gradeId: string | undefined; weightKg: string | undefined }[] = [];
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
      if (product.tracking === 'SERIAL' && !qty.equals(Quantity.ofUnits(1n))) broken.push({ field: lineField(i, 'quantity'), rule: 'ONE_ANIMAL_PER_LINE' });
      checked.push({ index: i, product, qty, unitId, gradeId: line.gradeId ?? unit?.gradeId ?? undefined, weightKg: line.weightKg ?? unit?.lastWeightKg ?? undefined });
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
        uom: c.product.baseUom,
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
        customer: customer === undefined ? null : { id: customer.id, customerNo: customer.customerNo, name: customer.name },
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
        delivery: null,
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
      });
    }
    return views;
  }

  /**
   * FR-ORD-016: paid, outstanding and the payment status, from the order's cleared payments and, once issued, its
   * billing document (gross less credits). Before the document, what is outstanding is the estimate less what was
   * received; a pending charge counts for nothing until it clears.
   */
  private figures(order: OrderRecord, bill: BillingDocumentView | undefined, all: readonly PaymentView[]): { paid: number; outstanding: number; paymentStatus: PaymentStatus } {
    const cleared = all.filter((p) => p.status === 'CLEARED');
    const sum = (pick: (p: PaymentView) => number) => Money.sum(cleared.map((p) => Money.fromJsonInteger(pick(p))));
    const paid = sum((p) => p.amountPesewas);
    const allocated = sum((p) => p.allocatedPesewas);
    const refunded = sum((p) => p.refundedPesewas);
    const due = bill === undefined ? null : Money.fromJsonInteger(bill.grossPesewas).minus(Money.fromJsonInteger(bill.settlement.creditedPesewas));
    const paymentStatus = paymentStatusOf({ documentDue: due, allocated, deposits: sum((p) => p.unallocatedPesewas), paid, refunded });
    const owed = due === null ? Money.ofPesewas(order.estimatedTotalPesewas) : due;
    const covered = due === null ? receivedForOrder(cleared) : allocated;
    return { paid: paid.toJsonInteger(), outstanding: owed.compareTo(covered) > 0 ? owed.minus(covered).toJsonInteger() : 0, paymentStatus };
  }
}
