import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationExpiry } from '../../../src/modules/inv';
import { CatalogueListing } from '../../../src/modules/shp';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The storefront over the seeded farm (FR-SHP-001 to FR-SHP-008, B07 continued 2's gate): the catalogue exposes no
 * cost and pages through CR-019's sort; a guest cart re-resolves prices and refuses a live animal; checkout reserves
 * every line through INV or none, one buyer of the last crates wins under concurrency, and the expiry job releases
 * exactly what was reserved and gives the cart back. Every figure is a hand calculation from the seeded prices:
 * big eggs 6,000 a crate (base list), beef 3,213 a kg online (3,060 plus 5 percent), yam 2,000 a tuber; Dodowa's zone
 * charges 1,500 and waives it above 50,000.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const SCHEDULER = '01900000-0000-7000-8000-000000000004';

interface Guest {
  readonly cartId: string;
  readonly cookie: string;
}

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };

async function newCart(): Promise<Guest> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  expect(created.status).toBe(201);
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
}

const write = (method: 'post' | 'patch' | 'put' | 'delete', path: string, guest: Guest | null, body?: object, key: string = randomUUID()) => {
  const req = request(api.server)[method](`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key);
  if (guest !== null) req.set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};
const read = (path: string, guest: Guest | null = null) => {
  const req = request(api.server).get(`/v1${path}`);
  return guest === null ? req : req.set('Cookie', guest.cookie);
};
const add = (guest: Guest, sku: string, quantity: string) => write('post', `/shop/carts/${guest.cartId}/lines`, guest, { productId: id(`product:${sku}`), quantity });
const checkout = (guest: Guest, body: object = { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' }) =>
  write('post', `/shop/carts/${guest.cartId}/checkout`, guest, body);

async function reserved(holderId: string): Promise<Array<{ product: string; qty: string; status: string }>> {
  const { rows } = await database.pool('admin').query<{ sku: string; qty: string; status: string }>(
    'SELECT p.sku, r.qty::text AS qty, r.status FROM inv.stock_reservation r JOIN mdm.product p ON p.id = r.product_id WHERE r.holder_document_id = $1 ORDER BY p.sku, r.qty',
    [holderId],
  );
  return rows.map((r) => ({ product: r.sku, qty: r.qty, status: r.status }));
}

async function reservedAt(sku: string): Promise<string> {
  const { rows } = await database.pool('admin').query<{ reserved: string }>('SELECT COALESCE(sum(reserved_qty), 0)::numeric(14,3)::text AS reserved FROM inv.stock_balance WHERE product_id = $1', [id(`product:${sku}`)]);
  return rows[0]!.reserved;
}

function keysOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysOf(item, found);
    }
  }
  return found;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await database.pool('admin').query<{ code: string; id: string }>("SELECT 'product:' || sku AS code, id FROM mdm.product UNION ALL SELECT 'zone:' || code, id FROM mdm.delivery_zone")).rows) {
    ids.set(row.code, row.id);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the public catalogue (FR-SHP-001, FR-SHP-002)', () => {
  it('lists the listed and request-to-buy products with levels and engine prices, and never a cost, floor, ceiling or count', async () => {
    const page = await read('/shop/catalogue?limit=100');
    expect(page.status).toBe(200);
    const bySlug = new Map((page.body.data as Array<Record<string, unknown>>).map((item) => [item['slug'], item]));
    expect(bySlug.get('eggs-big-crate-of-30')).toMatchObject({ onlineMode: 'LISTED', priceFromPesewas: 6_000, priceToPesewas: null, priceBasis: 'PER_UNIT', availability: 'IN_STOCK', saleUom: 'CRATE' });
    expect(bySlug.get('beef-15-kg-pack')).toMatchObject({ priceFromPesewas: 3_213, priceBasis: 'PER_KG', availability: 'LOW_STOCK', catchWeight: true, nominalPackKg: '15.000' });
    expect(bySlug.get('eggs-small-crate-of-30')).toMatchObject({ availability: 'OUT_OF_STOCK' });
    expect(bySlug.get('goat')).toMatchObject({ onlineMode: 'REQUEST_TO_BUY', availability: 'ON_REQUEST', priceFromPesewas: 25_000, priceToPesewas: 170_000, priceBasis: 'PER_HEAD' });
    expect([...bySlug.keys()].some((slug) => String(slug).includes('offal'))).toBe(false);
    const keys = [...keysOf(page.body)].map((k) => k.toLowerCase());
    expect(keys.filter((k) => /cost|floor|ceiling|onhand|qty|quantity|reserved/.test(k))).toEqual([]);
  });

  it('searches name and description: "goat" finds the goat and goat meat only', async () => {
    const found = await read('/shop/catalogue?q=goat');
    expect((found.body.data as Array<{ slug: string }>).map((i) => i.slug).sort()).toEqual(['goat', 'goat-meat-15-kg-pack']);
  });

  it('pages a price sort two at a time without skipping or repeating, unpriced last, and refuses another sort', async () => {
    const all = (await read('/shop/catalogue?limit=100&sort=PRICE_ASC')).body.data as Array<{ productId: string; priceFromPesewas: number | null }>;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const pageReq: request.Response = await read(`/shop/catalogue?limit=2&sort=PRICE_ASC${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      seen.push(...(pageReq.body.data as Array<{ productId: string }>).map((i) => i.productId));
      cursor = pageReq.body.page.nextCursor as string | null;
    } while (cursor !== null);
    expect(seen).toEqual(all.map((i) => i.productId));
    const prices = all.map((i) => i.priceFromPesewas);
    const priced = prices.filter((p): p is number => p !== null);
    expect(priced).toEqual([...priced].sort((a, b) => a - b));
    expect(prices.slice(priced.length).every((p) => p === null)).toBe(true);
    const refused = await read('/shop/catalogue?sort=COST_ASC');
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0]).toMatchObject({ field: '/sort', code: 'SORT_NOT_ALLOWED' });
    const stale = await read(`/shop/catalogue?sort=NAME&cursor=${encodeURIComponent((await read('/shop/catalogue?limit=1&sort=PRICE_ASC')).body.page.nextCursor as string)}`);
    expect(stale.status).toBe(400);
  });

  it('shows a product page with its level and the catch-weight rule, never the count, and 404 for an unlisted slug', async () => {
    const beef = await read('/shop/products/beef-15-kg-pack');
    expect(beef.status).toBe(200);
    expect(beef.body).toMatchObject({ availability: 'LOW_STOCK', weightTolerancePercent: expect.stringMatching(/^10(\.0+)?$/), seo: { slug: 'beef-15-kg-pack' } });
    expect(beef.body.finalChargeRule).toContain('GHS 32.13 per kg');
    expect([...keysOf(beef.body)].filter((k) => /cost|floor|ceiling|onhand|qty|quantity|reserved/i.test(k))).toEqual([]);
    expect((await read('/shop/products/goat-offal-per-kg-seed')).status).toBe(404);
  });

  it('lists only the categories that hold listed products', async () => {
    const categories = await read('/shop/categories');
    expect(categories.status).toBe(200);
    const codes = (categories.body.data as Array<{ code: string; productCount: number }>).map((c) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['LIVE', 'MEAT', 'EGGS', 'PRODUCE']));
  });
});

describe('the guest cart (FR-SHP-003, FR-SHP-004)', () => {
  let cart: Guest;

  it('prices two crates of eggs at 12,000 and two beef packs at an estimated 30 kg, the server summing the lines', async () => {
    cart = await newCart();
    expect((await add(cart, 'EGG-CRATE-BIG', '2.000')).status).toBe(200);
    const after = await add(cart, 'MEAT-BEEF-15KG', '2.000');
    expect(after.status).toBe(200);
    const [eggs, beef] = after.body.lines as Array<Record<string, unknown>>;
    expect(eggs).toMatchObject({ quantity: '2.000', uom: 'CRATE', displayedUnitPricePesewas: 6_000, estimatedLineTotalPesewas: 12_000, catchWeight: false, available: true });
    // 3,213 a kg times 30.000 kg is exactly 96,390.
    expect(beef).toMatchObject({ quantity: '2.000', uom: 'PACK', displayedUnitPricePesewas: 3_213, estimatedWeightKg: '30.000', estimatedLineTotalPesewas: 96_390, catchWeight: true, available: true });
    expect(after.body).toMatchObject({ itemCount: 4, estimatedSubtotalPesewas: 108_390 });
  });

  it('refuses a live animal with REQUEST_TO_BUY_ONLY and a fraction of a crate with QUANTITY_INVALID', async () => {
    const goat = await add(cart, 'LIV-GOAT', '1.000');
    expect(goat.status).toBe(422);
    expect(goat.body.error.code).toBe('REQUEST_TO_BUY_ONLY');
    const half = await add(cart, 'EGG-CRATE-BIG', '1.500');
    expect(half.status).toBe(422);
    expect(half.body.error.code).toBe('QUANTITY_INVALID');
    expect((await add(cart, 'BYP-GOAT-OFFAL', '1.000')).body.error.code).toBe('PRODUCT_UNAVAILABLE');
  });

  it('answers 404 to a request without the cart token, or with another cart token', async () => {
    expect((await read(`/shop/carts/${cart.cartId}`)).status).toBe(404);
    const other = await newCart();
    expect((await read(`/shop/carts/${cart.cartId}`, other)).status).toBe(404);
    expect((await write('post', `/shop/carts/${cart.cartId}/lines`, other, { productId: id('product:PRD-YAM-TUBER'), quantity: '1.000' })).status).toBe(404);
    expect((await read(`/shop/carts/${cart.cartId}`, cart)).status).toBe(200);
  });

  it('refuses a cart write from an origin that is not allowed', async () => {
    const forged = await request(api.server).post(`/v1/shop/carts/${cart.cartId}/lines`).set('Origin', 'https://evil.example').set('Idempotency-Key', randomUUID()).set('Cookie', cart.cookie).send({ productId: id('product:PRD-YAM-TUBER'), quantity: '1.000' });
    expect(forged.status).toBe(403);
  });

  it('applies one coupon through the engine and refuses a second', async () => {
    expect((await write('put', `/shop/carts/${cart.cartId}/coupon`, cart, { code: 'welcome10' })).body.couponCode).toBe('WELCOME10');
    const second = await write('put', `/shop/carts/${cart.cartId}/coupon`, cart, { code: 'XMAS2026' });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('COUPON_ALREADY_APPLIED');
    const unknown = await newCart();
    expect((await write('put', `/shop/carts/${unknown.cartId}/coupon`, unknown, { code: 'NOSUCHCODE' })).status).toBe(422);
  });

  describe('checkout (FR-SHP-005 to FR-SHP-008)', () => {
    let started: request.Response;

    it('reserves every line, takes the coupon off the eggs, and shows the estimate, the most it can come to and the rule', async () => {
      started = await checkout(cart, { contactName: 'Ama Serwaa Ofori', contactPhone: '0244512876', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'PREPAID', differencePreference: 'REFUND' });
      expect(started.status).toBe(201);
      // Eggs 12,000 less 10 percent (1,200); beef 96,390, at most 96,390 + 9,639 = 106,029; the goods are over 50,000, so no fee.
      expect(started.body).toMatchObject({
        status: 'STARTED',
        fulfilmentMode: 'DELIVERY',
        contactPhone: '+233244512876',
        deliveryZone: { code: 'DODOWA' },
        deliveryFeePesewas: 0,
        estimatedTotalPesewas: 107_190,
        maximumTotalPesewas: 116_829,
        promotions: [{ code: 'WELCOME10', discountPesewas: 1_200 }],
        priceChanged: false,
      });
      expect(started.body.lines[1]).toMatchObject({ estimatedLineTotalPesewas: 96_390, maximumLineTotalPesewas: 106_029, estimatedWeightKg: '30.000' });
      expect(started.body.finalChargeRule).toContain('GHS 1,071.90');
      expect(started.body.finalChargeRule).toContain('GHS 1,168.29');
      expect(Date.parse(started.body.reservedUntil) - clock.now().getTime()).toBe(15 * 60_000);
      expect(await reserved(started.body.id)).toEqual([
        { product: 'EGG-CRATE-BIG', qty: '2.000', status: 'ACTIVE' },
        { product: 'MEAT-BEEF-15KG', qty: '30.000', status: 'ACTIVE' },
      ]);
      expect((await add(cart, 'PRD-YAM-TUBER', '1.000')).body.error.code).toBe('CART_NOT_ACTIVE');
      expect((await checkout(cart)).body.error.code).toBe('CART_NOT_ACTIVE');
    });

    it('starts none of a cart whose last line cannot be covered', async () => {
      const short = await newCart();
      await add(short, 'PRD-YAM-TUBER', '2.000');
      await add(short, 'MEAT-BEEF-15KG', '2.000');
      const refused = await checkout(short);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('STOCK_UNAVAILABLE');
      expect(await reservedAt('PRD-YAM-TUBER')).toBe('0.000');
      expect((await read(`/shop/carts/${short.cartId}`, short)).body.status).toBe('ACTIVE');
    });

    it('lets exactly one of two buyers of the last 28 crates check out at once', async () => {
      const [first, second] = [await newCart(), await newCart()];
      await add(first, 'EGG-CRATE-BIG', '28.000');
      await add(second, 'EGG-CRATE-BIG', '28.000');
      const answers = await Promise.all([checkout(first), checkout(second)]);
      expect(answers.map((a) => a.status).sort()).toEqual([201, 422]);
      expect(answers.find((a) => a.status === 422)!.body.error.code).toBe('STOCK_UNAVAILABLE');
      expect(await reservedAt('EGG-CRATE-BIG')).toBe('30.000');
    });

    it('charges the Dodowa fee of exactly 1,500 on a 4,000 cart, collection only outside every zone, nothing to collect', async () => {
      const small = await newCart();
      await add(small, 'PRD-YAM-TUBER', '2.000');
      const outside = await checkout(small, { contactName: 'Kofi Mensah', contactPhone: '+233201234567', fulfilmentMode: 'DELIVERY', address: { ...dodowa, area: 'Bantama', city: 'Kumasi', region: 'Ashanti' }, paymentTerms: 'COD' });
      expect(outside.status).toBe(422);
      expect(outside.body.error.code).toBe('DELIVERY_UNAVAILABLE');
      const slots = await read(`/shop/delivery/slots?zoneId=${id('zone:DODOWA')}`);
      expect(slots.status).toBe(200);
      const [slot, later] = slots.body.data as Array<{ id: string; available: boolean; remaining: number }>;
      expect(slot).toMatchObject({ available: true, remaining: 8 });
      const unknownSlot = await checkout(small, { contactName: 'Kofi Mensah', contactPhone: '+233201234567', fulfilmentMode: 'DELIVERY', address: dodowa, deliverySlotId: randomUUID(), paymentTerms: 'COD' });
      expect(unknownSlot.body.error.code).toBe('SLOT_UNAVAILABLE');
      const delivered = await checkout(small, { contactName: 'Kofi Mensah', contactPhone: '+233201234567', fulfilmentMode: 'DELIVERY', address: dodowa, deliverySlotId: slot!.id, paymentTerms: 'COD' });
      expect(delivered.status).toBe(201);
      expect(delivered.body).toMatchObject({ deliveryFeePesewas: 1_500, estimatedTotalPesewas: 5_500, maximumTotalPesewas: 5_500, deliverySlot: { id: slot!.id } });
      const stored = await database.pool('admin').query<{ delivery_slot_id: string }>('SELECT delivery_slot_id FROM shp.checkout_session WHERE id = $1', [delivered.body.id]);
      expect(stored.rows[0]!.delivery_slot_id).toBe(slot!.id);
      const moved = await write('patch', `/shop/checkouts/${delivered.body.id}`, small, { deliverySlotId: later!.id });
      expect(moved.status).toBe(200);
      expect(moved.body.deliverySlot.id).toBe(later!.id);
      const collected = await newCart();
      await add(collected, 'PRD-YAM-TUBER', '2.000');
      const pickUp = await checkout(collected);
      expect(pickUp.body).toMatchObject({ deliveryFeePesewas: 0, estimatedTotalPesewas: 4_000, deliveryZone: null });
      const codCollect = await newCart();
      await add(codCollect, 'PRD-YAM-TUBER', '1.000');
      expect((await checkout(codCollect, { contactName: 'Kofi Mensah', contactPhone: '+233201234567', fulfilmentMode: 'COLLECTION', paymentTerms: 'COD' })).body.error.code).toBe('CHECKOUT_INVALID');
    });

    it('answers a replayed start with the same checkout, and another guest a 404', async () => {
      const replayGuest = await newCart();
      await add(replayGuest, 'PRD-CABBAGE-HEAD', '3.000');
      const key = randomUUID();
      const body = { contactName: 'Efua Asante', contactPhone: '+233277000111', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' };
      const once = await write('post', `/shop/carts/${replayGuest.cartId}/checkout`, replayGuest, body, key);
      const twice = await write('post', `/shop/carts/${replayGuest.cartId}/checkout`, replayGuest, body, key);
      expect(twice.status).toBe(201);
      expect(twice.body.id).toBe(once.body.id);
      expect((await read(`/shop/checkouts/${once.body.id}`)).status).toBe(404);
      expect((await read(`/shop/checkouts/${once.body.id}`, replayGuest)).body.estimatedTotalPesewas).toBe(3_000);
    });

    it('releases exactly what it reserved 15 minutes and 1 second later, ends the checkout and gives the cart back', async () => {
      const beforeEggs = await reservedAt('EGG-CRATE-BIG');
      const beforeBeef = await reservedAt('MEAT-BEEF-15KG');
      clock.advanceBy(15 * 60_000 + 1_000);
      const expired = await runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(ReservationExpiry).run({ kind: 'SYSTEM', principalId: SCHEDULER }));
      expect(expired.length).toBeGreaterThanOrEqual(2);
      expect(await reserved(started.body.id)).toEqual([
        { product: 'EGG-CRATE-BIG', qty: '2.000', status: 'EXPIRED' },
        { product: 'MEAT-BEEF-15KG', qty: '30.000', status: 'EXPIRED' },
      ]);
      expect(await reservedAt('MEAT-BEEF-15KG')).toBe((Number(beforeBeef) - 30).toFixed(3));
      expect(await reservedAt('EGG-CRATE-BIG')).toBe('0.000');
      expect(beforeEggs).toBe('30.000');
      const seen = await read(`/shop/checkouts/${started.body.id}`, cart);
      expect(seen.body.status).toBe('EXPIRED');
      expect((await read(`/shop/carts/${cart.cartId}`, cart)).body.status).toBe('ACTIVE');
      const events = await database.pool('admin').query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'shp.CheckoutExpired' AND subject_id = $1", [started.body.id]);
      expect(events.rows[0]!.n).toBe('1');
      // A second run finds nothing more to release.
      expect(await runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(ReservationExpiry).run({ kind: 'SYSTEM', principalId: SCHEDULER }))).toEqual([]);
      const late = await write('patch', `/shop/checkouts/${started.body.id}`, cart, { paymentTerms: 'COD' });
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('CHECKOUT_NOT_OPEN');
      // The eggs are on sale again to the next buyer.
      await api.app.get(CatalogueListing).refresh();
      const again = await checkout(cart);
      expect(again.status).toBe(201);
    });

    it('holds the checkout rules in the database: lines never change, and an ended checkout is frozen', async () => {
      const admin = database.pool('app');
      await expect(admin.query('UPDATE shp.checkout_line SET qty = 1 WHERE checkout_id = $1', [started.body.id])).rejects.toMatchObject({ code: 'HK004' });
      await expect(admin.query("UPDATE shp.checkout_session SET contact_name = 'Someone else', version = version + 1 WHERE id = $1", [started.body.id])).rejects.toMatchObject({ code: 'HK004' });
      await expect(admin.query('UPDATE shp.checkout_session SET maximum_total_pesewas = 1, version = version + 1 WHERE id = $1', [(await checkout(await (async () => {
        const g = await newCart();
        await add(g, 'PRD-CABBAGE-HEAD', '1.000');
        return g;
      })())).body.id])).rejects.toMatchObject({ constraint: 'ck_checkout_session_totals' });
      await expect(admin.query('INSERT INTO shp.product_listing (product_id) VALUES ($1)', [id('product:LIV-GOAT')])).rejects.toMatchObject({ code: '42501' });
    });
  });
  describe('the cart names its open checkout, and only its own (CR-029)', () => {
    const atCheckout: Array<{ guest: Guest; checkoutId: string }> = [];

    it('is null on an active cart and names the checkout while the cart is at checkout, never another cart’s', async () => {
      for (const quantity of ['1.000', '2.000']) {
        const guest = await newCart();
        await add(guest, 'PRD-CABBAGE-HEAD', quantity);
        expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'ACTIVE', checkoutId: null });
        const started = await checkout(guest);
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        atCheckout.push({ guest, checkoutId: started.body.id as string });
      }
      const [first, second] = atCheckout;
      expect(first!.checkoutId).not.toBe(second!.checkoutId);
      for (const { guest, checkoutId } of atCheckout) {
        const seen = await read(`/shop/carts/${guest.cartId}`, guest);
        expect(seen.body).toMatchObject({ status: 'CHECKOUT', checkoutId });
        expect((await read(`/shop/checkouts/${seen.body.checkoutId as string}`, guest)).body.id, 'a second tab opens the checkout from the cart').toBe(checkoutId);
      }
      expect((await read(`/shop/carts/${first!.guest.cartId}`, second!.guest)).status, 'another guest learns nothing').toBe(404);
    });

    it('is null once the checkout completes or the cart is abandoned', async () => {
      const [completed, abandoned] = atCheckout;
      const admin = database.pool('admin');
      await admin.query("UPDATE shp.checkout_session SET status = 'COMPLETED', posted_at = $2, posted_by = created_by, version = version + 1 WHERE id = $1", [completed!.checkoutId, clock.now()]);
      await admin.query("UPDATE shp.cart SET status = 'CONVERTED', version = version + 1 WHERE id = $1", [completed!.guest.cartId]);
      await admin.query("UPDATE shp.cart SET status = 'ABANDONED', version = version + 1 WHERE id = $1", [abandoned!.guest.cartId]);
      expect((await read(`/shop/carts/${completed!.guest.cartId}`, completed!.guest)).body).toMatchObject({ status: 'CONVERTED', checkoutId: null });
      expect((await read(`/shop/carts/${abandoned!.guest.cartId}`, abandoned!.guest)).body).toMatchObject({ status: 'ABANDONED', checkoutId: null });
    });

    it('is null again once the checkout expires and the cart is given back', async () => {
      const guest = await newCart();
      await add(guest, 'PRD-CABBAGE-HEAD', '1.000');
      const started = await checkout(guest);
      expect((await read(`/shop/carts/${guest.cartId}`, guest)).body.checkoutId).toBe(started.body.id);
      clock.advanceBy(15 * 60_000 + 1_000);
      await runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(ReservationExpiry).run({ kind: 'SYSTEM', principalId: SCHEDULER }));
      expect((await read(`/shop/checkouts/${started.body.id as string}`, guest)).body.status).toBe('EXPIRED');
      expect((await read(`/shop/carts/${guest.cartId}`, guest)).body).toMatchObject({ status: 'ACTIVE', checkoutId: null });
    });
  });
});
