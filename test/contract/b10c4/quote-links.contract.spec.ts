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

/** B10 continued 4: the quote's links, their revoke, the buyer's own quotes and the decided public quote answer in the shapes of 2.21.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let sales: TestSession;
let buyer: TestSession;
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
  ids.set('customer', (await admin.query<{ id: string }>("SELECT id FROM mdm.customer WHERE customer_no = 'C-00002'")).rows[0]!.id);
  sales = await login(api.server, await createUser(database, { name: 'Esi Appiah', grants: [{ role: 'SALES', branchId: ids.get('branch')! }] }));
  const shopper = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  await admin.query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [shopper.principalId, ids.get('customer')]);
  buyer = await login(api.server, shopper);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the quote link and the buyer (2.21.0)', () => {
  it('answers issue, revoke, the decided public quote and listMyQuotes in their contract shapes', async () => {
    const quote = await post('/quotes', {
      customerId: ids.get('customer'),
      contactName: 'Abena Kyei',
      contactPhone: '+233244519034',
      validUntil: new Date(clock.now().getTime() + 7 * 86_400_000).toISOString(),
      taxInclusive: true,
      lines: [{ productId: ids.get('eggs')!, description: 'Big eggs by the crate', quantity: '1.000', uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: 6_000 }],
    });
    expect(quote.status, JSON.stringify(quote.body)).toBe(201);
    const versionId = quote.body.currentVersion.id as string;
    const first = await post(`/quote-versions/${versionId}/issue`, { channels: ['WHATSAPP'] });
    expectShape('QuoteVersion', first.body);
    const second = await post(`/quote-versions/${versionId}/issue`, { channels: [] });
    const revoked = await post(`/quote-links/${first.body.acceptanceLinkId as string}/revoke`, { reason: 'Sent to the wrong WhatsApp number' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expectShape('QuoteVersion', revoked.body);
    expectShape('QuoteLink', revoked.body.links[0]);
    const again = await post(`/quote-links/${first.body.acceptanceLinkId as string}/revoke`, { reason: 'Again' });
    expectShape('Error', again.body);
    const accepted = await request(api.server).post(`/v1/shop/quotes/${second.body.acceptanceLinkToken as string}/accept`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send({ acceptedName: 'Abena Kyei' });
    expectShape('QuoteDecision', accepted.body);
    expectShape('PublicQuote', (await request(api.server).get(`/v1/shop/quotes/${second.body.acceptanceLinkToken as string}`)).body);
    const mine = await consoleGet(api.server, buyer, '/v1/me/quotes');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expectShape('PublicQuotePage', mine.body);
    expect(mine.body.data[0]).toMatchObject({ status: 'ACCEPTED', acceptedName: 'Abena Kyei' });
  });
});
