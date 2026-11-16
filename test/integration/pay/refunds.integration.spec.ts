import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { approveAndDeliver, initiateCharge, journalCount, journalOf, referenceFor, runRefundDispatch, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Refunds, where till fraud lives (FR-PAY-012, FR-PAY-013, abuse case 12; the owner, 2026-11-16). A refund references its
 * original payment and never exceeds what is left of it, held by the database; every refund a person asks for is
 * approved by a different person with a fresh step-up, proved with the smallest team (one Owner, one Manager) and with
 * a single Owner, who cannot refund alone; a provider refund that fails is retried with backoff, then waits on the break
 * queue for a person, the stock untouched; a payout recorded by hand is never recorded by the refund's maker; each
 * refund posts once, Dr 2200 Cr the original tender, and the trial balance still sums to zero.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let branchId: string;
let testBranchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const tick = (ms = 1_000) => clock.advanceBy(ms);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);

async function deposit(who: string, amount: number, customer: string | null = id('tema')): Promise<string> {
  const started = await initiateCharge(api.server, as(who), customer === null ? { amountPesewas: amount } : { amountPesewas: amount, customerId: customer });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  tick();
  expect((await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string))).status).toBe(200);
  return started.body.id as string;
}

async function refundState(refundId: string): Promise<{ status: string; attempts: number; next: Date | null; paidBy: string | null }> {
  const { rows } = await admin().query<{ status: string; attempts: number; next_attempt_at: Date | null; paid_by: string | null }>('SELECT status, attempts, next_attempt_at, paid_by FROM pay.refund WHERE id = $1', [refundId]);
  return { status: rows[0]!.status, attempts: rows[0]!.attempts, next: rows[0]!.next_attempt_at, paidBy: rows[0]!.paid_by };
}

async function refunded(paymentId: string): Promise<number> {
  const { rows } = await admin().query<{ refunded: string }>('SELECT refunded_pesewas::text AS refunded FROM pay.payment WHERE id = $1', [paymentId]);
  return Number(rows[0]!.refunded);
}

async function stockFootprint(): Promise<string> {
  const { rows } = await admin().query<{ f: string }>(
    `SELECT (SELECT count(*) FROM inv.stock_movement)::text || '/' || (SELECT count(*) FROM inv.stock_reservation)::text || '/' ||
            (SELECT count(*) FILTER (WHERE status = 'ACTIVE') FROM inv.stock_reservation)::text || '/' || (SELECT COALESCE(sum(on_hand_qty), 0) FROM inv.stock_balance)::text || '/' || (SELECT COALESCE(sum(reserved_qty), 0) FROM inv.stock_balance)::text AS f`,
  );
  return rows[0]!.f;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branches = new Map((await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.branch')).rows.map((r) => [r.code, r.id] as const));
  branchId = branches.get('DDW')!;
  testBranchId = branches.get('TST')!;
  ids.set('tema', (await admin().query<{ id: string }>('SELECT id FROM mdm.customer WHERE name = $1', ['Tema Cold Store Ltd (SEED)'])).rows[0]!.id);
  const people: [string, string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', branchId, true],
    ['manager', 'Akosua Boateng', 'MANAGER', branchId, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId, false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', branchId, false],
    ['soleOwner', 'Nana Yeboah', 'OWNER', testBranchId, true],
  ];
  for (const [who, name, role, branch, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: branch }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a refund never exceeds what is left of its payment, held by the database (FR-PAY-012)', () => {
  it('asks for 25,000 of a 30,000 payment: 202, nothing paid, and the 25,000 held against the payment', async () => {
    ids.set('payment', await deposit('owner', 30_000));
    const asked = await post('manager', '/refunds', { originalPaymentId: id('payment'), amountPesewas: 25_000, destination: 'ORIGINAL_METHOD', reasonCode: 'QUALITY_COMPLAINT', note: 'Two crates cracked on arrival' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'REFUND', subject: { docType: 'REFUND' } });
    ids.set('refund', asked.body.subject.id as string);
    ids.set('approval', asked.body.approvalRequestId as string);
    expect(await refunded(id('payment'))).toBe(25_000);
    expect(await journalCount(database, id('refund'), 'pay.RefundPaid')).toBe(0);
    const reported = await admin().query<{ payload: { abuseCases: number[]; amountPesewas: number; requestedBy: string } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.RefundRequested' AND subject_id = $1", [id('refund')]);
    expect(reported.rows[0]!.payload).toMatchObject({ abuseCases: [12], amountPesewas: 25_000, requestedBy: users.get('manager')!.principalId });
    const view = await get('manager', `/refunds/${id('refund')}`);
    expect(view.body).toMatchObject({ status: 'PENDING_APPROVAL', amountPesewas: 25_000, originalPayment: { id: id('payment'), method: { kind: 'MOBILE_MONEY' } }, createdBy: { displayName: 'Akosua Boateng' } });
  });

  it('refuses 6,000 afterwards, with 5,000 left, and 30,001 of a fresh 30,000 payment: more than was paid', async () => {
    const more = await post('manager', '/refunds', { originalPaymentId: id('payment'), amountPesewas: 6_000, destination: 'ORIGINAL_METHOD', reasonCode: 'QUALITY_COMPLAINT', note: 'And the rest' });
    expect([more.status, more.body.error.code]).toEqual([422, 'REFUND_EXCEEDS_PAYMENT']);
    const fresh = await deposit('owner', 30_000);
    const larger = await post('manager', '/refunds', { originalPaymentId: fresh, amountPesewas: 30_001, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'One pesewa more than paid' });
    expect([larger.status, larger.body.error.code]).toEqual([422, 'REFUND_EXCEEDS_PAYMENT']);
    expect(await refunded(fresh)).toBe(0);
  });

  it('refuses beyond the cap and a payout by the maker even by direct SQL as hk_app', async () => {
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'REFUND', 'pay', $2, $3)", [docId, branchId, users.get('cashier')!.principalId]);
    await expect(
      app().query(
        `INSERT INTO pay.refund (id, original_payment_id, amount_pesewas, destination, reason_code, status, branch_id, created_by, updated_by)
         VALUES ($1, $2, 5001, 'ORIGINAL_METHOD', 'OVERCHARGED', 'PENDING_APPROVAL', $3, $4, $4)`,
        [docId, id('payment'), branchId, users.get('cashier')!.principalId],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_refund_cap' });
    await expect(app().query('UPDATE pay.refund SET paid_by = created_by, version = version + 1 WHERE id = $1', [id('refund')])).rejects.toMatchObject({ constraint: 'ck_refund_paid_by' });
    await expect(app().query('UPDATE pay.refund SET amount_pesewas = 1, version = version + 1 WHERE id = $1', [id('refund')])).rejects.toMatchObject({ constraint: 'ck_refund_transition' });
    await expect(app().query("UPDATE pay.refund SET status = 'PAID', version = version + 1 WHERE id = $1", [id('refund')])).rejects.toMatchObject({ constraint: 'ck_refund_transition' });
  });

  it('names what else a refund breaks: a payment still pending, a note its reason requires, store credit for a payment with no customer', async () => {
    const pending = await initiateCharge(api.server, as('cashier'), { amountPesewas: 2_000 });
    const refused = await post('cashier', '/refunds', { originalPaymentId: pending.body.id, amountPesewas: 1_000, destination: 'STORE_CREDIT', reasonCode: 'QUALITY_COMPLAINT' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['DESTINATION_NOT_AVAILABLE', 'NOTE_REQUIRED', 'PAYMENT_NOT_CLEARED']);
  });
});

describe('a refund is approved by a different person with step-up: the smallest team, and a single Owner (ADR-0017, the owner, 2026-11-16)', () => {
  it('refuses the Manager approving the refund she asked for', async () => {
    await step('manager');
    const own = await post('manager', `/iam/approvals/${id('approval')}/approve`, { reason: 'My own' });
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await refundState(id('refund'))).status).toBe('PENDING_APPROVAL');
  });

  it('refuses the Owner without a fresh step-up, then lets the Owner approve with one: the refund goes to the provider', async () => {
    tick(10 * 60_000);
    const stale = await post('owner', `/iam/approvals/${id('approval')}/approve`, { reason: 'Photographs seen' });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await step('owner');
    const approved = await post('owner', `/iam/approvals/${id('approval')}/approve`, { reason: 'Photographs seen' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await refundState(id('refund'))).status).toBe('APPROVED');
  });

  it('a single Owner cannot refund alone: the Owner’s own approval is refused and nobody at another branch may decide it', async () => {
    const payment = await deposit('soleOwner', 9_000, null);
    const asked = await post('soleOwner', '/refunds', { originalPaymentId: payment, amountPesewas: 9_000, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'Charged twice at the gate' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('soleOwner');
    const own = await post('soleOwner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Mine' });
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await step('manager');
    expect((await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Not my branch' })).status).toBe(403);
    await runRefundDispatch(api);
    expect((await refundState(asked.body.subject.id as string)).status).toBe('PENDING_APPROVAL');
    expect(await journalCount(database, asked.body.subject.id as string, 'pay.RefundPaid')).toBe(0);
  });

  it('gives the money back to the payment when the checker rejects the refund', async () => {
    const payment = await deposit('owner', 4_000);
    const asked = await post('cashier', '/refunds', { originalPaymentId: payment, amountPesewas: 4_000, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Asked for broilers' });
    expect(await refunded(payment)).toBe(4_000);
    await step('accountant');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/reject`, { reason: 'No return seen' })).status).toBe(200);
    expect((await refundState(asked.body.subject.id as string)).status).toBe('REJECTED');
    expect(await refunded(payment)).toBe(0);
  });
});

describe('an approved refund is paid once, through the provider or by hand (FR-PAY-012, FR-PAY-013)', () => {
  it('sends the approved refund to the provider with its id as the idempotency key, waits while it is processed, then posts Dr 2200 Cr 1120 once', async () => {
    fake.refundBehaviour = 'pending';
    await runRefundDispatch(api);
    expect((await refundState(id('refund'))).status).toBe('PROCESSING');
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/refund').map((c) => c.idempotencyKey)).toEqual([id('refund')]);
    expect([...fake.refunds.values()].map((r) => r.merchant_note), 'the refund carries its id in the note Paystack keeps').toEqual([`ref ${id('refund')}`]);
    tick(61_000);
    await runRefundDispatch(api);
    expect((await refundState(id('refund'))).status, 'still processing at the provider').toBe('PROCESSING');
    for (const r of fake.refunds.values()) r.status = 'processed';
    tick(61_000);
    await runRefundDispatch(api);
    expect((await refundState(id('refund'))).status).toBe('PAID');
    expect(await journalOf(database, id('refund'))).toEqual([
      ['2200', 'D', 25_000, 'Tema Cold Store Ltd (SEED)'],
      ['1120', 'C', 25_000, 'Paystack'],
    ]);
    tick(61_000);
    await runRefundDispatch(api);
    expect(await journalCount(database, id('refund'), 'pay.RefundPaid')).toBe(1);
  });

  it('refund fails after the stock was released: retried after 5 and 10 minutes, then FAILED with a break; the stock stays released', async () => {
    const payment = await deposit('owner', 40_000);
    const asked = await post('cashier', '/refunds', { originalPaymentId: payment, amountPesewas: 40_000, destination: 'ORIGINAL_METHOD', reasonCode: 'DAMAGED_IN_DELIVERY', note: 'Order cancelled, goats never left the pen' });
    ids.set('failing', asked.body.subject.id as string);
    await step('accountant');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Cancellation confirmed' })).status).toBe(200);
    const stockBefore = await stockFootprint();
    fake.refundBehaviour = 'reject';
    await runRefundDispatch(api);
    expect(await refundState(id('failing'))).toMatchObject({ status: 'FAILED', attempts: 1 });
    tick(4 * 60_000);
    await runRefundDispatch(api);
    expect((await refundState(id('failing'))).attempts, 'not before its five minutes').toBe(1);
    tick(61_000);
    await runRefundDispatch(api);
    expect((await refundState(id('failing'))).attempts).toBe(2);
    tick(10 * 60_000 + 1_000);
    await runRefundDispatch(api);
    expect(await refundState(id('failing'))).toEqual({ status: 'FAILED', attempts: 3, next: null, paidBy: null });
    const breaks = await admin().query<{ kind: string; amount: string }>("SELECT kind, amount_pesewas::text AS amount FROM pay.reconciliation_break WHERE refund_id = $1 AND status = 'OPEN'", [id('failing')]);
    expect(breaks.rows).toEqual([{ kind: 'REFUND_FAILED', amount: '40000' }]);
    tick(3_600_000);
    await runRefundDispatch(api);
    expect((await refundState(id('failing'))).attempts, 'it now waits for a person').toBe(3);
    expect(await journalCount(database, id('failing'), 'pay.RefundPaid')).toBe(0);
    expect(await stockFootprint()).toBe(stockBefore);
  });

  it('records the failed refund paid by hand with its reference, never by its maker, posting once and closing the break', async () => {
    expect((await post('cashier', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MTN-REV-0042' })).status).toBe(403);
    await step('accountant');
    const noReference = await post('accountant', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString() });
    expect([noReference.status, noReference.body.error.details[0].code]).toEqual([422, 'REFERENCE_REQUIRED']);
    const key = randomUUID();
    const paid = await post('accountant', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MTN-REV-0042' }, key);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body).toMatchObject({ status: 'PAID', amountPesewas: 40_000 });
    expect(await journalOf(database, id('failing'))).toEqual([
      ['2200', 'D', 40_000, 'Tema Cold Store Ltd (SEED)'],
      ['1120', 'C', 40_000, 'Paystack'],
    ]);
    const open = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.reconciliation_break WHERE refund_id = $1 AND status = 'OPEN'", [id('failing')]);
    expect(open.rows[0]!.n).toBe('0');
    const replay = await post('accountant', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MTN-REV-0042' }, key);
    expect([replay.status, replay.body.status]).toEqual([200, 'PAID']);
    const again = await post('accountant', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'MTN-REV-0043' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'NOT_PAYABLE']);
    expect(await journalCount(database, id('failing'), 'pay.RefundPaid')).toBe(1);
  });

  it('refuses the maker recording the payout of a refund a Manager approved', async () => {
    const payment = await deposit('owner', 3_000);
    const asked = await post('owner', '/refunds', { originalPaymentId: payment, amountPesewas: 3_000, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'Weighed short' });
    await step('manager');
    expect((await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Scale ticket checked' })).status).toBe(200);
    await step('owner');
    const own = await post('owner', `/refunds/${asked.body.subject.id as string}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'CASH-001' });
    expect([own.status, own.body.error.code]).toEqual([403, 'MAKER_CANNOT_CHECK']);
  });

  it('retries a refund that waited for a person: the provider pays it on the next attempt, once, and its break closes', async () => {
    const payment = await deposit('owner', 10_000);
    const asked = await post('cashier', '/refunds', { originalPaymentId: payment, amountPesewas: 10_000, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Wrong cut' });
    const refundId = asked.body.subject.id as string;
    await step('manager');
    await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked' });
    fake.refundBehaviour = 'down';
    for (const wait of [0, 5 * 60_000 + 1_000, 10 * 60_000 + 1_000]) {
      tick(wait);
      await runRefundDispatch(api);
    }
    expect((await refundState(refundId)).status).toBe('FAILED');
    expect((await post('cashier', `/refunds/${id('refund')}/retry`)).body.error.details[0].code, 'a paid refund is not retried').toBe('NOT_RETRYABLE');
    const retried = await post('cashier', `/refunds/${refundId}/retry`);
    expect([retried.status, retried.body.status]).toEqual([200, 'APPROVED']);
    fake.refundBehaviour = 'processed';
    tick(61_000);
    await runRefundDispatch(api);
    expect((await refundState(refundId)).status).toBe('PAID');
    expect(await journalCount(database, refundId, 'pay.RefundPaid')).toBe(1);
    const open = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.reconciliation_break WHERE refund_id = $1 AND status = 'OPEN'", [refundId]);
    expect(open.rows[0]!.n).toBe('0');
  });
});

describe('a provider refund is sent once even though Paystack ignores the idempotency key (A-218)', () => {
  it('finds a part refund Paystack made while its answer timed out by the note it carries, and never sends it twice', async () => {
    const payment = await deposit('owner', 8_000);
    const asked = await post('cashier', '/refunds', { originalPaymentId: payment, amountPesewas: 3_000, destination: 'ORIGINAL_METHOD', reasonCode: 'WRONG_ITEM', note: 'Wrong size of crate' });
    const refundId = asked.body.subject.id as string;
    await step('manager');
    expect((await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Crate returned' })).status).toBe(200);
    fake.refundBehaviour = 'timeout';
    await runRefundDispatch(api);
    fake.refundBehaviour = 'pending';
    const made = [...fake.refunds.values()].filter((r) => r.transaction_reference === referenceFor(payment));
    expect(made.map((r) => [r.amount, r.merchant_note]), 'one refund at Paystack, however often the answer timed out').toEqual([[3_000, `ref ${refundId}`]]);
    const { rows } = await admin().query<{ status: string; provider_reference: string | null }>('SELECT status, provider_reference FROM pay.refund WHERE id = $1', [refundId]);
    expect(rows[0], 'the retry after the timeout found it, and sent nothing').toEqual({ status: 'PROCESSING', provider_reference: String(made[0]!.id) });
    expect(fake.calls.filter((c) => c.method === 'POST' && c.path === '/refund' && c.idempotencyKey === refundId)).toHaveLength(1);
    made[0]!.status = 'processed';
    tick(61_000);
    await runRefundDispatch(api);
    expect((await refundState(refundId)).status).toBe('PAID');
    expect([...fake.refunds.values()].filter((r) => r.transaction_reference === referenceFor(payment))).toHaveLength(1);
    expect(await journalOf(database, refundId)).toEqual([
      ['2200', 'D', 3_000, 'Tema Cold Store Ltd (SEED)'],
      ['1120', 'C', 3_000, 'Paystack'],
    ]);
  });
});

describe('every refund write refuses the wrong role, in the handler (ADR-0035)', () => {
  it('refuses the storekeeper asking, reading, retrying or paying a refund, the cashier approving or paying one, and the accountant asking for one', async () => {
    const body = { originalPaymentId: id('payment'), amountPesewas: 1_000, destination: 'ORIGINAL_METHOD', reasonCode: 'OVERCHARGED', note: 'x' };
    expect((await post('storekeeper', '/refunds', body)).status).toBe(403);
    expect((await get('storekeeper', '/refunds')).status).toBe(403);
    expect((await get('storekeeper', `/refunds/${id('refund')}`)).status).toBe(403);
    expect((await post('storekeeper', `/refunds/${id('failing')}/retry`)).status).toBe(403);
    expect((await post('storekeeper', `/refunds/${id('failing')}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'X' })).status).toBe(403);
    expect((await post('accountant', '/refunds', body)).status).toBe(403);
    const asked = await post('cashier', '/refunds', { ...body, originalPaymentId: await deposit('owner', 1_000) });
    expect(asked.status).toBe(202);
    expect((await post('cashier', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'x' })).status).toBe(403);
    const page = await get('cashier', '/refunds?limit=2');
    expect([page.status, page.body.data.length, page.body.page.hasMore]).toEqual([200, 2, true]);
  });
});

describe('after the day’s refunds the books still tie (FR-FIN-011)', () => {
  it('sums the trial balance to exactly zero', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
  });
});
