import { createUuidV7Generator, Money, Quantity, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { IsolationLevelError, sqlStateOf, type Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { UnauthenticatedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { IdempotencyKeyReusedError, type Idempotency } from '../../../platform/idempotency/idempotency';
import type { Billing, BillingDocumentView } from '../../bil';
import type { ApprovalListing } from '../../iam';
import type { Reservations, Stock, StockUnits } from '../../inv';
import { extendPrice, type MasterDataRefs, type PriceBasis, type PricingService, type ProductFacts } from '../../mdm';
import type { Payments, PaymentView } from '../../pay';
import { lineNumber } from '../domain/line-numbers';
import { judgeTenders, paymentStatusOf, type PaymentStatus } from '../domain/order';
import { judgeOverride, judgePriceApprover, type OverrideApproval } from '../domain/price-override';
import type { OrderCompleted } from '../events';
import { PriceApproverIsSellerError, PriceOverrideNeedsApprovalError, QuoteRequiredError, SaleInvalidError, type SaleRule } from './errors';
import type { ApprovalPendingView } from './order-reversals';
import type { NewOrderLine, OrderRecord, OrderStore, WeightSource } from './order-store';
import { overrideHash, type FlaggedLine, type PriceOverrides } from './price-overrides';

export const ORDER_COMPLETED = 'ord.OrderCompleted';
/** The operation a sale's idempotency key is scoped to (ADR-0014): the order's own client id is the key. */
export const POST_SALE_OPERATION = 'ord.postSale';
const SALE_MOVEMENT = 'SALE_ISSUE';
const UNIQUE_VIOLATION = '23505';

/** Channels whose sale B9a posts; POS needs its shift (B9b), QUOTE its accepted quote lines (B10). */
const POSTABLE_CHANNELS: ReadonlySet<string> = new Set(['ONLINE', 'WHOLESALE']);
/** Fulfilled at the sale; delivery is B11's dispatch. */
const POSTABLE_FULFILMENT: ReadonlySet<string> = new Set(['COUNTER', 'COLLECTION']);

export interface SaleLineRequest {
  readonly productId: string;
  /** The animal sold, or the lot a lot-tracked product is issued from. */
  readonly stockUnitId?: string | null;
  /** A reservation the order's checkout holds for this line, consumed by the issue. */
  readonly reservationId?: string | null;
  readonly fromLocationId: string;
  /** In `uom`, the product's base unit when left out. */
  readonly quantity: string;
  readonly uom?: string;
  /** The weight sold, with its source: required for a line priced per kilogram. */
  readonly weightKg?: string | null;
  readonly weightSource?: WeightSource | null;
  /** The grade the engine prices by; the animal's own grade when left out. */
  readonly gradeId?: string | null;
  /** The price agreed with the buyer; the resolved list price when left out. */
  readonly agreedUnitPricePesewas?: bigint | null;
  readonly varianceReasonCode?: string | null;
}

export interface SaleTenderRequest {
  readonly methodCode: string;
  readonly amountPesewas: bigint;
  readonly register: { readonly id: string; readonly code: string } | null;
}

/** A sale fulfilled and paid at once, on any channel B9a posts (FR-ORD-006). */
export interface SaleRequest {
  /** Client-generated UUIDv7: the order's id and the sale's idempotency key (ADR-0013, ADR-0014). */
  readonly orderId: string;
  readonly channel: 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';
  readonly branchId: string;
  readonly customerId?: string | null;
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly fulfilmentMode: 'COUNTER' | 'COLLECTION' | 'DELIVERY';
  /** The checkout or other document the sale came from, which may hold its reservations. */
  readonly sourceDocumentId?: string | null;
  readonly taxInclusive: boolean;
  /** When the sale happened; now when left out. */
  readonly occurredAt?: Date | null;
  readonly notes?: string | null;
  readonly lines: readonly SaleLineRequest[];
  readonly tenders: readonly SaleTenderRequest[];
}

export interface SaleOrderLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly qtyOrdered: string;
  readonly uom: string;
  readonly qtyFulfilled: string;
  readonly fulfilledWeightKg: string | null;
  readonly weightSource: WeightSource | null;
  readonly priceSource: 'ENGINE' | 'QUOTE' | 'MANUAL_APPROVED';
  readonly priceBasis: PriceBasis;
  readonly priceListEntryId: string | null;
  readonly resolvedUnitPricePesewas: number;
  readonly floorUnitPricePesewas: number;
  readonly ceilingUnitPricePesewas: number;
  readonly agreedUnitPricePesewas: number;
  readonly variancePesewas: number;
  readonly varianceDirection: 'BELOW' | 'ABOVE' | null;
  readonly varianceReasonCode: string | null;
  readonly estimatedLineTotalPesewas: number;
  readonly finalLineTotalPesewas: number | null;
  readonly stockMovementId: string | null;
  readonly lineStatus: string;
}

/** The sale as it was posted: the order, its billing document and its payments. */
export interface SaleView {
  readonly id: string;
  readonly orderNo: string | null;
  readonly channel: OrderRecord['channel'];
  readonly status: OrderRecord['status'];
  readonly paymentStatus: PaymentStatus;
  readonly paymentTerms: OrderRecord['paymentTerms'];
  readonly fulfilmentMode: OrderRecord['fulfilmentMode'];
  readonly customerId: string | null;
  readonly taxInclusive: boolean;
  readonly estimatedTotalPesewas: number;
  readonly finalTotalPesewas: number | null;
  readonly paidPesewas: number;
  readonly outstandingPesewas: number;
  readonly currency: 'GHS';
  readonly billingDocument: { readonly id: string; readonly kind: string; readonly documentNo: string | null; readonly grossPesewas: number } | null;
  readonly payments: readonly PaymentView[];
  readonly lines: readonly SaleOrderLineView[];
  readonly placedAt: string;
  readonly completedAt: string | null;
  readonly branchId: string;
}

interface PlannedLine {
  readonly index: number;
  /** Why the line's agreed price waits for a different user's approval, or null (A-230). */
  readonly approval: OverrideApproval;
  readonly record: NewOrderLine;
  readonly product: ProductFacts;
  readonly baseQty: Quantity;
  readonly weight: { readonly kg: Weight; readonly source: WeightSource } | null;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly fromLocationId: string;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const field = (i: number, name: string) => `/lines/${i}/${name}`;

/** A request as it is hashed for its idempotency key: amounts as strings, times as ISO strings. */
function hashable(request: SaleRequest): unknown {
  return JSON.parse(JSON.stringify(request, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
}

/**
 * SalePosting (FR-ORD-006, FR-ORD-007, DOMAIN_MODEL 5.10, ADR-0010): the one code path that posts a sale on any channel,
 * in the caller's serializable transaction. In that transaction it claims the sale's idempotency key, prices every line
 * through MDM's engine, issues the stock through INV (consuming a line's reservation), issues the receipt through BIL's
 * `Billing.issueIn`, records and allocates the tenders through PAY's `Payments.recordIn`, completes the order with its
 * history, audits it and publishes `ord.OrderCompleted`. The ledger posts the stock issue, the receipt and each payment
 * from their ◆ events in the same transaction, so a failure anywhere leaves nothing behind and the receipt number
 * returns to its series. A replay of the same sale answers the first result and posts nothing. It authorises nothing:
 * the selling command that calls it has (POS's counter sale in B9b, ORD's fulfilment in B11). The caller declares
 * `locksFor` as its `seriesLocks` (A-186).
 */
export class SalePosting {
  private readonly nextId: () => string;

  constructor(
    private readonly store: OrderStore,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly stock: Stock,
    private readonly units: StockUnits,
    private readonly reservations: Reservations,
    private readonly billing: Billing,
    private readonly payments: Payments,
    private readonly numbers: NumberSeries,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly overrides: PriceOverrides,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** The series a sale at the branch allocates from today, as `seriesLocks`: the order's, the receipt's and the journal's. */
  locksFor(branchId: string): string[] {
    const today = toBusinessDate(this.clock.now());
    return [`SALES_ORDER:${today.slice(0, 4)}:${branchId}`, ...this.billing.seriesLocksFor('RECEIPT', branchId)];
  }

  /**
   * Asks for the approval of a sale's price override before the sale posts (A-230): a price outside the band, or below
   * list beyond the seller's per-line limit at the branch, prices exactly as `postIn` will price it. The sale's id is
   * registered as its order's document and a `PRICE_OVERRIDE` approval is asked for on it, binding every flagged line's
   * pricing record; nothing is stocked, issued or paid. Asked again for the same sale, it answers the approval that
   * waits. Once a holder of `ord.price_override.approve` who is not the seller approves it, the same seller posts the
   * same sale through `postIn`. It authorises nothing: the selling command that calls it has.
   */
  async requestOverrideIn(tx: Transaction, actor: Actor | undefined, request: SaleRequest): Promise<ApprovalPendingView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a sale needs an actor');
    const { customerId } = await this.precheck(tx, request);
    const asked = await this.overrides.ofSubjectIn(tx, request.orderId);
    if (asked.some((a) => a.requestedBy !== actor.principalId) || (await this.store.orders(tx, [request.orderId])).length > 0) {
      throw new IdempotencyKeyReusedError('the order id is another sale, or already posted');
    }
    const limit = await this.overrides.lineLimitIn(tx, actor, request.branchId);
    const planned = await this.plan(tx, request, request.occurredAt ?? this.clock.now(), limit);
    const flagged: FlaggedLine[] = planned.flatMap((p) => (p.approval === null ? [] : [{ ...p.record, varianceRequiresApproval: true, approval: p.approval }]));
    if (flagged.length === 0) throw new SaleInvalidError([{ field: '/lines', rule: 'NO_OVERRIDE_TO_APPROVE' }]);
    const pending = asked.find((a) => a.status === 'PENDING');
    if (pending !== undefined) {
      if (pending.payloadHash === overrideHash(request.orderId, customerId, flagged)) return this.overrides.pendingView(pending, { id: request.orderId, number: null });
      throw new SaleInvalidError([{ field: '/lines', rule: 'OVERRIDE_PENDING' }]);
    }
    if (asked.length === 0) await this.register(tx, actor, request);
    const approval = await this.overrides.requestIn(tx, actor, { orderId: request.orderId, orderNo: null, branchId: request.branchId, customerId, salespersonId: actor.principalId, lines: flagged });
    return this.overrides.pendingView(approval, { id: request.orderId, number: null });
  }

  async postIn(tx: Transaction, actor: Actor | undefined, request: SaleRequest): Promise<SaleView> {
    if (tx.isolation !== 'serializable') throw new IsolationLevelError(tx.isolation);
    if (actor === undefined) throw new UnauthenticatedError('a sale needs an actor');
    const claim = await this.idempotency.claim(tx, { operationId: POST_SALE_OPERATION, principalId: actor.principalId, key: request.orderId, request: hashable(request) });
    if (claim.kind === 'REPLAY') return claim.response.body as SaleView;

    const now = this.clock.now();
    const occurredAt = request.occurredAt ?? now;
    const { customerId, branch, customerLocation } = await this.precheck(tx, request);

    // The order is a registered document before anything names it (by its override approval, when one was asked for
    // first by this seller); its number is allocated in this transaction.
    const asked = await this.overrides.ofSubjectIn(tx, request.orderId);
    if (asked.some((a) => a.requestedBy !== actor.principalId)) throw new IdempotencyKeyReusedError('the order id is another person\'s sale');
    if (asked.length === 0) await this.register(tx, actor, request);
    const orderNo = await this.numbers.allocateIn(tx, {
      docType: 'SALES_ORDER',
      fiscalYear: Number(toBusinessDate(now).slice(0, 4)),
      branchId: request.branchId,
      branchCode: branch.code,
      documentId: request.orderId,
    });

    const planned = this.approved(request, customerId, asked, actor.principalId, await this.plan(tx, request, occurredAt, await this.overrides.lineLimitIn(tx, actor, request.branchId)));
    const movements = new Map<string, string>();
    for (const line of planned) {
      const posted =
        line.record.reservationId === null
          ? await this.stock.postIn(tx, actor.principalId, {
              movementType: SALE_MOVEMENT,
              productId: line.product.id,
              stockUnitId: line.stockUnit?.id ?? null,
              branchId: request.branchId,
              fromLocationId: line.fromLocationId,
              toLocationId: customerLocation,
              qty: line.baseQty,
              weight: line.weight,
              sourceDocumentId: request.orderId,
              sourceLineRef: line.record.id,
              occurredAt,
            })
          : await this.reservations.consumeIn(tx, actor.principalId, line.record.reservationId, {
              movementType: SALE_MOVEMENT,
              toLocationId: customerLocation,
              sourceDocumentId: request.orderId,
              sourceLineRef: line.record.id,
              weight: line.weight,
              occurredAt,
            });
      movements.set(line.record.id, posted.id);
    }

    const document = await this.billing.issueIn(tx, actor, {
      kind: 'RECEIPT',
      branchId: request.branchId,
      customerId,
      orderDocumentId: request.orderId,
      taxInclusive: request.taxInclusive,
      occurredAt,
      lines: planned.map((line) => ({
        lineKind: 'PRODUCT' as const,
        productId: line.product.id,
        stockUnit: line.stockUnit,
        orderLineRef: line.record.id,
        quantity: line.record.priceBasis === 'PER_KG' ? line.weight!.kg.toKgString() : line.baseQty.toDecimalString(),
        uom: line.record.priceBasis === 'PER_KG' ? 'KG' : line.product.baseUom,
        weightKg: line.weight?.kg.toKgString() ?? null,
        unitPricePesewas: line.record.agreedUnitPricePesewas,
        resolvedUnitPricePesewas: line.record.resolvedUnitPricePesewas,
      })),
    });
    const gross = Money.fromJsonInteger(document.grossPesewas);
    const tendered = judgeTenders(gross, request.tenders.map((t) => Money.ofPesewas(t.amountPesewas)));
    if (!tendered.ok) throw new SaleInvalidError([{ field: '/tenders', rule: tendered.error }]);

    await this.store.insertOrder(tx, {
      id: request.orderId,
      orderNo,
      channel: request.channel,
      customerId,
      contactName: request.contactName ?? null,
      contactPhone: request.contactPhone ?? null,
      paymentTerms: 'IMMEDIATE',
      fulfilmentMode: request.fulfilmentMode,
      sourceDocumentId: request.sourceDocumentId ?? null,
      shiftDocumentId: null,
      salespersonId: actor.principalId,
      taxInclusive: request.taxInclusive,
      deliveryFeePesewas: 0n,
      estimatedTotalPesewas: gross.pesewas,
      maximumTotalPesewas: gross.pesewas,
      isOffline: false,
      placedAt: occurredAt,
      notes: request.notes ?? null,
      branchId: request.branchId,
      actorId: actor.principalId,
    });
    await this.store.recordStatus(tx, request.orderId, { id: this.nextId(), fromStatus: null, toStatus: 'PLACED', reason: null, occurredAt, actorId: actor.principalId });
    await this.store.insertLines(
      tx,
      planned.map((line) => ({ ...line.record, stockMovementId: movements.get(line.record.id)! })),
    );

    const payments: PaymentView[] = [];
    let left = gross.pesewas;
    for (const [i, tender] of request.tenders.entries()) {
      const applied = tender.amountPesewas < left ? tender.amountPesewas : left;
      left -= applied;
      payments.push(
        await this.payments.recordIn(
          tx,
          actor,
          {
            branchId: request.branchId,
            channel: request.channel,
            methodCode: tender.methodCode,
            amountPesewas: tender.amountPesewas,
            customerId,
            orderDocumentId: request.orderId,
            register: tender.register,
            receivedAt: occurredAt,
            allocations: applied === 0n ? [] : [{ billingDocumentId: document.id, amountPesewas: applied }],
          },
          `/tenders/${i}`,
        ),
      );
    }

    await this.store.complete(tx, request.orderId, { billingDocumentId: document.id, finalTotalPesewas: gross.pesewas, completedAt: now, actorId: actor.principalId });
    await this.store.recordStatus(tx, request.orderId, { id: this.nextId(), fromStatus: 'PLACED', toStatus: 'COMPLETED', reason: null, occurredAt: now, actorId: actor.principalId });
    const [order] = await this.store.orders(tx, [request.orderId]);
    const view = this.view(order!, document, payments);
    const completed: OrderCompleted = {
      orderId: view.id,
      orderNo,
      channel: request.channel,
      branchId: request.branchId,
      customerId,
      billingDocumentId: document.id,
      billingDocumentNo: document.documentNo!,
      finalTotalPesewas: gross.toJsonInteger(),
      paymentIds: payments.map((p) => p.id),
      lines: view.lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, qty: l.qtyFulfilled, finalLineTotalPesewas: l.finalLineTotalPesewas! })),
      placedAt: occurredAt.toISOString(),
      completedAt: now.toISOString(),
    };
    await this.events.publish(tx, { type: ORDER_COMPLETED, subjectType: 'SalesOrder', subjectId: view.id, branchId: request.branchId, payload: completed, occurredAt });
    await this.audit.record(tx, { module: 'ord', action: 'SALE', entityType: 'SalesOrder', entityId: view.id, branchId: request.branchId, before: null, after: { ...view } });
    await this.idempotency.complete(tx, claim.id, { status: 201, body: view });
    return view;
  }

  /** The rules a sale breaks before anything is priced, and where it is sold from and to. */
  private async precheck(tx: Transaction, request: SaleRequest): Promise<{ readonly customerId: string | null; readonly branch: { readonly code: string }; readonly customerLocation: string }> {
    const customerId = request.customerId ?? null;
    const broken: SaleRule[] = [];
    if (!POSTABLE_CHANNELS.has(request.channel)) broken.push({ field: '/channel', rule: 'CHANNEL_NOT_AVAILABLE' });
    if (!POSTABLE_FULFILMENT.has(request.fulfilmentMode)) broken.push({ field: '/fulfilmentMode', rule: 'FULFILMENT_NOT_AVAILABLE' });
    if (request.lines.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    if (request.tenders.length === 0) broken.push({ field: '/tenders', rule: 'NO_TENDERS' });
    if (customerId !== null) {
      const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
      if (customer === undefined || !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
    }
    if (broken.length > 0) throw new SaleInvalidError(broken);
    const branch = (await this.refs.branchesIn(tx, [request.branchId])).get(request.branchId);
    const customerLocation = branch === undefined ? null : await this.refs.virtualLocationIn(tx, request.branchId, 'CUSTOMER');
    if (branch === undefined || customerLocation === null) throw new SaleInvalidError([{ field: '/branchId', rule: 'LOCATION_NOT_IN_BRANCH' }]);
    return { customerId, branch, customerLocation };
  }

  private async register(tx: Transaction, actor: Actor, request: SaleRequest): Promise<void> {
    try {
      await this.documents.register(tx, { id: request.orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId: request.branchId, actorId: actor.principalId });
    } catch (error) {
      // Another document, or another person's sale, already has this id: never post a second sale under it.
      if (sqlStateOf(error) === UNIQUE_VIOLATION) throw new IdempotencyKeyReusedError('the order id is already a registered document');
      throw error;
    }
  }

  /**
   * The planned lines with every flagged line naming the approval this seller asked for and a different user gave for
   * exactly these prices (A-230); refused when there is none: still waiting, given for other prices, or never asked.
   */
  private approved(request: SaleRequest, customerId: string | null, asked: readonly ApprovalListing[], sellerId: string, planned: readonly PlannedLine[]): PlannedLine[] {
    const flagged = planned.filter((p) => p.approval !== null);
    if (flagged.length === 0) return [...planned];
    const hash = overrideHash(
      request.orderId,
      customerId,
      flagged.map((p) => ({ ...p.record, varianceRequiresApproval: true })),
    );
    const approval = asked.find((a) => a.status === 'APPROVED' && a.payloadHash === hash);
    if (approval === undefined) {
      const why = asked.some((a) => a.status === 'PENDING') ? 'APPROVAL_PENDING' : asked.some((a) => a.status === 'APPROVED') ? 'APPROVAL_DIFFERS' : null;
      throw new PriceOverrideNeedsApprovalError(flagged.map((p) => ({ field: field(p.index, 'agreedUnitPricePesewas'), reason: why ?? p.approval! })));
    }
    if (!judgePriceApprover(approval.decidedBy!, { requestedBy: approval.requestedBy, salespersonId: sellerId, postedBy: sellerId }).ok) {
      throw new PriceApproverIsSellerError('the seller of this price cannot approve it');
    }
    return planned.map((p) =>
      p.approval === null
        ? p
        : { ...p, record: { ...p.record, varianceRequiresApproval: true, varianceApprovalRequestId: approval.id, varianceApprovedBy: approval.decidedBy, varianceApprovedAt: approval.decidedAt } },
    );
  }

  /**
   * Every line checked, converted to its base unit and priced by the engine: the resolved band, the agreed price and its
   * variance, extended once (ADR-0001). A line the engine cannot price is QUOTE_REQUIRED; an agreed price outside the
   * band, or below list beyond the seller's per-line limit, is marked with why it needs an approval (A-230).
   */
  private async plan(tx: Transaction, request: SaleRequest, at: Date, lineLimit: bigint): Promise<PlannedLine[]> {
    const products = await this.refs.productsIn(tx, request.lines.map((l) => l.productId));
    const locations = await this.refs.locationsIn(tx, request.lines.map((l) => l.fromLocationId));
    const unitIds = request.lines.flatMap((l) => (l.stockUnitId === undefined || l.stockUnitId === null ? [] : [l.stockUnitId]));
    const units = await this.units.factsIn(tx, unitIds, at);
    const reasons = await this.refs.reasonCodesIn(tx, request.lines.flatMap((l) => (l.varianceReasonCode === undefined || l.varianceReasonCode === null ? [] : [l.varianceReasonCode])));
    const broken: SaleRule[] = [];
    const checked: { index: number; product: ProductFacts; baseQty: Quantity; weight: PlannedLine['weight']; gradeId: string | undefined; pricingWeight: string | undefined; unit: PlannedLine['stockUnit'] }[] = [];
    for (const [i, line] of request.lines.entries()) {
      const product = products.get(line.productId);
      if (product === undefined || !product.isLive) {
        broken.push({ field: field(i, 'productId'), rule: 'PRODUCT_NOT_ACTIVE' });
        continue;
      }
      if (product.stockPolicy === 'NON_STOCK') broken.push({ field: field(i, 'productId'), rule: 'PRODUCT_NOT_STOCKED' });
      const location = locations.get(line.fromLocationId);
      if (location === undefined || location.branchId !== request.branchId || location.isVirtual || !location.isLive) {
        broken.push({ field: field(i, 'fromLocationId'), rule: 'LOCATION_NOT_IN_BRANCH' });
      }
      const unitId = line.stockUnitId ?? null;
      const unit = unitId === null ? undefined : units.get(unitId);
      if (product.tracking !== 'NONE' && unitId === null) broken.push({ field: field(i, 'stockUnitId'), rule: 'STOCK_UNIT_REQUIRED' });
      if (unitId !== null && (unit === undefined || unit.productId !== product.id)) broken.push({ field: field(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
      const quantity = Quantity.parse(line.quantity);
      const uom = line.uom ?? product.baseUom;
      const converted = uom === product.baseUom ? { ok: true as const, value: quantity } : await this.refs.toBaseIn(tx, product.id, uom, quantity);
      if (!converted.ok) {
        broken.push({ field: field(i, 'uom'), rule: converted.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'NO_CONVERSION' });
        continue;
      }
      if (product.tracking === 'SERIAL' && !converted.value.equals(Quantity.ofUnits(1n))) broken.push({ field: field(i, 'quantity'), rule: 'ONE_ANIMAL_PER_LINE' });
      const hasWeight = line.weightKg !== undefined && line.weightKg !== null;
      if (hasWeight && (line.weightSource === undefined || line.weightSource === null)) broken.push({ field: field(i, 'weightSource'), rule: 'WEIGHT_SOURCE_REQUIRED' });
      const weight = hasWeight && line.weightSource !== undefined && line.weightSource !== null ? { kg: Weight.parseKg(line.weightKg!), source: line.weightSource } : null;
      if (line.reservationId !== undefined && line.reservationId !== null) {
        const held = await this.reservations.heldIn(tx, line.reservationId);
        if (held === null || held.status !== 'ACTIVE') broken.push({ field: field(i, 'reservationId'), rule: 'RESERVATION_NOT_ACTIVE' });
        else if (
          held.productId !== product.id ||
          held.stockUnitId !== unitId ||
          held.locationId !== line.fromLocationId ||
          !Quantity.parse(held.qty).equals(converted.value) ||
          (held.holderDocumentId !== request.orderId && held.holderDocumentId !== (request.sourceDocumentId ?? null))
        ) {
          broken.push({ field: field(i, 'reservationId'), rule: 'RESERVATION_DIFFERS' });
        }
      }
      checked.push({
        index: i,
        product,
        baseQty: converted.value,
        weight,
        gradeId: line.gradeId ?? unit?.gradeId ?? undefined,
        pricingWeight: line.weightKg ?? unit?.lastWeightKg ?? undefined,
        unit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
      });
    }
    if (broken.length > 0) throw new SaleInvalidError(broken);

    const resolved = await this.pricing.resolveIn(tx, {
      channel: request.channel,
      branchId: request.branchId,
      ...(request.customerId === undefined || request.customerId === null ? {} : { customerId: request.customerId }),
      at,
      lines: checked.map((c) => ({
        lineRef: String(c.index),
        productId: c.product.id,
        quantity: c.baseQty.toDecimalString(),
        ...(c.gradeId === undefined ? {} : { gradeId: c.gradeId }),
        ...(c.pricingWeight === undefined ? {} : { weightKg: c.pricingWeight }),
      })),
    });
    const unpriced = resolved.lines.filter((l) => l.outcome !== 'RESOLVED' || l.resolved === null);
    if (unpriced.length > 0) throw new QuoteRequiredError(unpriced.map((l) => ({ field: `/lines/${l.lineRef}`, reason: l.quoteRequiredReason ?? 'NO_RULE' })));

    const planned: PlannedLine[] = [];
    for (const c of checked) {
      const line = request.lines[c.index]!;
      const band = resolved.lines.find((l) => l.lineRef === String(c.index))!.resolved!;
      const list = BigInt(band.listPricePesewas);
      const agreed = line.agreedUnitPricePesewas ?? list;
      const reasonCode = line.varianceReasonCode ?? null;
      if (agreed !== list) {
        const reason = reasonCode === null ? undefined : reasons.get(reasonCode);
        if (reasonCode === null) broken.push({ field: field(c.index, 'varianceReasonCode'), rule: 'VARIANCE_REASON_REQUIRED' });
        else if (reason === undefined || reason.domain !== 'PRICE_OVERRIDE') broken.push({ field: field(c.index, 'varianceReasonCode'), rule: 'VARIANCE_REASON_INVALID' });
        else if (reason.requiresNote) broken.push({ field: field(c.index, 'varianceReasonCode'), rule: 'VARIANCE_NOTE_REQUIRED' });
      }
      const measure = { quantity: c.baseQty, weight: c.weight?.kg ?? null };
      const agreedTotal = extendPrice(agreed, band.basis, measure);
      const resolvedTotal = extendPrice(list, band.basis, measure);
      if (!agreedTotal.ok || !resolvedTotal.ok) {
        broken.push({ field: field(c.index, 'weightKg'), rule: 'WEIGHT_REQUIRED' });
        continue;
      }
      const variance = resolvedTotal.value > agreedTotal.value ? resolvedTotal.value - agreedTotal.value : agreedTotal.value - resolvedTotal.value;
      const verdict = judgeOverride({ listPricePesewas: list, floorPricePesewas: BigInt(band.floorPricePesewas), ceilingPricePesewas: BigInt(band.ceilingPricePesewas) }, agreed, variance, lineLimit);
      planned.push({
        index: c.index,
        approval: verdict.kind === 'VARIANCE' ? verdict.approval : null,
        product: c.product,
        baseQty: c.baseQty,
        weight: c.weight,
        stockUnit: c.unit,
        fromLocationId: line.fromLocationId,
        record: {
          id: this.nextId(),
          salesOrderId: request.orderId,
          lineNo: lineNumber(c.index),
          productId: c.product.id,
          stockUnitId: c.unit?.id ?? null,
          qtyOrdered: c.baseQty.toDecimalString(),
          uom: c.product.baseUom,
          qtyFulfilled: c.baseQty.toDecimalString(),
          fulfilledWeightKg: c.weight?.kg.toKgString() ?? null,
          weightSource: c.weight?.source ?? null,
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
          varianceRequiresApproval: false,
          varianceApprovalRequestId: null,
          varianceApprovedBy: null,
          varianceApprovedAt: null,
          discountPesewas: 0n,
          estimatedLineTotalPesewas: agreedTotal.value,
          finalLineTotalPesewas: agreedTotal.value,
          reservationId: line.reservationId ?? null,
          stockMovementId: null,
          lineStatus: 'FULFILLED',
        },
      });
    }
    if (broken.length > 0) throw new SaleInvalidError(broken);
    return planned;
  }

  /** The sale as it stands, from the order's rows, its document and its payments. */
  private view(order: OrderRecord, document: BillingDocumentView, payments: readonly PaymentView[]): SaleView {
    const allocated = Money.sum(payments.map((p) => Money.fromJsonInteger(p.allocatedPesewas)));
    const paid = Money.sum(payments.map((p) => Money.fromJsonInteger(p.amountPesewas)));
    const due = Money.fromJsonInteger(document.grossPesewas).minus(Money.fromJsonInteger(document.settlement.creditedPesewas));
    return {
      id: order.id,
      orderNo: order.orderNo,
      channel: order.channel,
      status: order.status,
      paymentStatus: paymentStatusOf({
        documentDue: due,
        allocated,
        deposits: Money.sum(payments.map((p) => Money.fromJsonInteger(p.unallocatedPesewas))),
        paid,
        refunded: Money.sum(payments.map((p) => Money.fromJsonInteger(p.refundedPesewas))),
      }),
      paymentTerms: order.paymentTerms,
      fulfilmentMode: order.fulfilmentMode,
      customerId: order.customerId,
      taxInclusive: order.taxInclusive,
      estimatedTotalPesewas: json(order.estimatedTotalPesewas),
      finalTotalPesewas: order.finalTotalPesewas === null ? null : json(order.finalTotalPesewas),
      paidPesewas: paid.toJsonInteger(),
      outstandingPesewas: due.compareTo(allocated) > 0 ? due.minus(allocated).toJsonInteger() : 0,
      currency: 'GHS',
      billingDocument: { id: document.id, kind: document.kind, documentNo: document.documentNo, grossPesewas: document.grossPesewas },
      payments,
      lines: order.lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        stockUnitId: l.stockUnitId,
        qtyOrdered: l.qtyOrdered,
        uom: l.uom,
        qtyFulfilled: l.qtyFulfilled,
        fulfilledWeightKg: l.fulfilledWeightKg,
        weightSource: l.weightSource,
        priceSource: l.priceSource,
        priceBasis: l.priceBasis,
        priceListEntryId: l.priceListEntryId,
        resolvedUnitPricePesewas: json(l.resolvedUnitPricePesewas),
        floorUnitPricePesewas: json(l.floorUnitPricePesewas),
        ceilingUnitPricePesewas: json(l.ceilingUnitPricePesewas),
        agreedUnitPricePesewas: json(l.agreedUnitPricePesewas),
        variancePesewas: json(l.variancePesewas),
        varianceDirection: l.varianceDirection,
        varianceReasonCode: l.varianceReasonCode,
        estimatedLineTotalPesewas: json(l.estimatedLineTotalPesewas),
        finalLineTotalPesewas: l.finalLineTotalPesewas === null ? null : json(l.finalLineTotalPesewas),
        stockMovementId: l.stockMovementId,
        lineStatus: l.lineStatus,
      })),
      placedAt: order.placedAt.toISOString(),
      completedAt: order.completedAt?.toISOString() ?? null,
      branchId: order.branchId,
    };
  }
}
