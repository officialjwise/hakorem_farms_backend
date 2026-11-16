import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderPayments } from '../../../src/modules/pay';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { approveAndDeliver, balanceOf, deliverWebhook, initiateCharge, issueInvoice, journalCount, journalOf, referenceFor, runSweep, trialBalanceSum } from '../../support/pay';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Every payment edge case of the shared brief, written before the happy path (B09a continued gate, FR-PAY-003 to
 * FR-PAY-010): against the real adapter and a local fake of Paystack's documented API (the sandbox needs a key this
 * repository never holds, A-210). A webhook takes effect only signed, inside its window, unseen and with its amount
 * re-verified by lookup; a timeout after the charge, a webhook before the API answer, a webhook twice, for an order
 * that no longer exists, after the order expired, for a reference never initiated, or for another amount: each lands
 * exactly once or not at all, with exact pesewas, and the money is never lost. Over-, under- and partial payment
 * allocate exactly; the trial balance still sums to zero; every PAY write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const tick = (ms = 1_000) => clock.advanceBy(ms);

async function paymentRow(paymentId: string): Promise<{ status: string; verification: string; allocated: number; refunded: number }> {
  const { rows } = await admin().query<{ status: string; verification: string; allocated: string; refunded: string }>(
    'SELECT status, verification, allocated_pesewas::text AS allocated, refunded_pesewas::text AS refunded FROM pay.payment WHERE id = $1',
    [paymentId],
  );
  const r = rows[0]!;
  return { status: r.status, verification: r.verification, allocated: Number(r.allocated), refunded: Number(r.refunded) };
}

async function webhookOutcomes(reference: string): Promise<string[]> {
  const { rows } = await admin().query<{ outcome: string }>('SELECT outcome FROM pay.webhook_event WHERE reference = $1 ORDER BY recorded_at, id', [reference]);
  return rows.map((r) => r.outcome);
}

async function openBreaks(where: { paymentId?: string; reference?: string }): Promise<string[]> {
  const { rows } = await admin().query<{ kind: string }>(
    "SELECT kind FROM pay.reconciliation_break WHERE status = 'OPEN' AND ($1::uuid IS NULL OR payment_id = $1) AND ($2::text IS NULL OR reference = $2) ORDER BY kind",
    [where.paymentId ?? null, where.reference ?? null],
  );
  return rows.map((r) => r.kind);
}

/** A cleared mobile money deposit of `amount` from Tema Cold Store, through the charge, the customer's approval and the webhook. */
async function clearedDeposit(amount: number): Promise<string> {
  const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: amount, customerId: id('tema') });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  tick();
  const delivered = await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string));
  expect(delivered.status).toBe(200);
  expect((await paymentRow(started.body.id as string)).status).toBe('CLEARED');
  return started.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  // The day runs for hours on the test clock: sessions outlive it, as a shift's would with its refreshes.
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branches = new Map((await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.branch')).rows.map((r) => [r.code, r.id] as const));
  branchId = branches.get('DDW')!;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', 'Tema Cold Store Ltd (SEED)'],
    ['goat', 'SELECT id FROM mdm.product WHERE sku = $1', 'LIV-GOAT'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  const people: [string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a webhook is accepted only signed, in its window, unseen and with its amount re-verified (FR-PAY-004, FR-PAY-006, abuse case 5)', () => {
  it('starts a mobile money charge PENDING, with our reference, the phone masked and one charge at the provider', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 50_000, customerId: id('tema') });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ status: 'PENDING', verification: 'UNVERIFIED', amountPesewas: 50_000, unallocatedPesewas: 50_000, provider: 'PAYSTACK', payerPhoneMasked: '+233 24 *** *876', method: { kind: 'MOBILE_MONEY' } });
    expect(started.body.providerReference).toBe(referenceFor(started.body.id as string));
    expect(fake.transactions.get(referenceFor(started.body.id as string))).toMatchObject({ amount: 50_000, currency: 'GHS' });
    ids.set('signed', started.body.id as string);
  });

  it('refuses a body with one byte changed with 401 and no detail, logs it, and changes nothing; five forgeries give five rows and one answer', async () => {
    const reference = referenceFor(id('signed'));
    const t = fake.approve(reference);
    const genuine = fake.webhook(t);
    const bodies: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const forged = await deliverWebhook(api.server, { body: genuine.body.replace('"amount":50000', `"amount":${5_000_000 + i}`), signature: genuine.signature });
      expect(forged.status).toBe(401);
      bodies.push(JSON.stringify({ code: forged.body.error.code, message: forged.body.error.message, details: forged.body.error.details }));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/signature|time|amount|replay/i);
    const rows = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.webhook_event WHERE outcome = 'REJECTED_SIGNATURE' AND NOT signature_valid AND event_id IS NULL");
    expect(rows.rows[0]!.n).toBe('5');
    const reported = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'pay.WebhookRejected'");
    expect(reported.rows[0]!.n).toBe('5');
    const audited = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.audit_event WHERE action = 'WEBHOOK_REJECTED'");
    expect(audited.rows[0]!.n).toBe('5');
    expect((await paymentRow(id('signed'))).status).toBe('PENDING');
  });

  it('rejects a signed event timestamped six minutes ago as stale, with no state change', async () => {
    const t = fake.transactions.get(referenceFor(id('signed')))!;
    const stale = fake.webhook(t, { paidAt: new Date(clock.now().getTime() - 360_000).toISOString() });
    expect((await deliverWebhook(api.server, stale)).status).toBe(200);
    expect(await webhookOutcomes(t.reference)).toEqual(['REJECTED_STALE']);
    expect((await paymentRow(id('signed'))).status).toBe('PENDING');
  });

  it('rejects a signed event whose amount is not the provider’s own record, and never trusts it', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 50_000, customerId: id('tema') });
    tick();
    const response = await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string), { webhookAmount: 5_000_000 });
    expect(response.status).toBe(200);
    expect(await webhookOutcomes(referenceFor(started.body.id as string))).toEqual(['REJECTED_AMOUNT']);
    expect((await paymentRow(started.body.id as string)).status).toBe('PENDING');
    expect(await journalCount(database, started.body.id as string, 'pay.PaymentCleared')).toBe(0);
    ids.set('forgedAmount', started.body.id as string);
  });

  it('accepts the valid event once: CLEARED by the callback, one journal Dr 1120 Cr 2200 for exactly 50,000; the replay is acknowledged with no effect', async () => {
    tick();
    const t = fake.approve(referenceFor(id('signed')));
    const hook = fake.webhook(t);
    expect((await deliverWebhook(api.server, hook)).status).toBe(200);
    expect(await paymentRow(id('signed'))).toEqual({ status: 'CLEARED', verification: 'PROVIDER_CALLBACK', allocated: 0, refunded: 0 });
    expect(await journalOf(database, id('signed'))).toEqual([
      ['1120', 'D', 50_000, 'Paystack'],
      ['2200', 'C', 50_000, 'Tema Cold Store Ltd (SEED)'],
    ]);
    const again = await deliverWebhook(api.server, hook);
    expect([again.status, again.body]).toEqual([200, { received: true }]);
    expect(await webhookOutcomes(t.reference)).toEqual(['REJECTED_STALE', 'ACCEPTED', 'REPLAYED']);
    expect(await journalCount(database, id('signed'), 'pay.PaymentCleared')).toBe(1);
  });

  it('holds a success the provider records for another amount than asked: never cleared, a break, and on the unmatched queue', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 50_000, customerId: id('tema') });
    tick();
    const response = await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string), { amount: 49_000 });
    expect(response.status).toBe(200);
    expect(await webhookOutcomes(referenceFor(started.body.id as string))).toEqual(['REJECTED_AMOUNT']);
    expect((await paymentRow(started.body.id as string)).status).toBe('PENDING');
    expect(await openBreaks({ paymentId: started.body.id as string })).toEqual(['PROVIDER_AMOUNT_DIFFERS']);
    const amount = await admin().query<{ amount: string; details: { requestedPesewas: number; confirmedPesewas: number } }>("SELECT amount_pesewas::text AS amount, details FROM pay.reconciliation_break WHERE payment_id = $1", [started.body.id]);
    expect([amount.rows[0]!.amount, amount.rows[0]!.details.requestedPesewas, amount.rows[0]!.details.confirmedPesewas]).toEqual(['49000', 50_000, 49_000]);
    expect(await journalCount(database, started.body.id as string, 'pay.PaymentCleared')).toBe(0);
    const queue = await get('accountant', '/payments/unmatched');
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(started.body.id);
  });
});

describe('the payment edge cases of the brief land exactly once, and the money is never lost (FR-PAY-007, FR-PAY-008)', () => {
  it('provider times out after the customer was charged: the payment stays PENDING, the retry reuses our reference so the customer is charged once, and the sweep clears it by lookup half a minute later', async () => {
    const key = randomUUID();
    const chargesBefore = fake.calls.filter((c) => c.path === '/charge').length;
    fake.chargeBehaviour = { delayMs: 1_500, beforeAnswer: async (t) => void fake.approve(t.reference, { paidAt: clock.now() }) };
    const body = { id: randomUUID(), amountPesewas: 44_000, customerId: id('tema') };
    const started = await initiateCharge(api.server, as('cashier'), body, key);
    fake.chargeBehaviour = { delayMs: 0 };
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ status: 'PENDING', clearedAt: null });
    const paymentId = started.body.id as string;
    expect(fake.calls.filter((c) => c.path === '/charge').length - chargesBefore, 'the timed-out charge was retried').toBe(2);
    expect([...fake.transactions.values()].filter((t) => t.reference === referenceFor(paymentId)), 'and Paystack holds one charge').toHaveLength(1);
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared'), 'not marked paid on a timeout').toBe(0);
    const replay = await initiateCharge(api.server, as('cashier'), body, key);
    expect([replay.status, replay.body.id]).toEqual([201, paymentId]);
    expect(fake.calls.filter((c) => c.path === '/charge').length - chargesBefore, 'the same key sends nothing more').toBe(2);
    tick(30_000);
    const report = await runSweep(api);
    expect(report.cleared).toBeGreaterThanOrEqual(1);
    expect(await paymentRow(paymentId)).toEqual({ status: 'CLEARED', verification: 'PROVIDER_LOOKUP', allocated: 0, refunded: 0 });
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
    expect(await journalOf(database, paymentId)).toEqual([
      ['1120', 'D', 44_000, 'Paystack'],
      ['2200', 'C', 44_000, 'Tema Cold Store Ltd (SEED)'],
    ]);
    await runSweep(api);
    expect(await journalCount(database, paymentId, 'pay.PaymentCleared')).toBe(1);
  });

  it('webhook arrives before the API response: it finds the payment by our reference and clears it; the later response changes nothing', async () => {
    fake.chargeBehaviour = {
      delayMs: 0,
      beforeAnswer: async (t) => {
        fake.approve(t.reference);
        const delivered = await deliverWebhook(api.server, fake.webhook(t));
        expect(delivered.status).toBe(200);
      },
    };
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 30_000, customerId: id('tema') });
    fake.chargeBehaviour = { delayMs: 0 };
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ status: 'CLEARED', verification: 'PROVIDER_CALLBACK' });
    const charge = await admin().query<{ status: string; confirmed: string }>('SELECT status, confirmed_pesewas::text AS confirmed FROM pay.provider_transaction WHERE payment_id = $1', [started.body.id]);
    expect(charge.rows[0]).toEqual({ status: 'SUCCEEDED', confirmed: '30000' });
    expect(await journalCount(database, started.body.id as string, 'pay.PaymentCleared')).toBe(1);
  });

  it('initiating twice with the same key creates one payment and one provider call; the same key with another body is 409', async () => {
    const key = randomUUID();
    const body = { id: randomUUID(), amountPesewas: 12_000, customerId: id('tema') };
    const before = fake.calls.filter((c) => c.path === '/charge').length;
    const first = await initiateCharge(api.server, as('cashier'), body, key);
    const second = await initiateCharge(api.server, as('cashier'), body, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.body.id).toBe(first.body.id);
    expect(fake.calls.filter((c) => c.path === '/charge').length - before).toBe(1);
    const other = await initiateCharge(api.server, as('cashier'), { ...body, amountPesewas: 12_001 }, key);
    expect(other.status).toBe(409);
    const payments = await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM pay.payment WHERE id = $1', [body.id]);
    expect(payments.rows[0]!.n).toBe('1');
  });

  it('webhook for an order that no longer exists: stored, answered 200, cleared as a deposit in 2200 with a break, and on the unmatched queue', async () => {
    const orderId = randomUUID();
    await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'test', actor: actorOf('cashier') }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => api.app.get(DocumentRegistry).register(tx, { id: orderId, docType: 'SALES_ORDER', ownerModule: 'ord', branchId, actorId: users.get('cashier')!.principalId })),
    );
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 26_500, customerId: id('tema'), orderId });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.order).toEqual({ id: orderId, docType: 'SALES_ORDER', number: null });
    // The order is cancelled: ORD's cancelOrder (B09a continued 2) calls this port in its own transaction.
    await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'test', actor: actorOf('cashier') }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(ProviderPayments).releaseChargeIn(tx, started.body.id as string, users.get('cashier')!.principalId)),
    );
    tick();
    const delivered = await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string));
    expect(delivered.status).toBe(200);
    expect((await paymentRow(started.body.id as string)).status).toBe('CLEARED');
    expect(await journalOf(database, started.body.id as string)).toEqual([
      ['1120', 'D', 26_500, 'Paystack'],
      ['2200', 'C', 26_500, 'Tema Cold Store Ltd (SEED)'],
    ]);
    expect(await openBreaks({ paymentId: started.body.id as string })).toEqual(['UNMATCHED_PAYMENT']);
    const cleared = await admin().query<{ payload: { heldAsUnmatched: boolean } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.PaymentCleared' AND subject_id = $1", [started.body.id]);
    expect(cleared.rows[0]!.payload.heldAsUnmatched).toBe(true);
    const queue = await get('accountant', '/payments/unmatched');
    expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(started.body.id);
  });

  it('late webhook after the order expired: the money paid after the 15-minute window clears as an unmatched deposit with a break, never as the order’s', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 18_000, customerId: id('tema') });
    tick(15 * 60_000 + 1_000);
    const delivered = await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string));
    expect(delivered.status).toBe(200);
    expect((await paymentRow(started.body.id as string)).status).toBe('CLEARED');
    expect(await openBreaks({ paymentId: started.body.id as string })).toEqual(['UNMATCHED_PAYMENT']);
    const details = await admin().query<{ details: { reason: string } }>("SELECT details FROM pay.reconciliation_break WHERE payment_id = $1", [started.body.id]);
    expect(details.rows[0]!.details.reason).toBe('PAID_AFTER_WINDOW');
    expect(await balanceOf(database, '2200', 'Tema Cold Store Ltd (SEED)')).toBeLessThan(0);
  });

  it('webhook for a reference this system never initiated: logged, answered 200, raised as a break, never posted against a guess', async () => {
    tick();
    const foreign = fake.addForeign('T7731049912', 25_000, clock.now());
    const before = await trialBalanceSum(database);
    const delivered = await deliverWebhook(api.server, fake.webhook(foreign));
    expect([delivered.status, delivered.body]).toEqual([200, { received: true }]);
    expect(await webhookOutcomes('T7731049912')).toEqual(['IGNORED_UNKNOWN_REFERENCE']);
    expect(await openBreaks({ reference: 'T7731049912' })).toEqual(['PROVIDER_REFERENCE_UNKNOWN']);
    const posted = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.payment WHERE provider_reference = 'T7731049912'");
    expect(posted.rows[0]!.n).toBe('0');
    expect(await trialBalanceSum(database)).toBe(before);
  });

  it('the sweep finds a payment whose webhook never came and posts it through the same path; a second run over its window changes nothing', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 21_000, customerId: id('tema') });
    fake.approve(referenceFor(started.body.id as string));
    tick(60_000);
    const first = await runSweep(api);
    expect(first.cleared).toBeGreaterThanOrEqual(1);
    expect(await paymentRow(started.body.id as string)).toMatchObject({ status: 'CLEARED', verification: 'PROVIDER_LOOKUP' });
    expect(await journalCount(database, started.body.id as string, 'pay.PaymentCleared')).toBe(1);
    const breaksBefore = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.reconciliation_break");
    tick(60_000);
    const second = await runSweep(api);
    expect([second.cleared, second.breaksRaised]).toEqual([0, 0]);
    const breaksAfter = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.reconciliation_break");
    expect(breaksAfter.rows[0]!.n).toBe(breaksBefore.rows[0]!.n);
    const windows = await admin().query<{ from: Date; to: Date }>("SELECT window_from AS from, window_to AS to FROM pay.provider_sweep ORDER BY window_to");
    for (let i = 1; i < windows.rows.length; i += 1) expect(windows.rows[i]!.from).toEqual(windows.rows[i - 1]!.to);
    expect(await journalCount(database, started.body.id as string, 'pay.PaymentCleared')).toBe(1);
  });

  it('the forged-amount payment is cleared later by the sweep for the provider’s own 50,000, exactly once', async () => {
    expect(await paymentRow(id('forgedAmount'))).toMatchObject({ status: 'CLEARED', verification: 'PROVIDER_LOOKUP' });
    expect(await journalCount(database, id('forgedAmount'), 'pay.PaymentCleared')).toBe(1);
  });

  it('with the provider down the call is 503 and the circuit opens after five failures, so the sixth asks nothing and writes nothing; a charge the provider never got fails after the grace period, with a break', async () => {
    fake.available = false;
    for (let i = 0; i < 5; i += 1) {
      const down = await initiateCharge(api.server, as('cashier'), { amountPesewas: 7_000 + i, customerId: id('tema') });
      expect(down.status).toBe(503);
    }
    const calls = fake.calls.length;
    const sixth = await initiateCharge(api.server, as('cashier'), { amountPesewas: 9_999, customerId: id('tema') });
    expect([sixth.status, sixth.body.error.code]).toEqual([503, 'PAYMENT_PROVIDER_UNAVAILABLE']);
    expect(fake.calls.length).toBe(calls);
    const none = await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM pay.payment WHERE amount_pesewas = 9999');
    expect(none.rows[0]!.n).toBe('0');
    fake.available = true;
    tick(30_000);
    const stranded = await admin().query<{ id: string }>("SELECT id FROM pay.payment WHERE amount_pesewas BETWEEN 7000 AND 7004 AND status = 'PENDING' ORDER BY id");
    expect(stranded.rows).toHaveLength(5);
    await runSweep(api);
    expect((await paymentRow(stranded.rows[0]!.id)).status, 'inside the grace period it waits').toBe('PENDING');
    tick(31 * 60_000);
    await runSweep(api);
    for (const row of stranded.rows) {
      expect((await paymentRow(row.id)).status).toBe('FAILED');
      expect(await openBreaks({ paymentId: row.id })).toEqual(['PROVIDER_PAYMENT_MISSING']);
      expect(await journalCount(database, row.id, 'pay.PaymentCleared')).toBe(0);
    }
  });
});

describe('overpayment, underpayment and partial payment allocate exactly (FR-PAY-009, FR-PAY-010)', () => {
  it('overpayment: 120,000 against an invoice of 100,000 settles it and holds 20,000 in 2200 against the customer', async () => {
    const invoice = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, 100_000n);
    const paymentId = await clearedDeposit(120_000);
    const depositBefore = await balanceOf(database, '2200', 'Tema Cold Store Ltd (SEED)');
    const allocatedAt = clock.now().toISOString();
    const allocated = await post('accountant', `/payments/${paymentId}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 100_000 }] });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
    expect(allocated.body).toMatchObject({ allocatedPesewas: 100_000, unallocatedPesewas: 20_000 });
    expect(allocated.body.allocations[0]).toMatchObject({ billingDocument: { id: invoice.id, docType: 'INVOICE', number: invoice.documentNo }, amountPesewas: 100_000, direction: 'APPLY' });
    expect(await journalOf(database, paymentId, 'pay.DepositAllocated')).toEqual([
      ['2200', 'D', 100_000, 'Tema Cold Store Ltd (SEED)'],
      ['1200', 'C', 100_000, 'Tema Cold Store Ltd (SEED)'],
    ]);
    expect((await balanceOf(database, '2200', 'Tema Cold Store Ltd (SEED)')) - depositBefore).toBe(100_000);
    const doc = await get('accountant', `/billing-documents/${invoice.id}`);
    // Settled and as of the application clock's instant, never the database's (ADR-0067).
    expect(doc.body.settlement).toMatchObject({ allocatedPesewas: 100_000, outstandingPesewas: 0, paymentStatus: 'PAID', settledAt: allocatedAt, asOf: allocatedAt });
    ids.set('overpayment', paymentId);
  });

  it('underpayment: 60,000 against 100,000 leaves 40,000 outstanding and the invoice part paid; 40,001 more is refused', async () => {
    const invoice = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, 100_000n);
    const paymentId = await clearedDeposit(60_000);
    expect((await post('accountant', `/payments/${paymentId}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 60_000 }] })).status).toBe(200);
    const doc = await get('accountant', `/billing-documents/${invoice.id}`);
    expect(doc.body.settlement).toMatchObject({ allocatedPesewas: 60_000, outstandingPesewas: 40_000, paymentStatus: 'PART_PAID' });
    const more = await post('accountant', `/payments/${id('overpayment')}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 20_001 }] });
    expect([more.status, more.body.error.code]).toEqual([422, 'ALLOCATION_EXCEEDS_AVAILABLE']);
    const tooMuch = await post('accountant', `/payments/${id('overpayment')}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 20_000 }] });
    expect(tooMuch.status, 'the 20,000 deposit settles half of what is left').toBe(200);
    expect((await get('accountant', `/billing-documents/${invoice.id}`)).body.settlement).toMatchObject({ outstandingPesewas: 20_000, paymentStatus: 'PART_PAID' });
  });

  it('partial payment: 100,000 against invoices of 60,000 and 50,000 allocates 60,000 and 40,000 and leaves 10,000; 60,001 to the first is refused', async () => {
    const first = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, 60_000n);
    const second = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, 50_000n);
    const paymentId = await clearedDeposit(100_000);
    const refused = await post('accountant', `/payments/${paymentId}/allocate`, { allocations: [{ billingDocumentId: first.id, amountPesewas: 60_001 }] });
    expect([refused.status, refused.body.error.code]).toEqual([422, 'ALLOCATION_EXCEEDS_AVAILABLE']);
    const allocated = await post('accountant', `/payments/${paymentId}/allocate`, { allocations: [{ billingDocumentId: first.id, amountPesewas: 60_000 }, { billingDocumentId: second.id, amountPesewas: 40_000 }] });
    expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
    expect(allocated.body).toMatchObject({ allocatedPesewas: 100_000, unallocatedPesewas: 0 });
    expect((await get('accountant', `/billing-documents/${second.id}`)).body.settlement).toMatchObject({ outstandingPesewas: 10_000, paymentStatus: 'PART_PAID' });
    expect((await get('accountant', `/billing-documents/${first.id}`)).body.settlement).toMatchObject({ outstandingPesewas: 0, paymentStatus: 'PAID' });
    const beyond = await post('accountant', `/payments/${paymentId}/allocate`, { allocations: [{ billingDocumentId: second.id, amountPesewas: 1 }] });
    expect([beyond.status, beyond.body.error.code]).toEqual([422, 'ALLOCATION_EXCEEDS_AVAILABLE']);
    ids.set('partial', paymentId);
    ids.set('partialSecond', second.id);
    ids.set('partialAllocation', (allocated.body.allocations as Array<{ id: string; billingDocument: { id: string } }>).find((a) => a.billingDocument.id === second.id)!.id);
  });

  it('takes an allocation off once with a reason: the invoice is outstanding again and the money back on deposit (Dr 1200 Cr 2200)', async () => {
    const off = await post('accountant', `/payments/${id('partial')}/unallocate`, { allocationId: id('partialAllocation'), reason: 'Applied to the wrong invoice' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ allocatedPesewas: 60_000, unallocatedPesewas: 40_000 });
    expect((await get('accountant', `/billing-documents/${id('partialSecond')}`)).body.settlement).toMatchObject({ outstandingPesewas: 50_000, paymentStatus: 'UNPAID' });
    const lines = await journalOf(database, id('partial'), 'pay.DepositAllocated');
    expect(lines.slice(-2)).toEqual([
      ['1200', 'D', 40_000, 'Tema Cold Store Ltd (SEED)'],
      ['2200', 'C', 40_000, 'Tema Cold Store Ltd (SEED)'],
    ]);
    const again = await post('accountant', `/payments/${id('partial')}/unallocate`, { allocationId: id('partialAllocation'), reason: 'Twice' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'ALREADY_UNALLOCATED']);
  });

  it('refuses to allocate a payment still pending, or to another customer’s document', async () => {
    const pending = await initiateCharge(api.server, as('cashier'), { amountPesewas: 5_000, customerId: id('tema') });
    const invoice = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, 5_000n);
    const refused = await post('accountant', `/payments/${pending.body.id as string}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 5_000 }] });
    expect([refused.status, refused.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['PAYMENT_NOT_CLEARED']]);
    const walkIn = await clearedDepositWithoutCustomer(5_000);
    const other = await post('accountant', `/payments/${walkIn}/allocate`, { allocations: [{ billingDocumentId: invoice.id, amountPesewas: 5_000 }] });
    expect([other.status, other.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['CUSTOMER_DIFFERS']]);
  });
});

async function clearedDepositWithoutCustomer(amount: number): Promise<string> {
  const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: amount });
  tick();
  await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string));
  return started.body.id as string;
}

describe('the database holds the provider rules even against direct SQL as hk_app (FR-PAY-004, FR-PAY-005)', () => {
  it('refuses a mobile money payment written CLEARED, or cleared without the provider’s confirmation of exactly its amount', async () => {
    const pending = await initiateCharge(api.server, as('cashier'), { amountPesewas: 8_000, customerId: id('tema') });
    const paymentId = pending.body.id as string;
    await expect(app().query("UPDATE pay.payment SET status = 'CLEARED', verification = 'PROVIDER_CALLBACK', cleared_at = now(), posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [paymentId])).rejects.toMatchObject({ constraint: 'ck_payment_provider_confirmed' });
    await app().query("UPDATE pay.provider_transaction SET status = 'SUCCEEDED', confirmed_pesewas = 7999, verified_at = now(), version = version + 1 WHERE payment_id = $1", [paymentId]);
    await expect(app().query("UPDATE pay.payment SET status = 'CLEARED', verification = 'PROVIDER_LOOKUP', cleared_at = now(), posted_at = now(), posted_by = created_by, version = version + 1 WHERE id = $1", [paymentId])).rejects.toMatchObject({ constraint: 'ck_payment_provider_confirmed' });
    await expect(app().query("UPDATE pay.provider_transaction SET confirmed_pesewas = 8000, version = version + 1 WHERE payment_id = $1", [paymentId])).rejects.toMatchObject({ constraint: 'ck_provider_transaction_transition' });
    await expect(app().query("UPDATE pay.provider_transaction SET requested_pesewas = 1, version = version + 1 WHERE payment_id = $1", [paymentId])).rejects.toMatchObject({ constraint: 'ck_provider_transaction_transition' });
  });

  it('keeps the webhook log append-only and a validly signed event id once', async () => {
    expect(await sqlStateOf(app().query('UPDATE pay.webhook_event SET outcome = $1', ['ACCEPTED']))).toBe('42501');
    expect(await sqlStateOf(app().query('DELETE FROM pay.webhook_event'))).toBe('42501');
    expect(await sqlStateOf(admin().query('UPDATE pay.webhook_event SET outcome = $1', ['ACCEPTED']))).toBe('HK001');
    const { rows } = await admin().query<{ event_id: string }>("SELECT event_id FROM pay.webhook_event WHERE outcome = 'ACCEPTED' LIMIT 1");
    await expect(
      app().query(
        `INSERT INTO pay.webhook_event (id, provider, event_id, event_type, signature_valid, payload_hash, payload, outcome, received_at, actor_id)
         VALUES ($1, 'PAYSTACK', $2, 'charge.success', true, $3, '{}', 'ACCEPTED', now(), '01900000-0000-7000-8000-000000000007')`,
        [randomUUID(), rows[0]!.event_id, Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({ constraint: 'uq_webhook_event_reference' });
  });
});

describe('every PAY write built refuses the wrong role, in the handler (ADR-0035)', () => {
  it('refuses the storekeeper and the farm hand every payment read and write, and the cashier allocation', async () => {
    for (const who of ['storekeeper', 'farmHand']) {
      expect((await initiateCharge(api.server, as(who), { amountPesewas: 1_000 })).status).toBe(403);
      expect((await post(who, `/payments/${id('overpayment')}/allocate`, { allocations: [{ billingDocumentId: randomUUID(), amountPesewas: 1 }] })).status).toBe(403);
      expect((await post(who, `/payments/${id('overpayment')}/unallocate`, { allocationId: randomUUID(), reason: 'x' })).status).toBe(403);
      expect((await post(who, `/payments/${id('overpayment')}/check-status`)).status).toBe(403);
      expect((await get(who, `/payments/${id('overpayment')}`)).status).toBe(403);
      expect((await get(who, '/payments')).status).toBe(403);
      expect((await get(who, '/payments/unmatched')).status).toBe(403);
    }
    expect((await post('cashier', `/payments/${id('overpayment')}/allocate`, { allocations: [{ billingDocumentId: randomUUID(), amountPesewas: 1 }] })).status).toBe(403);
    expect((await post('cashier', `/payments/${id('overpayment')}/unallocate`, { allocationId: randomUUID(), reason: 'x' })).status).toBe(403);
    const page = await get('cashier', '/payments?methodKind=MOBILE_MONEY&limit=2');
    expect([page.status, page.body.data.length, page.body.page.hasMore]).toEqual([200, 2, true]);
  });
});

describe('after the day’s payments the books still tie (FR-FIN-011)', () => {
  it('sums the trial balance to exactly zero, and 1120 holds every provider payment cleared', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
    const cleared = await admin().query<{ total: string }>("SELECT COALESCE(sum(amount_pesewas), 0)::text AS total FROM pay.payment WHERE status = 'CLEARED' AND method_kind = 'MOBILE_MONEY'");
    expect(await balanceOf(database, '1120', 'Paystack')).toBe(Number(cleared.rows[0]!.total));
  });
});
