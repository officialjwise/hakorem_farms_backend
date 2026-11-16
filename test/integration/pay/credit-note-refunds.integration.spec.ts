import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { approveAndDeliver, balanceOf, initiateCharge, issueInvoice, journalCount, journalOf, referenceFor, runRefundDispatch, trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The refund against a credit note, and the cheque's bank payout (FR-PAY-012, FR-BIL-007, abuse case 12, ADR-0066; the
 * owner, 2026-11-16: "refunds are where till fraud lives"). An invoice of 86,240 paid in full is credited 30,000: the
 * credit note is issued although nothing was outstanding, and leaves 30,000 owed back to the customer. A refund against
 * it never exceeds the credit note's amount less what was already refunded against it, held by the database under the
 * credit note's lock (two refunds of the last 20,000 at once leave exactly one); it is approved, with step-up, by someone
 * other than its maker and other than the credit note's maker; paid, it posts Dr 1200 against the customer and Cr the
 * tender. A cheque goes back through a bank payout, paid by hand with its reference by someone other than the maker
 * (Cr 1100 against the bank account). Every amount is exact, and the trial balance still sums to zero.
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
const approve = (who: string, approvalId: string) => post(who, `/iam/approvals/${approvalId}/approve`, { reason: 'Checked against the credit note' });
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const TEMA = 'Tema Cold Store Ltd (SEED)';
const GCB = 'GCB current account (SEED)';
/** A TOTP sign-in counts as a fresh step-up for five minutes: past it, an approval needs a new one. */
const PAST_STEP_UP = 6 * 60_000;

async function invoice(gross: bigint): Promise<string> {
  return (await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: id('tema'), productId: id('goat') }, gross)).id;
}

/** A mobile money payment of the customer's, cleared by the provider's webhook and allocated to a document. */
async function paidByMobileMoney(documentId: string, amount: number): Promise<string> {
  const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: amount, customerId: id('tema') });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  tick();
  expect((await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string))).status).toBe(200);
  const allocated = await post('accountant', `/payments/${started.body.id as string}/allocate`, { allocations: [{ billingDocumentId: documentId, amountPesewas: amount }] });
  expect(allocated.status, JSON.stringify(allocated.body)).toBe(200);
  return started.body.id as string;
}

/** Raised by the Accountant, approved by the Manager with step-up: the credit note's maker is the Accountant. */
async function creditNote(documentId: string, amount: number): Promise<string> {
  const original = await get('accountant', `/billing-documents/${documentId}`);
  const asked = await post('accountant', `/billing-documents/${documentId}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Two goats returned lame', lines: [{ lineId: original.body.lines[0].id, amountPesewas: amount }] });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await step('manager');
  const approved = await approve('manager', asked.body.approvalRequestId as string);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return asked.body.subject.id as string;
}

function refundBody(paymentId: string, creditNoteId: string | null, amount: number, destination = 'ORIGINAL_METHOD') {
  return { originalPaymentId: paymentId, amountPesewas: amount, destination, reasonCode: 'QUALITY_COMPLAINT', note: 'Returned goats, credit note agreed', ...(creditNoteId === null ? {} : { creditNoteId }) };
}

async function settlement(documentId: string): Promise<{ outstanding: number; refundable: number; refunded: number; status: string }> {
  const { rows } = await admin().query<{ o: string; f: string; r: string; s: string }>(
    'SELECT outstanding_pesewas::text AS o, refundable_pesewas::text AS f, refunded_pesewas::text AS r, payment_status AS s FROM bil.document_settlement WHERE billing_document_id = $1',
    [documentId],
  );
  return { outstanding: Number(rows[0]!.o), refundable: Number(rows[0]!.f), refunded: Number(rows[0]!.r), status: rows[0]!.s };
}

async function refundRow(refundId: string): Promise<{ status: string; approvedBy: string | null; paidBy: string | null }> {
  const { rows } = await admin().query<{ status: string; approved_by: string | null; paid_by: string | null }>('SELECT status, approved_by, paid_by FROM pay.refund WHERE id = $1', [refundId]);
  return { status: rows[0]!.status, approvedBy: rows[0]!.approved_by, paidBy: rows[0]!.paid_by };
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
    ['CHEQUE', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'CHEQUE'],
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
  // The seeded farm keeps cheques off until the owner decides (A-115): the Owner turns them on.
  const { rows } = await admin().query<{ version: number }>("SELECT version FROM mdm.payment_method WHERE code = 'CHEQUE'");
  const enabled = await consolePatch(api.server, as('owner'), `/v1/payment-methods/${id('CHEQUE')}`).send({ version: rows[0]!.version, isEnabled: true });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  fake.refundBehaviour = 'processed';
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a credit note on a paid document leaves the credited money refundable (FR-BIL-007, ADR-0066)', () => {
  it('credits 30,000 of an invoice of 86,240 paid in full: issued, Dr 4200 Cr 1200 30,000, and 30,000 owed back', async () => {
    ids.set('receivableAtStart', String(await balanceOf(database, '1200', TEMA)));
    ids.set('inv', await invoice(86_240n));
    ids.set('momo', await paidByMobileMoney(id('inv'), 86_240));
    expect(await settlement(id('inv'))).toEqual({ outstanding: 0, refundable: 0, refunded: 0, status: 'PAID' });
    const receivableBefore = await balanceOf(database, '1200', TEMA);
    ids.set('crn', await creditNote(id('inv'), 30_000));
    expect(await journalOf(database, id('crn'), 'bil.CreditNoteIssued')).toEqual([
      ['4200', 'D', 30_000, null],
      ['1200', 'C', 30_000, TEMA],
    ]);
    expect(await balanceOf(database, '1200', TEMA)).toBe(receivableBefore - 30_000);
    expect(await settlement(id('inv'))).toEqual({ outstanding: 0, refundable: 30_000, refunded: 0, status: 'PAID' });
    const viewed = await get('accountant', `/billing-documents/${id('crn')}`);
    expect(viewed.body).toMatchObject({ kind: 'CREDIT_NOTE', status: 'ISSUED', grossPesewas: 30_000, settlement: { refundedPesewas: 0, refundablePesewas: 30_000 } });
    expect((await get('accountant', `/billing-documents/${id('inv')}`)).body.settlement).toMatchObject({ creditedPesewas: 30_000, outstandingPesewas: 0, refundablePesewas: 30_000 });
  });

  it('refuses a further allocation to a document that owes the customer money, held by the database', async () => {
    await expect(app().query("SELECT bil.apply_settlement($1, 1, 'APPLY')", [id('inv')])).rejects.toMatchObject({ constraint: 'ck_document_settlement_outstanding' });
  });
});

describe('a refund against the credit note: approved by neither its maker nor the credit note’s, with step-up (abuse case 12)', () => {
  it('asks for 10,000 against the credit note: 202, held against the credit note, nothing posted', async () => {
    const plain = await post('manager', '/refunds', refundBody(id('momo'), null, 10_000));
    expect([plain.status, plain.body.error?.code]).toEqual([422, 'REFUND_EXCEEDS_PAYMENT']);
    const asked = await post('manager', '/refunds', refundBody(id('momo'), id('crn'), 10_000));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ kind: 'REFUND', subject: { docType: 'REFUND' } });
    ids.set('refund1', asked.body.subject.id as string);
    ids.set('approval1', asked.body.approvalRequestId as string);
    expect(await settlement(id('crn'))).toMatchObject({ refunded: 10_000 });
    expect(await settlement(id('inv'))).toMatchObject({ outstanding: 0, refundable: 20_000, refunded: 10_000 });
    expect(await journalCount(database, id('refund1'), 'pay.RefundPaid')).toBe(0);
    const reported = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.RefundRequested' AND subject_id = $1", [id('refund1')]);
    expect(reported.rows[0]!.payload).toMatchObject({ abuseCases: [12], creditNoteId: id('crn'), creditNoteMakerId: users.get('accountant')!.principalId, requestedBy: users.get('manager')!.principalId });
    const view = await get('cashier', `/refunds/${id('refund1')}`);
    expect(view.body).toMatchObject({ status: 'PENDING_APPROVAL', amountPesewas: 10_000, creditNote: { id: id('crn'), docType: 'CREDIT_NOTE' } });
    expect(view.body.creditNote.number).toMatch(/^CRN-/);
  });

  it('refuses the refund’s maker, the credit note’s maker and an approver without step-up; the Owner with step-up approves', async () => {
    await step('manager');
    const byMaker = await approve('manager', id('approval1'));
    expect([byMaker.status, byMaker.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    await step('accountant');
    const byNoteMaker = await approve('accountant', id('approval1'));
    expect([byNoteMaker.status, byNoteMaker.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expect((await refundRow(id('refund1'))).status).toBe('PENDING_APPROVAL');
    const byCashier = await approve('cashier', id('approval1'));
    expect(byCashier.status).toBe(403);
    tick(PAST_STEP_UP);
    const unstepped = await approve('owner', id('approval1'));
    expect([unstepped.status, unstepped.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await step('owner');
    const approved = await approve('owner', id('approval1'));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await refundRow(id('refund1'))).toEqual({ status: 'APPROVED', approvedBy: users.get('owner')!.principalId, paidBy: null });
  });

  it('pays the 10,000 back through the provider and posts it once: Dr 1200 against the customer, Cr 1120 Paystack', async () => {
    await runRefundDispatch(api);
    expect((await refundRow(id('refund1'))).status).toBe('PAID');
    expect(await journalOf(database, id('refund1'), 'pay.RefundPaid')).toEqual([
      ['1200', 'D', 10_000, TEMA],
      ['1120', 'C', 10_000, 'Paystack'],
    ]);
    await runRefundDispatch(api);
    expect(await journalCount(database, id('refund1'), 'pay.RefundPaid')).toBe(1);
  });
});

describe('a refund never exceeds the credit note’s amount less what was already refunded against it, held by the database', () => {
  it('lets exactly one of two refunds of the last 20,000 through when they arrive at once', async () => {
    const both = await Promise.all([
      post('cashier', '/refunds', refundBody(id('momo'), id('crn'), 20_000)),
      post('sales', '/refunds', refundBody(id('momo'), id('crn'), 20_000)),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 422]);
    const refused = both.find((r) => r.status === 422)!;
    expect(refused.body.error.code).toBe('REFUND_EXCEEDS_CREDIT_NOTE');
    const accepted = both.find((r) => r.status === 202)!;
    ids.set('refund2', accepted.body.subject.id as string);
    ids.set('approval2', accepted.body.approvalRequestId as string);
    const { rows } = await admin().query<{ n: string; total: string }>("SELECT count(*)::text AS n, sum(amount_pesewas)::text AS total FROM pay.refund WHERE credit_note_id = $1 AND status <> 'REJECTED'", [id('crn')]);
    expect(rows[0]).toEqual({ n: '2', total: '30000' });
    expect(await settlement(id('crn'))).toMatchObject({ refunded: 30_000 });
    expect(await settlement(id('inv'))).toMatchObject({ outstanding: 0, refundable: 0, refunded: 30_000 });
  });

  it('refuses one pesewa more over the API and by direct SQL as hk_app', async () => {
    const more = await post('cashier', '/refunds', refundBody(id('momo'), id('crn'), 1));
    expect([more.status, more.body.error.code]).toEqual([422, 'REFUND_EXCEEDS_CREDIT_NOTE']);
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'REFUND', 'pay', $2, $3)", [docId, branchId, users.get('cashier')!.principalId]);
    await expect(
      app().query(
        `INSERT INTO pay.refund (id, original_payment_id, amount_pesewas, destination, reason_code, credit_note_id, status, branch_id, created_by, updated_by)
         VALUES ($1, $2, 1, 'ORIGINAL_METHOD', 'QUALITY_COMPLAINT', $3, 'PENDING_APPROVAL', $4, $5, $5)`,
        [docId, id('momo'), id('crn'), branchId, users.get('cashier')!.principalId],
      ),
    ).rejects.toMatchObject({ constraint: 'ck_credit_note_refund_cap' });
    await expect(app().query("SELECT * FROM bil.credit_note_refund($1, 1, 'RELEASE')", [id('crn')])).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the credit note’s maker as approver even by direct SQL, and gives the 20,000 back when the checker rejects it', async () => {
    await expect(
      app().query("UPDATE pay.refund SET status = 'APPROVED', updated_by = $2, version = version + 1 WHERE id = $1", [id('refund2'), users.get('accountant')!.principalId]),
    ).rejects.toMatchObject({ constraint: 'ck_refund_credit_note_checker' });
    await step('owner');
    const rejected = await post('owner', `/iam/approvals/${id('approval2')}/reject`, { reason: 'The customer asked for store credit instead' });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await refundRow(id('refund2'))).status).toBe('REJECTED');
    expect(await settlement(id('crn'))).toMatchObject({ refunded: 10_000 });
    expect(await settlement(id('inv'))).toMatchObject({ outstanding: 0, refundable: 20_000, refunded: 10_000 });
  });

  it('pays the last 20,000 to store credit at once on approval: Dr 1200 Cr 2210, both against the customer', async () => {
    const asked = await post('cashier', '/refunds', refundBody(id('momo'), id('crn'), 20_000, 'STORE_CREDIT'));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('owner');
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    expect(await journalOf(database, asked.body.subject.id as string, 'pay.RefundPaid')).toEqual([
      ['1200', 'D', 20_000, TEMA],
      ['2210', 'C', 20_000, TEMA],
    ]);
    expect(await settlement(id('inv'))).toMatchObject({ outstanding: 0, refundable: 0, refunded: 30_000 });
    expect((await get('accountant', `/billing-documents/${id('crn')}`)).body.settlement).toMatchObject({ refundedPesewas: 30_000, refundablePesewas: 0 });
  });

  it('refuses a credit note of another document’s payment and one that is not a credit note', async () => {
    const other = await invoice(5_000n);
    const otherPayment = await paidByMobileMoney(other, 5_000);
    const wrongPayment = await post('cashier', '/refunds', refundBody(otherPayment, id('crn'), 1));
    expect([wrongPayment.status, wrongPayment.body.error.code]).toEqual([422, 'REFUND_INVALID']);
    expect(wrongPayment.body.error.details.map((d: { code: string }) => d.code).sort()).toEqual(['REFUND_EXCEEDS_CREDIT_NOTE', 'REFUND_EXCEEDS_PAYMENT']);
    const notANote = await post('cashier', '/refunds', refundBody(id('momo'), id('inv'), 1));
    expect([notANote.status, notANote.body.error.code, notANote.body.error.details]).toEqual([422, 'REFUND_INVALID', [expect.objectContaining({ field: '/creditNoteId', code: 'CREDIT_NOTE_NOT_AVAILABLE' })]]);
  });
});

describe('a cheque is refunded to its original method through a bank payout (ADR-0066)', () => {
  it('credits 12,500 of a 50,000 invoice paid by a cleared cheque, and pays it out of the bank by hand with its reference', async () => {
    ids.set('inv2', await invoice(50_000n));
    const cheque = { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: 50_000, customerId: id('tema'), bankAccountId: id('gcb'), externalReference: 'CHQ-104417', receivedAt: clock.now().toISOString(), allocations: [{ billingDocumentId: id('inv2'), amountPesewas: 50_000 }] };
    expect((await post('accountant', '/payments', cheque)).status).toBe(201);
    const today = (await get('accountant', `/payments/${cheque.id}`)).body.receivedAt.slice(0, 10) as string;
    const cleared = await post('accountant', `/payments/${cheque.id}/clear-cheque`, { clearedOn: today });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    const note = await creditNote(id('inv2'), 12_500);
    const asked = await post('manager', '/refunds', refundBody(cheque.id, note, 12_500));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const refundId = asked.body.subject.id as string;
    await step('owner');
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    await runRefundDispatch(api);
    expect((await refundRow(refundId)).status, 'a bank payout never goes to the provider').toBe('APPROVED');
    await step('manager');
    const byMaker = await post('manager', `/refunds/${refundId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'GCB-TRF-88120' });
    expect([byMaker.status, byMaker.body.error.code]).toEqual([403, 'MAKER_CANNOT_CHECK']);
    await step('accountant');
    const noReference = await post('accountant', `/refunds/${refundId}/mark-paid`, { paidAt: clock.now().toISOString() });
    expect([noReference.status, noReference.body.error?.code]).toEqual([422, 'REFUND_INVALID']);
    const paid = await post('accountant', `/refunds/${refundId}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'GCB-TRF-88120' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(await refundRow(refundId)).toEqual({ status: 'PAID', approvedBy: users.get('owner')!.principalId, paidBy: users.get('accountant')!.principalId });
    expect(await journalOf(database, refundId, 'pay.RefundPaid')).toEqual([
      ['1200', 'D', 12_500, TEMA],
      ['1100', 'C', 12_500, GCB],
    ]);
  });

  it('pays an unallocated cheque deposit back out of the bank too: Dr 2200 Cr 1100 against the bank account', async () => {
    const cheque = { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: 7_500, customerId: id('tema'), bankAccountId: id('gcb'), externalReference: 'CHQ-104418', receivedAt: clock.now().toISOString(), allocations: [] };
    expect((await post('accountant', '/payments', cheque)).status).toBe(201);
    const today = (await get('accountant', `/payments/${cheque.id}`)).body.receivedAt.slice(0, 10) as string;
    expect((await post('accountant', `/payments/${cheque.id}/clear-cheque`, { clearedOn: today })).status).toBe(200);
    const asked = await post('cashier', '/refunds', refundBody(cheque.id, null, 7_500));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await step('owner');
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    await step('accountant');
    const paid = await post('accountant', `/refunds/${asked.body.subject.id as string}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'GCB-TRF-88121' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(await journalOf(database, asked.body.subject.id as string, 'pay.RefundPaid')).toEqual([
      ['2200', 'D', 7_500, TEMA],
      ['1100', 'C', 7_500, GCB],
    ]);
  });
});

describe('every refund write refuses the wrong role, and the books still balance', () => {
  it('refuses the Storekeeper a refund, the Cashier and Sales an approval and a payout', async () => {
    const byStorekeeper = await post('storekeeper', '/refunds', refundBody(id('momo'), id('crn'), 1));
    expect(byStorekeeper.status).toBe(403);
    const asked = await post('cashier', '/refunds', refundBody(id('momo'), null, 1));
    expect(asked.status).toBe(422);
    const anyRefund = id('refund1');
    for (const who of ['cashier', 'sales', 'storekeeper']) {
      expect((await post(who, `/refunds/${anyRefund}/mark-paid`, { paidAt: clock.now().toISOString(), externalReference: 'X-1' })).status).toBe(403);
    }
  });

  it('sums the trial balance to exactly zero and leaves the customer\'s receivable where it started, to the pesewa', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
    // Every invoice here was paid, credited and refunded in full: 86,240 - 86,240 - 30,000 + 10,000 + 20,000, 50,000 -
    // 50,000 - 12,500 + 12,500 and 5,000 - 5,000 net to nothing on 1200; the 7,500 cheque deposit never touched it.
    expect(await balanceOf(database, '1200', TEMA)).toBe(Number(id('receivableAtStart')));
    expect(await settlement(id('inv2'))).toEqual({ outstanding: 0, refundable: 0, refunded: 12_500, status: 'PAID' });
  });

});
