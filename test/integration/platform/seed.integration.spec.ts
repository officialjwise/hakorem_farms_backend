import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedUnits } from '../../../src/seed/seed-units';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const password = `Seed-${randomUUID()}`;
let database: TestDatabase;
let api: TestApp;

async function runSeed(): Promise<number> {
  let records = 0;
  for (const unit of seedUnits({ SEED_STAFF_PASSWORD: password })) {
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      records += (await unit.run(client)).records;
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
  return records;
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
    expect(products.rows.map((row) => row.sku)).toEqual(['EGG-CRATE-BIG', 'LIV-GOAT', 'LIV-SHEEP', 'MEAT-CHICKEN-WINGS-15KG', 'MEAT-GOAT-15KG', 'PRD-YAM-TUBER']);
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
    expect(products.body.data).toHaveLength(6);
    const owner = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: 'kwabena.owusu@seed.hakoremfarms.invalid', password });
    expect(owner.body.status).toBe('TOTP_ENROLMENT_REQUIRED');
  });
});
