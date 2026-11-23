import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** B10 continued 5: the pipeline, a quote issued subject to stock and its archived document answer in the shapes of 2.23.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
const ids = new Map<string, string>();
const post = (path: string, body: object) => consolePost(api.server, sales, `/v1${path}`).send(body);

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
  const admin = database.pool('admin');
  ids.set('branch', (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id);
  ids.set('eggs', (await admin.query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id);
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId: ids.get('branch')! }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the quote pipeline, subject to stock and the quote document (2.23.0)', () => {
  it('answers a version issued subject to stock, its public quote with documentUrl, and getQuotePipeline in their contract shapes', async () => {
    const quote = await post('/quotes', {
      contactName: 'Kofi Mensah',
      contactPhone: '+233244512876',
      validUntil: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString(),
      taxInclusive: true,
      lines: [{ productId: ids.get('eggs')!, description: 'Big eggs by the crate', quantity: '1000.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }],
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expectShape('Quote', quote.body);
    const issued = await post(`/quote-versions/${quote.body.currentVersion.id as string}/issue`, { channels: ['SMS'] });
    expect([issued.status, issued.body.subjectToStock]).toEqual([200, true]);
    expectShape('QuoteVersion', issued.body);
    await documentWorker(api, database, clock).settle();
    const shown = await request(api.server).get(`/v1/shop/quotes/${issued.body.acceptanceLinkToken as string}`);
    expect(shown.body.documentUrl).toEqual(expect.any(String));
    expectShape('PublicQuote', shown.body);
    const day = toBusinessDate(clock.now());
    const pipeline = await consoleGet(api.server, sales, `/v1/quotes/pipeline?from=${day}&to=${day}&groupBy=PRODUCT_LINE`);
    expect(pipeline.status, JSON.stringify(pipeline.body)).toBe(200);
    expectShape('QuotePipeline', pipeline.body);
    const refused = await consoleGet(api.server, sales, `/v1/quotes/pipeline?from=${day}&groupBy=SALESPERSON`);
    expect(refused.status).toBe(400);
    expectShape('Error', refused.body);
  });
});
