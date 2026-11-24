import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CR-039 (B11 continued 13, A-290; the gate's last item): the shop sells a product in more than one unit, each at its own
 * price. The seeded big eggs are sold by the crate of 30 at GHS 60.00 and by the egg at GHS 2.20 on the base list, so 30
 * eggs bought singly are GHS 66.00, never the crate's price worked out per egg. A crate and three eggs are two cart lines,
 * priced, checked out, reserved in eggs and placed, each in its own unit, to the pesewa.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const CRATE_PESEWAS = 6_000;
const EGG_PESEWAS = 220;
const EGGS_PER_CRATE = 30;

interface Guest {
  readonly cartId: string;
  readonly cookie: string;
}

async function newCart(): Promise<Guest> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  expect(created.status).toBe(201);
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  return { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
}
const write = (method: 'post' | 'patch', path: string, guest: Guest, body: object, key: string = randomUUID()) =>
  request(api.server)[method](`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).set('Cookie', guest.cookie).send(body);
const add = (guest: Guest, sku: string, quantity: string, uom?: string) => write('post', `/shop/carts/${guest.cartId}/lines`, guest, { productId: id(sku), quantity, ...(uom === undefined ? {} : { uom }) });

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
  for (const row of (await database.pool('admin').query<{ sku: string; id: string }>('SELECT sku, id FROM mdm.product')).rows) ids.set(row.sku, row.id);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('CR-039: the crate and the single egg, each at its own price', () => {
  it('lists each unit a product is sold by online, the sale unit first, each priced by its own entry', async () => {
    const page = await request(api.server).get('/v1/shop/catalogue?limit=100');
    expect(page.status).toBe(200);
    const bySlug = new Map((page.body.data as Array<Record<string, unknown>>).map((item) => [item['slug'], item]));
    const eggs = bySlug.get('eggs-big-crate-of-30')!;
    // The product's own price is the crate's, as before; each unit carries its own.
    expect(eggs).toMatchObject({ saleUom: 'CRATE', priceFromPesewas: CRATE_PESEWAS, priceToPesewas: null });
    expect(eggs['sellingUnits']).toEqual([
      { uom: 'CRATE', uomName: expect.any(String), priceFromPesewas: CRATE_PESEWAS, priceToPesewas: null, availability: 'IN_STOCK' },
      { uom: 'EGG', uomName: expect.any(String), priceFromPesewas: EGG_PESEWAS, priceToPesewas: null, availability: 'IN_STOCK' },
    ]);
    // A single egg is never the crate's price shared out: 30 of them cost GHS 66.00, not GHS 60.00.
    expect(EGG_PESEWAS * EGGS_PER_CRATE).toBe(6_600);
    // A catch-weight pack and a banded animal are sold in their one unit, priced as the product is.
    const beef = bySlug.get('beef-15-kg-pack')!;
    expect(beef['sellingUnits']).toEqual([{ uom: beef['saleUom'], uomName: expect.any(String), priceFromPesewas: beef['priceFromPesewas'], priceToPesewas: beef['priceToPesewas'], availability: beef['availability'] }]);
    const goat = bySlug.get('goat')!;
    expect(goat['sellingUnits']).toEqual([{ uom: goat['saleUom'], uomName: expect.any(String), priceFromPesewas: 25_000, priceToPesewas: 170_000, availability: 'ON_REQUEST' }]);
    const detail = await request(api.server).get('/v1/shop/products/eggs-big-crate-of-30');
    expect(detail.status).toBe(200);
    expect(detail.body.sellingUnits).toEqual(eggs['sellingUnits']);
  });

  it('keeps a crate and three single eggs as two lines, each priced in its own unit, to the pesewa', async () => {
    const guest = await newCart();
    expect((await add(guest, 'EGG-0003', '1.000')).status).toBe(200);
    const added = await add(guest, 'EGG-0003', '3.000', 'EGG');
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    // The crate added again by naming its unit joins the crate's line.
    const again = await add(guest, 'EGG-0003', '1.000', 'CRATE');
    expect(again.status).toBe(200);
    const lines = (again.body.lines as Array<{ uom: string; quantity: string; displayedUnitPricePesewas: number; estimatedLineTotalPesewas: number }>).map((l) => [l.uom, l.quantity, l.displayedUnitPricePesewas, l.estimatedLineTotalPesewas]);
    expect(lines.sort()).toEqual([
      ['CRATE', '2.000', CRATE_PESEWAS, 2 * CRATE_PESEWAS],
      ['EGG', '3.000', EGG_PESEWAS, 3 * EGG_PESEWAS],
    ]);
    expect(again.body.estimatedSubtotalPesewas).toBe(12_660);
    expect(again.body.itemCount).toBe(5);
    const { rows } = await database.pool('admin').query<{ uom: string; qty: string }>('SELECT uom, qty::text AS qty FROM shp.cart_line WHERE cart_id = $1 ORDER BY uom', [guest.cartId]);
    expect(rows).toEqual([{ uom: 'CRATE', qty: '2.000' }, { uom: 'EGG', qty: '3.000' }]);
    // Changing the egg line's quantity reprices it by the egg.
    const eggLine = (again.body.lines as Array<{ id: string; uom: string }>).find((l) => l.uom === 'EGG')!;
    const changed = await write('patch', `/shop/carts/${guest.cartId}/lines/${eggLine.id}`, guest, { quantity: '7.000' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.estimatedSubtotalPesewas).toBe(2 * CRATE_PESEWAS + 7 * EGG_PESEWAS);
  });

  it('refuses a unit the product is not sold by online, and a unit on a catch-weight pack, adding nothing', async () => {
    const guest = await newCart();
    for (const [sku, uom] of [['EGG-0003', 'TRAY'], ['EGG-0003', 'KG'], ['MEAT-0007', 'KG']] as const) {
      const refused = await add(guest, sku, '1.000', uom);
      expect(refused.status, `${sku} ${uom}`).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PRODUCT_UNAVAILABLE', details: [{ field: '/uom', code: 'UOM_NOT_SOLD' }] });
    }
    expect((await write('post', `/shop/carts/${guest.cartId}/lines`, guest, { productId: id('EGG-0003'), quantity: '1.000', uom: '' })).status).toBe(400);
    const { rows } = await database.pool('admin').query('SELECT 1 FROM shp.cart_line WHERE cart_id = $1', [guest.cartId]);
    expect(rows).toEqual([]);
  });

  it('checks out, reserves in eggs and places each line in its own unit at its own price', async () => {
    const guest = await newCart();
    expect((await add(guest, 'EGG-0003', '1.000')).status).toBe(200);
    expect((await add(guest, 'EGG-0003', '3.000', 'EGG')).status).toBe(200);
    const address = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
    const started = await write('post', `/shop/carts/${guest.cartId}/checkout`, guest, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address, paymentTerms: 'COD' });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const lines = (started.body.lines as Array<{ uom: string; quantity: string; unitPricePesewas: number; estimatedLineTotalPesewas: number }>).map((l) => [l.uom, l.quantity, l.unitPricePesewas, l.estimatedLineTotalPesewas]).sort();
    expect(lines).toEqual([
      ['CRATE', '1.000', CRATE_PESEWAS, CRATE_PESEWAS],
      ['EGG', '3.000', EGG_PESEWAS, 660],
    ]);
    expect(started.body.estimatedTotalPesewas - started.body.deliveryFeePesewas).toBe(6_660);
    // Stock is held in the base unit: one crate is 30 eggs, and three eggs are three.
    const { rows: held } = await database.pool('admin').query<{ qty: string }>(
      "SELECT sum(r.qty)::numeric(14,3)::text AS qty FROM inv.stock_reservation r WHERE r.holder_document_id = $1 AND r.status = 'ACTIVE'",
      [started.body.id],
    );
    expect(held[0]!.qty).toBe('33.000');
    const { rows: base } = await database.pool('admin').query<{ uom: string; base_qty: string }>('SELECT uom, base_qty::text AS base_qty FROM shp.checkout_line WHERE checkout_id = $1 ORDER BY uom', [started.body.id]);
    expect(base).toEqual([{ uom: 'CRATE', base_qty: '30.000' }, { uom: 'EGG', base_qty: '3.000' }]);

    const placed = await write('post', `/shop/checkouts/${started.body.id as string}/place`, guest, { paymentMethod: 'COD' });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const { rows: ordered } = await database.pool('admin').query<{ uom: string; qty: string; price: string; entry: string }>(
      `SELECT l.uom, l.qty_ordered::text AS qty, l.agreed_unit_price_pesewas::text AS price, e.uom AS entry
         FROM ord.sales_order_line l JOIN mdm.price_list_entry e ON e.id = l.price_list_entry_id
        WHERE l.sales_order_id = $1 ORDER BY l.uom`,
      [placed.body.orderId],
    );
    expect(ordered).toEqual([
      { uom: 'CRATE', qty: '1.000', price: String(CRATE_PESEWAS), entry: 'CRATE' },
      { uom: 'EGG', qty: '3.000', price: String(EGG_PESEWAS), entry: null },
    ]);
  });
});
