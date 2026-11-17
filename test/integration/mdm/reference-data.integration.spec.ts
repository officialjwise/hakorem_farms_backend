import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Suppliers, payment methods, delivery zones with the delivery quote, the fixed reason codes, the price list
 * listings and updates and archiveProduct, over the seeded farm (FR-MDM-007, FR-MDM-009, FR-MDM-010, FR-MDM-011,
 * FR-MDM-015, FR-MDM-001): every write refuses the wrong role (ADR-0035), a zone fee is exact pesewas, an address in
 * no zone is "delivery unavailable" rather than a zero fee, and the database refuses what the handlers refuse.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession;
let manager: TestSession;
let managerAtTest: TestSession;
let sales: TestSession;
let cashier: TestSession;
let driver: TestSession;
let storekeeper: TestSession;
const ids = new Map<string, string>();
const SYSTEM = '01900000-0000-7000-8000-000000000001';

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const quote = (body: object) => request(api.server).post('/v1/shop/delivery/quote').set('Origin', TEST_ORIGIN).send(body);
const address = (area: string, city: string) => ({ recipientName: 'Ama Serwaa (TEST)', recipientPhone: '+233244512876', line1: 'Near the market', area, city, region: 'Greater Accra' });
const codes = (body: { data: Array<{ code: string }> }) => body.data.map((row) => row.code);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await database.pool('admin').query<{ code: string; id: string }>(
    `SELECT 'branch:' || code AS code, id FROM mdm.branch
     UNION ALL SELECT 'location:' || b.code || ':' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id
     UNION ALL SELECT 'list:' || code, id FROM mdm.price_list
     UNION ALL SELECT 'category:' || code, id FROM mdm.category
     UNION ALL SELECT 'product:' || sku, id FROM mdm.product
     UNION ALL SELECT 'zone:' || code, id FROM mdm.delivery_zone`,
  )).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = ids.get('branch:DDW')!;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  managerAtTest = await enrolAndLogin(api.server, await createUser(database, { name: 'Test Manager', grants: [{ role: 'MANAGER', branchId: ids.get('branch:TST')! }] }), () => clock.now());
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: ids.get('location:DDW:SHOP')! }] }));
  driver = await login(api.server, await createUser(database, { name: 'Selorm Agbeko', grants: [{ role: 'DRIVER', branchId }] }));
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: ids.get('location:DDW:COLD')! }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('wrong roles are refused on every supplier, reference data, price list and product write (ADR-0035)', () => {
  const someId = randomUUID();
  const writes: ReadonlyArray<readonly [string, 'POST' | 'PATCH', string, () => object, readonly string[]]> = [
    ['createSupplier', 'POST', '/suppliers', () => ({ name: 'Refused Feeds' }), ['sales', 'cashier', 'driver']],
    ['updateSupplier', 'PATCH', `/suppliers/${someId}`, () => ({ version: 1, name: 'Refused' }), ['sales', 'cashier', 'driver']],
    ['archiveSupplier', 'POST', `/suppliers/${someId}/archive`, () => ({ version: 1, reason: 'Refused' }), ['sales', 'cashier', 'storekeeper', 'driver']],
    ['updatePaymentMethod', 'PATCH', `/payment-methods/${someId}`, () => ({ version: 1, isEnabled: true }), ['sales', 'cashier', 'storekeeper', 'driver']],
    [
      'createDeliveryZone',
      'POST',
      '/delivery-zones',
      () => ({ branchId: ids.get('branch:DDW')!, code: 'REFUSED', name: 'Refused', areas: ['Nowhere'], feePesewas: 100, cutoffTime: '12:00' }),
      ['sales', 'cashier', 'storekeeper', 'driver'],
    ],
    ['updateDeliveryZone', 'PATCH', `/delivery-zones/${someId}`, () => ({ version: 1, feePesewas: 1 }), ['sales', 'cashier', 'storekeeper', 'driver']],
    ['updatePriceList', 'PATCH', `/price-lists/${someId}`, () => ({ version: 1, name: 'Refused' }), ['sales', 'cashier', 'storekeeper', 'driver']],
    ['archivePriceList', 'POST', `/price-lists/${someId}/archive`, () => ({ version: 1, reason: 'Refused' }), ['sales', 'cashier', 'storekeeper', 'driver']],
    ['archiveProduct', 'POST', `/products/${someId}/archive`, () => ({ version: 1, reason: 'Refused' }), ['sales', 'cashier', 'storekeeper', 'driver']],
  ];
  const sessions = () => ({ sales, cashier, storekeeper, driver }) as Record<string, TestSession>;

  it.each(writes)('%s: each role without the permission is refused with 403 FORBIDDEN, and the refusal is audited', async (_operationId, method, path, body, refused) => {
    const count = async () => (await database.pool('admin').query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;
    const before = await count();
    for (const role of refused) {
      const session = sessions()[role]!;
      const response = method === 'POST' ? await post(session, path, body()) : await patch(session, path, body());
      expect(response.status, role).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect((await count()) - before).toBe(refused.length);
  });

  it('the Driver reads no supplier, payment method, zone or reason code; the Cashier reads methods and reason codes but no supplier', async () => {
    for (const path of ['/suppliers', '/payment-methods', '/delivery-zones', '/reason-codes']) {
      expect((await get(driver, path)).status, path).toBe(403);
    }
    expect((await get(cashier, '/payment-methods')).status).toBe(200);
    expect((await get(cashier, '/reason-codes')).status).toBe(200);
    expect((await get(cashier, '/suppliers')).status).toBe(403);
  });

  it('a Manager granted at the test branch cannot create or change a Dodowa zone: zone writes are scoped to their branch', async () => {
    const created = await post(managerAtTest, '/delivery-zones', { branchId: ids.get('branch:DDW')!, code: 'SCOPE', name: 'Refused', areas: ['Kpong'], feePesewas: 100, cutoffTime: '12:00' });
    expect(created.status).toBe(403);
    const changed = await patch(managerAtTest, `/delivery-zones/${ids.get('zone:DODOWA')!}`, { version: 1, feePesewas: 1 });
    expect(changed.status).toBe(403);
  });
});

describe('reason codes are a fixed list (FR-MDM-011)', () => {
  it('lists every code, ordered by code, across pages, and filters by domain', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get(cashier, `/reason-codes?limit=20${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status).toBe(200);
      seen.push(...codes(page.body));
      cursor = page.body.page.nextCursor;
    } while (cursor !== null);
    // 48 from B4 continued (d) 3, B08 continued 2's two BILLING_ADJUSTMENT reasons for debit notes, and B09a continued 1b's
    // two PAYMENT_REVERSAL reasons, and B09a continued 2c's ORDER_CANCELLED (REFUND) and SALE_VOIDED (PAYMENT_REVERSAL).
    expect(seen).toHaveLength(55);
    expect(seen).toEqual(expect.arrayContaining(['ORDER_CANCELLED', 'SALE_VOIDED', 'ORDER_RETURNED']));
    expect([...seen].sort()).toEqual(seen);
    const mortality = await get(cashier, '/reason-codes?domain=MORTALITY');
    expect(mortality.body.data).toContainEqual({ code: 'DISEASE_SUSPECTED', domain: 'MORTALITY', description: 'Died, disease suspected', requiresNote: true, lossAccountGroup: 'MORTALITY' });
    expect(mortality.body.data.every((row: { domain: string }) => row.domain === 'MORTALITY')).toBe(true);
  });

  it('the contract offers no write operation on reason codes, and the API answers none', async () => {
    const contract = readFileSync('contract/openapi.yaml', 'utf8');
    const start = contract.indexOf('\n  "/reason-codes":');
    const item = contract.slice(start, contract.indexOf('\n  "/', start + 5));
    expect(item).toMatch(/\n {4}get:/);
    expect(item).not.toMatch(/\n {4}(post|put|patch|delete):/);
    expect((await post(manager, '/reason-codes', { code: 'MADE_UP', domain: 'VOID', description: 'Made up' })).status).toBe(404);
  });

  it('the application role cannot insert, change or delete a reason code (42501)', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("INSERT INTO mdm.reason_code (code, domain, description) VALUES ('MADE_UP', 'VOID', 'Made up')"))).toBe('42501');
    expect(await sqlStateOf(app.query("UPDATE mdm.reason_code SET requires_note = false WHERE code = 'PREDATOR'"))).toBe('42501');
    expect(await sqlStateOf(app.query("DELETE FROM mdm.reason_code WHERE code = 'PREDATOR'"))).toBe('42501');
  });
});

describe('delivery zones and quoteDelivery (FR-MDM-010)', () => {
  it('quotes exactly 1,500 pesewas for an address in the seeded Dodowa zone, with no session', async () => {
    const response = await quote({ address: address('Dodowa', 'Dodowa') });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      deliverable: true,
      zone: { id: ids.get('zone:DODOWA')!, code: 'DODOWA', name: 'Dodowa and surroundings (SEED)' },
      feePesewas: 1500,
      freeOverPesewas: 50000,
      cutoffTime: '14:00',
      slots: [],
      currency: 'GHS',
    });
  });

  it('finds the zone by city, ignoring case, when no zone names the area', async () => {
    const response = await quote({ address: address('Old Town', ' DODOWA ') });
    expect(response.body).toMatchObject({ deliverable: true, feePesewas: 1500 });
  });

  it('answers "delivery unavailable" for an address in no zone: deliverable false and no fee, never a zero fee', async () => {
    const response = await quote({ address: { ...address('Ho Central', 'Ho'), region: 'Volta' } });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deliverable: false, zone: null, feePesewas: null, freeOverPesewas: null, cutoffTime: null, slots: [], currency: 'GHS' });
  });

  it('quotes a zone whose fee is zero as exactly 0, and still deliverable', async () => {
    const created = await post(manager, '/delivery-zones', { branchId: ids.get('branch:DDW')!, code: 'FARM-GATE', name: 'Farm gate collection', areas: ['Pute'], feePesewas: 0, cutoffTime: '17:30' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'FARM-GATE', feePesewas: 0, freeOverPesewas: null, cutoffTime: '17:30', isActive: true, currency: 'GHS', branch: { code: 'DDW' } });
    expect((await quote({ address: address('Pute', 'Dodowa') })).body).toMatchObject({ deliverable: true, feePesewas: 0, zone: { code: 'FARM-GATE' } });
  });

  it('refuses a cart id until carts exist, and an unknown region with 400', async () => {
    expect((await quote({ address: address('Dodowa', 'Dodowa'), cartId: randomUUID() })).body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/cartId' }] });
    expect((await quote({ address: { ...address('Dodowa', 'Dodowa'), region: 'Lagos' } })).status).toBe(400);
  });

  it('refuses an area another active zone covers, names that zone, and lets an inactive zone share it', async () => {
    const refused = await post(manager, '/delivery-zones', { branchId: ids.get('branch:DDW')!, code: 'TWIN', name: 'Twin', areas: ['Kpong', 'afienya'], feePesewas: 2_000, cutoffTime: '12:00' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'DELIVERY_ZONE_INVALID', details: [{ field: '/areas/1', code: 'AREA_IN_ZONE:DODOWA' }] });
    const created = await post(manager, '/delivery-zones', { branchId: ids.get('branch:DDW')!, code: 'KPONG', name: 'Kpong', areas: ['Kpong'], feePesewas: 2_500, cutoffTime: '12:00' });
    const off = await patch(manager, `/delivery-zones/${created.body.id}`, { version: created.body.version, isActive: false });
    expect(off.status).toBe(200);
    const shared = await patch(manager, `/delivery-zones/${created.body.id}`, { version: off.body.version, areas: ['Kpong', 'Afienya'] });
    expect(shared.status).toBe(200);
    const backOn = await patch(manager, `/delivery-zones/${created.body.id}`, { version: shared.body.version, isActive: true });
    expect(backOn.body.error).toMatchObject({ code: 'DELIVERY_ZONE_INVALID', details: [{ field: '/areas/1', code: 'AREA_IN_ZONE:DODOWA' }] });
  });

  it('changes a fee exactly, audits before and after, and refuses a stale version with 409', async () => {
    const zones = await get(manager, `/delivery-zones?branchId=${ids.get('branch:DDW')!}`);
    const kpong = zones.body.data.find((row: { code: string }) => row.code === 'KPONG');
    const changed = await patch(manager, `/delivery-zones/${kpong.id}`, { version: kpong.version, feePesewas: 2_501, areas: ['Kpong', 'Akuse'] });
    expect(changed.status).toBe(200);
    expect(changed.body.feePesewas).toBe(2501);
    expect((await patch(manager, `/delivery-zones/${kpong.id}`, { version: kpong.version, feePesewas: 1 })).status).toBe(409);
    const { rows } = await database.pool('admin').query<{ before: Buffer; after: Buffer }>(
      "SELECT before, after FROM platform.audit_event WHERE entity_type = 'DeliveryZone' AND entity_id = $1 AND action = 'UPDATE' ORDER BY recorded_at DESC, id DESC LIMIT 1",
      [kpong.id],
    );
    expect(JSON.parse(rows[0]!.before.toString('utf8'))).toMatchObject({ feePesewas: 2500 });
    expect(JSON.parse(rows[0]!.after.toString('utf8'))).toMatchObject({ feePesewas: 2501, areas: ['Kpong', 'Akuse'] });
  });

  it('the database refuses a negative fee, a zone with no areas and a cut-off with seconds (23514)', async () => {
    const insert = (fee: string, areas: string, cutoff: string) =>
      database
        .pool('admin')
        .query(
          `INSERT INTO mdm.delivery_zone (id, branch_id, code, name, areas, fee_pesewas, cutoff_time, created_by, updated_by)
           VALUES ($1, $2, $3, 'Bad', ${areas}, ${fee}, '${cutoff}', $4, $4)`,
          [randomUUID(), ids.get('branch:DDW')!, `BAD-${randomUUID().slice(0, 6).toUpperCase()}`, SYSTEM],
        );
    expect(await sqlStateOf(insert('-1', "ARRAY['Somewhere']", '12:00'))).toBe('23514');
    expect(await sqlStateOf(insert('100', 'ARRAY[]::text[]', '12:00'))).toBe('23514');
    expect(await sqlStateOf(insert('100', "ARRAY['Elsewhere']", '12:00:30'))).toBe('23514');
  });

  it('gives a saved address the zone it is in, and null when it is in none (A-112)', async () => {
    const seeded = await database.pool('admin').query<{ code: string | null; area: string }>(
      'SELECT z.code, a.area FROM mdm.customer_address a LEFT JOIN mdm.delivery_zone z ON z.id = a.delivery_zone_id ORDER BY a.area',
    );
    expect(seeded.rows).toEqual([
      { code: 'DODOWA', area: 'Dodowa' },
      { code: null, area: 'Spintex' },
    ]);
    const customer = await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Yaw Boakye (TEST)', phone: '0244771203' });
    const home = await post(sales, `/customers/${customer.body.id}/addresses`, {
      label: 'Home',
      recipientName: 'Yaw Boakye',
      recipientPhone: '0244771203',
      line1: 'Behind the clinic',
      area: 'Ayikuma',
      city: 'Dodowa',
      region: 'Greater Accra',
    });
    expect(home.status).toBe(201);
    expect(home.body.deliveryZone).toEqual({ id: ids.get('zone:DODOWA')!, code: 'DODOWA', name: 'Dodowa and surroundings (SEED)' });
    const moved = await patch(sales, `/customer-addresses/${home.body.id}`, { version: home.body.version, area: 'Ho Central', city: 'Ho', region: 'Volta' });
    expect(moved.body.deliveryZone).toBeNull();
  });
});

describe('payment methods (FR-MDM-009)', () => {
  const method = async (code: string) => (await get(manager, '/payment-methods?includeDisabled=true')).body.data.find((row: { code: string }) => row.code === code);

  it('lists the five methods the seeded Owner enabled, and all seven with includeDisabled', async () => {
    expect(codes((await get(cashier, '/payment-methods')).body).sort()).toEqual(['BANK_TRANSFER', 'CARD', 'CASH', 'COD', 'MOMO']);
    const all = await get(manager, '/payment-methods?includeDisabled=true');
    expect(all.body.data).toHaveLength(7);
    expect(await method('CASH')).toMatchObject({ kind: 'CASH', allowedOffline: true, requiresProviderVerification: false, isEnabled: true });
  });

  it('refuses requiresProviderVerification = false on mobile money and card with 422, and the database refuses it too', async () => {
    for (const code of ['MOMO', 'CARD']) {
      const found = await method(code);
      const refused = await patch(owner, `/payment-methods/${found.id}`, { version: found.version, requiresProviderVerification: false });
      expect(refused.status, code).toBe(422);
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_METHOD_INVALID', details: [{ field: '/requiresProviderVerification', code: 'VERIFICATION_REQUIRED' }] });
    }
    const error = database.pool('admin').query("UPDATE mdm.payment_method SET requires_provider_verification = false, version = version + 1 WHERE code = 'MOMO'");
    expect(await sqlStateOf(error)).toBe('23514');
  });

  it('refuses mobile money offline while pos.offline_mobile_money_allowed is off, and the database refuses a card offline', async () => {
    const momo = await method('MOMO');
    const refused = await patch(owner, `/payment-methods/${momo.id}`, { version: momo.version, allowedOffline: true });
    expect(refused.body.error).toMatchObject({ code: 'PAYMENT_METHOD_INVALID', details: [{ field: '/allowedOffline', code: 'OFFLINE_NOT_ALLOWED' }] });
    const error = database.pool('admin').query("UPDATE mdm.payment_method SET allowed_offline = true, version = version + 1 WHERE code = 'CARD'");
    expect(await sqlStateOf(error)).toBe('23514');
  });

  it('enabling then disabling CHEQUE adds it to and removes it from the methods offered for new sales, audited each time', async () => {
    const cheque = await method('CHEQUE');
    const on = await patch(owner, `/payment-methods/${cheque.id}`, { version: cheque.version, isEnabled: true });
    expect(on.status).toBe(200);
    expect(codes((await get(cashier, '/payment-methods')).body)).toContain('CHEQUE');
    const off = await patch(manager, `/payment-methods/${cheque.id}`, { version: on.body.version, isEnabled: false });
    expect(off.body.isEnabled).toBe(false);
    expect(codes((await get(cashier, '/payment-methods')).body)).not.toContain('CHEQUE');
    const audits = await database.pool('admin').query("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'PaymentMethod' AND entity_id = $1 AND action = 'UPDATE'", [cheque.id]);
    expect(audits.rows[0]!.n).toBe(2);
  });
});

describe('suppliers (FR-MDM-007)', () => {
  let supplierId: string;

  it('stores 0244661290 as +233244661290, refuses a second live supplier with that phone however it is typed, and finds it by phone', async () => {
    const created = await post(storekeeper, '/suppliers', {
      name: 'Akuapem Hills Goat Breeders (TEST)',
      contactName: 'Kwame Asiedu',
      phone: '0244661290',
      email: 'Sales@Akuapem.example',
      address: 'Mampong-Akuapem',
      tin: 'C0012345678',
      categoryIds: [ids.get('category:LIVE')!],
    });
    expect(created.status).toBe(201);
    supplierId = created.body.id;
    expect(created.body).toMatchObject({
      phone: '+233244661290',
      email: 'sales@akuapem.example',
      tinMasked: '*******5678',
      status: 'ACTIVE',
      hasProfile: false,
      categories: [{ id: ids.get('category:LIVE')!, code: 'LIVE', name: 'Live animals' }],
    });
    expect(created.body.supplierNo).toMatch(/^S-\d{4}$/);
    for (const typed of ['+233244661290', '024 466 1290']) {
      const duplicate = await post(storekeeper, '/suppliers', { name: 'Someone else', phone: typed });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/phone' }] });
    }
    const found = async (query: string) => (await get(storekeeper, `/suppliers?${query}`)).body.data.map((row: { id: string }) => row.id);
    expect(await found('q=0244661290')).toEqual([supplierId]);
    expect(await found('q=akuapem')).toEqual([supplierId]);
    expect(await found(`categoryId=${ids.get('category:LIVE')!}`)).toEqual([supplierId]);
  });

  it('refuses an unknown category and keeps a supplier in the database to one live phone (uq_supplier_phone_hash)', async () => {
    const refused = await post(storekeeper, '/suppliers', { name: 'Unknown category', categoryIds: [randomUUID()] });
    expect(refused.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/categoryIds/0' }] });
    const admin = database.pool('admin');
    const { rows } = await admin.query<{ phone_hash: Buffer }>('SELECT phone_hash FROM mdm.supplier WHERE id = $1', [supplierId]);
    const error = admin.query(
      `INSERT INTO mdm.supplier (id, supplier_no, name, phone_e164, phone_hash, status, created_by, updated_by)
       VALUES ($1, 'S-9999', 'Twin', '+233244661290', $2, 'ACTIVE', $3, $3)`,
      [randomUUID(), rows[0]!.phone_hash, SYSTEM],
    );
    expect(await sqlStateOf(error)).toBe('23505');
  });

  it('replaces the categories supplied, publishes mdm.SupplierRegistered once, and archives with a reason that frees the phone', async () => {
    const before = (await get(storekeeper, `/suppliers/${supplierId}`)).body;
    const changed = await patch(storekeeper, `/suppliers/${supplierId}`, { version: before.version, categoryIds: [ids.get('category:MEAT')!, ids.get('category:LIVE')!], status: 'BLOCKED' });
    expect(changed.status).toBe(200);
    expect(codes({ data: changed.body.categories })).toEqual(['LIVE', 'MEAT']);
    expect(changed.body.status).toBe('BLOCKED');
    const events = await database.pool('admin').query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'mdm.SupplierRegistered' AND subject_id = $1", [supplierId]);
    expect(events.rows[0]!.n).toBe(1);
    const archived = await post(manager, `/suppliers/${supplierId}/archive`, { version: changed.body.version, reason: 'Stopped trading (TEST)' });
    expect(archived.status).toBe(200);
    expect((await get(storekeeper, '/suppliers?q=0244661290')).body.data).toEqual([]);
    expect((await get(storekeeper, `/suppliers/${supplierId}`)).status).toBe(200);
    expect((await post(storekeeper, '/suppliers', { name: 'New owner of the number', phone: '0244661290' })).status).toBe(201);
  });
});

describe('price list listings and updates (FR-MDM-015)', () => {
  it('lists the seeded lists, filters by kind, and pages versions and entries with exact pesewas', async () => {
    const lists = await get(manager, '/price-lists?limit=100');
    expect(codes(lists.body)).toEqual(expect.arrayContaining(['BASE', 'ONLINE', 'WHOLESALE', 'CATERERS-2026']));
    expect(codes((await get(manager, '/price-lists?kind=CUSTOMER')).body)).toEqual(['CATERERS-2026']);
    const versions = await get(manager, `/price-lists/${ids.get('list:CATERERS-2026')!}/versions`);
    expect(versions.body.data).toHaveLength(1);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 1, status: 'ACTIVE' });
    const entries = await get(manager, `/price-list-versions/${versions.body.data[0].id}/entries?limit=1`);
    expect(entries.body.data).toHaveLength(1);
    expect(Number.isInteger(entries.body.data[0].listPricePesewas)).toBe(true);
    expect(entries.body.data[0].currency).toBe('GHS');
    const forProduct = await get(manager, `/price-list-versions/${versions.body.data[0].id}/entries?productId=${entries.body.data[0].product.id}`);
    expect(forProduct.body.data.every((row: { product: { id: string } }) => row.product.id === entries.body.data[0].product.id)).toBe(true);
  });

  it('renames a list, refuses a tax-inclusive change once a version was approved, and refuses archiving a list in force', async () => {
    const id = ids.get('list:CATERERS-2026')!;
    const list = (await get(manager, `/price-lists/${id}`)).body;
    const renamed = await patch(manager, `/price-lists/${id}`, { version: list.version, name: 'Caterers 2026 (SEED)' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Caterers 2026 (SEED)');
    const flag = await patch(manager, `/price-lists/${id}`, { version: renamed.body.version, taxInclusive: !renamed.body.taxInclusive });
    expect(flag.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ field: '/taxInclusive', code: 'PRICED_WITH_THIS_FLAG' }] });
    const archive = await post(manager, `/price-lists/${id}/archive`, { version: renamed.body.version, reason: 'Contract ended' });
    expect(archive.status).toBe(422);
    expect(archive.body.error.details.map((detail: { code: string }) => detail.code)).toEqual(['HAS_LIVE_VERSION', 'ASSIGNED_TO_CUSTOMERS']);
  });

  it('archives a list that prices nothing, which then leaves the listing', async () => {
    const created = await post(manager, '/price-lists', { code: 'EASTER-2027', name: 'Easter 2027', kind: 'CUSTOMER', taxInclusive: true });
    const flipped = await patch(manager, `/price-lists/${created.body.id}`, { version: created.body.version, taxInclusive: false });
    expect(flipped.body.taxInclusive).toBe(false);
    const archived = await post(manager, `/price-lists/${created.body.id}/archive`, { version: flipped.body.version, reason: 'Not needed (TEST)' });
    expect(archived.status).toBe(200);
    expect(codes((await get(manager, '/price-lists?kind=CUSTOMER')).body)).not.toContain('EASTER-2027');
    expect((await get(manager, `/price-lists/${created.body.id}`)).status).toBe(404);
  });
});

describe('archiveProduct (FR-MDM-001)', () => {
  it('refuses a product an active price list prices, and archives an unpriced one with an audit event and mdm.ProductArchived', async () => {
    const goat = (await get(manager, `/products/${ids.get('product:LIV-GOAT')!}`)).body;
    const refused = await post(manager, `/products/${goat.id}/archive`, { version: goat.version, reason: 'Refused' });
    expect(refused.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ code: 'USED_BY_LIVE_PRICES' }] });
    const created = await post(manager, '/products', {
      sku: 'PRD-PLANTAIN-BUNCH',
      name: 'Plantain, bunch',
      categoryId: ids.get('category:PRODUCE')!,
      stockPolicy: 'COUNTABLE',
      baseUom: 'BUNCH',
      saleUom: 'BUNCH',
      onlineMode: 'HIDDEN',
    });
    expect(created.status).toBe(201);
    const archived = await post(manager, `/products/${created.body.id}/archive`, { version: created.body.version, reason: 'No longer stocked (TEST)' });
    expect(archived.status).toBe(200);
    expect(archived.body.version).toBe(created.body.version + 1);
    expect((await get(manager, `/products/${created.body.id}`)).status).toBe(404);
    const admin = database.pool('admin');
    expect((await admin.query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'mdm.ProductArchived' AND subject_id = $1", [created.body.id])).rows[0]!.n).toBe(1);
    const audit = await admin.query<{ after: Buffer }>("SELECT after FROM platform.audit_event WHERE entity_type = 'Product' AND entity_id = $1 AND action = 'ARCHIVE'", [created.body.id]);
    expect(audit.rows.map((row) => JSON.parse(row.after.toString('utf8')).reason)).toEqual(['No longer stocked (TEST)']);
  });
});
