import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationExpiry } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { PaystackPaymentProvider } from '../../../src/platform/payments/payment-provider';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { paystackEnvironment, startFakePaystack, type FakePaystack, type FakeTransaction } from '../../support/fake-paystack';
import { consolePost, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { deliverWebhook, journalCount, journalOf, referenceFor, runRefundDispatch, runSweep, trialBalanceSum } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Card as an online payment (B09c, FR-SHP-005, FR-PAY-003 to FR-PAY-008, FR-PAY-012, FR-PAY-013, A-287), over the
 * seeded farm against the local Paystack fake, which answers as Paystack's test mode did on 2026-11-23. A guest places a
 * checkout by card: the payment is written PENDING with our reference before Paystack hears of it, and once the
 * transaction has committed Paystack's hosted page is opened (channels card only) and handed back. No card number,
 * expiry or security code reaches the server: the card is typed into Paystack's page; the only card detail this system
 * ever receives is what Paystack's webhook carries, and none of it is kept. Every edge case B09a continued proved for
 * mobile money is proved here for the card. Figures: big eggs 6,000 a crate online, so two crates are 12,000.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const SCHEDULER = '01900000-0000-7000-8000-000000000004';
const CALLBACK = 'https://hakoremfarms.com/checkout/card-return';
const PAGE = /^https:\/\/checkout\.paystack\.com\/[A-Za-z0-9]{6,64}$/;

interface Guest {
  readonly cartId: string;
  readonly cookie: string;
}

const collection = { contactName: 'Ama Serwaa Ofori', contactPhone: '+233244512876', fulfilmentMode: 'COLLECTION', paymentTerms: 'PREPAID' };
const card = { paymentMethod: 'CARD' };

const write = (method: 'post' | 'put', path: string, guest: Guest | null, body?: object, key: string = randomUUID()) => {
  const req = request(api.server)[method](`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key);
  if (guest !== null) req.set('Cookie', guest.cookie);
  return body === undefined ? req : req.send(body);
};
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);

async function newCart(): Promise<Guest> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  expect(created.status).toBe(201);
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!;
  return { cartId: created.body.id as string, cookie: cookie.split(';')[0]! };
}

async function atCheckout(crates = '2', body: object = collection): Promise<{ guest: Guest; checkoutId: string }> {
  const guest = await newCart();
  expect((await write('post', `/shop/carts/${guest.cartId}/lines`, guest, { productId: id('EGG-0003'), quantity: `${crates}.000` })).status).toBe(200);
  const started = await write('post', `/shop/carts/${guest.cartId}/checkout`, guest, body);
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  return { guest, checkoutId: started.body.id as string };
}

const place = (guest: Guest | null, checkoutId: string, body: object = card, key: string = randomUUID()) => write('post', `/shop/checkouts/${checkoutId}/place`, guest, body, key);
const expire = () => runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(ReservationExpiry).run({ kind: 'SYSTEM', principalId: SCHEDULER }));

/** A card order placed, its page open: the order, the payment, its reference. */
async function placedByCard(crates = '2'): Promise<{ orderId: string; paymentId: string; reference: string; redirectUrl: string; checkoutId: string }> {
  const { guest, checkoutId } = await atCheckout(crates);
  const placed = await place(guest, checkoutId);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const paymentId = placed.body.payment.paymentId as string;
  return { orderId: placed.body.orderId as string, paymentId, reference: referenceFor(paymentId), redirectUrl: placed.body.payment.redirectUrl as string, checkoutId };
}

const paymentRow = async (paymentId: string) =>
  (await admin().query<{ status: string; amount: number; method: string; verification: string; phone: string | null }>('SELECT status, amount_pesewas::int AS amount, method_kind AS method, verification, payer_phone_masked AS phone FROM pay.payment WHERE id = $1', [paymentId])).rows[0]!;
const chargeRow = async (paymentId: string) =>
  (await admin().query<{ status: string; channel: string; network: string | null; requested: number; page_url: string | null; released: boolean }>('SELECT status, channel, network, requested_pesewas::int AS requested, page_url, released_at IS NOT NULL AS released FROM pay.provider_transaction WHERE payment_id = $1', [paymentId])).rows[0]!;
const orderStatus = async (orderId: string) => (await admin().query<{ status: string; cancel_reason_code: string | null }>('SELECT status, cancel_reason_code FROM ord.sales_order WHERE id = $1', [orderId])).rows[0]!;
const breaksOf = async (paymentId: string) => (await admin().query<{ kind: string; amount: number | null }>('SELECT kind, amount_pesewas::int AS amount FROM pay.reconciliation_break WHERE payment_id = $1 ORDER BY raised_at, id', [paymentId])).rows;
const webhookOutcomes = async (reference: string) => (await admin().query<{ outcome: string }>('SELECT outcome FROM pay.webhook_event WHERE reference = $1 ORDER BY received_at, id', [reference])).rows.map((r) => r.outcome);
const initialisedFor = (reference: string) => fake.initialised.filter((b) => b['reference'] === reference);

/** The customer pays on the hosted page and Paystack sends its signed webhook. */
async function payOnPage(reference: string, options: { amount?: number; currency?: string; webhookAmount?: number } = {}): Promise<{ status: number; transaction: FakeTransaction }> {
  clock.advanceBy(1_000);
  const t = fake.payCard(reference, { ...(options.amount === undefined ? {} : { amount: options.amount }), ...(options.currency === undefined ? {} : { currency: options.currency }) });
  const response = await deliverWebhook(api.server, fake.webhook(t, options.webhookAmount === undefined ? {} : { amount: options.webhookAmount }));
  return { status: response.status, transaction: t };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', $3, $3)`,
      [randomUUID(), key, SYSTEM_PRINCIPAL],
    );
  }
  fake = await startFakePaystack(() => clock.now());
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), PAYSTACK_CARD_CALLBACK_URL: CALLBACK, AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await admin().query<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')).rows) ids.set(row.code, row.id);
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [who, name, role] of [
    ['manager', 'Akosua Boateng', 'MANAGER'],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT'],
  ] as const) {
    sessions.set(who, await enrolAndLogin(api.server, await createUser(database, { name, grants: [{ role, branchId }] }), () => clock.now()));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('the adapter carries pesewas both ways: GH₵55.00 is 5,500 (A-287 (e))', () => {
  it('opens a card page for 5,500 and reads the paid card back as exactly 5,500 pesewas in cedis', async () => {
    const provider = new PaystackPaymentProvider({ baseUrl: fake.url, secretKey: fake.secretKey, timeoutMs: 1_000 });
    const reference = `HK-${randomUUID()}`;
    const page = await provider.initiate({ reference, amountPesewas: 5_500n, email: 'payments@example.com', channels: ['card'] });
    expect(page.authorizationUrl).toMatch(PAGE);
    expect(initialisedFor(reference)).toEqual([{ reference, amount: '5500', currency: 'GHS', email: 'payments@example.com', channels: ['card'] }]);
    expect(await provider.lookup(reference)).toMatchObject({ status: 'ABANDONED', amountPesewas: 5_500n, currency: 'GHS' });
    fake.payCard(reference);
    expect(await provider.lookup(reference)).toMatchObject({ status: 'SUCCESS', amountPesewas: 5_500n, currency: 'GHS' });
  });
});

describe('placeOrder by card opens Paystack’s hosted page after the order commits (FR-SHP-005, FR-PAY-003)', () => {
  let guest: Guest;
  let checkoutId: string;
  let key: string;
  let placed: request.Response;

  beforeAll(async () => {
    ({ guest, checkoutId } = await atCheckout());
    key = randomUUID();
    placed = await place(guest, checkoutId, card, key);
  });

  it('answers 201 with the order and the card page on Paystack’s checkout host', () => {
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    expect(placed.body.payment).toMatchObject({ status: 'PENDING', redirectUrl: expect.stringMatching(PAGE) });
    expect(placed.body.checkout).toMatchObject({ status: 'AWAITING_PAYMENT', estimatedTotalPesewas: 12_000 });
  });

  it('writes the card payment PENDING for exactly the order’s estimate, with no phone, and the page’s address on its charge', async () => {
    const paymentId = placed.body.payment.paymentId as string;
    expect(await paymentRow(paymentId)).toEqual({ status: 'PENDING', amount: 12_000, method: 'CARD', verification: 'UNVERIFIED', phone: null });
    expect(await chargeRow(paymentId)).toEqual({ status: 'PENDING', channel: 'CARD', network: null, requested: 12_000, page_url: placed.body.payment.redirectUrl, released: false });
  });

  it('opens the page once, for the server’s amount in GHS, channels card only, the farm’s mailbox and the configured return address', () => {
    const reference = referenceFor(placed.body.payment.paymentId as string);
    expect(initialisedFor(reference)).toEqual([{ reference, amount: '12000', currency: 'GHS', email: 'payments@example.com', channels: ['card'], callback_url: CALLBACK }]);
  });

  it('answers a replay with the same page and opens no second one', async () => {
    const opened = fake.initialised.length;
    const again = await place(guest, checkoutId, card, key);
    expect([again.status, again.body.orderId, again.body.payment.paymentId, again.body.payment.redirectUrl]).toEqual([201, placed.body.orderId, placed.body.payment.paymentId, placed.body.payment.redirectUrl]);
    expect(fake.initialised.length).toBe(opened);
  });

  it('refuses a card number, or any field the request does not name, before anything is placed (no card data reaches the server)', async () => {
    const { guest: other, checkoutId: open } = await atCheckout('1');
    const refused = await place(other, open, { paymentMethod: 'CARD', cardNumber: '0000000000000000', cvv: '000', expiry: '12/30' });
    expect(refused.status).toBe(400);
    expect((await admin().query('SELECT 1 FROM ord.sales_order WHERE source_document_id = $1', [open])).rows).toEqual([]);
  });

  it('refuses a card on cash-on-delivery terms (the method must be the checkout’s terms), placing nothing', async () => {
    const dodowa = { recipientName: 'Kofi Boateng', recipientPhone: '0201234567', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
    const { guest: cod, checkoutId: codCheckout } = await atCheckout('1', { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
    const refused = await place(cod, codCheckout);
    expect([refused.status, refused.body.error.details[0].code]).toEqual([422, 'PAYMENT_METHOD_MISMATCH']);
    expect((await admin().query('SELECT 1 FROM ord.sales_order WHERE source_document_id = $1', [codCheckout])).rows).toEqual([]);
  });

  it('waits while the page is open: Paystack answers an unpaid page as abandoned, and the sweep changes nothing', async () => {
    const paymentId = placed.body.payment.paymentId as string;
    clock.advanceBy(31_000);
    await runSweep(api);
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
    expect((await chargeRow(paymentId)).status).toBe('PENDING');
    expect(await orderStatus(placed.body.orderId as string)).toMatchObject({ status: 'PLACED' });
  });

  it('confirms the order once the card is paid on the page: the webhook’s lookup clears it once, Dr 1120 Cr 2200', async () => {
    const paymentId = placed.body.payment.paymentId as string;
    const reference = referenceFor(paymentId);
    const { status, transaction } = await payOnPage(reference);
    expect(status).toBe(200);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'CLEARED', verification: 'PROVIDER_CALLBACK' });
    expect(await journalOf(database, paymentId, 'pay.PaymentCleared')).toEqual([
      ['1120', 'D', 12_000, 'Paystack'],
      ['2200', 'C', 12_000, expect.any(String)],
    ]);
    expect(await orderStatus(placed.body.orderId as string)).toMatchObject({ status: 'CONFIRMED' });
    // The same event delivered again is a no-op answered 200; a later sweep changes nothing either.
    expect((await deliverWebhook(api.server, fake.webhook(transaction))).status).toBe(200);
    clock.advanceBy(31_000);
    await runSweep(api);
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
    expect(await webhookOutcomes(reference)).toEqual(['ACCEPTED', 'REPLAYED']);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('keeps none of the card’s details Paystack’s webhook carried: not in the webhook log, an event, the audit, an answer or a log line', async () => {
    const reference = referenceFor(placed.body.payment.paymentId as string);
    const body = JSON.parse(fake.webhook(fake.transactions.get(reference)!).body) as { data: { authorization: Record<string, string> } };
    // The long made-up values must appear nowhere; the short ones (bin, last four) by their names, which nothing else uses.
    const values = ['authorization_code', 'signature', 'account_name'].map((k) => body.data.authorization[k]!);
    expect(values.every((v) => v.length >= 12)).toBe(true);
    const names = ['"bin"', '"last4"', '"exp_month"', '"exp_year"', '"authorization"', '"authorization_code"', '"card_type"', '"account_name"'];
    const tables = [
      'SELECT payload::text AS t FROM pay.webhook_event',
      'SELECT payload::text AS t FROM platform.outbox_message',
      'SELECT response_body::text AS t FROM platform.idempotency_key',
      'SELECT to_jsonb(p)::text AS t FROM pay.payment p',
      'SELECT to_jsonb(c)::text AS t FROM pay.provider_transaction c',
    ];
    for (const sql of tables) {
      const text = (await admin().query<{ t: string | null }>(sql)).rows.map((r) => r.t ?? '').join('\n');
      for (const secret of [...values, ...names, 'payments@farm.example']) expect(text.includes(secret), `${sql} holds ${secret}`).toBe(false);
    }
    for (const secret of [...values, ...names, 'payments@farm.example']) {
      const audit = await admin().query(
        `SELECT 1 FROM platform.audit_event WHERE position(convert_to($1, 'UTF8') IN coalesce("after", ''::bytea) || coalesce("before", ''::bytea) || convert_to(coalesce(metadata::text, ''), 'UTF8')) > 0`,
        [secret],
      );
      expect(audit.rows, `the audit holds ${secret}`).toEqual([]);
    }
    const logs = JSON.stringify(api.logLines());
    for (const secret of [...values, 'payments@farm.example']) expect(logs.includes(secret), `a log line holds ${secret}`).toBe(false);
  });
});

describe('the card page could not be opened after the order committed (A-287 (d))', () => {
  it('leaves the order and payment PENDING with 503 when Paystack is down, and a replay opens the page under the same reference', async () => {
    const { guest, checkoutId } = await atCheckout('1');
    const key = randomUUID();
    fake.pageBehaviour = { delayMs: 0, down: true };
    const failed = await place(guest, checkoutId, card, key);
    fake.pageBehaviour = { delayMs: 0 };
    expect([failed.status, failed.body.error?.code]).toEqual([503, 'PAYMENT_PROVIDER_UNAVAILABLE']);
    const order = (await admin().query<{ id: string; status: string }>('SELECT id, status FROM ord.sales_order WHERE source_document_id = $1', [checkoutId])).rows[0]!;
    expect(order.status).toBe('PLACED');
    const paymentId = (await admin().query<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [order.id])).rows[0]!.id;
    expect(await chargeRow(paymentId)).toMatchObject({ status: 'INITIATED', page_url: null });
    const replay = await place(guest, checkoutId, card, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.payment).toMatchObject({ paymentId, status: 'PENDING', redirectUrl: expect.stringMatching(PAGE) });
    expect(new Set(fake.initialised.filter((b) => String(b['reference']).startsWith('HK-') && b['reference'] === referenceFor(paymentId)).map((b) => b['reference'])).size).toBe(1);
    expect(await chargeRow(paymentId)).toMatchObject({ status: 'PENDING', page_url: replay.body.payment.redirectUrl });
  });

  it('times out after Paystack opened the page: a replay never opens a second page under a new reference, and the pending payment expires with its window', async () => {
    const { guest, checkoutId } = await atCheckout('1');
    const key = randomUUID();
    fake.pageBehaviour = { delayMs: 1_500 };
    const lost = await place(guest, checkoutId, card, key);
    fake.pageBehaviour = { delayMs: 0 };
    expect(lost.status).toBe(503);
    const order = (await admin().query<{ id: string }>('SELECT id FROM ord.sales_order WHERE source_document_id = $1', [checkoutId])).rows[0]!;
    const paymentId = (await admin().query<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [order.id])).rows[0]!.id;
    const replay = await place(guest, checkoutId, card, key);
    expect(replay.status).toBe(503);
    const references = (await admin().query<{ reference: string }>('SELECT reference FROM pay.provider_transaction WHERE payment_id = $1', [paymentId])).rows.map((r) => r.reference);
    expect(references).toEqual([referenceFor(paymentId)]);
    expect([...fake.transactions.keys()].filter((r) => r === referenceFor(paymentId))).toHaveLength(1);
    expect(await chargeRow(paymentId)).toMatchObject({ status: 'INITIATED', page_url: null });
    // Nobody was handed the page, so nobody can pay it: the hold ends the order, the page's grace ends the payment.
    clock.advanceBy(16 * 60_000);
    await expire();
    expect(await orderStatus(order.id)).toEqual({ status: 'CANCELLED', cancel_reason_code: 'PAYMENT_NOT_RECEIVED' });
    await runSweep(api);
    expect((await paymentRow(paymentId)).status, 'still inside the page’s grace').toBe('PENDING');
    clock.advanceBy(30 * 60_000);
    await runSweep(api);
    expect((await paymentRow(paymentId)).status).toBe('FAILED');
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(0);
  });

  it('refuses a page Paystack answers on any other host: never handed to the browser, never stored', async () => {
    const { guest, checkoutId } = await atCheckout('1');
    fake.pageBehaviour = { delayMs: 0, pageUrl: 'https://checkout.paystack.com.evil.example/abc123def456' };
    const refused = await place(guest, checkoutId);
    fake.pageBehaviour = { delayMs: 0 };
    expect([refused.status, refused.body.error?.code]).toEqual([503, 'PAYMENT_PROVIDER_UNAVAILABLE']);
    expect(JSON.stringify(refused.body)).not.toContain('evil');
    const page = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.provider_transaction WHERE page_url LIKE '%evil%'");
    expect(page.rows[0]!.n).toBe('0');
  });
});

describe('webhooks and lookups for a card, in every order they come (FR-PAY-004, FR-PAY-007, FR-PAY-008)', () => {
  it('clears once when the webhook arrives before Paystack’s answer to the page, and the late answer changes nothing', async () => {
    const { guest, checkoutId } = await atCheckout('1');
    fake.pageBehaviour = {
      delayMs: 0,
      beforeAnswer: async (t) => {
        fake.payCard(t.reference);
        expect((await deliverWebhook(api.server, fake.webhook(t))).status).toBe(200);
      },
    };
    const placed = await place(guest, checkoutId);
    fake.pageBehaviour = { delayMs: 0 };
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const paymentId = placed.body.payment.paymentId as string;
    expect(placed.body.payment).toMatchObject({ status: 'CLEARED', redirectUrl: null });
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'CLEARED' });
    expect(await chargeRow(paymentId)).toMatchObject({ status: 'SUCCEEDED', page_url: null });
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
    expect(await orderStatus(placed.body.orderId as string)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('waits after a declined card and clears once when a second card is paid on the same page', async () => {
    const { paymentId, reference, orderId } = await placedByCard('1');
    fake.declineCard(reference);
    clock.advanceBy(31_000);
    await runSweep(api);
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
    expect(await orderStatus(orderId)).toMatchObject({ status: 'PLACED' });
    expect((await payOnPage(reference)).status).toBe(200);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'CLEARED' });
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
    expect(await orderStatus(orderId)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('clears by the sweep’s lookup when the webhook never comes (timeout after the charge)', async () => {
    const { paymentId, reference, orderId } = await placedByCard('1');
    fake.payCard(reference);
    clock.advanceBy(31_000);
    await runSweep(api);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'CLEARED', verification: 'PROVIDER_LOOKUP' });
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
    expect(await orderStatus(orderId)).toMatchObject({ status: 'CONFIRMED' });
  });

  it('rejects a webhook whose amount differs from Paystack’s own record, changing nothing', async () => {
    const { paymentId, reference } = await placedByCard('1');
    expect((await payOnPage(reference, { webhookAmount: 1 })).status).toBe(200);
    expect(await webhookOutcomes(reference)).toEqual(['REJECTED_AMOUNT']);
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(0);
  });

  it('holds the payment PENDING with a break when Paystack confirms another amount or another currency than was asked', async () => {
    const short = await placedByCard('1');
    expect((await payOnPage(short.reference, { amount: 5_999 })).status).toBe(200);
    expect((await paymentRow(short.paymentId)).status).toBe('PENDING');
    expect(await breaksOf(short.paymentId)).toEqual([{ kind: 'PROVIDER_AMOUNT_DIFFERS', amount: 5_999 }]);
    const dollars = await placedByCard('1');
    expect((await payOnPage(dollars.reference, { currency: 'USD' })).status).toBe(200);
    expect((await paymentRow(dollars.paymentId)).status).toBe('PENDING');
    expect(await breaksOf(dollars.paymentId)).toEqual([{ kind: 'PROVIDER_AMOUNT_DIFFERS', amount: 6_000 }]);
    expect(await journalCount(database, short.paymentId, 'pay.PaymentCleared') + (await journalCount(database, dollars.paymentId, 'pay.PaymentCleared'))).toBe(0);
  });

  it('logs a card webhook for a reference this system never created, and raises it as a break without posting', async () => {
    const reference = `T${randomUUID().replaceAll('-', '')}`;
    const t = fake.addForeign(reference, 7_500, clock.now());
    t.channel = 'card';
    expect((await deliverWebhook(api.server, fake.webhook(t))).status).toBe(200);
    expect(await webhookOutcomes(reference)).toEqual(['IGNORED_UNKNOWN_REFERENCE']);
    const breaks = await admin().query<{ kind: string; amount: number }>('SELECT kind, amount_pesewas::int AS amount FROM pay.reconciliation_break WHERE reference = $1', [reference]);
    expect(breaks.rows).toEqual([{ kind: 'PROVIDER_REFERENCE_UNKNOWN', amount: 7_500 }]);
  });

  it('clears a card paid after its order stopped waiting as an unmatched deposit with a break, never the order’s (late webhook)', async () => {
    const { paymentId, reference, orderId } = await placedByCard('1');
    clock.advanceBy(16 * 60_000);
    await expire();
    expect(await orderStatus(orderId)).toEqual({ status: 'CANCELLED', cancel_reason_code: 'PAYMENT_NOT_RECEIVED' });
    expect(await chargeRow(paymentId)).toMatchObject({ released: true });
    expect((await payOnPage(reference)).status).toBe(200);
    expect(await paymentRow(paymentId)).toMatchObject({ status: 'CLEARED' });
    expect(await breaksOf(paymentId)).toEqual([{ kind: 'UNMATCHED_PAYMENT', amount: 6_000 }]);
    expect(await orderStatus(orderId)).toMatchObject({ status: 'CANCELLED' });
    ids.set('unmatchedCard', paymentId);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('raises a card paid on its page after its payment had failed as an URGENT break for abuse case 45, posting nothing', async () => {
    const { paymentId, reference } = await placedByCard('1');
    clock.advanceBy(46 * 60_000);
    await runSweep(api);
    expect((await paymentRow(paymentId)).status).toBe('FAILED');
    expect((await payOnPage(reference)).status).toBe(200);
    expect((await paymentRow(paymentId)).status).toBe('FAILED');
    expect(await breaksOf(paymentId)).toEqual([{ kind: 'PROVIDER_PAID_AFTER_FAILURE', amount: 6_000 }]);
    const raised = await admin().query<{ payload: { severity: string; abuseCases: number[] } }>(
      "SELECT o.payload FROM platform.outbox_message o JOIN pay.reconciliation_break b ON b.id = o.subject_id WHERE o.event_type = 'pay.ReconciliationBreakRaised' AND b.payment_id = $1",
      [paymentId],
    );
    expect(raised.rows.map((r) => [r.payload.severity, r.payload.abuseCases])).toEqual([['URGENT', [45]]]);
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(0);
    // Delivered again, the event is a replay and raises nothing more.
    expect((await deliverWebhook(api.server, fake.webhook(fake.transactions.get(reference)!))).status).toBe(200);
    expect(await breaksOf(paymentId)).toHaveLength(1);
  });

  it('refuses a forged card webhook with 401 and keeps nothing it said: the signature is checked before the body is read', async () => {
    const { reference, paymentId } = await placedByCard('1');
    const t = fake.payCard(reference);
    const hook = fake.webhook(t);
    const forged = await deliverWebhook(api.server, { body: hook.body, signature: hook.signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) });
    expect(forged.status).toBe(401);
    const rows = await admin().query<{ payload: object; reference: string | null }>("SELECT payload, reference FROM pay.webhook_event WHERE outcome = 'REJECTED_SIGNATURE' ORDER BY received_at DESC, id DESC LIMIT 1");
    expect(rows.rows[0]).toEqual({ payload: {}, reference: null });
    expect((await paymentRow(paymentId)).status).toBe('PENDING');
  });
});

describe('a chargeback on a card payment reaches a person (abuse case 45)', () => {
  it('raises a dispute Paystack confirms as an URGENT break, posts nothing, and acts on it once', async () => {
    const { paymentId, reference } = await placedByCard('1');
    const { transaction } = await payOnPage(reference);
    const dispute = fake.openDispute(transaction);
    const hook = fake.disputeWebhook(dispute);
    expect((await deliverWebhook(api.server, hook)).status).toBe(200);
    expect((await deliverWebhook(api.server, hook)).status).toBe(200);
    expect(await breaksOf(paymentId)).toEqual([{ kind: 'PROVIDER_DISPUTE_OPENED', amount: 6_000 }]);
    const raised = await admin().query<{ payload: { severity: string; abuseCases: number[] } }>(
      "SELECT o.payload FROM platform.outbox_message o JOIN pay.reconciliation_break b ON b.id = o.subject_id WHERE o.event_type = 'pay.ReconciliationBreakRaised' AND b.payment_id = $1",
      [paymentId],
    );
    expect(raised.rows.map((r) => [r.payload.severity, r.payload.abuseCases])).toEqual([['URGENT', [45]]]);
    const outcomes = await admin().query<{ outcome: string; payload: string }>("SELECT outcome, payload::text AS payload FROM pay.webhook_event WHERE event_type = 'charge.dispute.create' ORDER BY received_at, id");
    expect(outcomes.rows.map((r) => r.outcome)).toEqual(['ACCEPTED', 'REPLAYED']);
    const body = JSON.parse(hook.body) as { data: { bin: string; last4: string } };
    expect(outcomes.rows.some((r) => r.payload.includes(body.data.bin) || r.payload.includes(body.data.last4))).toBe(false);
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
  });

  it('rejects a dispute webhook whose amount differs from Paystack’s own record, raising nothing', async () => {
    const { paymentId, reference } = await placedByCard('1');
    const { transaction } = await payOnPage(reference);
    const dispute = fake.openDispute(transaction);
    expect((await deliverWebhook(api.server, fake.disputeWebhook(dispute, { refundAmount: 1 }))).status).toBe(200);
    expect(await breaksOf(paymentId)).toEqual([]);
    const outcome = await admin().query<{ outcome: string }>("SELECT outcome FROM pay.webhook_event WHERE event_id = $1 ORDER BY received_at DESC LIMIT 1", [`charge.dispute.create:${dispute.id}`]);
    expect(outcome.rows.map((r) => r.outcome)).toEqual(['REJECTED_AMOUNT']);
  });
});

describe('a card refund goes back to the card through Paystack, once (FR-PAY-012, FR-PAY-013, A-218)', () => {
  it('refunds the unmatched card deposit to the original card: one refund at Paystack despite a lost answer, then Dr 2200 Cr 1120 once', async () => {
    const paymentId = id('unmatchedCard');
    const asked = await post('manager', '/refunds', { originalPaymentId: paymentId, amountPesewas: 6_000, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'Paid by card after the order was cancelled' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const refundId = asked.body.subject.id as string;
    await stepUp(api.server, as('accountant') as TotpSession, clock);
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Order cancelled before payment' })).status).toBe(200);
    fake.refundBehaviour = 'timeout';
    await runRefundDispatch(api);
    fake.refundBehaviour = 'processed';
    clock.advanceBy(5 * 60_000 + 1_000);
    await runRefundDispatch(api);
    const atPaystack = [...fake.refunds.values()].filter((r) => r.transaction_reference === referenceFor(paymentId));
    expect(atPaystack.map((r) => [r.amount, r.merchant_note])).toEqual([[6_000, `ref ${refundId}`]]);
    for (const r of atPaystack) r.status = 'processed';
    clock.advanceBy(61_000);
    await runRefundDispatch(api);
    expect((await admin().query<{ status: string }>('SELECT status FROM pay.refund WHERE id = $1', [refundId])).rows[0]!.status).toBe('PAID');
    expect(await journalOf(database, refundId, 'pay.RefundPaid')).toEqual([
      ['2200', 'D', 6_000, expect.any(String)],
      ['1120', 'C', 6_000, 'Paystack'],
    ]);
    clock.advanceBy(61_000);
    await runRefundDispatch(api);
    expect(await journalCount(database, refundId, 'pay.RefundPaid')).toBe(1);
    expect(await trialBalanceSum(database)).toBe('0');
  });
});

describe('the database holds a card page’s address (migration 0311)', () => {
  it('refuses a page changed or cleared once written, a page written with its charge, a network on a card, another host, and a page on a mobile money charge', async () => {
    const app = database.pool('app');
    const chargeOf = async (paymentId: string) => (await admin().query<{ id: string }>('SELECT id FROM pay.provider_transaction WHERE payment_id = $1', [paymentId])).rows[0]!.id;
    const refused = (sql: string, params: unknown[]) => sqlStateOf(app.query(sql, params));
    const opened = await chargeOf((await placedByCard('1')).paymentId);
    expect(await refused("UPDATE pay.provider_transaction SET page_url = 'https://checkout.paystack.com/abcdefgh', version = version + 1 WHERE id = $1", [opened])).toBe(SQLSTATE.documentFrozen);
    expect(await refused('UPDATE pay.provider_transaction SET page_url = NULL, version = version + 1 WHERE id = $1', [opened])).toBe(SQLSTATE.documentFrozen);
    expect(await refused("UPDATE pay.provider_transaction SET network = 'MTN', version = version + 1 WHERE id = $1", [opened])).toBe(SQLSTATE.checkViolation);
    const fresh = randomUUID();
    expect(
      await refused(
        `INSERT INTO pay.provider_transaction (id, payment_id, provider, reference, kind, channel, requested_pesewas, status, awaited_until, branch_id, created_by, updated_by, page_url)
         SELECT $1::uuid, $1::uuid, provider, 'HKrefused' || left(replace($1::text, '-', ''), 12), 'CHARGE', 'CARD', 100, 'INITIATED', awaited_until, branch_id, created_by, created_by, 'https://checkout.paystack.com/abcdefgh'
           FROM pay.provider_transaction WHERE id = $2`,
        [fresh, opened],
      ),
    ).toBe(SQLSTATE.documentFrozen);
    // A charge whose page was never opened (Paystack down): only Paystack's checkout host, and only on a card charge.
    const { guest, checkoutId } = await atCheckout('1');
    fake.pageBehaviour = { delayMs: 0, down: true };
    expect((await place(guest, checkoutId)).status).toBe(503);
    fake.pageBehaviour = { delayMs: 0 };
    const order = (await admin().query<{ id: string }>('SELECT id FROM ord.sales_order WHERE source_document_id = $1', [checkoutId])).rows[0]!.id;
    const unopened = await chargeOf((await admin().query<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [order])).rows[0]!.id);
    expect(await refused("UPDATE pay.provider_transaction SET page_url = 'https://evil.example/abcdefgh', version = version + 1 WHERE id = $1", [unopened])).toBe(SQLSTATE.checkViolation);
    expect(await refused("UPDATE pay.provider_transaction SET page_url = 'http://checkout.paystack.com/abcdefgh', version = version + 1 WHERE id = $1", [unopened])).toBe(SQLSTATE.checkViolation);
    expect(await refused("UPDATE pay.provider_transaction SET channel = 'MOBILE_MONEY', network = 'MTN', page_url = 'https://checkout.paystack.com/abcdefgh', version = version + 1 WHERE id = $1", [unopened])).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(app.query("UPDATE pay.provider_transaction SET page_url = 'https://checkout.paystack.com/abcdefgh', version = version + 1 WHERE id = $1", [unopened]))).toBeUndefined();
  });
});
