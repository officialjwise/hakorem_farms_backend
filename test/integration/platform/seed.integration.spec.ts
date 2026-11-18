import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_BUSINESS_PROFILE, SEED_OFFLINE_SETTINGS } from '../../../src/seed/farm-aud';
import { SEED_FEED_PRODUCTS } from '../../../src/seed/farm-liv';
import { SEED_CUSTOMERS, SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_PROMOTIONS, SEED_SPECIES } from '../../../src/seed/reference-pricing';
import { SEED_PAYMENT_METHODS_ENABLED } from '../../../src/seed/farm-mdm';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const password = `Seed-${randomUUID()}`;
let database: TestDatabase;
let api: TestApp;

function runSeed(): Promise<number> {
  return runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: password }));
}

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the seeded farm (hakorem-seed)', () => {
  it('loads once, as hk_app, and a second run changes nothing', async () => {
    expect(await runSeed()).toBeGreaterThan(50);
    expect(await runSeed()).toBe(0);
  });

  it('marks every seeded person as seed: emails in .invalid, phones in the seed block', async () => {
    const { rows } = await database.pool('admin').query<{ email: string; phone_e164: string }>('SELECT email, phone_e164 FROM iam.user_account');
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.email).toMatch(/@seed\.hakoremfarms\.invalid$/);
      expect(row.phone_e164).toMatch(/^\+2332000001\d\d$/);
    }
  });

  it('has the farm branch and the test branch, each with every virtual location, and the catalogue basics', async () => {
    const admin = database.pool('admin');
    const branches = await admin.query<{ code: string; is_test: boolean }>('SELECT code, is_test FROM mdm.branch ORDER BY code');
    expect(branches.rows).toEqual([
      { code: 'DDW', is_test: false },
      { code: 'TST', is_test: true },
    ]);
    const virtual = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM mdm.location WHERE is_virtual');
    expect(virtual.rows[0]!.n).toBe(16);
    const products = await admin.query<{ sku: string }>('SELECT sku FROM mdm.product ORDER BY sku');
    // B3's six products, from B4 the rest of the reference catalogue, and from B06 continued 2 the store's feed and medicine.
    expect(products.rows.map((row) => row.sku)).toEqual([...SEED_PRODUCTS, ...SEED_FEED_PRODUCTS].map((product) => product.sku).sort());
    expect(products.rows.map((row) => row.sku)).toEqual(expect.arrayContaining(['EGG-0003', 'LIV-0004', 'LIV-0005', 'MEAT-0002', 'MEAT-0007', 'PRD-0005']));
  });

  it('lets the seeded cashier log in with the generated password and see the catalogue', async () => {
    const login = await request(api.server)
      .post('/v1/auth/staff/login')
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: 'adwoa.darko@seed.hakoremfarms.invalid', password, deviceLabel: 'Shop till tablet' });
    expect(login.status).toBe(200);
    expect(login.body.session.grants).toEqual([expect.objectContaining({ roleCode: 'CASHIER', branchCode: 'DDW', locationCode: 'SHOP' })]);
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const products = await request(api.server).get('/v1/products?limit=100').set('Cookie', cookies);
    expect(products.body.data).toHaveLength(SEED_PRODUCTS.length + SEED_FEED_PRODUCTS.length);
    const owner = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: 'kwabena.owusu@seed.hakoremfarms.invalid', password });
    expect(owner.body.status).toBe('TOTP_ENROLMENT_REQUIRED');
  });
});

describe('the MDM seed through the services (A-085)', () => {
  it('writes the catalogue as the seeded Manager: categories, species, grades, bands and products, each audited by the seed', async () => {
    const admin = database.pool('admin');
    const { rows } = await admin.query<{ entity_type: string; n: number; actors: string[]; agents: string[] }>(
      `SELECT e.entity_type, count(*)::int AS n, array_agg(DISTINCT p.display_name) AS actors, array_agg(DISTINCT e.user_agent) AS agents
         FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.action = 'CREATE' AND e.entity_type IN ('Category', 'Species', 'Grade', 'WeightBand', 'Product')
        GROUP BY e.entity_type ORDER BY e.entity_type`,
    );
    const bands = SEED_SPECIES.reduce((sum, species) => sum + species.bands.length, 0);
    const grades = SEED_SPECIES.reduce((sum, species) => sum + species.grades.length, 0);
    expect(rows).toEqual([
      // The reference catalogue's four, and the LIV seed's feed and medicine (B06 continued 2).
      { entity_type: 'Category', n: 5, actors: ['Akosua Boateng'], agents: ['hakorem-seed'] },
      { entity_type: 'Grade', n: grades, actors: ['Akosua Boateng'], agents: ['hakorem-seed'] },
      { entity_type: 'Product', n: SEED_PRODUCTS.length + SEED_FEED_PRODUCTS.length, actors: ['Akosua Boateng'], agents: ['hakorem-seed'] },
      { entity_type: 'Species', n: 7, actors: ['Akosua Boateng'], agents: ['hakorem-seed'] },
      { entity_type: 'WeightBand', n: bands, actors: ['Akosua Boateng'], agents: ['hakorem-seed'] },
    ]);
    const tracking = await admin.query<{ sku: string; tracking: string }>("SELECT sku, tracking FROM mdm.product WHERE sku IN ('LIV-0001', 'LIV-0004', 'EGG-0003', 'PRD-0005') ORDER BY sku");
    expect(tracking.rows).toEqual([
      { sku: 'EGG-0003', tracking: 'LOT' },
      { sku: 'LIV-0001', tracking: 'LOT' },
      { sku: 'LIV-0004', tracking: 'SERIAL' },
      { sku: 'PRD-0005', tracking: 'NONE' },
    ]);
  });

  it('has tax scheme version 1 active, drafted by the seeded Accountant and approved by the seeded Owner', async () => {
    const admin = database.pool('admin');
    const { rows } = await admin.query<{ version_no: number; status: string; maker: string; checker: string; cells: number }>(
      `SELECT v.version_no, v.status, m.display_name AS maker, c.display_name AS checker,
              (SELECT count(*)::int FROM mdm.tax_category_levy l WHERE l.version_id = v.id) AS cells
         FROM mdm.tax_scheme_version v
         JOIN iam.approval_request a ON a.id = v.approval_request_id
         JOIN iam.principal m ON m.id = a.requested_by
         JOIN iam.principal c ON c.id = a.decided_by`,
    );
    expect(rows).toEqual([{ version_no: 1, status: 'ACTIVE', maker: 'Yaw Agyeman', checker: 'Kwabena Owusu', cells: 21 }]);
    const audit = await admin.query<{ user_agent: string | null }>("SELECT DISTINCT user_agent FROM platform.audit_event WHERE entity_type = 'TaxSchemeVersion'");
    expect(audit.rows).toEqual([{ user_agent: 'hakorem-seed' }]);
  });

  it('answers calculateTax for the seeded cashier: VAT 1,500, NHIL 250 and GETFund 250 on a meat net of 10,000, a goat zero-rated', async () => {
    const login = await request(api.server)
      .post('/v1/auth/staff/login')
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: 'adwoa.darko@seed.hakoremfarms.invalid', password, deviceLabel: 'Shop till tablet' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const result = await request(api.server)
      .post('/v1/tax/calculate')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', cookies)
      .set('X-CSRF-Token', login.body.session.csrfToken)
      .set('Idempotency-Key', randomUUID())
      .send({
        taxInclusive: false,
        taxDate: new Date().toISOString().slice(0, 10),
        lines: [
          { lineRef: 'meat', taxCategoryId: '01900000-0000-7000-8000-000000000204', amountPesewas: 10_000 },
          { lineRef: 'goat', taxCategoryId: '01900000-0000-7000-8000-000000000201', amountPesewas: 65_000 },
        ],
      });
    expect(result.status).toBe(200);
    expect(result.body.lines[0].levies.map((levy: { amountPesewas: number }) => levy.amountPesewas)).toEqual([1_500, 250, 250]);
    expect(result.body.lines[0].grossPesewas).toBe(12_000);
    expect(result.body.lines[1].levies.map((levy: { treatment: string; amountPesewas: number }) => [levy.treatment, levy.amountPesewas])).toEqual([
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
      ['ZERO_RATED', 0],
    ]);
  });

  it('has every price list active on version 1, drafted by the seeded Manager and approved by the seeded Owner', async () => {
    const { rows } = await database.pool('admin').query<{ code: string; status: string; maker: string; checker: string }>(
      `SELECT l.code, v.status, m.display_name AS maker, c.display_name AS checker
         FROM mdm.price_list l
         JOIN mdm.price_list_version v ON v.price_list_id = l.id
         JOIN iam.approval_request a ON a.id = v.approval_request_id
         JOIN iam.principal m ON m.id = a.requested_by
         JOIN iam.principal c ON c.id = a.decided_by
        ORDER BY l.code`,
    );
    expect(rows.map((row) => row.code)).toEqual(SEED_PRICE_LISTS.map((list) => list.code).sort());
    expect(new Set(rows.map((row) => `${row.status} ${row.maker} ${row.checker}`))).toEqual(new Set(['ACTIVE Akosua Boateng Kwabena Owusu']));
  });

  it('has the seeded promotions active, each with its coupon, and the caterer on the contract list', async () => {
    const admin = database.pool('admin');
    const promotions = await admin.query<{ code: string; status: string; coupon: string; max_uses: number }>(
      'SELECT p.code, p.status, c.code AS coupon, c.max_uses FROM mdm.promotion p JOIN mdm.coupon c ON c.promotion_id = p.id ORDER BY p.code',
    );
    expect(promotions.rows).toEqual(
      SEED_PROMOTIONS.map((promotion) => ({ code: promotion.code, status: 'ACTIVE', coupon: promotion.coupon!.code, max_uses: promotion.coupon!.maxUses })).sort((a, b) => (a.code < b.code ? -1 : 1)),
    );
    const assigned = await admin.query<{ customer_no: string; code: string }>(
      'SELECT c.customer_no, l.code FROM mdm.customer_price_list a JOIN mdm.customer c ON c.id = a.customer_id JOIN mdm.price_list l ON l.id = a.price_list_id WHERE a.deleted_at IS NULL',
    );
    expect(assigned.rows).toEqual([{ customer_no: 'C-00004', code: 'CATERERS-2026' }]);
  });

  it("assigns the caterer's list through assignCustomerPriceList as the seeded Manager", async () => {
    const { rows } = await database.pool('admin').query<{ actor: string; user_agent: string; n: number }>(
      `SELECT p.display_name AS actor, e.user_agent, count(*)::int AS n FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.action = 'ASSIGN_PRICE_LIST' GROUP BY 1, 2`,
    );
    expect(rows).toEqual([{ actor: 'Akosua Boateng', user_agent: 'hakorem-seed', n: 1 }]);
  });
});

describe('payment methods and the delivery zone through the services (A-085, A-115)', () => {
  it('the seeded Owner turned on the five methods the farm takes, and cheques and store credit stay off', async () => {
    const admin = database.pool('admin');
    const methods = await admin.query<{ code: string; is_enabled: boolean }>('SELECT code, is_enabled FROM mdm.payment_method ORDER BY code');
    expect(methods.rows.filter((row) => row.is_enabled).map((row) => row.code)).toEqual([...SEED_PAYMENT_METHODS_ENABLED].sort());
    const { rows } = await admin.query<{ actor: string; n: number; agents: string[] }>(
      `SELECT p.display_name AS actor, count(*)::int AS n, array_agg(DISTINCT e.user_agent) AS agents
         FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.entity_type = 'PaymentMethod' GROUP BY 1`,
    );
    expect(rows).toEqual([{ actor: 'Kwabena Owusu', n: SEED_PAYMENT_METHODS_ENABLED.length, agents: ['hakorem-seed'] }]);
  });

  it('the seeded Manager created the Dodowa zone at exactly 1,500 pesewas before the customers, so the Dodowa address is in it', async () => {
    const admin = database.pool('admin');
    const zone = await admin.query<{ code: string; fee: string; free_over: string; actor: string; agent: string }>(
      `SELECT z.code, z.fee_pesewas::text AS fee, z.free_over_pesewas::text AS free_over, p.display_name AS actor, e.user_agent AS agent
         FROM mdm.delivery_zone z JOIN platform.audit_event e ON e.entity_id = z.id AND e.action = 'CREATE' JOIN iam.principal p ON p.id = e.actor_id`,
    );
    expect(zone.rows).toEqual([{ code: 'DODOWA', fee: '1500', free_over: '50000', actor: 'Akosua Boateng', agent: 'hakorem-seed' }]);
    const addresses = await admin.query<{ area: string; zoned: boolean }>('SELECT area, delivery_zone_id IS NOT NULL AS zoned FROM mdm.customer_address ORDER BY area');
    expect(addresses.rows).toEqual([
      { area: 'Dodowa', zoned: true },
      { area: 'Spintex', zoned: false },
    ]);
  });
});

describe('branches, locations and customers through the services (A-085, ADR-0042)', () => {
  it('bootstraps Dodowa as the System, the Owner creates the test branch, the Manager creates the locations and customers, all audited by the seed', async () => {
    const { rows } = await database.pool('admin').query<{ entity_type: string; actor: string; n: number; agents: string[] }>(
      `SELECT e.entity_type, p.display_name AS actor, count(*)::int AS n, array_agg(DISTINCT e.user_agent) AS agents
         FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.action = 'CREATE' AND e.entity_type IN ('Branch', 'Location', 'Customer', 'CustomerAddress')
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const addresses = SEED_CUSTOMERS.filter((customer) => customer.address !== null).length;
    expect(rows).toEqual([
      { entity_type: 'Branch', actor: 'Kwabena Owusu', n: 1, agents: ['hakorem-seed'] },
      { entity_type: 'Branch', actor: 'System', n: 1, agents: ['hakorem-seed'] },
      { entity_type: 'Customer', actor: 'Akosua Boateng', n: SEED_CUSTOMERS.length, agents: ['hakorem-seed'] },
      { entity_type: 'CustomerAddress', actor: 'Akosua Boateng', n: addresses, agents: ['hakorem-seed'] },
      // Dodowa's seven, and the feed and medicine store the LIV seed adds (B06 continued 2).
      { entity_type: 'Location', actor: 'Akosua Boateng', n: 8, agents: ['hakorem-seed'] },
    ]);
  });

  it('stores the customers in their tiers with numbers in order and phones normalised from the local form', async () => {
    const { rows } = await database.pool('admin').query<{ customer_no: string; name: string; phone_e164: string; tier: string }>(
      'SELECT c.customer_no, c.name, c.phone_e164, t.code AS tier FROM mdm.customer c JOIN mdm.customer_tier t ON t.id = c.tier_id ORDER BY c.customer_no',
    );
    expect(rows).toEqual(
      SEED_CUSTOMERS.map((customer) => ({ customer_no: customer.customerNo, name: customer.name, phone_e164: `+233${customer.phone.replace(/\s/g, '').slice(1)}`, tier: customer.tier })),
    );
  });

  it('gives the location-scoped staff their grants once the locations exist, and keeps the cold room frozen with its range', async () => {
    const admin = database.pool('admin');
    const grants = await admin.query<{ email: string; location: string }>(
      `SELECT u.email, l.code AS location FROM iam.role_grant g JOIN iam.user_account u ON u.principal_id = g.principal_id
         JOIN mdm.location l ON l.id = g.location_id ORDER BY u.email`,
    );
    expect(grants.rows).toEqual([
      { email: 'abdul.iddrisu@seed.hakoremfarms.invalid', location: 'PENS' },
      { email: 'adwoa.darko@seed.hakoremfarms.invalid', location: 'SHOP' },
      { email: 'kofi.mensah@seed.hakoremfarms.invalid', location: 'COLD' },
    ]);
    const cold = await admin.query("SELECT temp_class, temp_min_c::text AS min, temp_max_c::text AS max FROM mdm.location WHERE code = 'COLD'");
    expect(cold.rows).toEqual([{ temp_class: 'FROZEN', min: '-25.0', max: '-18.0' }]);
  });

  it('writes no MDM row as SQL: no seed source inserts into or updates an mdm table', () => {
    const directory = join(__dirname, '../../../src/seed');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join(directory, file), 'utf8'), file).not.toMatch(/(INSERT\s+INTO|UPDATE)\s+mdm\./i);
    }
  });
});

describe('the staff and their grants through the IAM services (A-085, ADR-0043)', () => {
  it('bootstraps the Owner as the System, and the Owner creates every other account, each audited by the seed', async () => {
    const { rows } = await database.pool('admin').query<{ actor: string; n: number; agents: string[] }>(
      `SELECT p.display_name AS actor, count(*)::int AS n, array_agg(DISTINCT e.user_agent) AS agents
         FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.action = 'CREATE' AND e.entity_type = 'UserAccount' GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual([
      { actor: 'Kwabena Owusu', n: 8, agents: ['hakorem-seed'] },
      { actor: 'System', n: 1, agents: ['hakorem-seed'] },
    ]);
  });

  it('grants every role through createGrant: the Owner grant by the System, the other eight (and the second Manager, B10 continued) by the Owner, each a PERMISSION_CHANGE', async () => {
    const { rows } = await database.pool('admin').query<{ actor: string; n: number; agents: string[] }>(
      `SELECT p.display_name AS actor, count(*)::int AS n, array_agg(DISTINCT e.user_agent) AS agents
         FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.action = 'PERMISSION_CHANGE' AND e.entity_type = 'RoleGrant' GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual([
      { actor: 'Kwabena Owusu', n: 8, agents: ['hakorem-seed'] },
      { actor: 'System', n: 1, agents: ['hakorem-seed'] },
    ]);
    const events = await database.pool('admin').query<{ n: number }>("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'iam.RoleGranted'");
    expect(events.rows[0]!.n).toBe(9);
  });

  it('sets each seeded password through the first sign-in: no account still needs a change, and each changed it on a login challenge', async () => {
    const admin = database.pool('admin');
    const accounts = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM iam.user_account WHERE must_change_password');
    expect(accounts.rows[0]!.n).toBe(0);
    const changes = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'PASSWORD_CHANGE' AND user_agent = 'hakorem-seed' AND (metadata->>'viaLoginChallenge')::boolean",
    );
    expect(changes.rows[0]!.n).toBe(9);
  });

  it('writes no IAM row as SQL, and no seed unit is a SQL unit any more', () => {
    const directory = join(__dirname, '../../../src/seed');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join(directory, file), 'utf8'), file).not.toMatch(/(INSERT\s+INTO|UPDATE)\s+(iam|mdm)\./i);
    }
    expect(seedUnits({ SEED_STAFF_PASSWORD: password }).map((unit) => unit.kind)).toEqual(Array.from({ length: 20 }, () => 'SERVICE'));
  });
});

describe('the offline till settings through AUD (OFFLINE_SYNC 5.2, B09b continued 2, A-277 (b))', () => {
  it('sets each once, farm-wide at its documented default, by the seeded Owner through SettingsAdmin, audited by the seed', async () => {
    const admin = database.pool('admin');
    const rows = (await admin.query<{ key: string; value: unknown; branch_id: string | null; value_type: string }>('SELECT key, value, branch_id, value_type FROM platform.setting WHERE key = ANY($1::text[]) ORDER BY key', [SEED_OFFLINE_SETTINGS.map((x) => x.key)])).rows;
    expect(rows).toEqual([
      { key: 'pay.unverified_window_days', value: 3, branch_id: null, value_type: 'INTEGER' },
      { key: 'pos.offline.allow_unverified_mobile_money', value: false, branch_id: null, value_type: 'BOOLEAN' },
      { key: 'pos.offline.max_hours', value: 8, branch_id: null, value_type: 'INTEGER' },
      { key: 'pos.offline.max_queued_sales', value: 500, branch_id: null, value_type: 'INTEGER' },
      { key: 'sync.clock_tolerance_seconds', value: 300, branch_id: null, value_type: 'INTEGER' },
    ]);
    const audits = await admin.query<{ actor: string; agent: string; n: number }>(
      `SELECT p.display_name AS actor, e.user_agent AS agent, count(*)::int AS n FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.entity_type = 'Setting' AND e.action = 'UPDATE' AND position(convert_to('pos.offline', 'UTF8') IN e."after") + position(convert_to('sync.clock', 'UTF8') IN e."after") + position(convert_to('pay.unverified', 'UTF8') IN e."after") > 0
        GROUP BY 1, 2`,
    );
    expect(audits.rows).toEqual([{ actor: 'Kwabena Owusu', agent: 'hakorem-seed', n: 5 }]);
  });
});

describe('the business profile through AUD (FR-AUD-008, CR-028)', () => {
  it('is set once by the seeded Owner through BusinessProfiles, audited by the seed, with invented numbers from the seed block', async () => {
    const admin = database.pool('admin');
    const rows = (await admin.query<{ version: number; value: Record<string, unknown> }>("SELECT version, value FROM platform.setting WHERE key = 'aud.business_profile'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.value).toMatchObject({ phone: SEED_BUSINESS_PROFILE.phone, whatsapp: SEED_BUSINESS_PROFILE.whatsapp, tin: 'C0000000001', vatNumber: null });
    expect(rows[0]!.value['phone']).toMatch(/^\+2332000001\d\d$/);
    expect(rows[0]!.value['whatsapp']).toMatch(/^\+2332000001\d\d$/);
    expect(rows[0]!.value['email']).toMatch(/@seed\.hakoremfarms\.invalid$/);
    for (const text of ['legalName', 'tradingName', 'address', 'directions']) expect(rows[0]!.value[text], text).toMatch(/\(SEED\)/);
    const audits = await admin.query<{ actor: string; agent: string }>(
      `SELECT p.display_name AS actor, e.user_agent AS agent FROM platform.audit_event e JOIN iam.principal p ON p.id = e.actor_id
        WHERE e.entity_type = 'BusinessProfile' AND e.action = 'UPDATE'`,
    );
    expect(audits.rows).toEqual([{ actor: 'Kwabena Owusu', agent: 'hakorem-seed' }]);
  });

  it('answers the shop with the seeded contact details only', async () => {
    const shop = await request(api.server).get('/v1/shop/profile');
    expect(shop.status).toBe(200);
    expect(shop.body).toEqual({
      tradingName: SEED_BUSINESS_PROFILE.tradingName,
      phone: '+233200000120',
      whatsapp: '+233200000121',
      address: SEED_BUSINESS_PROFILE.address,
      directions: SEED_BUSINESS_PROFILE.directions,
      openingHours: SEED_BUSINESS_PROFILE.openingHours,
    });
  });
});
