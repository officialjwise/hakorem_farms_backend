import { createUuidV7Generator, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Slots } from '../../del';
import { InsufficientStockError, reservationLockKey, StockUnitNotAvailableError, StockUnitOnHoldError, StockUnitReservedError, type Reservations, type StockQueries } from '../../inv';
import type { ReservationEnded } from '../../inv';
import type { OnlineProductFacts, PricingService, Storefront, TaxService } from '../../mdm';
import { lineNumber, reservedUntil } from '../domain/checkout-clock';
import { allocateReservation, checkoutTotals, deliveryFee, wholeUnits } from '../domain/pricing-lines';
import type { CheckoutEnded, CheckoutStarted } from '../events';
import { cedis, STOREFRONT_ACTOR, type CatalogueListing } from './catalogue';
import type { CartProductView, Carts, GuestToken } from './carts';
import {
  CartEmptyError,
  CartNotActiveError,
  CheckoutInvalidError,
  CheckoutNotOpenError,
  DeliveryUnavailableError,
  fill,
  ProductUnavailableError,
  RequestToBuyOnlyError,
  SlotUnavailableError,
  StockUnavailableError,
} from './errors';
import { priceLinesIn } from './line-pricing';
import type { AddressSnapshot, CheckoutLineRecord, CheckoutRecord, CheckoutWrite, ShpStore } from './shp-store';

/** A-045: an online checkout holds its stock this many minutes while payment is awaited (a setting). */
export const RESERVATION_MINUTES_SETTING = 'shp.checkout_reservation_minutes';
const RESERVATION_MINUTES_DEFAULT = 15;
const THOUSANDTHS_PER_UNIT = 1_000n;
const DOC_TYPE = 'CHECKOUT_SESSION';
const LIST_VARIANTS: ReadonlySet<string> = new Set(['thumb', 'card']);

export interface AddressInput {
  readonly recipientName: string;
  readonly recipientPhone: string;
  readonly line1: string;
  readonly area: string;
  readonly city: string;
  readonly region: string;
  readonly digitalAddress?: string | undefined;
  readonly directions?: string | undefined;
}

export interface CheckoutStartRequest {
  readonly contactName: string;
  readonly contactPhone: string;
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly deliveryAddressId?: string | undefined;
  readonly address?: AddressInput | undefined;
  readonly deliverySlotId?: string | undefined;
  readonly paymentTerms: 'PREPAID' | 'COD';
  readonly differencePreference?: 'REFUND' | 'STORE_CREDIT' | undefined;
}

export interface CheckoutUpdateRequest {
  readonly deliveryAddressId?: string | undefined;
  readonly address?: AddressInput | undefined;
  readonly deliverySlotId?: string | undefined;
  readonly paymentTerms?: 'PREPAID' | 'COD' | undefined;
  readonly differencePreference?: 'REFUND' | 'STORE_CREDIT' | undefined;
}

/** The contract's `Checkout`. */
export interface CheckoutView {
  readonly id: string;
  readonly cartId: string;
  readonly status: CheckoutRecord['status'];
  readonly contactName: string;
  readonly contactPhone: string;
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly deliveryAddress: AddressSnapshot | null;
  readonly deliveryZone: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly deliverySlot: { readonly id: string; readonly date: string; readonly startsAt: string; readonly endsAt: string; readonly available: boolean; readonly remaining: number } | null;
  readonly deliveryFeePesewas: number;
  readonly paymentTerms: 'PREPAID' | 'COD';
  readonly taxInclusive: boolean;
  readonly lines: readonly {
    readonly cartLineId: string;
    readonly product: CartProductView;
    readonly quantity: string;
    readonly uom: string;
    readonly unitPricePesewas: number;
    readonly priceBasis: CheckoutLineRecord['priceBasis'];
    readonly catchWeight: boolean;
    readonly estimatedWeightKg: string | null;
    readonly estimatedLineTotalPesewas: number;
    readonly maximumLineTotalPesewas: number;
  }[];
  readonly promotions: CheckoutRecord['promotions'];
  readonly estimatedTotalPesewas: number;
  readonly maximumTotalPesewas: number;
  readonly taxPesewas: number;
  readonly finalChargeRule: string;
  readonly differencePreference: 'REFUND' | 'STORE_CREDIT';
  readonly priceChanged: boolean;
  readonly reservedUntil: string;
  readonly orderId: string | null;
  readonly currency: 'GHS';
}

interface Delivery {
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly addressSnapshot: AddressSnapshot | null;
  readonly deliveryZoneId: string | null;
  readonly deliverySlotId: string | null;
  readonly zone: { readonly feePesewas: bigint; readonly freeOverPesewas: bigint | null } | null;
}

/**
 * Checkout (FR-SHP-005 to FR-SHP-008, ADR-0019, ADR-0021, SA-13): starting one re-resolves every price through MDM's
 * engine, prices the delivery from the address's zone, and reserves every line through INV's `Reservations` at
 * serializable isolation, all lines or none, for the reservation lifetime (A-045). A chosen slot is stored through its
 * foreign key; capacity is B11's. The expiry job ends the reservations exactly as reserved and, in its transaction,
 * this module ends the checkout and gives the cart back (`reservationEndedIn`). Order placement and payment are B09a.
 */
export class Checkouts {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ShpStore,
    private readonly carts: Carts,
    private readonly listing: CatalogueListing,
    private readonly storefront: Storefront,
    private readonly pricing: PricingService,
    private readonly tax: TaxService,
    private readonly stock: StockQueries,
    private readonly reservations: Reservations,
    private readonly slots: Slots,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly settings: Settings,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async start(token: GuestToken, cartId: string, body: CheckoutStartRequest, key: string): Promise<StoredResponse<CheckoutView>> {
    // The balances the cart may reserve from, read first, so their locks are taken before BEGIN and concurrent
    // checkouts of the last crate queue instead of aborting together (ADR-0005, A-060).
    const locks = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const cart = await this.carts.ownedIn(tx, token, cartId, false);
      const lines = await this.store.cartLines(tx, cart.id);
      return (await this.stock.promisableIn(tx, cart.branchId, lines.map((l) => l.productId))).map((r) => reservationLockKey(r.productId, r.stockUnitId, r.locationId));
    });
    return this.uow.run({ isolation: 'serializable', seriesLocks: locks }, async (tx) => {
      const cart = await this.carts.ownedIn(tx, token, cartId, true);
      const claim = await this.idempotency.claim(tx, { operationId: 'startCheckout', principalId: STOREFRONT_ACTOR.principalId, key, request: { cartId, token: cart.guestTokenHash!.toString('hex'), ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CheckoutView>;
      if (cart.status !== 'ACTIVE') throw new CartNotActiveError(`cart ${cartId} is ${cart.status}`);
      const cartLines = await this.store.cartLines(tx, cart.id);
      if (cartLines.length === 0) throw new CartEmptyError(`cart ${cartId} has no lines`);
      const contactPhone = this.storefront.normalisePhone(body.contactPhone);
      if (contactPhone === null) throw new CheckoutInvalidError([{ field: '/contactPhone', rule: 'INVALID_PHONE' }]);

      const products = new Map((await this.storefront.onlineProductsIn(tx, cartLines.map((l) => l.productId))).map((p) => [p.id, p] as const));
      for (const line of cartLines) {
        const product = products.get(line.productId);
        if (product === undefined) throw new ProductUnavailableError(`/lines/${line.id}`, 'NOT_LISTED');
        if (product.onlineMode === 'REQUEST_TO_BUY') throw new RequestToBuyOnlyError(`/lines/${line.id}`);
        if (!wholeUnits(Quantity.parse(line.qty))) throw new CheckoutInvalidError([{ field: `/lines/${line.id}`, rule: 'WHOLE_UNITS' }]);
      }
      const prices = await priceLinesIn(this.pricing, tx, cart.branchId, cart.couponCode, cartLines.map((l) => ({ lineRef: l.id, product: products.get(l.productId)!, quantity: Quantity.parse(l.qty) })));
      const inclusive = await this.storefront.priceListsTaxInclusiveIn(tx, prices.flatMap((p) => (p.kind === 'PRICED' ? [p.priceListId] : [])));
      const lines: CheckoutLineRecord[] = [];
      for (const [index, line] of cartLines.entries()) {
        const price = prices[index]!;
        const product = products.get(line.productId)!;
        if (price.kind !== 'PRICED') throw new ProductUnavailableError(`/lines/${line.id}`, 'NO_ONLINE_PRICE');
        // Online prices are shown with tax in (A-023); a tax-exclusive list on the online channel is not sold here.
        if (inclusive.get(price.priceListId) !== true) throw new ProductUnavailableError(`/lines/${line.id}`, 'NOT_TAX_INCLUSIVE');
        lines.push({
          lineNo: lineNumber(index),
          cartLineId: line.id,
          productId: product.id,
          qty: line.qty,
          uom: line.uom,
          baseQty: (await this.baseQtyIn(tx, product, Quantity.parse(line.qty))).toDecimalString(),
          priceListEntryId: price.priceListEntryId,
          unitPricePesewas: price.unitPrice.pesewas,
          priceBasis: price.basis,
          catchWeight: price.estimate.estimatedWeight !== null,
          estimatedWeightKg: price.estimate.estimatedWeight?.toKgString() ?? null,
          estimatedLineTotalPesewas: price.estimate.estimated.pesewas,
          maximumLineTotalPesewas: price.estimate.maximum.pesewas,
          discountPesewas: price.discount.pesewas,
          taxCategoryId: product.taxCategoryId,
        });
      }
      const priceChanged = cartLines.some((line, index) => {
        const price = prices[index]!;
        return price.kind === 'PRICED' && price.unitPrice.pesewas !== line.displayedUnitPricePesewas;
      });
      const promotions = mergePromotions(prices.flatMap((p) => (p.kind === 'PRICED' ? p.promotions : [])));
      const delivery = await this.deliveryIn(tx, cart.branchId, body);
      const now = this.clock.now();
      const minutes = await this.settings.integer(RESERVATION_MINUTES_SETTING, RESERVATION_MINUTES_DEFAULT, cart.branchId);
      const id = this.nextId();
      const write = await this.priced(tx, {
        id,
        cartId: cart.id,
        contactName: body.contactName.trim(),
        contactPhone,
        paymentTerms: body.paymentTerms,
        couponCode: cart.couponCode,
        promotions,
        differencePreference: body.differencePreference ?? 'REFUND',
        priceChanged,
        reservedUntil: reservedUntil(now, minutes),
        branchId: cart.branchId,
        ...delivery,
      }, lines);
      if (write.paymentTerms === 'COD' && write.fulfilmentMode !== 'DELIVERY') throw new CheckoutInvalidError([{ field: '/paymentTerms', rule: 'COD_NEEDS_DELIVERY' }]);

      await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'shp', branchId: cart.branchId, actorId: STOREFRONT_ACTOR.principalId });
      await this.store.insertCheckout(tx, write, lines, STOREFRONT_ACTOR.principalId);
      await this.reserveIn(tx, cart.branchId, id, lines, write.reservedUntil);
      await this.store.setCart(tx, cart.id, { status: 'CHECKOUT' });
      await this.audit.record(tx, { module: 'shp', action: 'CREATE', entityType: 'CheckoutSession', entityId: id, branchId: cart.branchId, before: null, after: auditFacts(write, lines.length) });
      await this.events.publish<CheckoutStarted>(tx, {
        type: 'shp.CheckoutStarted',
        subjectType: 'CheckoutSession',
        subjectId: id,
        branchId: cart.branchId,
        payload: { checkoutId: id, cartId: cart.id, reservedUntil: write.reservedUntil.toISOString(), estimatedTotalPesewas: Number(write.estimatedTotalPesewas), lineCount: lines.length },
      });
      const response = { status: 201, body: await this.viewIn(tx, (await this.store.checkout(tx, id, false))!) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  get(token: GuestToken, id: string): Promise<CheckoutView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const checkout = await this.ownedIn(tx, token, id, false);
      return this.viewIn(tx, checkout);
    });
  }

  update(token: GuestToken, id: string, body: CheckoutUpdateRequest, key: string): Promise<StoredResponse<CheckoutView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const before = await this.ownedIn(tx, token, id, true);
      const cart = (await this.store.cart(tx, before.cartId, false))!;
      const claim = await this.idempotency.claim(tx, { operationId: 'updateCheckout', principalId: STOREFRONT_ACTOR.principalId, key, request: { id, token: cart.guestTokenHash!.toString('hex'), ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CheckoutView>;
      if (before.status !== 'STARTED' || before.reservedUntil.getTime() <= this.clock.now().getTime()) throw new CheckoutNotOpenError(`checkout ${id} is ${before.status}`);
      const address = body.address ?? (before.addressSnapshot === null ? undefined : { ...before.addressSnapshot, digitalAddress: before.addressSnapshot.digitalAddress ?? undefined, directions: before.addressSnapshot.directions ?? undefined });
      const slotId = body.deliverySlotId ?? before.deliverySlotId ?? undefined;
      const delivery = await this.deliveryIn(tx, before.branchId, { fulfilmentMode: before.fulfilmentMode, address, deliveryAddressId: body.deliveryAddressId, deliverySlotId: slotId });
      const lines = await this.store.checkoutLines(tx, id);
      const write = await this.priced(tx, {
        ...before,
        ...delivery,
        paymentTerms: body.paymentTerms ?? before.paymentTerms,
        differencePreference: body.differencePreference ?? before.differencePreference,
      }, lines);
      if (write.paymentTerms === 'COD' && write.fulfilmentMode !== 'DELIVERY') throw new CheckoutInvalidError([{ field: '/paymentTerms', rule: 'COD_NEEDS_DELIVERY' }]);
      await this.store.updateCheckout(tx, id, write, STOREFRONT_ACTOR.principalId);
      await this.audit.record(tx, { module: 'shp', action: 'UPDATE', entityType: 'CheckoutSession', entityId: id, branchId: before.branchId, before: auditFacts(before, lines.length), after: auditFacts(write, lines.length) });
      const response = { status: 200, body: await this.viewIn(tx, (await this.store.checkout(tx, id, false))!) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * In the transaction that ends one of a checkout's reservations (ADR-0010, a module keeping its own aggregate
   * consistent with a lower module's fact): an expiry ends the checkout EXPIRED (FR-SHP-006), a release by hand ends it
   * CANCELLED; either way the cart is given back and `shp.CheckoutExpired` or `shp.CheckoutCancelled` is published.
   * The other reservations of the checkout are the expiry job's to end, each exactly as reserved.
   */
  async reservationEndedIn(tx: Transaction, event: EventEnvelope): Promise<void> {
    const payload = event.payload as unknown as ReservationEnded;
    const checkout = await this.store.checkout(tx, payload.holderDocumentId, true);
    if (checkout === null || (checkout.status !== 'STARTED' && checkout.status !== 'AWAITING_PAYMENT')) return;
    const status = event.type === 'inv.ReservationExpired' ? 'EXPIRED' : 'CANCELLED';
    await this.store.endCheckout(tx, checkout.id, status, event.actorId);
    await this.store.setCart(tx, checkout.cartId, { status: 'ACTIVE' });
    await this.audit.record(tx, { module: 'shp', action: status === 'EXPIRED' ? 'EXPIRE' : 'CANCEL', entityType: 'CheckoutSession', entityId: checkout.id, branchId: checkout.branchId, before: { status: checkout.status }, after: { status, reservationId: payload.reservationId } });
    await this.events.publish<CheckoutEnded>(tx, {
      type: status === 'EXPIRED' ? 'shp.CheckoutExpired' : 'shp.CheckoutCancelled',
      subjectType: 'CheckoutSession',
      subjectId: checkout.id,
      branchId: checkout.branchId,
      causationId: event.id,
      payload: { checkoutId: checkout.id, cartId: checkout.cartId, reservedUntil: checkout.reservedUntil.toISOString(), reason: payload.reason },
    });
  }

  private async ownedIn(tx: Transaction, token: GuestToken, id: string, lock: boolean): Promise<CheckoutRecord> {
    const checkout = await this.store.checkout(tx, id, lock);
    if (checkout === null) throw new NotFoundError(`no checkout ${id}`);
    // The checkout is the guest's when its cart is: the same 404 for a stranger as for no checkout at all.
    await this.carts.ownedIn(tx, token, checkout.cartId, false);
    return checkout;
  }

  /** A line's quantity in the product's base unit: a catch-weight line's estimated kilograms (A-178), else MDM's exact conversion. */
  private async baseQtyIn(tx: Transaction, product: OnlineProductFacts, quantity: Quantity): Promise<Quantity> {
    const per = await this.listing.perSaleUnit(tx, product);
    return Quantity.ofThousandths((quantity.thousandths * per.thousandths) / THOUSANDTHS_PER_UNIT);
  }

  /** Reserves every line through INV, oldest stock first; one line short and the whole checkout rolls back. */
  private async reserveIn(tx: Transaction, branchId: string, checkoutId: string, lines: readonly CheckoutLineRecord[], expiresAt: Date): Promise<void> {
    const promisable = await this.stock.promisableIn(tx, branchId, lines.map((l) => l.productId));
    const short: string[] = [];
    const plans = lines.map((line) => {
      const rows = promisable.filter((r) => r.productId === line.productId);
      const pieces = allocateReservation(Quantity.parse(line.baseQty), rows);
      if (pieces === null) short.push(line.cartLineId);
      return { line, rows, pieces: pieces ?? [] };
    });
    if (short.length > 0) throw new StockUnavailableError(short);
    for (const plan of plans) {
      for (const piece of plan.pieces) {
        const row = plan.rows[piece.index]!;
        try {
          await this.reservations.reserveIn(tx, STOREFRONT_ACTOR.principalId, { productId: row.productId, stockUnitId: row.stockUnitId, locationId: row.locationId, qty: piece.qty, holderDocumentId: checkoutId, expiresAt });
        } catch (error) {
          if (error instanceof InsufficientStockError || error instanceof StockUnitNotAvailableError || error instanceof StockUnitReservedError || error instanceof StockUnitOnHoldError) {
            throw new StockUnavailableError([plan.line.cartLineId]);
          }
          throw error;
        }
      }
    }
  }

  /** The delivery side of a checkout: collection, or the zone of the address with a slot of that zone (FR-SHP-008, SA-13). */
  private async deliveryIn(tx: Transaction, branchId: string, body: Pick<CheckoutStartRequest, 'fulfilmentMode' | 'address' | 'deliveryAddressId' | 'deliverySlotId'>): Promise<Delivery> {
    // Saved addresses belong to customer accounts, which arrive with registered checkout (B09a, FR-SHP-010).
    if (body.deliveryAddressId !== undefined) throw new CheckoutInvalidError([{ field: '/deliveryAddressId', rule: 'SAVED_ADDRESS_NEEDS_ACCOUNT' }]);
    if (body.fulfilmentMode === 'COLLECTION') {
      if (body.deliverySlotId !== undefined) throw new SlotUnavailableError('NOT_FOR_COLLECTION');
      if (body.address !== undefined) throw new CheckoutInvalidError([{ field: '/address', rule: 'NOT_FOR_COLLECTION' }]);
      return { fulfilmentMode: 'COLLECTION', addressSnapshot: null, deliveryZoneId: null, deliverySlotId: null, zone: null };
    }
    if (body.address === undefined) throw new CheckoutInvalidError([{ field: '/address', rule: 'REQUIRED' }]);
    const checked = this.storefront.checkAddress(body.address);
    if (!checked.ok) throw new CheckoutInvalidError(checked.error.map((rule) => ({ field: `/address${rule.field ?? ''}`, rule: rule.rule })));
    const zone = await this.storefront.deliveryZoneForIn(tx, body.address);
    if (zone === null || zone.branchId !== branchId) throw new DeliveryUnavailableError();
    let slotId: string | null = null;
    if (body.deliverySlotId !== undefined) {
      const slot = await this.slots.slotIn(tx, body.deliverySlotId);
      if (slot === null) throw new SlotUnavailableError('UNKNOWN');
      if (slot.deliveryZoneId !== zone.id) throw new SlotUnavailableError('OTHER_ZONE');
      if (slot.started) throw new SlotUnavailableError('STARTED');
      slotId = slot.id;
    }
    const a = body.address;
    return {
      fulfilmentMode: 'DELIVERY',
      addressSnapshot: { recipientName: a.recipientName.trim(), recipientPhone: checked.value.recipientPhone, line1: a.line1.trim(), area: a.area.trim(), city: a.city.trim(), region: checked.value.region, digitalAddress: checked.value.digitalAddress, directions: a.directions?.trim() ?? null },
      deliveryZoneId: zone.id,
      deliverySlotId: slotId,
      zone,
    };
  }

  /** The totals of a checkout from its lines and delivery: sums of integers, the fee, and the tax calculator's levies. */
  private async priced(
    tx: Transaction,
    base: Omit<CheckoutWrite, 'deliveryFeePesewas' | 'taxInclusive' | 'discountPesewas' | 'taxPesewas' | 'estimatedTotalPesewas' | 'maximumTotalPesewas'> & { readonly zone?: Delivery['zone'] },
    lines: readonly CheckoutLineRecord[],
  ): Promise<CheckoutWrite> {
    const priced = lines.map((l) => ({ estimated: Money.ofPesewas(l.estimatedLineTotalPesewas), maximum: Money.ofPesewas(l.maximumLineTotalPesewas), discount: Money.ofPesewas(l.discountPesewas) }));
    const goods = checkoutTotals(priced, Money.zero());
    const fee = base.zone === null || base.zone === undefined ? Money.zero() : deliveryFee(base.zone, goods.estimated);
    const totals = checkoutTotals(priced, fee);
    const taxLines = lines.map((l) => ({ lineRef: String(l.lineNo), taxCategoryId: l.taxCategoryId, amountPesewas: l.estimatedLineTotalPesewas - l.discountPesewas }));
    if (!fee.isZero()) taxLines.push({ lineRef: 'delivery', taxCategoryId: await this.storefront.deliveryTaxCategoryIdIn(tx), amountPesewas: fee.pesewas });
    const tax = await this.tax.calculateIn(tx, { taxInclusive: true, taxDate: toBusinessDate(this.clock.now()), lines: taxLines });
    const { zone: _zone, ...rest } = base;
    return {
      ...rest,
      deliveryFeePesewas: fee.pesewas,
      taxInclusive: true,
      discountPesewas: totals.discount.pesewas,
      taxPesewas: tax.totals.tax.pesewas,
      estimatedTotalPesewas: totals.estimated.pesewas,
      maximumTotalPesewas: totals.maximum.pesewas,
    };
  }

  private async viewIn(tx: Transaction, checkout: CheckoutRecord): Promise<CheckoutView> {
    const lines = await this.store.checkoutLines(tx, checkout.id);
    const [listings, products, zones, slot] = await Promise.all([
      this.store.listings(tx, checkout.branchId, lines.map((l) => l.productId)),
      this.storefront.onlineProductsIn(tx, lines.map((l) => l.productId)),
      this.storefront.zoneRefsIn(tx, checkout.deliveryZoneId === null ? [] : [checkout.deliveryZoneId]),
      checkout.deliverySlotId === null ? Promise.resolve(null) : this.slots.slotIn(tx, checkout.deliverySlotId),
    ]);
    const names = new Map(products.map((p) => [p.id, p.name] as const));
    const zone = checkout.deliveryZoneId === null ? undefined : zones.get(checkout.deliveryZoneId);
    const catchWeight = lines.some((l) => l.catchWeight);
    const difference = checkout.differencePreference === 'REFUND' ? 'shp.difference_refund' : 'shp.difference_store_credit';
    return {
      id: checkout.id,
      cartId: checkout.cartId,
      status: checkout.status,
      contactName: checkout.contactName,
      contactPhone: checkout.contactPhone,
      fulfilmentMode: checkout.fulfilmentMode,
      deliveryAddress: checkout.addressSnapshot,
      deliveryZone: zone === undefined ? null : { id: zone.id, code: zone.code, name: zone.name },
      deliverySlot: slot?.option ?? null,
      deliveryFeePesewas: Number(checkout.deliveryFeePesewas),
      paymentTerms: checkout.paymentTerms,
      taxInclusive: checkout.taxInclusive,
      lines: lines.map((l) => {
        const listing = listings.get(l.productId);
        const image = listing?.images[0];
        return {
          cartLineId: l.cartLineId,
          product: { id: l.productId, slug: listing?.slug ?? l.productId, name: names.get(l.productId) ?? listing?.name ?? l.productId, image: image === undefined ? null : { alt: image.alt, variants: image.variants.filter((v) => LIST_VARIANTS.has(v.variant)) } },
          quantity: l.qty,
          uom: l.uom,
          unitPricePesewas: Number(l.unitPricePesewas),
          priceBasis: l.priceBasis,
          catchWeight: l.catchWeight,
          estimatedWeightKg: l.estimatedWeightKg,
          estimatedLineTotalPesewas: Number(l.estimatedLineTotalPesewas),
          maximumLineTotalPesewas: Number(l.maximumLineTotalPesewas),
        };
      }),
      promotions: checkout.promotions,
      estimatedTotalPesewas: Number(checkout.estimatedTotalPesewas),
      maximumTotalPesewas: Number(checkout.maximumTotalPesewas),
      taxPesewas: Number(checkout.taxPesewas),
      finalChargeRule: catchWeight
        ? fill('shp.final_charge_rule', { estimate: cedis(checkout.estimatedTotalPesewas), maximum: cedis(checkout.maximumTotalPesewas), difference: fill(difference, {}) })
        : fill('shp.final_charge_rule_fixed', { estimate: cedis(checkout.estimatedTotalPesewas) }),
      differencePreference: checkout.differencePreference,
      priceChanged: checkout.priceChanged,
      reservedUntil: checkout.reservedUntil.toISOString(),
      orderId: checkout.orderId,
      currency: 'GHS',
    };
  }
}

/** One entry per promotion, its discounts summed over the lines it applied to. */
function mergePromotions(applied: readonly CheckoutRecord['promotions'][number][]): CheckoutRecord['promotions'] {
  const merged = new Map<string, { promotionId: string; code: string; name: string; discount: bigint }>();
  for (const p of applied) {
    const entry = merged.get(p.promotionId) ?? { promotionId: p.promotionId, code: p.code, name: p.name, discount: 0n };
    entry.discount += BigInt(p.discountPesewas);
    merged.set(p.promotionId, entry);
  }
  return [...merged.values()].map((p) => ({ promotionId: p.promotionId, code: p.code, name: p.name, discountPesewas: Number(p.discount) }));
}

/** The checkout's facts for the audit trail, with no personal data (the guest has no subject key, ADR-0022). */
function auditFacts(c: Pick<CheckoutWrite, 'fulfilmentMode' | 'deliveryZoneId' | 'deliverySlotId' | 'deliveryFeePesewas' | 'paymentTerms' | 'discountPesewas' | 'taxPesewas' | 'estimatedTotalPesewas' | 'maximumTotalPesewas' | 'reservedUntil' | 'priceChanged'>, lineCount: number) {
  return {
    fulfilmentMode: c.fulfilmentMode,
    deliveryZoneId: c.deliveryZoneId,
    deliverySlotId: c.deliverySlotId,
    deliveryFeePesewas: c.deliveryFeePesewas.toString(),
    paymentTerms: c.paymentTerms,
    discountPesewas: c.discountPesewas.toString(),
    taxPesewas: c.taxPesewas.toString(),
    estimatedTotalPesewas: c.estimatedTotalPesewas.toString(),
    maximumTotalPesewas: c.maximumTotalPesewas.toString(),
    reservedUntil: c.reservedUntil.toISOString(),
    priceChanged: c.priceChanged,
    lineCount,
  };
}
