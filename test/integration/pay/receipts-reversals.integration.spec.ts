import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { approveAndDeliver, initiateCharge, issueInvoice, journalCount, journalOf, referenceFor, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Payments recorded by hand, cheques, reversals and store credit (FR-PAY-001, FR-PAY-002, FR-PAY-009, FR-PAY-011,
 * FR-PAY-014, FR-PAY-015, ADR-0064). A cheque of 100,000 is PENDING and debits 1130 only, then clears 1130 into the bank
 * account it was paid into, or bounces and reopens its 100,000 item. A reversal waits for a different person with a
 * fresh step-up and posts the exact mirror of the payment's journal, reopening its allocations. Store credit of 6,000 is
 * never redeemed for 6,001, two redemptions of the last credit at once leave exactly one, and redeeming 6,000 debits
 * 2210. Every amount is asserted to the pesewa, and the trial balance still sums to zero.
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
const tick = (ms = 1_000) => clock.advanceBy(ms);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const TEMA = 'Tema Cold Store Ltd (SEED)';
const GCB = 'GCB current account (SEED)';
const today = () => toBusinessDate(clock.now());

async function invoice(gross: bigint): Promise<string> {
  return (await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, gross)).id;
}

function cheque(amount: number, allocations: { billingDocumentId: string; amountPesewas: number }[], extra: object = {}) {
  return { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: amount, customerId: id('tema'), bankAccountId: id('gcb'), externalReference: `CHQ-${randomUUID().slice(0, 6)}`, receivedAt: clock.now().toISOString(), allocations, ...extra };
}

function storeCredit(amount: number, allocations: { billingDocumentId: string; amountPesewas: number }[] = []) {
  return { id: randomUUID(), paymentMethodId: id('STORE_CREDIT'), amountPesewas: amount, customerId: id('tema'), receivedAt: clock.now().toISOString(), allocations };
}

async function outstanding(documentId: string): Promise<number> {
  const { rows } = await admin().query<{ o: string }>('SELECT outstanding_pesewas::text AS o FROM bil.document_settlement WHERE billing_document_id = $1', [documentId]);
  return Number(rows[0]!.o);
}

async function payment(paymentId: string): Promise<{ status: string; allocated: number; failure: string | null }> {
  const { rows } = await admin().query<{ status: string; allocated: string; failure_reason: string | null }>('SELECT status, allocated_pesewas::text AS allocated, failure_reason FROM pay.payment WHERE id = $1', [paymentId]);
  return { status: rows[0]!.status, allocated: Number(rows[0]!.allocated), failure: rows[0]!.failure_reason };
}

async function reversingOf(paymentId: string): Promise<string> {
  const { rows } = await admin().query<{ id: string; status: string }>('SELECT id, status FROM pay.payment WHERE reverses_payment_id = $1', [paymentId]);
  expect(rows[0]!.status).toBe('REVERSED');
  return rows[0]!.id;
}

async function creditBalance(): Promise<number> {
  const { rows } = await admin().query<{ b: string }>('SELECT balance_pesewas::text AS b FROM pay.store_credit_balance WHERE customer_id = $1', [id('tema')]);
  return rows[0] === undefined ? 0 : Number(rows[0].b);
}

/** Asks for a reversal as the Manager and has the Owner approve it with a fresh step-up. */
async function reverse(paymentId: string, reasonCode: string, note: string): Promise<void> {
  const asked = await post('manager', `/payments/${paymentId}/reverse`, { reasonCode, note });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await step('owner');
  const approved = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen the bank letter' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
}

async function refundToCredit(paymentId: string, amount: number): Promise<string> {
  const asked = await post('cashier', '/refunds', { originalPaymentId: paymentId, amountPesewas: amount, destination: 'STORE_CREDIT', reasonCode: 'QUALITY_COMPLAINT', note: 'Credit for two cracked crates' });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await step('owner');
  const approved = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Agreed with the customer' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return asked.body.subject.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', TEMA],
    ['goat', 'SELECT id FROM mdm.product WHERE sku = $1', 'LIV-GOAT'],
    ['gcb', 'SELECT id FROM fin.bank_account WHERE name = $1', GCB],
    ['wallet', 'SELECT id FROM fin.bank_account WHERE name = $1', 'MTN MoMo merchant wallet (SEED)'],
    ['CHEQUE', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'CHEQUE'],
    ['STORE_CREDIT', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'STORE_CREDIT'],
    ['MOMO', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'MOMO'],
    ['CASH', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'CASH'],
    ['BANK_TRANSFER', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'BANK_TRANSFER'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  const people: [string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Kofi Mensah', 'SALES', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const customer = await createUser(database, { name: 'Esi Asante', realm: 'CUSTOMER' });
  users.set('customer', customer);
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [customer.principalId, id('tema')]);
  sessions.set('customer', await login(api.server, customer));
  // The seeded farm keeps cheques and store credit off until the owner decides (A-115): the Owner turns them on.
  for (const code of ['CHEQUE', 'STORE_CREDIT']) {
    const { rows } = await admin().query<{ version: number }>('SELECT version FROM mdm.payment_method WHERE code = $1', [code]);
    const enabled = await consolePatch(api.server, as('owner'), `/v1/payment-methods/${id(code)}`).send({ version: rows[0]!.version, isEnabled: true });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a cheque is received PENDING in 1130 and clears into the bank (FR-PAY-001, FR-PAY-011)', () => {
  it('records a cheque of 100,000 against an invoice of 100,000: PENDING, debiting 1130 only, the invoice settled', async () => {
    ids.set('inv1', await invoice(100_000n));
    const key = randomUUID();
    const body = cheque(100_000, [{ billingDocumentId: id('inv1'), amountPesewas: 100_000 }], { chequeDueOn: today() });
    const recorded = await post('sales', '/payments', body, key);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body).toMatchObject({ id: body.id, paymentNo: null, status: 'PENDING', method: { kind: 'CHEQUE' }, amountPesewas: 100_000, allocatedPesewas: 100_000, unallocatedPesewas: 0, clearedAt: null, chequeDueOn: today(), bankAccount: { id: id('gcb'), kind: 'BANK' } });
    ids.set('cheque1', body.id);
    expect(await journalOf(database, body.id)).toEqual([
      ['1130', 'D', 100_000, null],
      ['1200', 'C', 100_000, TEMA],
    ]);
    expect(await outstanding(id('inv1'))).toBe(0);
    const replay = await post('sales', '/payments', body, key);
    expect([replay.status, replay.body.id]).toEqual([201, body.id]);
    const changed = await post('sales', '/payments', { ...body, amountPesewas: 99_999 }, key);
    expect(changed.status).toBe(409);
    expect(await journalCount(database, body.id, 'pay.PaymentCleared')).toBe(1);
  });

  it('clears it on the bank’s confirmation: Dr 1100 against the bank account, Cr 1130, once', async () => {
    tick(3 * 3_600_000);
    const refusedRole = await post('cashier', `/payments/${id('cheque1')}/clear-cheque`, { clearedOn: today() });
    expect(refusedRole.status).toBe(403);
    const tooEarly = await post('accountant', `/payments/${id('cheque1')}/clear-cheque`, { clearedOn: '2020-01-01' });
    expect([tooEarly.status, tooEarly.body.error.details[0].code]).toEqual([422, 'CLEARED_ON_OUT_OF_RANGE']);
    const cleared = await post('accountant', `/payments/${id('cheque1')}/clear-cheque`, { clearedOn: today() });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body).toMatchObject({ status: 'CLEARED', allocatedPesewas: 100_000 });
    expect(await journalOf(database, id('cheque1'), 'pay.ChequeCleared')).toEqual([
      ['1100', 'D', 100_000, GCB],
      ['1130', 'C', 100_000, null],
    ]);
    const again = await post('accountant', `/payments/${id('cheque1')}/clear-cheque`, { clearedOn: today() });
    expect([again.status, again.body.error.code, again.body.error.details[0].code]).toEqual([422, 'PAYMENT_REVERSAL_INVALID', 'CHEQUE_NOT_PENDING']);
    expect(await journalCount(database, id('cheque1'), 'pay.ChequeCleared')).toBe(1);
  });

  it('bounces a cheque on a different person’s approval with step-up: FAILED, the mirror posted, the 100,000 item open again', async () => {
    ids.set('inv2', await invoice(100_000n));
    const body = cheque(100_000, [{ billingDocumentId: id('inv2'), amountPesewas: 100_000 }]);
    expect((await post('accountant', '/payments', body)).status).toBe(201);
    ids.set('cheque2', body.id);
    const asked = await post('manager', `/payments/${body.id}/reverse`, { reasonCode: 'CHEQUE_DISHONOURED', note: 'Returned by Fidelity Bank: insufficient funds' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PAYMENT_REVERSAL', subject: { id: body.id, docType: 'PAYMENT' } });
    const reported = await admin().query<{ payload: { abuseCases: number[]; amountPesewas: number; requestedBy: string } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.PaymentReversalRequested' AND subject_id = $1", [body.id]);
    expect(reported.rows[0]!.payload).toMatchObject({ abuseCases: [32], amountPesewas: 100_000, requestedBy: users.get('manager')!.principalId });
    expect(await payment(body.id)).toEqual({ status: 'PENDING', allocated: 100_000, failure: null });
    expect(await outstanding(id('inv2'))).toBe(0);
    const twice = await post('accountant', `/payments/${body.id}/reverse`, { reasonCode: 'CHEQUE_DISHONOURED', note: 'Again' });
    expect([twice.status, twice.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['REVERSAL_PENDING']]);

    await step('manager');
    const own = await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Mine' });
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    tick(10 * 60_000);
    const stale = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Bank letter seen' });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const accountantApproves = await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Not mine to approve' });
    expect(accountantApproves.status).toBe(403);
    expect(await payment(body.id)).toEqual({ status: 'PENDING', allocated: 100_000, failure: null });

    await step('owner');
    const approved = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Bank letter seen' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await payment(body.id)).toEqual({ status: 'FAILED', allocated: 0, failure: 'Cheque dishonoured: Returned by Fidelity Bank: insufficient funds' });
    const reversing = await reversingOf(body.id);
    expect(await journalOf(database, reversing, 'pay.PaymentReversed')).toEqual([
      ['1130', 'C', 100_000, null],
      ['1200', 'D', 100_000, TEMA],
    ]);
    expect(await outstanding(id('inv2'))).toBe(100_000);
    const view = await get('accountant', `/payments/${body.id}`);
    expect(view.body).toMatchObject({ status: 'FAILED', allocatedPesewas: 0, unallocatedPesewas: 0 });
    expect(view.body.allocations.map((a: { direction: string; amountPesewas: number }) => [a.direction, a.amountPesewas])).toEqual([['APPLY', 100_000], ['UNAPPLY', 100_000]]);
    const mirror = await get('accountant', `/payments/${reversing}`);
    expect(mirror.body).toMatchObject({ status: 'REVERSED', reversesPaymentId: body.id, amountPesewas: 100_000, unallocatedPesewas: 0 });
    const open = await get('accountant', `/receivables/open-items?customerId=${id('tema')}`);
    expect(open.body.data.find((i: { billingDocument: { id: string } }) => i.billingDocument.id === id('inv2'))).toMatchObject({ grossPesewas: 100_000, allocatedPesewas: 0, outstandingPesewas: 100_000, daysOverdue: 0 });
  });

  it('reverses a cleared cheque recorded in error by mirroring both its receipt and its clearing', async () => {
    await reverse(id('cheque1'), 'RECORDED_IN_ERROR', 'Keyed against the wrong customer');
    expect(await payment(id('cheque1'))).toEqual({ status: 'REVERSED', allocated: 0, failure: null });
    expect(await journalOf(database, await reversingOf(id('cheque1')), 'pay.PaymentReversed')).toEqual([
      ['1130', 'C', 100_000, null],
      ['1200', 'D', 100_000, TEMA],
      ['1100', 'C', 100_000, GCB],
      ['1130', 'D', 100_000, null],
    ]);
    expect(await outstanding(id('inv1'))).toBe(100_000);
    const replayRefused = await post('manager', `/payments/${id('cheque1')}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'Again' });
    expect(replayRefused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['NOT_REVERSIBLE']);
  });
});

describe('reversing a 50,000 payment posts the mirror of its journal and reopens its allocations (FR-PAY-014)', () => {
  it('mirrors a 50,000 mobile money deposit and takes its allocation off, on the Owner’s approval of the Manager’s request', async () => {
    const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: 50_000, customerId: id('tema') });
    expect(started.status).toBe(201);
    tick();
    expect((await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string))).status).toBe(200);
    const momo = started.body.id as string;
    const inv = await invoice(50_000n);
    expect((await post('accountant', `/payments/${momo}/allocate`, { allocations: [{ billingDocumentId: inv, amountPesewas: 50_000 }] })).status).toBe(200);
    expect(await outstanding(inv)).toBe(0);
    const before = await journalOf(database, momo, 'pay.PaymentCleared');
    expect(before).toEqual([
      ['1120', 'D', 50_000, 'Paystack'],
      ['2200', 'C', 50_000, TEMA],
    ]);
    await reverse(momo, 'RECORDED_IN_ERROR', 'Customer paid twice by mistake; the provider reversed it');
    const reversing = await reversingOf(momo);
    expect(await journalOf(database, reversing, 'pay.PaymentReversed')).toEqual([
      ['1120', 'C', 50_000, 'Paystack'],
      ['2200', 'D', 50_000, TEMA],
    ]);
    const unapplied = await admin().query<{ lines: string }>(
      `SELECT string_agg(a.code || ' ' || l.side || ' ' || l.amount_pesewas, ', ' ORDER BY l.line_no) AS lines
         FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
        WHERE e.source_document_id = $1 AND e.event_code = 'pay.DepositAllocated' AND e.recorded_at = (SELECT max(recorded_at) FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'pay.DepositAllocated')`,
      [momo],
    );
    expect(unapplied.rows[0]!.lines).toBe('1200 D 50000, 2200 C 50000');
    expect(await outstanding(inv)).toBe(50_000);
    expect(await payment(momo)).toEqual({ status: 'REVERSED', allocated: 0, failure: null });
  });

  it('refuses what cannot be reversed: a reversing payment, a bank transfer still pending, a dishonoured reason for a non-cheque', async () => {
    const transfer = { id: randomUUID(), paymentMethodId: id('BANK_TRANSFER'), amountPesewas: 20_000, customerId: id('tema'), bankAccountId: id('gcb'), receivedAt: clock.now().toISOString() };
    const recorded = await post('accountant', '/payments', transfer);
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(recorded.body).toMatchObject({ status: 'PENDING', allocatedPesewas: 0 });
    expect(await journalOf(database, transfer.id)).toEqual([]);
    const pending = await post('manager', `/payments/${transfer.id}/reverse`, { reasonCode: 'CHEQUE_DISHONOURED', note: 'Not a cheque' });
    expect(pending.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['NOT_REVERSIBLE', 'REASON_NOT_FOR_METHOD']);
    const noNote = await post('manager', `/payments/${await reversingOf(id('cheque1'))}/reverse`, { reasonCode: 'OVERCHARGED' });
    expect(noNote.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['NOTE_REQUIRED', 'NOT_REVERSIBLE', 'REASON_UNKNOWN']);
  });
});

describe('store credit is a ledger in 2210, never redeemed beyond its balance (FR-PAY-015)', () => {
  it('refunds 6,000 to store credit on approval: Dr 2200, Cr 2210, a balance of 6,000 the customer and staff can read', async () => {
    const deposit = cheque(6_000, []);
    expect((await post('accountant', '/payments', deposit)).status).toBe(201);
    expect((await post('accountant', `/payments/${deposit.id}/clear-cheque`, { clearedOn: today() })).status).toBe(200);
    const refund = await refundToCredit(deposit.id, 6_000);
    expect(await journalOf(database, refund, 'pay.RefundPaid')).toEqual([
      ['2200', 'D', 6_000, TEMA],
      ['2210', 'C', 6_000, TEMA],
    ]);
    expect(await creditBalance()).toBe(6_000);
    const staff = await get('cashier', `/customers/${id('tema')}/store-credit`);
    expect(staff.status).toBe(200);
    expect(staff.body).toMatchObject({ customer: { id: id('tema') }, balancePesewas: 6_000, currency: 'GHS', entries: [{ direction: 'ISSUE', amountPesewas: 6_000, sourceDocument: { id: refund, docType: 'REFUND' } }] });
    const mine = await consoleGet(api.server, as('customer'), '/v1/me/store-credit');
    expect([mine.status, mine.body.balancePesewas]).toEqual([200, 6_000]);
    // A staff session is not a customer one: the customer realm's route does not know it.
    expect((await get('cashier', '/me/store-credit')).status).toBe(401);
    const refund2 = await get('manager', `/refunds/${refund}`);
    expect(refund2.body).toMatchObject({ status: 'PAID', destination: 'STORE_CREDIT', amountPesewas: 6_000 });
  });

  it('refuses 6,001 and redeems 6,000 against an invoice: Dr 2210, Cr 1200, the balance 0', async () => {
    const inv = await invoice(6_000n);
    const over = await post('cashier', '/payments', storeCredit(6_001));
    expect([over.status, over.body.error.code]).toEqual([422, 'STORE_CREDIT_INSUFFICIENT']);
    expect(await creditBalance()).toBe(6_000);
    const redeemed = await post('cashier', '/payments', storeCredit(6_000, [{ billingDocumentId: inv, amountPesewas: 6_000 }]));
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    expect(redeemed.body).toMatchObject({ status: 'CLEARED', method: { kind: 'STORE_CREDIT' }, allocatedPesewas: 6_000 });
    expect(await journalOf(database, redeemed.body.id as string)).toEqual([
      ['2210', 'D', 6_000, TEMA],
      ['1200', 'C', 6_000, TEMA],
    ]);
    expect(await creditBalance()).toBe(0);
    expect(await outstanding(inv)).toBe(0);
    ids.set('redemption', redeemed.body.id as string);
    ids.set('inv6000', inv);
  });

  it('gives the credit back when its redemption is reversed: the mirror credits 2210 and the invoice is open again', async () => {
    await reverse(id('redemption'), 'RECORDED_IN_ERROR', 'Redeemed against the wrong receipt');
    expect(await creditBalance()).toBe(6_000);
    expect(await journalOf(database, await reversingOf(id('redemption')), 'pay.PaymentReversed')).toEqual([
      ['2210', 'C', 6_000, TEMA],
      ['1200', 'D', 6_000, TEMA],
    ]);
    expect(await outstanding(id('inv6000'))).toBe(6_000);
  });

  it('lets exactly one of two redemptions of the last 6,000 at once succeed', async () => {
    const [first, second] = await Promise.all([post('cashier', '/payments', storeCredit(6_000)), post('sales', '/payments', storeCredit(6_000))]);
    expect([first.status, second.status].sort()).toEqual([201, 422]);
    expect([first, second].find((r) => r.status === 422)!.body.error.code).toBe('STORE_CREDIT_INSUFFICIENT');
    expect(await creditBalance()).toBe(0);
    const { rows } = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM pay.store_credit_entry WHERE customer_id = $1 AND direction = 'REDEEM'", [id('tema')]);
    expect(rows[0]!.n).toBe('2');
  });

  it('is held by the database: no redemption beyond the balance, no edit of an entry, no write of the balance, even as hk_app', async () => {
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PAYMENT', 'pay', $2, $3)", [docId, branchId, users.get('cashier')!.principalId]);
    await expect(
      app().query("INSERT INTO pay.store_credit_entry (id, customer_id, direction, amount_pesewas, source_document_id, branch_id, actor_id) VALUES ($1, $2, 'REDEEM', 1, $3, $4, $5)", [randomUUID(), id('tema'), docId, branchId, users.get('cashier')!.principalId]),
    ).rejects.toMatchObject({ constraint: 'ck_store_credit_balance' });
    await expect(app().query('UPDATE pay.store_credit_entry SET amount_pesewas = 1 WHERE customer_id = $1', [id('tema')])).rejects.toThrow();
    await expect(app().query('DELETE FROM pay.store_credit_entry WHERE customer_id = $1', [id('tema')])).rejects.toThrow();
    await expect(app().query('UPDATE pay.store_credit_balance SET balance_pesewas = 999999 WHERE customer_id = $1', [id('tema')])).rejects.toThrow(/permission denied/);
    await expect(admin().query('UPDATE pay.store_credit_entry SET amount_pesewas = 1 WHERE customer_id = $1', [id('tema')])).rejects.toThrow();
  });
});

describe('what a payment recorded by hand refuses, and the database’s rules (FR-PAY-001, FR-PAY-002, FR-PAY-005)', () => {
  it('never records mobile money or card by hand, nor cash without a shift, and names every rule a cheque breaks', async () => {
    const momo = await post('cashier', '/payments', { id: randomUUID(), paymentMethodId: id('MOMO'), amountPesewas: 5_000, receivedAt: clock.now().toISOString() });
    expect([momo.status, momo.body.error.code]).toEqual([422, 'PAYMENT_METHOD_REQUIRES_VERIFICATION']);
    const cash = await post('cashier', '/payments', { id: randomUUID(), paymentMethodId: id('CASH'), amountPesewas: 5_000, receivedAt: clock.now().toISOString() });
    expect(cash.body.error.details.map((d: { code: string }) => d.code)).toEqual(['TENDER_NOT_AVAILABLE']);
    const bad = await post('cashier', '/payments', { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: 5_000, customerId: id('tema'), bankAccountId: id('wallet'), receivedAt: new Date(clock.now().getTime() + 60_000).toISOString() });
    expect(bad.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['BANK_ACCOUNT_NOT_USABLE', 'CHEQUE_NUMBER_REQUIRED', 'RECEIVED_IN_FUTURE']);
    const inv = await invoice(1_000n);
    const transfer = await post('cashier', '/payments', { id: randomUUID(), paymentMethodId: id('BANK_TRANSFER'), amountPesewas: 1_000, customerId: id('tema'), bankAccountId: id('gcb'), receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: inv, amountPesewas: 1_000 }] });
    expect(transfer.body.error.details.map((d: { code: string }) => d.code)).toEqual(['ALLOCATION_WHILE_PENDING']);
    const noCustomer = await post('cashier', '/payments', { id: randomUUID(), paymentMethodId: id('STORE_CREDIT'), amountPesewas: 1_000, receivedAt: clock.now().toISOString() });
    expect(noCustomer.body.error.details.map((d: { code: string }) => d.code)).toEqual(['CUSTOMER_REQUIRED']);
  });

  it('refuses by direct SQL a reversal that leaves money allocated, a second reversing payment, and an edit of a cleared payment', async () => {
    const inv = await invoice(3_000n);
    const body = cheque(3_000, [{ billingDocumentId: inv, amountPesewas: 3_000 }]);
    expect((await post('accountant', '/payments', body)).status).toBe(201);
    await expect(app().query("UPDATE pay.payment SET status = 'FAILED', failure_reason = 'x', version = version + 1 WHERE id = $1", [body.id])).rejects.toMatchObject({ constraint: 'ck_payment_transition' });
    const reversed = id('cheque1');
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PAYMENT', 'pay', $2, $3)", [docId, branchId, users.get('cashier')!.principalId]);
    await expect(
      app().query(
        `INSERT INTO pay.payment (id, payment_method_id, method_kind, amount_pesewas, customer_id, bank_account_id, verification, received_at, cleared_at, status, reverses_payment_id,
                                  branch_id, created_by, updated_by, posted_at, posted_by)
         SELECT $1, payment_method_id, method_kind, amount_pesewas, customer_id, bank_account_id, verification, now(), now(), 'REVERSED', id, branch_id, $2, $2, now(), $2 FROM pay.payment WHERE id = $3`,
        [docId, users.get('cashier')!.principalId, reversed],
      ),
    ).rejects.toMatchObject({ constraint: 'uq_payment_reverses' });
    await expect(app().query('UPDATE pay.payment SET amount_pesewas = 1, version = version + 1 WHERE id = $1', [id('redemption')])).rejects.toMatchObject({ constraint: 'ck_payment_transition' });
    await expect(app().query("INSERT INTO pay.payment_reversal (id, payment_id, reason_code, note, status, branch_id, created_by, updated_by) VALUES ($1, $2, 'RECORDED_IN_ERROR', 'x', 'APPROVED', $3, $4, $4)", [randomUUID(), body.id, branchId, users.get('cashier')!.principalId])).rejects.toThrow();
  });
});

describe('the remaining PAY writes and reads refuse the wrong role, and the books balance (ADR-0035)', () => {
  it('refuses the Storekeeper every one, the Cashier and Sales clearing and reversing, and the Cashier the open items', async () => {
    const somePayment = id('cheque2');
    for (const [who, call] of [
      ['storekeeper', () => post('storekeeper', '/payments', cheque(1_000, []))],
      ['storekeeper', () => post('storekeeper', `/payments/${somePayment}/clear-cheque`, { clearedOn: today() })],
      ['storekeeper', () => post('storekeeper', `/payments/${somePayment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'x' })],
      ['storekeeper', () => get('storekeeper', `/customers/${id('tema')}/store-credit`)],
      ['storekeeper', () => get('storekeeper', '/receivables/open-items')],
      ['cashier', () => post('cashier', `/payments/${somePayment}/clear-cheque`, { clearedOn: today() })],
      ['cashier', () => post('cashier', `/payments/${somePayment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'x' })],
      ['sales', () => post('sales', `/payments/${somePayment}/clear-cheque`, { clearedOn: today() })],
      ['sales', () => post('sales', `/payments/${somePayment}/reverse`, { reasonCode: 'RECORDED_IN_ERROR', note: 'x' })],
      ['cashier', () => get('cashier', '/receivables/open-items')],
    ] as const) {
      const response = await call();
      expect([who, response.status, response.body.error?.code]).toEqual([who, 403, 'FORBIDDEN']);
    }
    // The customer's own session never reaches the staff read of anyone's credit.
    expect((await consoleGet(api.server, as('customer'), `/v1/customers/${id('tema')}/store-credit`)).status).toBe(401);
  });

  it('lists the open items with a total over everything the filter matches, to the pesewa', async () => {
    const page = await get('accountant', `/receivables/open-items?customerId=${id('tema')}&limit=2`);
    expect(page.status).toBe(200);
    const { rows } = await admin().query<{ total: string; n: string }>(
      `SELECT COALESCE(sum(s.outstanding_pesewas), 0)::text AS total, count(*)::text AS n FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id
        WHERE d.customer_id = $1 AND d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') AND s.outstanding_pesewas > 0`,
      [id('tema')],
    );
    expect(page.body.totalOutstandingPesewas).toBe(Number(rows[0]!.total));
    expect(page.body.data).toHaveLength(2);
    expect(page.body.page.hasMore).toBe(Number(rows[0]!.n) > 2);
    const overdue = await get('accountant', `/receivables/open-items?customerId=${id('tema')}&overdueOnly=true&asOf=2099-01-01`);
    expect(overdue.body.data[0].daysOverdue).toBeGreaterThan(26_000);
  });

  it('keeps the trial balance at exactly zero and 1130 at exactly the cheques still awaiting clearance', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
    const awaiting = await admin().query<{ n: string }>("SELECT COALESCE(sum(amount_pesewas), 0)::text AS n FROM pay.payment WHERE method_kind = 'CHEQUE' AND status = 'PENDING'");
    const ledger = await admin().query<{ n: string }>(
      "SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code = '1130'",
    );
    expect(ledger.rows[0]!.n).toBe(awaiting.rows[0]!.n);
    expect(Number(awaiting.rows[0]!.n)).toBe(3_000);
  });
});
