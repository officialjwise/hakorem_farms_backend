import { createUuidV7Generator, Money, Quantity, Rate, toBusinessDate, Weight, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { Reservations, StockQueries, StockUnits } from '../../inv';
import { extendPrice, type MasterDataRefs, type PricingService } from '../../mdm';
import { planLineReservation } from '../domain/confirmation';
import { accraDay, byLineNumber, lineNumber, nextLineNumber } from '../domain/line-numbers';
import { canMove, type OrderStatus } from '../domain/order';
import { pageProbe } from '../domain/paging';
import { judgeWeighed, pickedLineTotal, pickWeightSource, readyToPack, toleranceLimits, type ToleranceState } from '../domain/picking';
import type { CustomerConsentAnswered, CustomerConsentRequested, FulfilmentPacked } from '../events';
import { FulfilmentInvalidError, OrderStockShortError, type SaleRule } from './errors';
import type { ConsentMethod, FulfilmentRecord, FulfilmentStatus, FulfilmentStore, OrderConsentRecord, PickListLineRecord, PickRecord } from './fulfilment-store';
import type { OrderReversals } from './order-reversals';
import type { NewOrderLine, OrderHeaderRecord, OrderLineRecord, OrderRecord, OrderStore } from './order-store';
import type { Orders, Page, SalesOrderView } from './orders';

const READ = 'ord.fulfilment.read';
const PICK = 'ord.fulfilment.pick';
const UPDATE = 'ord.order.update';
export const CUSTOMER_CONSENT_REQUESTED = 'ord.CustomerConsentRequested';
export const CUSTOMER_CONSENT_ANSWERED = 'ord.CustomerConsentAnswered';
export const FULFILMENT_PACKED = 'ord.FulfilmentPacked';
/** A substitute or a smaller quantity the customer refused leaves nothing of the order to send: it ends as out of stock. */
const OUT_OF_STOCK_REASON = 'OUT_OF_STOCK';
/** Where a pick list may be picked from: a physical, live location of the order's branch (never in transit or a van). */
/** A line still to be sent, or fixed at dispatch (FULFILLED, or PARTIAL by agreement): what a pick list totals. */
const SENT_OR_OPEN: ReadonlySet<string> = new Set(['OPEN', 'FULFILLED', 'PARTIAL']);
const NOT_PICKED_FROM: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE', 'VEHICLE', 'RETURNS_HOLD']);

export interface FulfilmentCreateRequest {
  readonly pickLocationId: string;
  /** Part of the order (FR-ORD-008): each open line and how much of it; absent, every open line's remainder. */
  readonly lines?: readonly { readonly orderLineId: string; readonly quantity: string }[] | undefined;
}

export interface PickInputRequest {
  readonly id: string;
  readonly orderLineId: string;
  readonly stockUnitId?: string | undefined;
  readonly packBarcode?: string | undefined;
  readonly qty: string;
  readonly weightKg?: string | undefined;
  readonly weightSource?: 'SCALE' | 'MANUAL' | 'ESTIMATE' | undefined;
}

export interface FulfilmentQuery {
  readonly orderId: string | null;
  readonly status: FulfilmentStatus | null;
  readonly pickLocationId: string | null;
  /** An Africa/Accra calendar date. */
  readonly date: string | null;
}

interface UnitRefView {
  readonly id: string;
  readonly identifier: string;
  readonly tracking: 'SERIAL' | 'LOT';
}

/** The contract's `PickListLine`, with what is picked of it so far and its tolerance (B11, additive). */
export interface PickListLineView {
  readonly orderLineId: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly qtyToPick: string;
  readonly uom: string;
  readonly estimatedWeightKg: string | null;
  readonly suggestedStockUnits: readonly UnitRefView[];
  readonly status: 'OPEN' | 'CANCELLED';
  readonly pickedQty: string;
  readonly pickedWeightKg: string | null;
  readonly minimumWeightKg: string | null;
  readonly maximumWeightKg: string | null;
  readonly toleranceState: ToleranceState | null;
}

/** The contract's `FulfilmentLine`: one pick not withdrawn. */
export interface FulfilmentLineView {
  readonly id: string;
  readonly orderLineId: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly stockUnit: UnitRefView | null;
  readonly packBarcode: string | null;
  readonly qty: string;
  readonly weightKg: string | null;
  readonly weightSource: PickRecord['weightSource'];
  readonly linePricePesewas: number | null;
}

/** The contract's `Fulfilment`. */
export interface FulfilmentView {
  readonly id: string;
  readonly fulfilmentNo: string;
  readonly order: { readonly id: string; readonly docType: 'SALES_ORDER'; readonly number: string | null };
  readonly status: FulfilmentStatus;
  readonly pickLocation: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string };
  readonly picker: { readonly id: string; readonly displayName: string } | null;
  readonly pickList: readonly PickListLineView[];
  readonly lines: readonly FulfilmentLineView[];
  readonly weighedTotalPesewas: number | null;
  readonly withinTolerance: boolean | null;
  readonly pickedAt: string | null;
  readonly packedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly packageCount: number | null;
  readonly currency: 'GHS';
  readonly branchId: string;
  readonly version: number;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const pickField = (i: number, name: string) => `/picks/${i}/${name}`;
const invalidState = (what: string, status: string) =>
  new InvalidStateTransitionError(`${what} is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
const isCatchWeight = (line: OrderLineRecord) => line.priceBasis === 'PER_KG';
const activeOf = (picks: readonly PickRecord[]) => picks.filter((p) => p.withdrawnAt === null);
const keyOf = (productId: string, stockUnitId: string | null, locationId: string) => `${productId}:${stockUnitId ?? '-'}:${locationId}`;

/** A catch-weight line's estimate as the order took it, or null on any other line (ADR-0021). */
function estimateOf(line: OrderLineRecord) {
  if (!isCatchWeight(line) || line.estimatedWeightKg === null) return null;
  return { weight: Weight.parseKg(line.estimatedWeightKg), tolerance: Rate.parsePercent(line.tolerancePercent ?? '0'), estimatedTotal: Money.ofPesewas(line.estimatedLineTotalPesewas) };
}

/** The line's tolerance at its weighed total, from the figures its picks wrote; null when nothing is weighed. */
function toleranceOf(line: OrderLineRecord): ToleranceState | null {
  const estimate = estimateOf(line);
  if (estimate === null || line.fulfilledWeightKg === null || line.finalLineTotalPesewas === null) return null;
  return judgeWeighed(estimate, Weight.parseKg(line.fulfilledWeightKg), Money.ofPesewas(line.finalLineTotalPesewas));
}

/** The customer agreed to this line's weighed total: a HIGHER_TOTAL accepted at or above it. */
function consentedAbove(line: OrderLineRecord, consents: readonly OrderConsentRecord[]): boolean {
  if (line.finalLineTotalPesewas === null) return false;
  return consents.some((c) => c.kind === 'HIGHER_TOTAL' && c.status === 'ACCEPTED' && c.salesOrderLineId === line.id && c.weighedTotalPesewas! >= line.finalLineTotalPesewas!);
}

/** The smaller quantity the customer agreed to for the line, the latest SHORT_PICK accepted, or null. */
function agreedShortOf(line: OrderLineRecord, consents: readonly OrderConsentRecord[]): Quantity | null {
  const agreed = consents.filter((c) => c.kind === 'SHORT_PICK' && c.status === 'ACCEPTED' && c.salesOrderLineId === line.id).at(-1);
  return agreed === undefined ? null : Quantity.parse(agreed.proposedQty!);
}

/**
 * Fulfilment (FR-ORD-008 to FR-ORD-011, FR-ORD-013, ADR-0021, CR-053, CR-054, A-332 to A-335): the pick lists of a
 * confirmed order, picks with their weights and the catch-weight re-pricing at the weighed quantity, the customer's
 * consent beyond the tolerance, a substitute or a smaller quantity only with the customer's agreement, and packing. Each
 * handler authorises in the application layer at the order's branch (ADR-0035): `ord.fulfilment.read`,
 * `ord.fulfilment.pick` (make, pick, pack, cancel a pick list, propose), `ord.order.update` (record the customer's
 * answer, never by the person who asked). Every write is one serializable transaction, idempotent by its key.
 *
 * A pick moves no stock (A-332): it names what is taken and is checked against what the pick location holds that is
 * not promised to anyone else, the order's own reservations counted as its own, so a pick never takes a location below
 * zero (ADR-0081: a balance below zero offers nothing). The stock moves at dispatch (B11 continued).
 */
export class Fulfilments {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: FulfilmentStore,
    private readonly orderStore: OrderStore,
    private readonly orders: Orders,
    private readonly reversals: OrderReversals,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly units: StockUnits,
    private readonly stock: StockQueries,
    private readonly reservations: Reservations,
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

  /** getFulfilment: at the pick list's branch; another branch's is refused as any other. */
  get(actor: Actor | undefined, id: string): Promise<FulfilmentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [found] = await this.store.fulfilments(tx, [id]);
      if (found === undefined) throw new NotFoundError('no such pick list');
      await this.authoriser.authorise(tx, actor, READ, { branchId: found.branchId });
      return (await this.viewsIn(tx, [found]))[0]!;
    });
  }

  /** listFulfilments: the pick lists at the branches the caller reads whole, newest first, by order (CR-053), status, location or day. */
  list(actor: Actor | undefined, query: FulfilmentQuery, cursor: string | undefined, limit: number): Promise<Page<FulfilmentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listFulfilments', principalId: actor!.principalId, filters: { ...query } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const day = query.date === null ? null : accraDay(query.date);
      const found = await this.store.list(tx, { branchIds, orderId: query.orderId, status: query.status, pickLocationId: query.pickLocationId, from: day?.from ?? null, to: day?.to ?? null }, beforeId, pageProbe(limit));
      const data = await this.viewsIn(tx, await this.store.fulfilments(tx, found.slice(0, limit)));
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  /**
   * createFulfilment (FR-ORD-008): a pick list of a confirmed or picking order at one pick location of its branch, of
   * every open line's remainder or of the lines and quantities asked; a catch-weight line goes whole on one pick list.
   * The first pick list moves the order CONFIRMED to PICKING. Numbered `PCK-...` from its own series.
   */
  async create(actor: Actor | undefined, orderId: string, body: FulfilmentCreateRequest, key: string): Promise<StoredResponse<FulfilmentView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const [order] = await this.orderStore.orders(tx, [orderId]);
      if (order === undefined) throw new NotFoundError('no such order');
      await this.authoriser.authorise(tx, actor, PICK, { branchId: order.branchId });
      return order.branchId;
    });
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`FULFILMENT:${toBusinessDate(this.clock.now()).slice(0, 4)}:${branchId}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const claim = await this.idempotency.claim(tx, { operationId: 'createFulfilment', principalId: actor!.principalId, key, request: { orderId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
      const header = await this.lockOrder(tx, orderId);
      await this.authoriser.authorise(tx, actor, PICK, { branchId: header.branchId });
      if (header.status !== 'CONFIRMED' && header.status !== 'PICKING') throw invalidState(`order ${orderId}`, header.status);
      const order = (await this.orderStore.orders(tx, [orderId]))[0]!;
      const broken: SaleRule[] = [];
      const location = (await this.refs.locationsIn(tx, [body.pickLocationId])).get(body.pickLocationId);
      if (location === undefined || location.branchId !== header.branchId || !location.isLive || location.isVirtual || NOT_PICKED_FROM.has(location.kind)) {
        broken.push({ field: '/pickLocationId', rule: 'NOT_A_PICK_LOCATION' });
      }
      const open = order.lines.filter((l) => l.lineStatus === 'OPEN');
      const asked = await this.store.askedOf(
        tx,
        open.map((l) => l.id),
      );
      const remainder = (l: OrderLineRecord) => Quantity.parse(l.qtyOrdered).minus(Quantity.parse(asked.get(l.id) ?? '0'));
      const wanted: { line: OrderLineRecord; qty: Quantity }[] = [];
      if (body.lines === undefined) {
        for (const l of open) if (remainder(l).compareTo(Quantity.zero()) > 0) wanted.push({ line: l, qty: remainder(l) });
      } else {
        const seen = new Set<string>();
        for (const [i, asking] of body.lines.entries()) {
          const line = order.lines.find((l) => l.id === asking.orderLineId);
          const field = `/lines/${i}`;
          if (line === undefined) broken.push({ field, rule: 'LINE_NOT_ON_ORDER' });
          else if (seen.has(line.id)) broken.push({ field, rule: 'LINE_REPEATED' });
          else if (line.lineStatus !== 'OPEN') broken.push({ field, rule: 'LINE_NOT_OPEN' });
          else {
            const qty = Quantity.parse(asking.quantity);
            if (qty.compareTo(Quantity.zero()) <= 0 || qty.compareTo(remainder(line)) > 0) broken.push({ field: `${field}/quantity`, rule: 'QUANTITY_ABOVE_REMAINING' });
            else if (isCatchWeight(line) && !qty.equals(Quantity.parse(line.qtyOrdered))) broken.push({ field: `${field}/quantity`, rule: 'CATCH_WEIGHT_LINE_WHOLE' });
            else wanted.push({ line, qty });
          }
          if (line !== undefined) seen.add(line.id);
        }
      }
      if (broken.length === 0 && wanted.length === 0) broken.push({ field: '/lines', rule: 'NOTHING_TO_PICK' });
      for (const w of wanted) {
        if (isCatchWeight(w.line) && !w.qty.equals(Quantity.parse(w.line.qtyOrdered))) broken.push({ field: `/lines/${w.line.lineNo}`, rule: 'CATCH_WEIGHT_LINE_WHOLE' });
      }
      if (broken.length > 0) throw new FulfilmentInvalidError(broken);

      const id = this.nextId();
      const at = this.clock.now();
      const branch = (await this.refs.branchesIn(tx, [header.branchId])).get(header.branchId)!;
      await this.documents.register(tx, { id, docType: 'FULFILMENT', ownerModule: 'ord', branchId: header.branchId, actorId: actor!.principalId });
      const fulfilmentNo = await this.numbers.allocateIn(tx, { docType: 'FULFILMENT', fiscalYear: Number(toBusinessDate(at).slice(0, 4)), branchId: header.branchId, branchCode: branch.code, documentId: id });
      await this.store.insertFulfilment(tx, { id, fulfilmentNo, salesOrderId: orderId, pickLocationId: body.pickLocationId, branchId: header.branchId, createdBy: actor!.principalId });
      await this.store.insertPickListLines(
        tx,
        wanted
          .sort((a, b) => byLineNumber(a.line, b.line))
          .map((w, i) => ({ id: this.nextId(), fulfilmentId: id, salesOrderLineId: w.line.id, lineNo: lineNumber(i), qtyToPick: w.qty.toDecimalString(), status: 'OPEN' as const })),
        actor!.principalId,
      );
      if (header.status === 'CONFIRMED') await this.moveIn(tx, header, 'PICKING', `Pick list ${fulfilmentNo}`, at, actor!.principalId);
      const view = await this.viewOf(tx, id);
      await this.audit.record(tx, { module: 'ord', action: 'CREATE', entityType: 'Fulfilment', entityId: id, branchId: header.branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * recordPicks (FR-ORD-009, FR-ORD-010, CR-054): each pick by its client id (a resubmitted pick is stored once; an id
   * used for another pick is refused), its quantity in the line's unit, never more than the pick list asks; a
   * catch-weight pick with its weight and source. `withdraw` takes back picks of this pick list first (a pack swapped).
   * The line is re-priced at its weighed quantity, half-up once; a line above its tolerance makes the order ask the
   * customer (AWAITING_CUSTOMER), and coming back within it withdraws the question.
   */
  recordPicks(actor: Actor | undefined, id: string, body: { readonly picks: readonly PickInputRequest[]; readonly withdraw?: readonly string[] | undefined }, key: string): Promise<StoredResponse<FulfilmentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordPicks', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
      const f = await this.lockFulfilment(tx, id);
      await this.authoriser.authorise(tx, actor, PICK, { branchId: f.branchId });
      if (f.status !== 'PICK_LIST' && f.status !== 'PICKING') throw invalidState(`pick list ${id}`, f.status);
      const header = await this.lockOrder(tx, f.salesOrderId);
      if (header.status !== 'PICKING' && header.status !== 'AWAITING_CUSTOMER') throw invalidState(`order ${header.id}`, header.status);
      const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
      const full = (await this.store.fulfilments(tx, [id]))[0]!;
      const broken: SaleRule[] = [];
      const at = this.clock.now();
      const actorId = actor!.principalId;

      const mine = activeOf(full.picks);
      const withdraw = [...new Set(body.withdraw ?? [])];
      for (const [i, pickId] of withdraw.entries()) if (!mine.some((p) => p.id === pickId)) broken.push({ field: `/withdraw/${i}`, rule: 'PICK_NOT_FOUND' });

      const stored = await this.store.picksById(
        tx,
        body.picks.map((p) => p.id),
      );
      const products = await this.refs.productsIn(
        tx,
        order.lines.map((l) => l.productId),
      );
      const unitIds = body.picks.flatMap((p) => (p.stockUnitId === undefined ? [] : [p.stockUnitId]));
      const unitFacts = await this.units.factsIn(tx, unitIds, at);
      const fresh: PickRecord[] = [];
      const seen = new Set<string>();
      for (const [i, input] of body.picks.entries()) {
        const before = stored.find((p) => p.id === input.id);
        if (before !== undefined || seen.has(input.id)) {
          if (before === undefined || before.fulfilmentId !== id || !samePick(before, input)) broken.push({ field: pickField(i, 'id'), rule: 'PICK_ID_REUSED' });
          continue;
        }
        seen.add(input.id);
        const line = order.lines.find((l) => l.id === input.orderLineId);
        const listed = full.pickList.find((p) => p.salesOrderLineId === input.orderLineId && p.status === 'OPEN');
        if (line === undefined || listed === undefined || line.lineStatus !== 'OPEN') {
          broken.push({ field: pickField(i, 'orderLineId'), rule: 'LINE_NOT_ON_PICK_LIST' });
          continue;
        }
        const product = products.get(line.productId)!;
        const qty = Quantity.parse(input.qty);
        const weight = input.weightKg === undefined ? null : Weight.parseKg(input.weightKg);
        if (weight !== null && input.weightSource === undefined) broken.push({ field: pickField(i, 'weightSource'), rule: 'WEIGHT_SOURCE_REQUIRED' });
        if (isCatchWeight(line) && (weight === null || weight.isZero())) {
          broken.push({ field: pickField(i, 'weightKg'), rule: 'WEIGHT_REQUIRED' });
          continue;
        }
        const unitId = input.stockUnitId ?? null;
        const unit = unitId === null ? undefined : unitFacts.get(unitId);
        if (product.tracking === 'SERIAL') {
          if (unitId !== line.stockUnitId) broken.push({ field: pickField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_ANIMAL' });
          if (!qty.equals(Quantity.ofUnits(1n))) broken.push({ field: pickField(i, 'qty'), rule: 'ONE_ANIMAL_PER_LINE' });
        } else if (product.tracking === 'LOT') {
          if (unitId === null) broken.push({ field: pickField(i, 'stockUnitId'), rule: 'STOCK_UNIT_REQUIRED' });
          else if (unit === undefined || unit.productId !== line.productId) broken.push({ field: pickField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
        } else if (unitId !== null) broken.push({ field: pickField(i, 'stockUnitId'), rule: 'STOCK_UNIT_NOT_TRACKED' });
        let qtyBase: Quantity;
        if (isCatchWeight(line)) {
          // A catch-weight product is stocked by the kilogram: a pack picked takes its weighed kilograms (ADR-0021).
          qtyBase = Quantity.ofThousandths(weight!.grams);
        } else {
          const converted = await this.refs.toBaseIn(tx, line.productId, line.uom, qty);
          if (!converted.ok) {
            broken.push({ field: pickField(i, 'qty'), rule: 'INEXACT_QUANTITY' });
            continue;
          }
          qtyBase = converted.value;
        }
        fresh.push({
          id: input.id,
          fulfilmentId: id,
          pickListLineId: listed.id,
          salesOrderLineId: line.id,
          stockUnitId: unitId,
          packBarcode: input.packBarcode ?? null,
          qty: qty.toDecimalString(),
          qtyBase: qtyBase.toDecimalString(),
          weightKg: weight?.toKgString() ?? null,
          weightSource: weight === null ? null : (input.weightSource ?? null),
          withdrawnAt: null,
          recordedAt: at,
          createdBy: actorId,
        });
      }
      // Never more of a pick list line than it asks (CR-054); the database holds the same cap under the line's lock.
      const remaining = mine.filter((p) => !withdraw.includes(p.id));
      for (const listed of full.pickList.filter((p) => p.status === 'OPEN')) {
        const picked = Quantity.sum([...remaining, ...fresh].filter((p) => p.pickListLineId === listed.id).map((p) => Quantity.parse(p.qty)));
        if (picked.compareTo(Quantity.parse(listed.qtyToPick)) > 0) broken.push({ field: `/pickList/${listed.lineNo}`, rule: 'PICK_OVER' });
      }
      if (broken.length > 0) throw new FulfilmentInvalidError(broken);

      // A pick never takes more than its location holds that nobody else is promised (A-332, ADR-0081).
      const orderPicks = (await this.store.activePicksOfOrder(tx, header.id)).filter((p) => !withdraw.includes(p.id));
      const locations = new Map((await this.store.fulfilments(tx, [...new Set(orderPicks.map((p) => p.fulfilmentId))])).map((x) => [x.id, x.pickLocationId]));
      locations.set(id, f.pickLocationId);
      const want = new Map<string, Quantity>();
      const lineProduct = (lineId: string) => order.lines.find((l) => l.id === lineId)!.productId;
      for (const p of [...orderPicks, ...fresh]) {
        const k = keyOf(lineProduct(p.salesOrderLineId), p.stockUnitId, locations.get(p.fulfilmentId)!);
        want.set(k, (want.get(k) ?? Quantity.zero()).plus(Quantity.parse(p.qtyBase)));
      }
      const touched = new Set(fresh.map((p) => keyOf(lineProduct(p.salesOrderLineId), p.stockUnitId, f.pickLocationId)));
      if (touched.size > 0) {
        const allowed = await this.allowedAt(tx, header, [...new Set(fresh.map((p) => lineProduct(p.salesOrderLineId)))]);
        for (const [i, p] of fresh.entries()) {
          const k = keyOf(lineProduct(p.salesOrderLineId), p.stockUnitId, f.pickLocationId);
          if (want.get(k)!.compareTo(allowed.get(k) ?? Quantity.zero()) > 0) broken.push({ field: pickField(body.picks.findIndex((b) => b.id === p.id) ?? i, 'qty'), rule: 'STOCK_SHORT' });
        }
      }
      if (broken.length > 0) throw new FulfilmentInvalidError(broken);

      const before = await this.viewOf(tx, id);
      await this.store.withdrawPicks(tx, withdraw, at, actorId);
      await this.store.insertPicks(tx, fresh);
      if (f.status === 'PICK_LIST' && fresh.length > 0) await this.store.startPicking(tx, id, { pickerId: actorId, at });
      await this.repriceIn(tx, order, [...new Set([...fresh.map((p) => p.salesOrderLineId), ...mine.filter((p) => withdraw.includes(p.id)).map((p) => p.salesOrderLineId)])]);
      await this.judgeToleranceIn(tx, header.id, actorId);
      const view = await this.viewOf(tx, id);
      await this.audit.record(tx, { module: 'ord', action: 'PICK', entityType: 'Fulfilment', entityId: id, branchId: f.branchId, before: { ...before }, after: { ...view, withdrawn: withdraw } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * packFulfilment (FR-ORD-011): seals a pick list whose every line is picked in full, short only at what the customer
   * agreed to, a catch-weight line weighed and within its tolerance or consented above it, while the order waits for no
   * answer. The order is PACKED once no pick list of it is still being picked and every open line is packed.
   */
  pack(actor: Actor | undefined, id: string, body: { readonly packageCount: number; readonly backorderLineIds?: readonly string[] | undefined }, key: string): Promise<StoredResponse<FulfilmentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const claim = await this.idempotency.claim(tx, { operationId: 'packFulfilment', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
      const f = await this.lockFulfilment(tx, id);
      await this.authoriser.authorise(tx, actor, PICK, { branchId: f.branchId });
      if (f.status !== 'PICKING' && f.status !== 'PICK_LIST') throw invalidState(`pick list ${id}`, f.status);
      const header = await this.lockOrder(tx, f.salesOrderId);
      if (header.status === 'AWAITING_CUSTOMER') throw new FulfilmentInvalidError([{ field: '/status', rule: 'CONSENT_PENDING' }]);
      if (header.status !== 'PICKING') throw invalidState(`order ${header.id}`, header.status);
      const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
      const full = (await this.store.fulfilments(tx, [id]))[0]!;
      const consents = await this.store.consentsOf(tx, [header.id]);
      const toPack = full.pickList
        .filter((p) => p.status === 'OPEN')
        .map((p) => {
          const line = order.lines.find((l) => l.id === p.salesOrderLineId)!;
          return { p, line };
        })
        .filter(({ line }) => line.lineStatus === 'OPEN');
      // A short line's rest back-ordered (FR-ORD-012): a line of this pick list only, on no other live pick list, undiscounted.
      const backorder = new Set(body.backorderLineIds ?? []);
      const backorderRules = await this.backorderRulesIn(tx, header.id, id, backorder, toPack.map(({ line }) => line));
      if (backorderRules.length > 0) throw new FulfilmentInvalidError(backorderRules);
      const judged = readyToPack(
        toPack.map(({ p, line }) => ({
          lineNo: p.lineNo,
          catchWeight: isCatchWeight(line),
          toPick: Quantity.parse(p.qtyToPick),
          picked: Quantity.sum(activeOf(full.picks).filter((x) => x.pickListLineId === p.id).map((x) => Quantity.parse(x.qty))),
          agreedShort: agreedShortOf(line, consents),
          tolerance: toleranceOf(line),
          consentedAbove: consentedAbove(line, consents),
          backorder: backorder.has(line.id),
        })),
      );
      if (!judged.ok) throw new FulfilmentInvalidError(judged.error.map((e) => ({ field: `/pickList/${e.lineNo}`, rule: e.rule })));
      const before = await this.viewOf(tx, id);
      for (const { line } of toPack.filter(({ line }) => backorder.has(line.id))) {
        await this.store.backorderLine(tx, line.id, Quantity.parse(line.qtyOrdered).minus(Quantity.parse(line.qtyFulfilled)).toDecimalString());
      }
      const at = this.clock.now();
      if (f.status === 'PICK_LIST') await this.store.startPicking(tx, id, { pickerId: actor!.principalId, at });
      await this.store.pack(tx, id, { packageCount: body.packageCount, at, actorId: actor!.principalId });
      if (await this.everyLinePackedIn(tx, order)) await this.moveIn(tx, header, 'PACKED', `Pick list ${f.fulfilmentNo} packed`, at, actor!.principalId);
      const view = await this.viewOf(tx, id);
      const packed: FulfilmentPacked = {
        fulfilmentId: id,
        fulfilmentNo: f.fulfilmentNo,
        orderId: header.id,
        orderNo: header.orderNo!,
        branchId: f.branchId,
        packageCount: body.packageCount,
        weighedTotalPesewas: view.weighedTotalPesewas ?? 0,
        packedAt: at.toISOString(),
      };
      await this.events.publish(tx, { type: FULFILMENT_PACKED, subjectType: 'Fulfilment', subjectId: id, branchId: f.branchId, payload: packed, occurredAt: at });
      await this.audit.record(tx, { module: 'ord', action: 'PACK', entityType: 'Fulfilment', entityId: id, branchId: f.branchId, before: { ...before }, after: { ...view } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * cancelFulfilment (FR-ORD-014): a pick list not yet packed is cancelled with its reason, its picks withdrawn (nothing
   * moved, so nothing goes back), its lines free to go on another pick list; the order stays where it is.
   */
  cancel(actor: Actor | undefined, id: string, body: { readonly reason: string }, key: string): Promise<StoredResponse<FulfilmentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const claim = await this.idempotency.claim(tx, { operationId: 'cancelFulfilment', principalId: actor!.principalId, key, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<FulfilmentView>;
      const f = await this.lockFulfilment(tx, id);
      await this.authoriser.authorise(tx, actor, PICK, { branchId: f.branchId });
      if (f.status !== 'PICK_LIST' && f.status !== 'PICKING') throw invalidState(`pick list ${id}`, f.status);
      const header = await this.lockOrder(tx, f.salesOrderId);
      const before = await this.viewOf(tx, id);
      const full = (await this.store.fulfilments(tx, [id]))[0]!;
      const at = this.clock.now();
      const picked = activeOf(full.picks);
      await this.store.withdrawPicks(
        tx,
        picked.map((p) => p.id),
        at,
        actor!.principalId,
      );
      await this.store.cancel(tx, id, { reason: body.reason, at, actorId: actor!.principalId });
      await this.repriceIn(tx, (await this.orderStore.orders(tx, [header.id]))[0]!, [...new Set(picked.map((p) => p.salesOrderLineId))]);
      await this.judgeToleranceIn(tx, header.id, actor!.principalId);
      const view = await this.viewOf(tx, id);
      await this.audit.record(tx, { module: 'ord', action: 'CANCEL', entityType: 'Fulfilment', entityId: id, branchId: f.branchId, before: { ...before }, after: { ...view, reason: body.reason } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * proposeSubstitution (FR-ORD-013, CR-054 point 3): another product for an open line of a picking order, in a unit it
   * is sold by, priced by the engine now; the order waits AWAITING_CUSTOMER and nothing is substituted until the
   * customer accepts. A smaller quantity of the same product is `proposeShortPick`, never a substitution.
   */
  proposeSubstitution(
    actor: Actor | undefined,
    orderId: string,
    body: { readonly lineId: string; readonly productId: string; readonly stockUnitId?: string | undefined; readonly quantity: string; readonly uom?: string | undefined; readonly note: string },
    key: string,
  ): Promise<StoredResponse<SalesOrderView>> {
    return this.ask(actor, orderId, key, 'proposeSubstitution', body, async (tx, header, line) => {
      const broken: SaleRule[] = [];
      const at = this.clock.now();
      const product = (await this.refs.productsIn(tx, [body.productId])).get(body.productId);
      if (product === undefined || !product.isLive) throw new FulfilmentInvalidError([{ field: '/productId', rule: 'PRODUCT_NOT_ACTIVE' }]);
      if (product.stockPolicy === 'NON_STOCK') broken.push({ field: '/productId', rule: 'PRODUCT_NOT_STOCKED' });
      if (product.id === line.productId) broken.push({ field: '/productId', rule: 'SAME_PRODUCT' });
      const qty = Quantity.parse(body.quantity);
      const uom = body.uom ?? line.uom;
      if (uom !== product.baseUom) {
        const converted = await this.refs.toBaseIn(tx, product.id, uom, qty);
        if (!converted.ok) broken.push({ field: '/uom', rule: converted.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'UNIT_NOT_SOLD' });
      }
      const unitId = body.stockUnitId ?? null;
      if (product.tracking === 'SERIAL') {
        if (unitId === null) broken.push({ field: '/stockUnitId', rule: 'STOCK_UNIT_REQUIRED' });
        if (!qty.equals(Quantity.ofUnits(1n))) broken.push({ field: '/quantity', rule: 'ONE_ANIMAL_PER_LINE' });
      }
      if (unitId !== null) {
        const unit = (await this.units.factsIn(tx, [unitId], at)).get(unitId);
        if (unit === undefined || unit.productId !== product.id) broken.push({ field: '/stockUnitId', rule: 'STOCK_UNIT_OTHER_PRODUCT' });
      }
      if (broken.length > 0) throw new FulfilmentInvalidError(broken);
      const resolved = await this.pricing.resolveIn(tx, {
        channel: header.channel,
        branchId: header.branchId,
        customerId: header.customerId ?? undefined,
        at,
        lines: [{ lineRef: '0', productId: product.id, quantity: qty.toDecimalString(), ...(uom === product.baseUom ? {} : { uom }) }],
      });
      const band = resolved.lines[0]?.outcome === 'RESOLVED' ? resolved.lines[0].resolved : null;
      if (band === null || band === undefined) throw new FulfilmentInvalidError([{ field: '/productId', rule: 'NO_PRICE' }]);
      if (band.basis === 'PER_KG') throw new FulfilmentInvalidError([{ field: '/productId', rule: 'CATCH_WEIGHT_NOT_AVAILABLE' }]);
      const list = BigInt(band.listPricePesewas);
      const total = extendPrice(list, band.basis, { quantity: qty, weight: null });
      if (!total.ok) throw new Error('a unit price extends without a weight');
      return {
        kind: 'SUBSTITUTION' as const,
        proposedProductId: product.id,
        proposedStockUnitId: unitId,
        proposedQty: qty.toDecimalString(),
        proposedUom: uom,
        priceListEntryId: band.priceListEntryId,
        priceBasis: band.basis,
        resolvedUnitPricePesewas: list,
        floorUnitPricePesewas: BigInt(band.floorPricePesewas),
        ceilingUnitPricePesewas: BigInt(band.ceilingPricePesewas),
        proposedLineTotalPesewas: total.value,
        weighedWeightKg: null,
        weighedTotalPesewas: null,
      };
    });
  }

  /**
   * proposeShortPick (CR-054 point 2): a smaller quantity of an open line, in its own unit, at least nothing and less
   * than it ordered; the order waits AWAITING_CUSTOMER, and the pick list packs at that quantity only once the customer
   * agrees. A catch-weight line goes by its weight instead (FR-ORD-010): it packs below its tolerance at the lower total.
   */
  proposeShortPick(actor: Actor | undefined, orderId: string, body: { readonly lineId: string; readonly quantity: string; readonly note: string }, key: string): Promise<StoredResponse<SalesOrderView>> {
    return this.ask(actor, orderId, key, 'proposeShortPick', body, async (tx, _header, line) => {
      if (isCatchWeight(line)) throw new FulfilmentInvalidError([{ field: '/lineId', rule: 'CATCH_WEIGHT_GOES_BY_WEIGHT' }]);
      const qty = Quantity.parse(body.quantity);
      if (qty.compareTo(Quantity.parse(line.qtyOrdered)) >= 0) throw new FulfilmentInvalidError([{ field: '/quantity', rule: 'SHORT_NOT_LESS' }]);
      if (!qty.isZero()) {
        const converted = await this.refs.toBaseIn(tx, line.productId, line.uom, qty);
        if (!converted.ok) throw new FulfilmentInvalidError([{ field: '/quantity', rule: 'INEXACT_QUANTITY' }]);
      }
      return {
        kind: 'SHORT_PICK' as const,
        proposedProductId: null,
        proposedStockUnitId: null,
        proposedQty: qty.toDecimalString(),
        proposedUom: line.uom,
        priceListEntryId: null,
        priceBasis: null,
        resolvedUnitPricePesewas: null,
        floorUnitPricePesewas: null,
        ceilingUnitPricePesewas: null,
        proposedLineTotalPesewas: null,
        weighedWeightKg: null,
        weighedTotalPesewas: null,
      };
    });
  }

  /**
   * recordCustomerConsent (FR-ORD-010, FR-ORD-013): the customer's answer to what the order waits for, as staff took it
   * (by phone, in person, on WhatsApp or by a signed link), never by the person who asked (A-334). `kind` must be what
   * the order asked (CR-053).
   */
  recordConsent(
    actor: Actor | undefined,
    orderId: string,
    body: { readonly kind: OrderConsentRecord['kind']; readonly accepted: boolean; readonly method: 'PHONE' | 'IN_PERSON' | 'WHATSAPP' | 'SIGNED_LINK'; readonly note?: string | undefined },
    key: string,
  ): Promise<StoredResponse<SalesOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, UPDATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'recordCustomerConsent', principalId: actor!.principalId, key, request: { orderId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView>;
      const header = await this.lockOrder(tx, orderId);
      await this.authoriser.authorise(tx, actor, UPDATE, { branchId: header.branchId });
      const pending = await this.store.pendingConsent(tx, orderId);
      if (pending === null) throw new FulfilmentInvalidError([{ field: '/kind', rule: 'NO_CONSENT_PENDING' }]);
      if (pending.kind !== body.kind) throw new FulfilmentInvalidError([{ field: '/kind', rule: 'CONSENT_KIND_MISMATCH' }]);
      if (pending.createdBy === actor!.principalId && body.method !== 'SIGNED_LINK') throw new FulfilmentInvalidError([{ field: '/method', rule: 'CONSENT_ASKER_CANNOT_ANSWER' }]);
      await this.answerIn(tx, header, pending, body.accepted, body.method, body.note ?? null, actor!);
      const response = { status: 200, body: await this.orders.viewOf(tx, orderId) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The customer's own answer (answerMyOrderConsent), in the caller's transaction: the caller has proved the order is
   * the signed-in customer's. No question waiting is FULFILMENT_INVALID `NO_CONSENT_PENDING`.
   */
  async answerMineIn(tx: Transaction, actor: Actor, orderId: string, accepted: boolean): Promise<void> {
    const header = await this.lockOrder(tx, orderId);
    const pending = await this.store.pendingConsent(tx, orderId);
    if (pending === null) throw new FulfilmentInvalidError([{ field: '/accepted', rule: 'NO_CONSENT_PENDING' }]);
    await this.answerIn(tx, header, pending, accepted, 'CUSTOMER_ACCOUNT', null, actor);
  }

  /** The common path of a proposal: a picking order, an open line of it, no question already waiting. */
  private ask(
    actor: Actor | undefined,
    orderId: string,
    key: string,
    operationId: string,
    body: { readonly lineId: string; readonly note: string },
    propose: (tx: Transaction, header: OrderHeaderRecord, line: OrderLineRecord) => Promise<Omit<OrderConsentRecord, 'id' | 'salesOrderId' | 'salesOrderLineId' | 'status' | 'note' | 'askedAt' | 'answeredBy' | 'answeredAt' | 'method' | 'answerNote' | 'substituteLineId' | 'branchId' | 'createdBy'>>,
  ): Promise<StoredResponse<SalesOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PICK);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { orderId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SalesOrderView>;
      const header = await this.lockOrder(tx, orderId);
      await this.authoriser.authorise(tx, actor, PICK, { branchId: header.branchId });
      if (header.status === 'AWAITING_CUSTOMER') throw new FulfilmentInvalidError([{ field: '/lineId', rule: 'CONSENT_PENDING' }]);
      if (header.status !== 'PICKING') throw invalidState(`order ${orderId}`, header.status);
      const order = (await this.orderStore.orders(tx, [orderId]))[0]!;
      const line = order.lines.find((l) => l.id === body.lineId);
      if (line === undefined) throw new FulfilmentInvalidError([{ field: '/lineId', rule: 'LINE_NOT_ON_ORDER' }]);
      if (line.lineStatus !== 'OPEN') throw new FulfilmentInvalidError([{ field: '/lineId', rule: 'LINE_NOT_OPEN' }]);
      const before = await this.orders.viewOf(tx, orderId);
      const proposal = await propose(tx, header, line);
      const at = this.clock.now();
      const consentId = this.nextId();
      await this.store.insertConsent(tx, { id: consentId, salesOrderId: orderId, salesOrderLineId: line.id, note: body.note, askedAt: at, branchId: header.branchId, createdBy: actor!.principalId, ...proposal });
      await this.moveIn(tx, header, 'AWAITING_CUSTOMER', `Asked the customer: ${proposal.kind}`, at, actor!.principalId);
      await this.publishAsked(tx, header, line, (await this.store.pendingConsent(tx, orderId))!);
      const view = await this.orders.viewOf(tx, orderId);
      await this.audit.record(tx, { module: 'ord', action: 'PROPOSE', entityType: 'SalesOrder', entityId: orderId, branchId: header.branchId, before: { ...before }, after: { ...view } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * The answer, whoever gives it (FR-ORD-013). A higher total accepted lets the line pack at its weighed total. A
   * substitute accepted replaces the line: the original SUBSTITUTED, its picks withdrawn and its stock released, the
   * substitute written at its proposed price with stock reserved for it and put on the original's open pick list (no
   * stock, and the answer is refused STOCK_UNAVAILABLE with nothing changed). A substitute or a smaller quantity refused,
   * or a smaller quantity of nothing accepted, cancels the line; the last line cancelled cancels the order, refunding
   * what was paid. Then the order picks on, or asks the next question.
   */
  private async answerIn(tx: Transaction, header: OrderHeaderRecord, pending: OrderConsentRecord, accepted: boolean, method: Exclude<ConsentMethod, 'SYSTEM'>, note: string | null, actor: Actor): Promise<void> {
    const at = this.clock.now();
    const actorId = actor.principalId;
    const before = await this.orders.viewOf(tx, header.id);
    await this.store.answerConsent(tx, pending.id, { status: accepted ? 'ACCEPTED' : 'REFUSED', answeredBy: actorId, at, method, note });
    const order = (await this.orderStore.orders(tx, [header.id]))[0]!;
    const line = order.lines.find((l) => l.id === pending.salesOrderLineId)!;
    if (pending.kind === 'SUBSTITUTION' && accepted) {
      await this.substituteIn(tx, order, line, pending, actorId);
    } else if (pending.kind !== 'HIGHER_TOTAL' && (!accepted || Quantity.parse(pending.proposedQty!).isZero())) {
      await this.endLineIn(tx, order, line, 'CANCELLED', actorId);
    }
    const answered: CustomerConsentAnswered = {
      consentId: pending.id,
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      kind: pending.kind,
      accepted,
      method,
      answeredBy: actorId,
      answeredAt: at.toISOString(),
    };
    await this.events.publish(tx, { type: CUSTOMER_CONSENT_ANSWERED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: answered, occurredAt: at });
    const after = (await this.orderStore.orders(tx, [header.id]))[0]!;
    if (!after.lines.some((l) => l.lineStatus === 'OPEN')) {
      await this.reversals.cancelForCustomerIn(tx, header.id, actor, OUT_OF_STOCK_REASON, `The customer refused what order ${header.orderNo!} could send`);
      return;
    }
    await this.judgeToleranceIn(tx, header.id, actorId);
    await this.audit.record(tx, { module: 'ord', action: 'CONSENT', entityType: 'SalesOrder', entityId: header.id, branchId: header.branchId, before: { ...before }, after: { ...(await this.orders.viewOf(tx, header.id)), consentId: pending.id, accepted, method } });
  }

  private async substituteIn(tx: Transaction, order: OrderRecord, line: OrderLineRecord, c: OrderConsentRecord, actorId: string): Promise<void> {
    const openList = await this.openPickListOf(tx, order.id, line.id);
    await this.endLineIn(tx, order, line, 'SUBSTITUTED', actorId);
    const qty = Quantity.parse(c.proposedQty!);
    const lineId = this.nextId();
    const substitute: NewOrderLine = {
      id: lineId,
      salesOrderId: order.id,
      lineNo: nextLineNumber(order.lines.map((l) => l.lineNo)),
      productId: c.proposedProductId!,
      stockUnitId: c.proposedStockUnitId,
      qtyOrdered: qty.toDecimalString(),
      uom: c.proposedUom!,
      qtyFulfilled: '0.000',
      fulfilledWeightKg: null,
      weightSource: null,
      priceSource: 'ENGINE',
      priceBasis: c.priceBasis!,
      priceListEntryId: c.priceListEntryId,
      resolvedUnitPricePesewas: c.resolvedUnitPricePesewas!,
      floorUnitPricePesewas: c.floorUnitPricePesewas!,
      ceilingUnitPricePesewas: c.ceilingUnitPricePesewas!,
      agreedUnitPricePesewas: c.resolvedUnitPricePesewas!,
      variancePesewas: 0n,
      varianceDirection: null,
      varianceReasonCode: null,
      varianceRequiresApproval: false,
      varianceApprovalRequestId: null,
      varianceApprovedBy: null,
      varianceApprovedAt: null,
      discountPesewas: 0n,
      estimatedLineTotalPesewas: c.proposedLineTotalPesewas!,
      finalLineTotalPesewas: null,
      reservationId: null,
      stockMovementId: null,
      lineStatus: 'OPEN',
    };
    await this.orderStore.insertLines(tx, [substitute]);
    await this.store.setSubstitutedFor(tx, lineId, line.id);
    await this.store.setSubstituteLine(tx, c.id, lineId, this.clock.now(), actorId);
    // The substitute's stock is promised to the order now, oldest first, or the answer is refused with nothing changed.
    const base = await this.refs.toBaseIn(tx, substitute.productId, substitute.uom, qty);
    if (!base.ok) throw new Error(`substitute line ${lineId} in ${substitute.uom} has no exact base quantity (${base.error})`);
    const offered = (await this.stock.promisableIn(tx, order.branchId, [substitute.productId])).filter((b) => substitute.stockUnitId === null || b.stockUnitId === substitute.stockUnitId);
    const plan = planLineReservation(base.value, offered);
    if (plan.kind === 'SHORT') throw new OrderStockShortError([{ lineNo: substitute.lineNo, wanted: base.value.toDecimalString(), short: plan.short.toDecimalString() }]);
    const held: string[] = [];
    for (const piece of plan.pieces) {
      const b = offered[piece.index]!;
      held.push(await this.reservations.reserveIn(tx, actorId, { productId: b.productId, stockUnitId: b.stockUnitId, locationId: b.locationId, qty: piece.qty, holderDocumentId: order.id, expiresAt: null }));
    }
    if (held.length === 1) await this.orderStore.holdLine(tx, lineId, held[0]!);
    if (openList !== null) {
      const full = (await this.store.fulfilments(tx, [openList]))[0]!;
      await this.store.insertPickListLines(tx, [{ id: this.nextId(), fulfilmentId: openList, salesOrderLineId: lineId, lineNo: nextLineNumber(full.pickList.map((p) => p.lineNo)), qtyToPick: qty.toDecimalString(), status: 'OPEN' }], actorId);
    }
  }

  /**
   * A line that will not be sent as ordered: its picks withdrawn, its open pick list lines cancelled, its stock released
   * where the order holds it for this line alone (A-333), its picked figures cleared, and its status set.
   */
  private async endLineIn(tx: Transaction, order: OrderRecord, line: OrderLineRecord, status: 'CANCELLED' | 'SUBSTITUTED', actorId: string): Promise<void> {
    const at = this.clock.now();
    const picks = (await this.store.activePicksOfOrder(tx, order.id)).filter((p) => p.salesOrderLineId === line.id);
    await this.store.withdrawPicks(
      tx,
      picks.map((p) => p.id),
      at,
      actorId,
    );
    const lists = await this.store.fulfilments(
      tx,
      (await this.store.ofOrders(tx, [order.id])).filter((f) => f.status === 'PICK_LIST' || f.status === 'PICKING').map((f) => f.id),
    );
    await this.store.cancelPickListLines(
      tx,
      lists.flatMap((f) => f.pickList.filter((p) => p.salesOrderLineId === line.id && p.status === 'OPEN').map((p) => p.id)),
      at,
      actorId,
    );
    const why = `Order ${order.orderNo!} line ${line.lineNo} ${status === 'SUBSTITUTED' ? 'substituted' : 'cancelled'} with the customer's answer`;
    if (line.reservationId !== null) {
      const held = await this.reservations.heldIn(tx, line.reservationId);
      if (held !== null && held.status === 'ACTIVE') await this.reservations.releaseIn(tx, actorId, line.reservationId, why);
    } else if (!order.lines.some((l) => l.id !== line.id && l.lineStatus === 'OPEN' && l.productId === line.productId)) {
      for (const r of await this.reservations.activeOfHolderIn(tx, order.id)) {
        if (r.productId === line.productId && (line.stockUnitId === null || r.stockUnitId === line.stockUnitId)) await this.reservations.releaseIn(tx, actorId, r.id, why);
      }
    }
    await this.store.setLinePicked(tx, line.id, { qtyPicked: '0.000', weightKg: null, weightSource: null, finalLineTotalPesewas: null });
    await this.store.setLineStatus(tx, line.id, status);
  }

  /** The open pick list (PICK_LIST or PICKING) with an open line for this order line, or null. */
  private async openPickListOf(tx: Transaction, orderId: string, lineId: string): Promise<string | null> {
    const lists = await this.store.fulfilments(
      tx,
      (await this.store.ofOrders(tx, [orderId])).filter((f) => f.status === 'PICK_LIST' || f.status === 'PICKING').map((f) => f.id),
    );
    return lists.find((f) => f.pickList.some((p) => p.salesOrderLineId === lineId && p.status === 'OPEN'))?.id ?? null;
  }

  /** What each (product, unit, location) of the order's branch may give this order: not promised to others, its own reservations its own. */
  private async allowedAt(tx: Transaction, header: OrderHeaderRecord, productIds: readonly string[]): Promise<Map<string, Quantity>> {
    const allowed = new Map<string, Quantity>();
    const add = (k: string, q: Quantity) => allowed.set(k, (allowed.get(k) ?? Quantity.zero()).plus(q));
    for (const b of await this.stock.promisableIn(tx, header.branchId, productIds)) add(keyOf(b.productId, b.stockUnitId, b.locationId), b.availableQty);
    for (const r of await this.reservations.activeOfHolderIn(tx, header.id)) {
      if (productIds.includes(r.productId)) add(keyOf(r.productId, r.stockUnitId, r.locationId), Quantity.parse(r.qty));
    }
    return allowed;
  }

  /** Each line's picked figures from its picks not withdrawn on every pick list of the order: the line priced once (FR-ORD-009). */
  private async repriceIn(tx: Transaction, order: OrderRecord, lineIds: readonly string[]): Promise<void> {
    if (lineIds.length === 0) return;
    const picks = await this.store.activePicksOfOrder(tx, order.id);
    for (const lineId of lineIds) {
      const line = order.lines.find((l) => l.id === lineId)!;
      const of = picks.filter((p) => p.salesOrderLineId === lineId);
      if (of.length === 0) {
        await this.store.setLinePicked(tx, lineId, { qtyPicked: '0.000', weightKg: null, weightSource: null, finalLineTotalPesewas: null });
        continue;
      }
      const total = pickedLineTotal(
        line.agreedUnitPricePesewas,
        line.priceBasis,
        of.map((p) => ({ qty: Quantity.parse(p.qty), weight: p.weightKg === null ? null : Weight.parseKg(p.weightKg) })),
      );
      const weighed = of.filter((p) => p.weightKg !== null);
      const weight = total.weight ?? (weighed.length === of.length ? Weight.sum(weighed.map((p) => Weight.parseKg(p.weightKg!))) : null);
      await this.store.setLinePicked(tx, lineId, {
        qtyPicked: total.qty.toDecimalString(),
        weightKg: weight === null || weight.isZero() ? null : weight.toKgString(),
        weightSource: weight === null || weight.isZero() ? null : pickWeightSource(weighed.map((p) => p.weightSource!)),
        finalLineTotalPesewas: total.total.pesewas,
      });
    }
  }

  /**
   * FR-ORD-010: a catch-weight line above its tolerance that the customer has not answered at its weighed total is asked
   * about (HIGHER_TOTAL, one question at a time); a waiting HIGHER_TOTAL whose line is no longer so is withdrawn. The
   * order waits AWAITING_CUSTOMER while a question waits and picks on (PICKING) when none does.
   */
  private async judgeToleranceIn(tx: Transaction, orderId: string, actorId: string): Promise<void> {
    const header = await this.lockOrder(tx, orderId);
    if (header.status !== 'PICKING' && header.status !== 'AWAITING_CUSTOMER') return;
    const order = (await this.orderStore.orders(tx, [orderId]))[0]!;
    const consents = await this.store.consentsOf(tx, [orderId]);
    const answeredAt = (line: OrderLineRecord) =>
      consents.some((c) => c.kind === 'HIGHER_TOTAL' && (c.status === 'ACCEPTED' || c.status === 'REFUSED') && c.salesOrderLineId === line.id && c.weighedTotalPesewas === line.finalLineTotalPesewas);
    const toAsk = order.lines.filter((l) => l.lineStatus === 'OPEN' && toleranceOf(l) === 'ABOVE' && !consentedAbove(l, consents) && !answeredAt(l));
    let pending = await this.store.pendingConsent(tx, orderId);
    const at = this.clock.now();
    if (pending !== null && pending.kind === 'HIGHER_TOTAL') {
      const still = toAsk.find((l) => l.id === pending!.salesOrderLineId);
      if (still === undefined || still.finalLineTotalPesewas !== pending.weighedTotalPesewas) {
        await this.store.answerConsent(tx, pending.id, { status: 'WITHDRAWN', answeredBy: actorId, at, method: 'SYSTEM', note: 'The weighed total changed' });
        pending = null;
      }
    }
    if (pending === null && toAsk.length > 0) {
      const line = toAsk[0]!;
      const consentId = this.nextId();
      await this.store.insertConsent(tx, {
        id: consentId,
        salesOrderId: orderId,
        salesOrderLineId: line.id,
        kind: 'HIGHER_TOTAL',
        proposedProductId: null,
        proposedStockUnitId: null,
        proposedQty: null,
        proposedUom: null,
        priceListEntryId: null,
        priceBasis: null,
        resolvedUnitPricePesewas: null,
        floorUnitPricePesewas: null,
        ceilingUnitPricePesewas: null,
        proposedLineTotalPesewas: null,
        weighedWeightKg: line.fulfilledWeightKg,
        weighedTotalPesewas: line.finalLineTotalPesewas,
        note: null,
        askedAt: at,
        branchId: header.branchId,
        createdBy: actorId,
      });
      pending = (await this.store.pendingConsent(tx, orderId))!;
      await this.publishAsked(tx, header, line, pending);
    }
    if (pending !== null && header.status === 'PICKING') await this.moveIn(tx, header, 'AWAITING_CUSTOMER', `Asked the customer: ${pending.kind}`, at, actorId);
    if (pending === null && header.status === 'AWAITING_CUSTOMER') await this.moveIn(tx, header, 'PICKING', 'Nothing waits for the customer', at, actorId);
  }

  private async publishAsked(tx: Transaction, header: OrderHeaderRecord, line: OrderLineRecord, c: OrderConsentRecord): Promise<void> {
    const asked: CustomerConsentRequested = {
      consentId: c.id,
      orderId: header.id,
      orderNo: header.orderNo!,
      branchId: header.branchId,
      customerId: header.customerId,
      kind: c.kind,
      lineNo: line.lineNo,
      proposedProductId: c.proposedProductId,
      proposedQty: c.proposedQty,
      proposedUom: c.proposedUom,
      proposedTotalPesewas: c.kind === 'HIGHER_TOTAL' ? json(c.weighedTotalPesewas!) : c.proposedLineTotalPesewas === null ? null : json(c.proposedLineTotalPesewas),
      askedAt: c.askedAt.toISOString(),
    };
    await this.events.publish(tx, { type: CUSTOMER_CONSENT_REQUESTED, subjectType: 'SalesOrder', subjectId: header.id, branchId: header.branchId, payload: asked, occurredAt: c.askedAt });
  }

  /** Every open line is on a packed pick list for all it asks (or what the customer agreed to), and nothing is still being picked. */
  /** The back-order a pack asks for (FR-ORD-012): each named line open on this pick list, on no other live one, undiscounted. */
  private async backorderRulesIn(tx: Transaction, orderId: string, listId: string, wanted: ReadonlySet<string>, lines: readonly OrderLineRecord[]): Promise<SaleRule[]> {
    if (wanted.size === 0) return [];
    const rules: SaleRule[] = [];
    const others = (await this.store.fulfilments(tx, (await this.store.ofOrders(tx, [orderId])).filter((f) => f.id !== listId && f.status !== 'CANCELLED').map((f) => f.id))).flatMap((f) =>
      f.pickList.filter((p) => p.status === 'OPEN').map((p) => p.salesOrderLineId),
    );
    for (const lineId of wanted) {
      const line = lines.find((l) => l.id === lineId);
      if (line === undefined) rules.push({ field: '/backorderLineIds', rule: 'LINE_UNKNOWN' });
      else if (others.includes(lineId)) rules.push({ field: '/backorderLineIds', rule: 'ON_ANOTHER_PICK_LIST' });
      else if (line.discountPesewas !== 0n) rules.push({ field: '/backorderLineIds', rule: 'BACKORDER_DISCOUNTED' });
    }
    return rules;
  }

  private async everyLinePackedIn(tx: Transaction, order: OrderRecord): Promise<boolean> {
    const lists = await this.store.fulfilments(
      tx,
      (await this.store.ofOrders(tx, [order.id])).map((f) => f.id),
    );
    if (lists.some((f) => f.status === 'PICK_LIST' || f.status === 'PICKING')) return false;
    const consents = await this.store.consentsOf(tx, [order.id]);
    const packed = lists.filter((f) => f.status === 'PACKED');
    return order.lines
      .filter((l) => l.lineStatus === 'OPEN')
      .every((l) => {
        const asked = Quantity.sum(packed.flatMap((f) => f.pickList.filter((p) => p.salesOrderLineId === l.id && p.status === 'OPEN').map((p) => Quantity.parse(p.qtyToPick))));
        if (asked.isZero()) return false;
        return isCatchWeight(l) || asked.equals(Quantity.parse(l.qtyOrdered)) || agreedShortOf(l, consents) !== null;
      });
  }

  private async moveIn(tx: Transaction, header: OrderHeaderRecord, to: OrderStatus, reason: string, at: Date, actorId: string): Promise<void> {
    const from = (await this.orderStore.lock(tx, header.id))!.status;
    if (from === to) return;
    if (!canMove(from, to)) throw invalidState(`order ${header.id}`, from);
    await this.store.moveOrder(tx, header.id, to, at, actorId);
    await this.orderStore.recordStatus(tx, header.id, { id: this.nextId(), fromStatus: from, toStatus: to, reason, occurredAt: at, actorId });
  }

  private async lockOrder(tx: Transaction, id: string): Promise<OrderHeaderRecord> {
    const header = await this.orderStore.lock(tx, id);
    if (header === null) throw new NotFoundError('no such order');
    return header;
  }

  private async lockFulfilment(tx: Transaction, id: string) {
    const f = await this.store.lock(tx, id);
    if (f === null) throw new NotFoundError('no such pick list');
    return f;
  }

  /** A pick list as the contract shows it, in the caller's transaction (dispatch's answer). */
  viewIn(tx: Transaction, id: string): Promise<FulfilmentView> {
    return this.viewOf(tx, id);
  }

  private async viewOf(tx: Transaction, id: string): Promise<FulfilmentView> {
    return (await this.viewsIn(tx, await this.store.fulfilments(tx, [id])))[0]!;
  }

  private async viewsIn(tx: Transaction, lists: readonly FulfilmentRecord[]): Promise<FulfilmentView[]> {
    const orderIds = [...new Set(lists.map((f) => f.salesOrderId))];
    const orders = await this.orderStore.orders(tx, orderIds);
    const consents = await this.store.consentsOf(tx, orderIds);
    const lines = orders.flatMap((o) => o.lines);
    const products = await this.refs.productsIn(
      tx,
      lines.map((l) => l.productId),
    );
    const locations = await this.refs.locationsIn(
      tx,
      lists.map((f) => f.pickLocationId),
    );
    const people = await this.principals.refs(
      tx,
      lists.flatMap((f) => (f.pickerId === null ? [] : [f.pickerId])),
    );
    const suggestions = new Map<string, string[]>();
    for (const f of lists) {
      if (f.status !== 'PICK_LIST' && f.status !== 'PICKING') continue;
      const order = orders.find((o) => o.id === f.salesOrderId)!;
      const own = await this.reservations.activeOfHolderIn(tx, order.id);
      for (const p of f.pickList.filter((x) => x.status === 'OPEN')) {
        const line = lines.find((l) => l.id === p.salesOrderLineId)!;
        const units = own.filter((r) => r.productId === line.productId && r.locationId === f.pickLocationId && r.stockUnitId !== null).map((r) => r.stockUnitId!);
        if (line.stockUnitId !== null) units.unshift(line.stockUnitId);
        for (const lot of await this.stock.lotsAtIn(tx, order.branchId, line.productId, f.pickLocationId)) if (lot.stockUnitId !== null) units.push(lot.stockUnitId);
        suggestions.set(p.id, [...new Set(units)]);
      }
    }
    const unitFacts = await this.units.factsIn(tx, [...new Set([...[...suggestions.values()].flat(), ...lists.flatMap((f) => f.picks.flatMap((p) => (p.stockUnitId === null ? [] : [p.stockUnitId])))])], this.clock.now());
    const unitRef = (id: string): UnitRefView => {
      const u = unitFacts.get(id);
      return { id, identifier: u?.identifier ?? '', tracking: u?.tracking ?? 'LOT' };
    };
    return lists.map((f) => {
      const order = orders.find((o) => o.id === f.salesOrderId)!;
      const lineOf = (lineId: string) => order.lines.find((l) => l.id === lineId)!;
      const productRef = (line: OrderLineRecord) => {
        const p = products.get(line.productId);
        return { id: line.productId, sku: p?.sku ?? '', name: p?.name ?? '' };
      };
      const active = activeOf(f.picks);
      const listed = f.pickList.filter((p) => p.status === 'OPEN' && SENT_OR_OPEN.has(lineOf(p.salesOrderLineId).lineStatus));
      const totals = listed.map((p) => {
        const line = lineOf(p.salesOrderLineId);
        const of = active.filter((x) => x.pickListLineId === p.id);
        return of.length === 0 ? null : pickedLineTotal(line.agreedUnitPricePesewas, line.priceBasis, of.map((x) => ({ qty: Quantity.parse(x.qty), weight: x.weightKg === null ? null : Weight.parseKg(x.weightKg) })));
      });
      const weighed = totals.filter((t) => t !== null);
      const catchLines = listed.map((p) => lineOf(p.salesOrderLineId)).filter((l) => isCatchWeight(l) && toleranceOf(l) !== null);
      const location = locations.get(f.pickLocationId);
      return {
        id: f.id,
        fulfilmentNo: f.fulfilmentNo,
        order: { id: order.id, docType: 'SALES_ORDER' as const, number: order.orderNo },
        status: f.status,
        pickLocation: { id: f.pickLocationId, code: location?.code ?? '', name: location?.name ?? '', kind: location?.kind ?? '' },
        picker: f.pickerId === null ? null : (people.get(f.pickerId) ?? { id: f.pickerId, displayName: f.pickerId }),
        pickList: f.pickList.map((p) => pickListLineView(p, lineOf(p.salesOrderLineId), productRef(lineOf(p.salesOrderLineId)), (suggestions.get(p.id) ?? []).map(unitRef), active)),
        lines: active.map((x) => {
          const line = lineOf(x.salesOrderLineId);
          const price = pickedLineTotal(line.agreedUnitPricePesewas, line.priceBasis, [{ qty: Quantity.parse(x.qty), weight: x.weightKg === null ? null : Weight.parseKg(x.weightKg) }]).total;
          return {
            id: x.id,
            orderLineId: x.salesOrderLineId,
            product: productRef(line),
            stockUnit: x.stockUnitId === null ? null : unitRef(x.stockUnitId),
            packBarcode: x.packBarcode,
            qty: x.qty,
            weightKg: x.weightKg,
            weightSource: x.weightSource,
            linePricePesewas: price.toJsonInteger(),
          };
        }),
        weighedTotalPesewas: weighed.length === 0 ? null : Money.sum(weighed.map((t) => t.total)).toJsonInteger(),
        withinTolerance: catchLines.length === 0 ? null : catchLines.every((l) => toleranceOf(l) !== 'ABOVE' || consentedAbove(l, consents.filter((c) => c.salesOrderId === order.id))),
        pickedAt: f.pickedAt?.toISOString() ?? null,
        packedAt: f.packedAt?.toISOString() ?? null,
        dispatchedAt: f.dispatchedAt?.toISOString() ?? null,
        packageCount: f.packageCount,
        currency: 'GHS' as const,
        branchId: f.branchId,
        version: f.version,
      };
    });
  }
}

function pickListLineView(p: PickListLineRecord, line: OrderLineRecord, product: { id: string; sku: string; name: string }, suggested: UnitRefView[], active: readonly PickRecord[]): PickListLineView {
  const of = active.filter((x) => x.pickListLineId === p.id);
  const estimate = estimateOf(line);
  const limits = estimate === null ? null : toleranceLimits(estimate);
  const weighed = of.filter((x) => x.weightKg !== null);
  const pickedWeight = weighed.length === 0 ? null : Weight.sum(weighed.map((x) => Weight.parseKg(x.weightKg!)));
  return {
    orderLineId: line.id,
    product,
    qtyToPick: p.qtyToPick,
    uom: line.uom,
    estimatedWeightKg: line.estimatedWeightKg,
    suggestedStockUnits: suggested,
    status: p.status,
    pickedQty: Quantity.sum(of.map((x) => Quantity.parse(x.qty))).toDecimalString(),
    pickedWeightKg: pickedWeight?.toKgString() ?? null,
    minimumWeightKg: limits?.minimum.toKgString() ?? null,
    maximumWeightKg: limits?.maximum.toKgString() ?? null,
    toleranceState: estimate === null || pickedWeight === null ? null : toleranceOf(line),
  };
}

/** A resubmitted pick is the same pick: the same line, unit, barcode, quantity and weight. */
function samePick(stored: PickRecord, input: PickInputRequest): boolean {
  return (
    stored.salesOrderLineId === input.orderLineId &&
    stored.stockUnitId === (input.stockUnitId ?? null) &&
    stored.packBarcode === (input.packBarcode ?? null) &&
    Quantity.parse(stored.qty).equals(Quantity.parse(input.qty)) &&
    (stored.weightKg === null ? input.weightKg === undefined : input.weightKg !== undefined && Weight.parseKg(stored.weightKg).equals(Weight.parseKg(input.weightKg)))
  );
}
