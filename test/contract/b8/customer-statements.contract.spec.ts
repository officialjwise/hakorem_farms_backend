import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The customer statement operations (B08 continued 2d, 2.6.0) answer in the contract's shapes: `CustomerStatement`,
 * `CustomerStatementPage` and their refusals in the error envelope.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
let tema: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  tema = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id;
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('B08 continued 2d statement operations answer in the contract shapes', () => {
  it('a statement produced, issued and as a draft, listed and read, and the refusals', async () => {
    const today = toBusinessDate(clock.now());
    const issued = await consolePost(api.server, sales, '/v1/statements').send({ customerId: tema, periodStart: addDays(today, -6), periodEnd: today, issue: true });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expectShape('CustomerStatement', issued.body);
    const draft = await consolePost(api.server, sales, '/v1/statements').send({ customerId: tema, periodStart: today, periodEnd: today, issue: false });
    expect(draft.status).toBe(201);
    expectShape('CustomerStatement', draft.body);
    const page = await consoleGet(api.server, sales, '/v1/statements');
    expect(page.status).toBe(200);
    expectShape('CustomerStatementPage', page.body);
    const read = await consoleGet(api.server, sales, `/v1/statements/${issued.body.id as string}`);
    expect(read.status).toBe(200);
    expectShape('CustomerStatement', read.body);
    const refused = await consolePost(api.server, sales, '/v1/statements').send({ customerId: tema, periodStart: today, periodEnd: addDays(today, 1), issue: true });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const missing = await consoleGet(api.server, sales, `/v1/statements/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expectShape('Error', missing.body);
  });
});
