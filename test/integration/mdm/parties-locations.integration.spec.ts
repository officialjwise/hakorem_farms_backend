import { randomUUID } from 'node:crypto';
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
 * Branches, locations, customers, tiers, addresses and the assigned price list through the API, over the seeded
 * farm (FR-MDM-006, FR-MDM-008, FR-MDM-021): every write refuses the wrong role, Ghanaian phone numbers are
 * normalised and unique, a location's parent stays in its branch (the database refuses it too), virtual locations
 * never change, and the assigned list is what the engine prices with first.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let managerAtTest: TestSession;
let sales: TestSession;
let cashier: TestSession;
let driver: TestSession;
let storekeeper: TestSession;
const ids = new Map<string, string>();

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const send = (method: 'patch' | 'put', session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server)[method](`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const admin = database.pool('admin');
  for (const row of (await admin.query<{ code: string; id: string }>(
    `SELECT 'branch:' || code AS code, id FROM mdm.branch
     UNION ALL SELECT 'location:' || b.code || ':' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id
     UNION ALL SELECT 'customer:' || customer_no, id FROM mdm.customer
     UNION ALL SELECT 'list:' || code, id FROM mdm.price_list
     UNION ALL SELECT 'tier:' || code, id FROM mdm.customer_tier
     UNION ALL SELECT 'product:' || sku, id FROM mdm.product`,
  )).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = ids.get('branch:DDW')!;
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

describe('wrong roles are refused on every party and location write (ADR-0035)', () => {
  const someId = randomUUID();
  const writes: ReadonlyArray<readonly [string, 'POST' | 'PATCH' | 'PUT', string, object, readonly string[]]> = [
    ['createBranch', 'POST', '/branches', { code: 'KSI', name: 'Kumasi' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['updateBranch', 'PATCH', `/branches/${someId}`, { version: 1, name: 'Refused' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['createLocation', 'POST', '/locations', { branchId: someId, code: 'PEN2', name: 'Refused', kind: 'PEN' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['updateLocation', 'PATCH', `/locations/${someId}`, { version: 1, name: 'Refused' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['archiveLocation', 'POST', `/locations/${someId}/archive`, { version: 1, reason: 'Refused' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['createCustomer', 'POST', '/customers', { kind: 'INDIVIDUAL', name: 'Refused' }, ['cashier', 'storekeeper', 'driver']],
    ['updateCustomer', 'PATCH', `/customers/${someId}`, { version: 1, name: 'Refused' }, ['cashier', 'storekeeper', 'driver']],
    ['archiveCustomer', 'POST', `/customers/${someId}/archive`, { version: 1, reason: 'Refused' }, ['sales', 'cashier', 'storekeeper', 'driver']],
    ['createCustomerTier', 'POST', '/customer-tiers', { code: 'CATERING', name: 'Catering' }, ['cashier', 'storekeeper', 'driver']],
    ['createCustomerAddress', 'POST', `/customers/${someId}/addresses`, { label: 'Home', recipientName: 'x', recipientPhone: '0244123456', line1: 'x', area: 'x', city: 'x', region: 'Volta' }, ['cashier', 'storekeeper', 'driver']],
    ['updateCustomerAddress', 'PATCH', `/customer-addresses/${someId}`, { version: 1, label: 'Refused' }, ['cashier', 'storekeeper', 'driver']],
    ['archiveCustomerAddress', 'POST', `/customer-addresses/${someId}/archive`, { version: 1, reason: 'Refused' }, ['cashier', 'storekeeper', 'driver']],
    ['assignCustomerPriceList', 'PUT', `/customers/${someId}/price-list`, { priceListId: someId, validFrom: '2026-12-01T00:00:00Z' }, ['cashier', 'storekeeper', 'driver']],
  ];
  const sessions = () => ({ sales, cashier, storekeeper, driver }) as Record<string, TestSession>;

  it.each(writes)('%s: each role without the permission is refused with 403 FORBIDDEN, and the refusal is audited', async (_operationId, method, path, body, refused) => {
    const before = await database.pool('admin').query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
    for (const role of refused) {
      const session = sessions()[role]!;
      const response = method === 'POST' ? await post(session, path, body) : await send(method === 'PATCH' ? 'patch' : 'put', session, path, body);
      expect(response.status, role).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    const after = await database.pool('admin').query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
    expect(after.rows[0]!.n - before.rows[0]!.n).toBe(refused.length);
  });

  it('the Driver reads no customer, branch or location; the Cashier reads customers but cannot create one', async () => {
    for (const path of ['/customers', '/branches', '/locations', '/customer-tiers']) {
      expect((await get(driver, path)).status).toBe(403);
    }
    expect((await get(cashier, '/customers')).status).toBe(200);
  });

  it('a Manager granted at the test branch cannot create a location at Dodowa: location writes are scoped to their branch', async () => {
    const refused = await post(managerAtTest, '/locations', { branchId: ids.get('branch:DDW')!, code: 'PEN-T', name: 'Refused', kind: 'PEN' });
    expect(refused.status).toBe(403);
  });
});

describe('customers (FR-MDM-008)', () => {
  it('stores 0244123456 as +233244123456, refuses the same number again however it is typed, and finds the customer by phone', async () => {
    const created = await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Kwame Asante (TEST)', phone: '0244123456', email: 'Kwame@Example.invalid' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ phone: '+233244123456', email: 'kwame@example.invalid', tier: { code: 'RETAIL' }, status: 'ACTIVE', hasLogin: false, priceList: null, hasBusinessAccount: false });
    expect(created.body.customerNo).toMatch(/^C-\d{5}$/);
    for (const typed of ['+233244123456', '233 24 412 3456', '024-412-3456']) {
      const duplicate = await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Someone else', phone: typed });
      expect(duplicate.status).toBe(422);
      expect(duplicate.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/phone' }] });
    }
    const found = await get(sales, '/customers?q=0244123456');
    expect(found.body.data.map((c: { id: string }) => c.id)).toEqual([created.body.id]);
    const byName = await get(sales, '/customers?q=asante');
    expect(byName.body.data.map((c: { id: string }) => c.id)).toEqual([created.body.id]);
  });

  it('refuses a number that is no Ghanaian or E.164 number with 400 INVALID_PHONE', async () => {
    const refused = await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Bad phone', phone: '0144123456' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: '/phone', code: 'INVALID_PHONE' }] });
  });

  it('keeps one live customer per phone in the database too (uq_customer_phone_hash)', async () => {
    const admin = database.pool('admin');
    const { rows } = await admin.query<{ phone_hash: Buffer; tier_id: string }>("SELECT phone_hash, tier_id FROM mdm.customer WHERE phone_e164 = '+233244123456'");
    const error = sqlStateOf(admin
      .query(
        `INSERT INTO mdm.customer (id, customer_no, kind, name, phone_e164, phone_hash, tier_id, status, created_by, updated_by)
         VALUES ($1, 'C-99999', 'INDIVIDUAL', 'Twin', '+233244123456', $2, $3, 'ACTIVE', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
        [randomUUID(), rows[0]!.phone_hash, rows[0]!.tier_id],
      ));
    expect(await error).toBe('23505');
  });

  it('encrypts a TIN and shows only its last four characters; the stored bytes are not the number', async () => {
    const created = await post(sales, '/customers', { kind: 'BUSINESS', name: 'Ho Poultry Ltd (TEST)', tin: 'C0012345678', tierId: ids.get('tier:WHOLESALE') });
    expect(created.body).toMatchObject({ tinMasked: '*******5678', tier: { code: 'WHOLESALE' } });
    const { rows } = await database.pool('admin').query<{ tin_enc: Buffer }>('SELECT tin_enc FROM mdm.customer WHERE id = $1', [created.body.id]);
    expect(rows[0]!.tin_enc.toString('utf8')).not.toContain('C0012345678');
  });

  it('updates with the version read, refuses a stale one, and archives with a reason; the archived phone is free again', async () => {
    const created = await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Efua Mensah (TEST)', phone: '0557001122' });
    const changed = await send('patch', sales, `/customers/${created.body.id}`, { version: 1, status: 'BLOCKED', phone: '0557001123' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ status: 'BLOCKED', phone: '+233557001123', version: 2 });
    expect((await send('patch', sales, `/customers/${created.body.id}`, { version: 1, name: 'Stale' })).status).toBe(409);
    const archived = await post(manager, `/customers/${created.body.id}/archive`, { version: 2, reason: 'Duplicate record' });
    expect(archived.status).toBe(200);
    expect((await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Efua again', phone: '0557001123' })).status).toBe(201);
    const audit = await database.pool('admin').query<{ action: string; after: string }>(
      "SELECT action, \"after\"::text AS after FROM platform.audit_event WHERE entity_type = 'Customer' AND entity_id = $1 ORDER BY recorded_at",
      [created.body.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'ARCHIVE']);
    // Personal data in the trail is encrypted with the customer's key.
    expect(audit.rows.every((row) => !row.after.includes('Efua'))).toBe(true);
  });

  it('creates a tier and refuses its code twice', async () => {
    expect((await post(sales, '/customer-tiers', { code: 'CATERING', name: 'Catering' })).status).toBe(201);
    const twice = await post(sales, '/customer-tiers', { code: 'CATERING', name: 'Catering again' });
    expect(twice.body.error).toMatchObject({ code: 'DUPLICATE_VALUE', details: [{ field: '/code' }] });
  });
});

describe('customer addresses (FR-MDM-008)', () => {
  it('needs a region and a landmark or digital address, and normalises the driver phone; a new default replaces the old', async () => {
    const customer = (await post(sales, '/customers', { kind: 'INDIVIDUAL', name: 'Yaa Owusu (TEST)' })).body;
    const base = { label: 'Home', recipientName: 'Yaa Owusu', recipientPhone: '0201234567', line1: 'Near the Adenta barrier', area: 'Adenta', city: 'Accra', region: 'greater accra' };
    const home = await post(sales, `/customers/${customer.id}/addresses`, { ...base, isDefault: true });
    expect(home.status).toBe(201);
    expect(home.body).toMatchObject({ region: 'Greater Accra', recipientPhone: '+233201234567', isDefault: true, deliveryZone: null, digitalAddress: null });
    const bad = await post(sales, `/customers/${customer.id}/addresses`, { ...base, region: 'Lagos', line1: ' ', digitalAddress: 'GA1234567' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { code: string }) => d.code)).toEqual(['UNKNOWN_REGION', 'INVALID_DIGITAL_ADDRESS']);
    const blank = await post(sales, `/customers/${customer.id}/addresses`, { ...base, line1: ' ' });
    expect(blank.body.error.details).toEqual([expect.objectContaining({ field: '/line1', code: 'LANDMARK_OR_DIGITAL_ADDRESS' })]);
    const shop = await post(sales, `/customers/${customer.id}/addresses`, { ...base, label: 'Shop', line1: ' ', digitalAddress: 'ga-123-4567', isDefault: true });
    expect(shop.body).toMatchObject({ digitalAddress: 'GA-123-4567', isDefault: true });
    const list = await get(sales, `/customers/${customer.id}/addresses`);
    expect(list.body.data.map((a: { label: string; isDefault: boolean }) => [a.label, a.isDefault])).toEqual([
      ['Home', false],
      ['Shop', true],
    ]);
    expect((await get(sales, `/customers/${customer.id}`)).body.defaultArea).toBe('Adenta');
    const archived = await post(sales, `/customer-addresses/${home.body.id}/archive`, { version: home.body.version + 1, reason: 'Moved house' });
    expect(archived.status).toBe(200);
    expect((await get(sales, `/customers/${customer.id}/addresses`)).body.data).toHaveLength(1);
  });

  it('the database refuses an address with neither landmark nor digital address, and an unknown region', async () => {
    const admin = database.pool('admin');
    const customerId = ids.get('customer:C-00002')!;
    for (const [line1, region] of [
      [' ', 'Volta'],
      ['Market square', 'Lagos'],
    ] as const) {
      const error = sqlStateOf(admin
        .query(
          `INSERT INTO mdm.customer_address (id, customer_id, label, recipient_name, recipient_phone_e164, line1, area, city, region, created_by, updated_by)
           VALUES ($1, $2, 'x', 'x', '+233244000000', $3, 'x', 'x', $4, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
          [randomUUID(), customerId, line1, region],
        ));
      expect(await error).toBe('23514');
    }
  });
});

describe('branches and locations (FR-MDM-006)', () => {
  const SYSTEM = '01900000-0000-7000-8000-000000000001';

  it('creates a branch with its eight virtual locations, which can never be changed or archived', async () => {
    const created = await post(manager, '/branches', { code: 'KSI', name: 'Kumasi depot (TEST)', phone: '0322001122' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'KSI', phone: '+233322001122', isTest: false, status: 'ACTIVE' });
    const virtual = await get(manager, `/locations?branchId=${created.body.id}&includeVirtual=true`);
    expect(virtual.body.data.map((l: { kind: string }) => l.kind)).toEqual(['SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING']);
    expect((await get(manager, `/locations?branchId=${created.body.id}`)).body.data).toEqual([]);
    expect((await post(manager, '/branches', { code: 'KSI', name: 'Again' })).body.error.code).toBe('DUPLICATE_VALUE');
    // The Manager is granted at Dodowa only, so Dodowa's own virtual loss location is the one they may try to change.
    const loss = ids.get('location:DDW:V-LOSS')!;
    const refused = await send('patch', manager, `/locations/${loss}`, { version: 1, name: 'Renamed' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'LOCATION_INVALID', details: [{ code: 'VIRTUAL_LOCATION_FIXED' }] });
    expect((await post(manager, `/locations/${loss}/archive`, { version: 1, reason: 'x' })).body.error.code).toBe('LOCATION_INVALID');
    expect(await sqlStateOf(database.pool('admin').query("UPDATE mdm.location SET name = 'Hacked', version = version + 1 WHERE id = $1", [loss]))).toBe('23514');
    // A Manager granted at Dodowa cannot work on the new branch's locations until someone grants them there.
    expect((await post(manager, '/locations', { branchId: created.body.id, code: 'SITE', name: 'Kumasi site', kind: 'SITE' })).status).toBe(403);
  });

  it('refuses a virtual kind, a pen whose parent is in another branch (and so does the database), and a cold room without its range', async () => {
    const dodowa = ids.get('branch:DDW')!;
    const virtual = await post(manager, '/locations', { branchId: dodowa, code: 'LOSS2', name: 'Loss', kind: 'LOSS' });
    expect(virtual.body.error).toMatchObject({ code: 'LOCATION_INVALID', details: [{ field: '/kind', code: 'VIRTUAL_KIND_FIXED' }] });
    const testSite = await post(managerAtTest, '/locations', { branchId: ids.get('branch:TST')!, code: 'SITE', name: 'Smoke test site', kind: 'SITE' });
    expect(testSite.status).toBe(201);
    const across = await post(manager, '/locations', { branchId: dodowa, parentId: testSite.body.id, code: 'PEN-X', name: 'Cross pen', kind: 'PEN' });
    expect(across.status).toBe(422);
    expect(across.body.error).toMatchObject({ code: 'LOCATION_INVALID', details: [{ field: '/parentId', code: 'PARENT_IN_OTHER_BRANCH' }] });
    const insert = database
      .pool('admin')
      .query(
        `INSERT INTO mdm.location (id, branch_id, parent_id, code, name, kind, is_virtual, created_by, updated_by) VALUES ($1, $2, $3, 'PEN-X', 'Cross pen', 'PEN', false, $4, $4)`,
        [randomUUID(), dodowa, testSite.body.id, SYSTEM],
      );
    expect(await sqlStateOf(insert)).toBe('23514');
    const cold = await post(manager, '/locations', { branchId: dodowa, code: 'COLD2', name: 'Chiller', kind: 'COLD_ROOM', tempClass: 'CHILLED' });
    expect(cold.body.error.details.map((d: { field: string }) => d.field)).toEqual(['/tempMinC', '/tempMaxC']);
    const chiller = await post(manager, '/locations', { branchId: dodowa, parentId: ids.get('location:DDW:SITE'), code: 'COLD2', name: 'Chiller', kind: 'COLD_ROOM', tempClass: 'CHILLED', tempMinC: '0.0', tempMaxC: '4.0' });
    expect(chiller.status).toBe(201);
    expect(chiller.body).toMatchObject({ tempClass: 'CHILLED', tempMinC: '0.0', tempMaxC: '4.0', branch: { code: 'DDW' }, isVirtual: false });
    expect((await post(manager, '/locations', { branchId: dodowa, code: 'COLD2', name: 'Twice', kind: 'STORE' })).body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('refuses to archive a location with live locations below it, archives a leaf, and refuses a parent below the location', async () => {
    const dodowa = ids.get('branch:DDW')!;
    const site = ids.get('location:DDW:SITE')!;
    const yard = await post(manager, '/locations', { branchId: dodowa, parentId: site, code: 'YARD', name: 'Holding yard', kind: 'PEN' });
    const pen = await post(manager, '/locations', { branchId: dodowa, parentId: yard.body.id, code: 'YARD-1', name: 'Yard pen 1', kind: 'PEN', capacityHead: 20 });
    const loop = await send('patch', manager, `/locations/${yard.body.id}`, { version: 1, parentId: pen.body.id });
    expect(loop.body.error).toMatchObject({ code: 'LOCATION_INVALID', details: [{ code: 'PARENT_IS_SELF_OR_BELOW' }] });
    const busy = await post(manager, `/locations/${yard.body.id}/archive`, { version: 1, reason: 'Closed' });
    expect(busy.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ code: 'HAS_LIVE_CHILDREN' }] });
    expect((await post(manager, `/locations/${pen.body.id}/archive`, { version: 1, reason: 'Closed' })).status).toBe(200);
    expect((await post(manager, `/locations/${yard.body.id}/archive`, { version: 1, reason: 'Closed' })).status).toBe(200);
    expect((await get(storekeeper, `/locations/${yard.body.id}`)).status).toBe(200);
    const renamed = await send('patch', manager, `/locations/${ids.get('location:DDW:SHOP')}`, { version: 1, name: 'Shop floor and counter' });
    expect(renamed.body).toMatchObject({ name: 'Shop floor and counter', version: 2 });
  });

  it('updates a branch with the version read, scoped to it, and closes it', async () => {
    const test = (await get(managerAtTest, `/branches/${ids.get('branch:TST')}`)).body;
    expect((await send('patch', manager, `/branches/${test.id}`, { version: test.version, name: 'Refused' })).status).toBe(403);
    const closed = await send('patch', managerAtTest, `/branches/${test.id}`, { version: test.version, status: 'CLOSED', phone: '+233200000009' });
    expect(closed.body).toMatchObject({ status: 'CLOSED', phone: '+233200000009', isTest: true, version: test.version + 1 });
    expect((await send('patch', managerAtTest, `/branches/${test.id}`, { version: test.version, name: 'Stale' })).status).toBe(409);
  });
});

describe('the price list assigned to a customer (FR-MDM-021)', () => {
  const goat = () => ({
    channel: 'WHOLESALE',
    branchId: ids.get('branch:DDW'),
    customerId: ids.get('customer:C-00002'),
    lines: [{ lineRef: '1', productId: ids.get('product:LIV-GOAT'), quantity: '1.000', weightKg: '22.400', gradeId: undefined as string | undefined }],
  });
  const price = async (at?: string) => {
    const admin = database.pool('admin');
    const grade = await admin.query<{ id: string }>("SELECT g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id WHERE s.code = 'GOAT' AND g.code = 'A'");
    const body = goat();
    body.lines[0]!.gradeId = grade.rows[0]!.id;
    const response = await post(sales, '/pricing/resolve', at === undefined ? body : { ...body, at });
    return response.body.lines[0].resolved;
  };

  it("assigning Caterers 2026 makes the next resolvePrices use the list's entry; a list ending returns the customer to the tier", async () => {
    expect((await price()).priceList.code).toBe('WHOLESALE');
    const customerId = ids.get('customer:C-00002')!;
    const from = new Date(clock.now().getTime() - 60_000).toISOString();
    const until = new Date(clock.now().getTime() + 86_400_000).toISOString();
    const assigned = await send('put', sales, `/customers/${customerId}/price-list`, { priceListId: ids.get('list:CATERERS-2026'), validFrom: from, validTo: until });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toEqual({ customerId, priceList: { id: ids.get('list:CATERERS-2026'), code: 'CATERERS-2026', name: expect.any(String) }, validFrom: from, validTo: until });
    expect(await price()).toMatchObject({ priceList: { code: 'CATERERS-2026' }, listPricePesewas: 70_000 });
    expect((await get(sales, `/customers/${customerId}`)).body.priceList.code).toBe('CATERERS-2026');
    expect((await price(new Date(clock.now().getTime() + 2 * 86_400_000).toISOString())).priceList.code).toBe('WHOLESALE');
    const audit = await database.pool('admin').query("SELECT 1 FROM platform.audit_event WHERE action = 'ASSIGN_PRICE_LIST' AND entity_id = $1", [customerId]);
    expect(audit.rows).toHaveLength(1);
  });

  it('a new assignment replaces the one it meets: the earlier one ends where the new one starts', async () => {
    const customerId = ids.get('customer:C-00002')!;
    const from = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const replaced = await send('put', manager, `/customers/${customerId}/price-list`, { priceListId: ids.get('list:CATERERS-2026'), validFrom: from });
    expect(replaced.status).toBe(200);
    const { rows } = await database.pool('admin').query<{ valid_to: Date | null }>(
      'SELECT valid_to FROM mdm.customer_price_list WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY valid_from',
      [customerId],
    );
    expect(rows.map((row) => row.valid_to?.toISOString() ?? null)).toEqual([from, null]);
  });

  it('refuses a list that is not a CUSTOMER list, and a window that ends before it starts', async () => {
    const customerId = ids.get('customer:C-00003')!;
    const tierList = await send('put', sales, `/customers/${customerId}/price-list`, { priceListId: ids.get('list:WHOLESALE'), validFrom: '2026-12-01T00:00:00Z' });
    expect(tierList.body.error).toMatchObject({ code: 'PRICE_LIST_ASSIGNMENT_INVALID', details: [{ code: 'NOT_A_CUSTOMER_LIST' }] });
    const backwards = await send('put', sales, `/customers/${customerId}/price-list`, { priceListId: ids.get('list:CATERERS-2026'), validFrom: '2026-12-01T00:00:00Z', validTo: '2026-11-30T00:00:00Z' });
    expect(backwards.body.error).toMatchObject({ code: 'PRICE_LIST_ASSIGNMENT_INVALID', details: [{ code: 'NOT_AFTER_VALID_FROM' }] });
  });
});
