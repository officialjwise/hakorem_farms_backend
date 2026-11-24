import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { StockQueries } from '../../inv';
import type { MasterDataRefs, OnlineProductFacts, PricingService, Storefront } from '../../mdm';
import { wholeUnits, type PriceBasis } from '../domain/pricing-lines';
import type { CatalogueListing } from './catalogue';
import { STOREFRONT_ACTOR } from './catalogue';
import { CartNotActiveError, CouponAlreadyAppliedError, ProductUnavailableError, QuantityInvalidError, RequestToBuyOnlyError } from './errors';
import { priceLinesIn } from './line-pricing';
import type { CartLineRecord, CartRecord, ImageSetView, ShpStore } from './shp-store';

/** The most lines one cart holds. */
export const MAX_CART_LINES = 50;
const TOKEN_BYTES = 32;
const THOUSANDTHS_PER_UNIT = 1_000n;
const LIST_VARIANTS: ReadonlySet<string> = new Set(['thumb', 'card']);

/** The contract's `CartProduct`. */
export interface CartProductView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly image: ImageSetView | null;
}

/** The contract's `Cart`. */
export interface CartView {
  readonly id: string;
  readonly status: CartRecord['status'];
  /** The open checkout while the cart is at checkout, so another tab or device can open it (CR-029); null otherwise. */
  readonly checkoutId: string | null;
  readonly lines: readonly {
    readonly id: string;
    readonly product: CartProductView;
    readonly quantity: string;
    readonly uom: string;
    readonly displayedUnitPricePesewas: number;
    readonly priceBasis: PriceBasis;
    readonly catchWeight: boolean;
    readonly estimatedWeightKg: string | null;
    readonly estimatedLineTotalPesewas: number;
    readonly available: boolean;
  }[];
  readonly itemCount: number;
  readonly estimatedSubtotalPesewas: number;
  readonly couponCode: string | null;
  readonly currency: 'GHS';
  readonly updatedAt: string;
}

/** A guest's proof that a cart is theirs: the token in the `__Host-hk_guest` cookie, never stored, only its keyed hash. */
export interface GuestToken {
  readonly value: string | undefined;
}

/**
 * Guest carts (FR-SHP-003, FR-SHP-004, A-177): an unguessable cart id and a guest token in a host-only cookie, its
 * keyed hash stored; a request without the matching token is told the cart does not exist (404, no enumeration).
 * Prices are re-resolved by MDM's engine on every read and change, never stored as authority; a request-to-buy
 * product (a live animal) is refused; quantities are whole sale units; one coupon, validated by the engine. Every
 * write takes an Idempotency-Key, bound to the token, and is audited as the Storefront principal.
 */
export class Carts {
  private readonly nextId: () => string;
  private readonly tokenKey: Buffer;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ShpStore,
    private readonly listing: CatalogueListing,
    private readonly storefront: Storefront,
    private readonly pricing: PricingService,
    private readonly refs: MasterDataRefs,
    private readonly stock: StockQueries,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    clock: Clock,
    lookupKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.tokenKey = createHmac('sha256', lookupKey).update('hk-guest-cart-v1').digest();
  }

  hashToken(token: string): Buffer {
    return createHmac('sha256', this.tokenKey).update(token).digest();
  }

  /** createCart: a new guest cart at the storefront's branch, and the token the cookie carries. */
  async create(idempotencyKey: string): Promise<StoredResponse<CartView> & { readonly token: string | null }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const claim = await this.idempotency.claim(tx, { operationId: 'createCart', principalId: STOREFRONT_ACTOR.principalId, key: idempotencyKey, request: {} });
      // A replay answers the cart again without its token: only the first answer carries the cookie.
      if (claim.kind === 'REPLAY') return { ...(claim.response as StoredResponse<CartView>), token: null };
      const branchId = await this.listing.branchIn(tx);
      if (branchId === null) throw new NotFoundError('no storefront branch');
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const id = this.nextId();
      await this.store.insertCart(tx, { id, guestTokenHash: this.hashToken(token), branchId });
      await this.audit.record(tx, { module: 'shp', action: 'CREATE', entityType: 'Cart', entityId: id, branchId, before: null, after: { id, status: 'ACTIVE' } });
      const response = { status: 201, body: await this.viewIn(tx, (await this.store.cart(tx, id, false))!) };
      await this.idempotency.complete(tx, claim.id, response);
      return { ...response, token };
    });
  }

  get(token: GuestToken, id: string): Promise<CartView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => this.viewIn(tx, await this.ownedIn(tx, token, id, false)));
  }

  /**
   * addCartLine: whole units of one unit of a product (CR-039: `uom`, a crate or a single egg, one the product is sold by
   * online; left out, its sale unit). A product in two units is two lines, each priced by its own unit's entry.
   */
  addLine(token: GuestToken, id: string, body: { readonly productId: string; readonly quantity: string; readonly uom?: string | undefined }, key: string): Promise<StoredResponse<CartView>> {
    return this.write(token, id, 'addCartLine', body, key, async (tx, cart) => {
      const quantity = Quantity.parse(body.quantity);
      if (!wholeUnits(quantity)) throw new QuantityInvalidError('WHOLE_UNITS');
      const product = await this.sellableIn(tx, body.productId, '/productId');
      const uom = body.uom ?? product.saleUom;
      if (uom !== product.saleUom && !(await this.listing.sellingUomsIn(tx, cart.branchId, product)).includes(uom)) throw new ProductUnavailableError('/uom', 'UOM_NOT_SOLD');
      const lines = await this.store.cartLines(tx, cart.id);
      const existing = lines.find((line) => line.productId === product.id && line.uom === uom);
      if (existing === undefined && lines.length >= MAX_CART_LINES) throw new QuantityInvalidError('TOO_MANY_LINES');
      const total = existing === undefined ? quantity : Quantity.parse(existing.qty).plus(quantity);
      const price = await this.unitPriceIn(tx, cart, product, total, body.uom === undefined ? '/productId' : '/uom', uom);
      await this.store.upsertCartLine(tx, cart.id, { id: existing?.id ?? this.nextId(), productId: product.id, qty: total.toDecimalString(), uom, displayedUnitPricePesewas: price });
    });
  }

  updateLine(token: GuestToken, id: string, lineId: string, body: { readonly quantity: string }, key: string): Promise<StoredResponse<CartView>> {
    return this.write(token, id, 'updateCartLine', { lineId, ...body }, key, async (tx, cart) => {
      const quantity = Quantity.parse(body.quantity);
      if (!wholeUnits(quantity)) throw new QuantityInvalidError('WHOLE_UNITS');
      const line = (await this.store.cartLines(tx, cart.id)).find((l) => l.id === lineId);
      if (line === undefined) throw new NotFoundError(`no cart line ${lineId}`);
      const product = await this.sellableIn(tx, line.productId, '/quantity');
      await this.store.setCartLineQty(tx, cart.id, lineId, quantity.toDecimalString(), await this.unitPriceIn(tx, cart, product, quantity, '/quantity', line.uom));
    });
  }

  removeLine(token: GuestToken, id: string, lineId: string, key: string): Promise<StoredResponse<CartView>> {
    return this.write(token, id, 'removeCartLine', { lineId }, key, async (tx, cart) => {
      if (!(await this.store.deleteCartLine(tx, cart.id, lineId))) throw new NotFoundError(`no cart line ${lineId}`);
    });
  }

  applyCoupon(token: GuestToken, id: string, body: { readonly code: string }, key: string): Promise<StoredResponse<CartView>> {
    return this.write(token, id, 'applyCartCoupon', body, key, async (tx, cart) => {
      const code = body.code.trim().toUpperCase();
      if (cart.couponCode !== null && cart.couponCode !== code) throw new CouponAlreadyAppliedError(`cart ${cart.id} has ${cart.couponCode}`);
      // The engine judges the coupon (limits, validity, targets): a refusal is its 422 (FR-SHP-004, FR-MDM-018).
      await priceLinesIn(this.pricing, tx, cart.branchId, code, []);
      await this.store.setCart(tx, cart.id, { couponCode: code });
    });
  }

  removeCoupon(token: GuestToken, id: string, key: string): Promise<StoredResponse<CartView>> {
    return this.write(token, id, 'removeCartCoupon', {}, key, async (tx, cart) => {
      await this.store.setCart(tx, cart.id, { couponCode: null });
    });
  }

  /** The cart the token proves is the caller's, or 404 whatever the reason (no such cart, no token, another token). */
  async ownedIn(tx: Transaction, token: GuestToken, id: string, lock: boolean): Promise<CartRecord> {
    const cart = await this.store.cart(tx, id, lock);
    const given = token.value === undefined ? null : this.hashToken(token.value);
    if (cart === null || cart.guestTokenHash === null || given === null || !timingSafeEqual(cart.guestTokenHash, given)) throw new NotFoundError(`no cart ${id} for this token`);
    return cart;
  }

  /** The cart as the contract shows it, every price re-resolved now. */
  async viewIn(tx: Transaction, cart: CartRecord): Promise<CartView> {
    const lines = await this.store.cartLines(tx, cart.id);
    const products = new Map((await this.storefront.onlineProductsIn(tx, lines.map((l) => l.productId))).map((p) => [p.id, p] as const));
    const listings = await this.store.listings(tx, cart.branchId, lines.map((l) => l.productId));
    const sellable = lines.filter((l) => products.get(l.productId)?.onlineMode === 'LISTED');
    const prices = new Map(
      (await priceLinesIn(this.pricing, tx, cart.branchId, null, sellable.map((l) => ({ lineRef: l.id, product: products.get(l.productId)!, quantity: Quantity.parse(l.qty), uom: l.uom })))).map((p) => [p.lineRef, p] as const),
    );
    const promisable = await this.stock.promisableIn(tx, cart.branchId, sellable.map((l) => l.productId));
    const views = [];
    for (const line of lines) {
      const product = products.get(line.productId);
      const listing = listings.get(line.productId);
      const price = prices.get(line.id);
      const priced = price?.kind === 'PRICED' ? price : null;
      const available = priced !== null && product !== undefined && (await this.coveredIn(tx, product, line, promisable));
      views.push({
        id: line.id,
        product: this.productRef(line, product, listing),
        quantity: line.qty,
        uom: line.uom,
        displayedUnitPricePesewas: Number(priced?.unitPrice.pesewas ?? line.displayedUnitPricePesewas),
        priceBasis: priced?.basis ?? listing?.priceBasis ?? 'PER_UNIT',
        catchWeight: priced?.estimate.estimatedWeight !== null && priced?.estimate.estimatedWeight !== undefined,
        estimatedWeightKg: priced?.estimate.estimatedWeight?.toKgString() ?? null,
        estimatedLineTotalPesewas: Number(priced?.estimate.estimated.pesewas ?? 0n),
        available,
      });
    }
    const subtotal = Money.sum(views.map((v) => Money.ofPesewas(BigInt(v.estimatedLineTotalPesewas))));
    return {
      id: cart.id,
      status: cart.status,
      checkoutId: cart.status === 'CHECKOUT' ? await this.store.openCheckoutOf(tx, cart.id) : null,
      lines: views,
      itemCount: Number(Quantity.sum(lines.map((l) => Quantity.parse(l.qty))).thousandths / THOUSANDTHS_PER_UNIT),
      estimatedSubtotalPesewas: Number(subtotal.pesewas),
      couponCode: cart.couponCode,
      currency: 'GHS',
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  private async coveredIn(tx: Transaction, product: OnlineProductFacts, line: CartLineRecord, promisable: Awaited<ReturnType<StockQueries['promisableIn']>>): Promise<boolean> {
    const needed = Quantity.parse(line.qty).thousandths * (await this.listing.perUnit(tx, product, line.uom)).thousandths;
    const held = Quantity.sum(promisable.filter((r) => r.productId === product.id).map((r) => r.availableQty)).thousandths * THOUSANDTHS_PER_UNIT;
    return held >= needed;
  }

  private productRef(line: CartLineRecord, product: OnlineProductFacts | undefined, listing: { readonly slug: string; readonly images: readonly ImageSetView[] } | undefined): CartProductView {
    const image = listing?.images[0];
    return {
      id: line.productId,
      slug: listing?.slug ?? line.productId,
      name: product?.name ?? listing?.slug ?? line.productId,
      image: image === undefined ? null : { alt: image.alt, variants: image.variants.filter((v) => LIST_VARIANTS.has(v.variant)) },
    };
  }

  /** A product a cart may hold: listed online (a request-to-buy product is refused, ADR-0019). */
  private async sellableIn(tx: Transaction, productId: string, field: string): Promise<OnlineProductFacts> {
    const [product] = await this.storefront.onlineProductsIn(tx, [productId]);
    if (product === undefined) throw new ProductUnavailableError(field, 'NOT_LISTED');
    if (product.onlineMode === 'REQUEST_TO_BUY') throw new RequestToBuyOnlyError(field);
    if (product.stockPolicy !== 'CATCH_WEIGHT' && product.saleUom !== product.baseUom) {
      // A sale unit other than the base unit converts through MDM's exact conversion, or the line is refused.
      const converted = await this.refs.toBaseIn(tx, product.id, product.saleUom, Quantity.ofUnits(1n));
      if (!converted.ok) throw new ProductUnavailableError(field, 'NOT_LISTED');
    }
    return product;
  }

  private async unitPriceIn(tx: Transaction, cart: CartRecord, product: OnlineProductFacts, quantity: Quantity, field: string, uom: string): Promise<bigint> {
    const [price] = await priceLinesIn(this.pricing, tx, cart.branchId, null, [{ lineRef: 'line', product, quantity, uom }]);
    if (price?.kind !== 'PRICED') throw new ProductUnavailableError(field, 'NO_ONLINE_PRICE');
    return price.unitPrice.pesewas;
  }

  private write(token: GuestToken, id: string, operationId: string, body: object, key: string, change: (tx: Transaction, cart: CartRecord) => Promise<void>): Promise<StoredResponse<CartView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const before = await this.ownedIn(tx, token, id, true);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: STOREFRONT_ACTOR.principalId, key, request: { cartId: id, token: before.guestTokenHash!.toString('hex'), ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<CartView>;
      if (before.status !== 'ACTIVE') throw new CartNotActiveError(`cart ${id} is ${before.status}`);
      await change(tx, before);
      const after = (await this.store.cart(tx, id, false))!;
      await this.audit.record(tx, { module: 'shp', action: 'UPDATE', entityType: 'Cart', entityId: id, branchId: after.branchId, before: { couponCode: before.couponCode }, after: { couponCode: after.couponCode }, metadata: { operationId, ...body } });
      const response = { status: 200, body: await this.viewIn(tx, after) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }
}
