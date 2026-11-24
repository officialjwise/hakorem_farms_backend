import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AbandonedCarts } from '../../../src/modules/shp';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, signReport, type NtfHarness } from '../../support/ntf';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Abandoned-cart recovery (FR-SHP-015, ADR-0026's assignment, B11 continued 12, A-378): a cart a customer holds, with
 * lines, idle two hours and not checked out, gets at most one reminder, and only when the customer has given marketing
 * consent; it is a marketing message, so a STOP stops it and quiet hours delay it; it names nothing of what is in the
 * cart; a cart converted meanwhile, a guest's cart and a cart idle under two hours get none; the sweep run twice sends
 * one. The provider is a test double. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let manager: TestSession;
let branchId = '';
const ids = new Map<string, string>();
const admin = () => database.pool('admin');
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const count = async (sql: string, values: unknown[] = []) => Number((await one<{ n: string }>(sql, values)).n);
const HOUR = 3_600_000;
const BASE = 'https://shop.hakorem.test';
const WEBHOOK_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const sweep = () => runAsSystem({ principalId: SCHEDULER.principalId, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(AbandonedCarts).run(SCHEDULER));
const messageOf = (cartId: string) =>
  rows<{ status: string; body: string; reason: string | null; category: string; sendAfter: Date | null }>(
    `SELECT m.status, m.rendered_body AS body, m.suppressed_reason AS reason, m.category, m.send_after AS "sendAfter"
       FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE t.code = 'CART_REMINDER' AND m.idempotency_key LIKE '%:' || $1`,
    [cartId],
  );

/** A customer of Dodowa with their own number, with or without marketing consent. */
async function customer(name: string, phone: string, consent: boolean): Promise<string> {
  const made = await consolePost(api.server, manager, '/v1/customers', randomUUID()).send({ kind: 'INDIVIDUAL', name, phone, marketingConsent: consent });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.id as string;
}

/**
 * A cart of one crate of big eggs, held by the customer. The shop makes guest carts only so far (A-177, A-378): the cart
 * is made through the shop and given to its customer here, as a signed-in shopper's cart will be.
 */
async function cart(customerId: string | null): Promise<string> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const added = await request(api.server).post(`/v1/shop/carts/${cartId}/lines`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send({ productId: ids.get('EGG-0003'), quantity: '1.000' });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  // Last changed now on the application's clock: the shop stamps the database's own time (platform.touch_version), and
  // this file's clock runs at 10:00 Accra the next day, so the stamp is set here with the row triggers held for this one
  // statement.
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query('UPDATE shp.cart SET customer_id = $2, updated_at = $3 WHERE id = $1', [cartId, customerId, clock.now()]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  return cartId;
}

beforeAll(async () => {
  database = await createTestDatabase();
  // At 10:00 in Accra, outside quiet hours; the carts are made now and judged by the application's clock.
  const start = testStartTime();
  clock = new ManualClock(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1, 10, 0, 0)));
  await relaxRateLimits(database);
  await database.pool('app').query(
    `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
     VALUES ($1, 'rate_limit.public.per_address_1m', '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
    [randomUUID()],
  );
  api = await startTestApp(database, { clock, environment: { RECEIPT_LINK_BASE_URL: BASE, SMS_WEBHOOK_SECRET: WEBHOOK_SECRET, AUTH_ACCESS_TTL_SECONDS: '259200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '259200' } });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>("SELECT sku AS code, id FROM mdm.product WHERE sku = 'EGG-0003'")) ids.set(row.code, row.id);
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  const user = await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  manager = await enrolAndLogin(api.server, user, () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('abandoned carts: one reminder, only with consent, as marketing, naming nothing in the cart (FR-SHP-015)', () => {
  const sms = new FakeSms();
  const carts = new Map<string, string>();

  beforeAll(async () => {
    carts.set('akua', await cart(await customer('Akua Mensah', '0244100301', true)));
    carts.set('esi', await cart(await customer('Esi Badu', '0244100302', false)));
    carts.set('guest', await cart(null));
    carts.set('yaw', await cart(await customer('Yaw Darko', '0244100303', true)));
    carts.set('kofi', await cart(await customer('Kofi Agyei', '0244100304', true)));
  });

  it('a cart idle under two hours is not reminded; at two hours only the consenting customers\' carts are, once', async () => {
    clock.advanceBy(HOUR);
    expect(await sweep()).toEqual([]);
    clock.advanceBy(2 * HOUR);
    const reminded = await sweep();
    expect(new Set(reminded)).toEqual(new Set([carts.get('akua'), carts.get('yaw'), carts.get('kofi')]));
    expect(await sweep()).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM shp.abandoned_cart_notice')).toBe(3);
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'shp.CartAbandoned' AND subject_id = $1", [carts.get('akua')]);
    expect(Object.keys(event.payload).sort()).toEqual(['cartId', 'customerId', 'idleSince', 'noticeId']);
    expect(await one<{ status: string }>('SELECT status FROM shp.cart WHERE id = $1', [carts.get('akua')])).toEqual({ status: 'ACTIVE' });
  });

  it('is sent once to the customer\'s own number as marketing, with the shop\'s cart page and nothing of the cart', async () => {
    // Yaw replies STOP before the message is queued; Kofi's cart is checked out (no longer remindable) before it is sent.
    const body = JSON.stringify({ type: 'inbound', id: `mo-${randomUUID()}`, from: '+233244100303', text: 'STOP' });
    const stopped = await request(api.server).post('/v1/webhooks/messaging/GENERIC_HTTP').set('Content-Type', 'application/json').set('X-Provider-Signature', signReport(WEBHOOK_SECRET, body)).send(body);
    expect(stopped.status).toBe(200);
    await ntf.dispatch();
    await ntf.dispatch();
    await admin().query("UPDATE shp.cart SET status = 'CHECKOUT', version = version + 1 WHERE id = $1", [carts.get('kofi')]);
    expect(await messageOf(carts.get('akua')!)).toEqual([{ status: 'QUEUED', category: 'MARKETING', reason: null, sendAfter: null, body: 'HaKorem Farms: Akua, your cart is still saved. Finish your order here: {{link}} Reply STOP to stop these messages.' }]);
    expect(await messageOf(carts.get('yaw')!)).toEqual([expect.objectContaining({ status: 'SUPPRESSED', reason: 'OPTED_OUT' })]);
    expect(await messageOf(carts.get('esi')!)).toEqual([]);
    expect(await messageOf(carts.get('guest')!)).toEqual([]);
    const pass = await ntf.sender(sms).run(SCHEDULER);
    expect(pass.sent).toBe(1);
    expect(sms.calls.map((c) => [c.to, c.text])).toEqual([['+233244100301', `HaKorem Farms: Akua, your cart is still saved. Finish your order here: ${BASE}/cart Reply STOP to stop these messages.`]]);
    expect(sms.calls[0]!.text).not.toMatch(/egg|crate|GHS/i);
    expect(await messageOf(carts.get('kofi')!)).toEqual([expect.objectContaining({ status: 'SUPPRESSED', reason: 'NO_LINK' })]);
    await ntf.sender(sms).run(SCHEDULER);
    expect(sms.calls).toHaveLength(1);
  });

  it('consent is read again: withdrawn after the sweep, the reminder is not sent; a reminder due in quiet hours waits until 07:00', async () => {
    const ama = await customer('Ama Owusu', '0244100305', true);
    const amaCart = await cart(ama);
    const late = await customer('Abena Kyei', '0244100306', true);
    const lateCart = await cart(late);
    // 22:30 in Accra the next day: both carts are idle; the reminders are queued to wait out the quiet hours.
    const next = new Date(clock.now().getTime() + 24 * HOUR);
    clock.set(new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), 22, 30, 0)));
    expect(new Set(await sweep())).toEqual(new Set([amaCart, lateCart]));
    await ntf.dispatch();
    const [waiting] = await messageOf(lateCart);
    expect(waiting).toMatchObject({ status: 'DEFERRED_QUIET_HOURS' });
    expect(waiting!.sendAfter!.toISOString()).toBe(new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate() + 1, 7, 0, 0)).toISOString());
    await admin().query('UPDATE mdm.customer SET marketing_consent_at = NULL, version = version + 1 WHERE id = $1', [ama]);
    clock.set(waiting!.sendAfter!);
    const calls = sms.calls.length;
    await ntf.sender(sms).run(SCHEDULER);
    expect(await messageOf(amaCart)).toEqual([expect.objectContaining({ status: 'SUPPRESSED', reason: 'NO_CONSENT' })]);
    const raised = await rows<{ payload: { reason: string; templateCode: string; abuseCases: number[] } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'ntf.MessageSuppressed' AND payload->>'reason' = 'NO_CONSENT'");
    expect(raised.map((r) => [r.payload.templateCode, r.payload.abuseCases])).toEqual([['CART_REMINDER', [61]]]);
    expect(sms.calls.slice(calls).map((c) => c.to)).toEqual(['+233244100306']);
  });

  it('the database: one reminder per cart, only for a customer\'s cart, never changed', async () => {
    const notice = await one<{ id: string; cartId: string }>('SELECT id, cart_id AS "cartId" FROM shp.abandoned_cart_notice LIMIT 1');
    const insert = (cartId: string, sequence: number) =>
      database.pool('app').query('INSERT INTO shp.abandoned_cart_notice (id, cart_id, sequence_no, idle_since, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        randomUUID(), cartId, sequence, new Date(clock.now().getTime() - 3 * HOUR), clock.now(), SCHEDULER.principalId,
      ]);
    expect(await sqlStateOf(insert(notice.cartId, 1))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(insert(notice.cartId, 2))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insert(carts.get('guest')!, 1))).toBe('HK010');
    expect(await sqlStateOf(database.pool('app').query('UPDATE shp.abandoned_cart_notice SET idle_since = idle_since WHERE id = $1', [notice.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('DELETE FROM shp.abandoned_cart_notice WHERE id = $1', [notice.id]))).toBe(SQLSTATE.ledgerImmutable);
  });
});
