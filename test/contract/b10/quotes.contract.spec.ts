import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** QUO's operations and CR-041's reads (B10) answer in the shapes of contract/openapi.yaml 2.12.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
const ids = new Map<string, string>();
const post = (path: string, body: object) => consolePost(api.server, sales, `/v1${path}`).send(body);
const get = (path: string) => consoleGet(api.server, sales, `/v1${path}`);
const publicPost = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

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
  ids.set('caterers', (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE customer_no = 'C-00004'")).rows[0]!.id);
  ids.set('list', (await admin.query<{ id: string }>("SELECT id FROM mdm.price_list WHERE code = 'CATERERS-2026'")).rows[0]!.id);
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId: ids.get('branch')! }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the quote operations answer in the contract shapes', () => {
  it('a request, a quote, its versions, the issued version with its link, the public view, the decision and a closed link', async () => {
    const rfq = await post('/rfqs', { source: 'PHONE', contactName: 'Efua Asante', contactPhone: '+233201234567', requirements: 'Ten crates', productId: ids.get('eggs')!, quantity: '10.000', uom: 'CRATE' });
    expectShape('Rfq', rfq.body);
    expectShape('RfqPage', (await get('/rfqs')).body);
    const submitted = await publicPost('/shop/quote-requests', { contactName: 'Efua Asante', contactPhone: '+233201234567', requirements: 'Ten crates', consentToContact: true });
    expectShape('QuoteRequestReceived', submitted.body);
    const quote = await post('/quotes', {
      rfqId: rfq.body.id,
      contactName: 'Efua Asante',
      contactPhone: '+233201234567',
      validUntil: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString(),
      taxInclusive: true,
      lines: [{ productId: ids.get('eggs')!, description: 'Big eggs by the crate', quantity: '2.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }],
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    expectShape('Quote', quote.body);
    const issued = await post(`/quote-versions/${quote.body.currentVersion.id as string}/issue`, { channels: ['SMS'] });
    expectShape('QuoteVersion', issued.body);
    expectShape('QuoteVersionPage', (await get(`/quotes/${quote.body.id as string}/versions`)).body);
    expectShape('QuotePage', (await get('/quotes')).body);
    const token = issued.body.acceptanceLinkToken as string;
    expectShape('PublicQuote', (await request(api.server).get(`/v1/shop/quotes/${token}`)).body);
    const revised = await post(`/quotes/${quote.body.id as string}/versions`, { changeNote: 'A better price' });
    await post(`/quote-versions/${revised.body.id as string}/issue`, { channels: ['SMS'] });
    const closed = await request(api.server).get(`/v1/shop/quotes/${token}`);
    expect(closed.status).toBe(422);
    expectShape('Error', closed.body);
  });

  it("CR-041's reads", async () => {
    expectShape('PriceListAssignmentList', (await get(`/customers/${ids.get('caterers')!}/price-list`)).body);
  });
});
