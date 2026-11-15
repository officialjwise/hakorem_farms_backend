import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_PROMOTIONS } from '../../../src/seed/reference-pricing';
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
    expect(rows).toHaveLength(8);
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
    // B3's six products, and from B4 the rest of the reference catalogue.
    expect(products.rows.map((row) => row.sku)).toEqual(SEED_PRODUCTS.map((product) => product.sku).sort());
    expect(products.rows.map((row) => row.sku)).toEqual(expect.arrayContaining(['EGG-CRATE-BIG', 'LIV-GOAT', 'LIV-SHEEP', 'MEAT-CHICKEN-WINGS-15KG', 'MEAT-GOAT-15KG', 'PRD-YAM-TUBER']));
  });

  it('lets the seeded cashier log in with the generated password and see the catalogue', async () => {
    const login = await request(api.server)
      .post('/v1/auth/staff/login')
      .set('Origin', TEST_ORIGIN)
      .send({ identifier: 'adwoa.darko@seed.hakoremfarms.invalid', password, deviceLabel: 'Shop till tablet' });
    expect(login.status).toBe(200);
    expect(login.body.session.grants).toEqual([expect.objectContaining({ roleCode: 'CASHIER', branchCode: 'DDW', locationCode: 'SHOP' })]);
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const products = await request(api.server).get('/v1/products').set('Cookie', cookies);
    expect(products.body.data).toHaveLength(SEED_PRODUCTS.length);
    const owner = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: 'kwabena.owusu@seed.hakoremfarms.invalid', password });
    expect(owner.body.status).toBe('TOTP_ENROLMENT_REQUIRED');
  });
});

describe('the MDM seed through the services (A-085)', () => {
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
});
