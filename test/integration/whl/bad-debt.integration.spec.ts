import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountHolds } from '../../../src/modules/whl';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The bad-debt write-off (FR-WHL-012, ADR-0090, A-321), the gate of B10 continued 3: asked by the Accountant, nothing
 * moves until the Owner, never the person who asked, approves with step-up, and the database holds that too; on
 * approval Dr 6940 Cr 1200 against the customer exactly, the invoice row untouched, the open item closed in BIL with a
 * link to the journal, and the ageing of B10 continued 2 shows it closed from that day while still tying to 1200. No
 * payment can then be put onto the amount written off; money the customer pays afterwards is raised, never posted as
 * a recovery. Every figure is read back from BIL's, FIN's and WHL's own tables in SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const patch = (who: string, path: string, body: object) => consolePatch(api.server, as(who), `/v1${path}`).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const today = () => toBusinessDate(clock.now());
const DAY = 86_400_000;
let customers = 0;
const SEED_PASSWORD = `Seed-${randomUUID()}`;

async function approve(who: string, approvalRequestId: string) {
  await stepUp(api.server, as(who) as TotpSession, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the collection file' });
}

async function account(name: string): Promise<string> {
  const customerId = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-6${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  expect((await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: 0, paymentTermsDays: 30 })).status).toBe(201);
  return customerId;
}
const invoice = (customerId: string, gross: number, dueDate = today()) => issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId, productId: id('goat') }, BigInt(gross), dueDate);
const cheque = (customerId: string, allocations: { billingDocumentId: string; amountPesewas: number }[], amount: number) =>
  post('accountant', '/payments', { id: randomUUID(), paymentMethodId: id('CHEQUE'), amountPesewas: amount, customerId, bankAccountId: id('gcb'), externalReference: `CHQ-${randomUUID().slice(0, 6)}`, receivedAt: clock.now().toISOString(), allocations });

/** 1200 against the customer's party, and 6940, straight from the journal. */
async function ledgerTruth(customerId: string): Promise<{ receivable: number; badDebts: number }> {
  const { rows } = await admin().query<{ code: string; n: string }>(
    `SELECT a.code, COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE (a.code = '1200' AND p.ref_id = $1) OR (a.code = '6940' AND l.journal_entry_id IN (SELECT id FROM fin.journal_entry WHERE event_code = 'whl.BadDebtWrittenOff' AND event_subject_id IN (SELECT id FROM whl.bad_debt_write_off WHERE customer_id = $1)))
      GROUP BY a.code`,
    [customerId],
  );
  const of = (code: string) => Number(rows.find((r) => r.code === code)?.n ?? '0');
  return { receivable: of('1200'), badDebts: of('6940') };
}
const settlement = async (documentId: string) =>
  (await admin().query<{ outstanding: string; written_off: string; allocated: string; payment_status: string }>(
    'SELECT outstanding_pesewas::text AS outstanding, written_off_pesewas::text AS written_off, allocated_pesewas::text AS allocated, payment_status FROM bil.document_settlement WHERE billing_document_id = $1',
    [documentId],
  )).rows[0]!;
const invoiceRow = async (documentId: string) => (await admin().query('SELECT * FROM bil.billing_document WHERE id = $1', [documentId])).rows[0] as Record<string, unknown>;
const ageingOf = async (customerId: string, asOf: string) => (await get('accountant', `/receivables/ageing?customerId=${customerId}&asOf=${asOf}`)).body;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  // The tests move the clock on by months: the sessions live long enough (test settings only).
  const long = String(800 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('goat', (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).rows[0]!.id);
  ids.set('gcb', (await admin().query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id);
  ids.set('CHEQUE', (await admin().query<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'CHEQUE'")).rows[0]!.id);
  const tema = await createBranch(database, 'TMA');
  const people: [string, string, ('OWNER' | 'MANAGER' | 'ACCOUNTANT' | 'SALES' | 'CASHIER' | 'STOREKEEPER')[], boolean, string?][] = [
    ['owner', 'Kwabena Owusu', ['OWNER'], true],
    ['secondOwner', 'Ama Serwaa', ['OWNER'], true],
    ['manager', 'Akosua Boateng', ['MANAGER'], true],
    ['accountant', 'Yaw Agyeman', ['ACCOUNTANT'], true],
    ['sales', 'Esi Appiah', ['SALES'], false],
    ['cashier', 'Adwoa Darko', ['CASHIER'], false],
    ['storekeeper', 'Kwesi Ofori', ['STOREKEEPER'], false],
    ['temaAccountant', 'Kofi Mensah', ['ACCOUNTANT'], true, tema.branchId],
  ];
  for (const [who, name, roles, privileged, at] of people) {
    const user = await createUser(database, { name, grants: roles.map((role) => ({ role, branchId: at ?? branchId })) });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const { rows } = await admin().query<{ version: number }>("SELECT version FROM mdm.payment_method WHERE code = 'CHEQUE'");
  expect((await patch('owner', `/payment-methods/${id('CHEQUE')}`, { version: rows[0]!.version, isEnabled: true })).status).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('writing off a bad debt (FR-WHL-012)', () => {
  it('answers 202 and moves nothing; on the Owner’s approval posts Dr 6940 Cr 1200 of 50,000 against the customer and closes the open item, the invoice untouched', async () => {
    const customerId = await account('Bethel Youth Wing (TEST)');
    const owed = await invoice(customerId, 50_000);
    clock.set(new Date(clock.now().getTime() + 400 * DAY));
    const before = await invoiceRow(owed.id);
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 50_000, badDebts: 0 });

    const asked = await post('accountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 50_000, reason: 'Church treasurer relocated; two years overdue' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'BAD_DEBT_WRITE_OFF', subject: { docType: 'BAD_DEBT_WRITE_OFF', number: null } });
    expect(await settlement(owed.id)).toMatchObject({ outstanding: '50000', written_off: '0' });
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 50_000, badDebts: 0 });

    const approved = await approve('owner', asked.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 0, badDebts: 50_000 });
    const lines = await admin().query<{ code: string; side: string; amount: string; party: string | null }>(
      `SELECT a.code, l.side, l.amount_pesewas::text AS amount, p.ref_id AS party FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
         LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE e.event_code = 'whl.BadDebtWrittenOff' AND e.event_subject_id = $1 ORDER BY l.side DESC`,
      [asked.body.subject.id],
    );
    expect(lines.rows).toEqual([
      { code: '6940', side: 'D', amount: '50000', party: null },
      { code: '1200', side: 'C', amount: '50000', party: customerId },
    ]);
    expect(await settlement(owed.id)).toEqual({ outstanding: '0', written_off: '50000', allocated: '0', payment_status: 'UNPAID' });
    expect(await invoiceRow(owed.id)).toEqual(before);
    const writeOff = await admin().query<{ journal_entry_id: string; entry: string; requested_by: string; approved_by: string; amount: string; written_off_on: string }>(
      `SELECT w.journal_entry_id, e.id AS entry, w.requested_by, w.approved_by, w.amount_pesewas::text AS amount, w.written_off_on::text
         FROM whl.bad_debt_write_off w JOIN fin.journal_entry e ON e.event_subject_id = w.id AND e.event_code = 'whl.BadDebtWrittenOff' WHERE w.id = $1`,
      [asked.body.subject.id],
    );
    expect(writeOff.rows).toEqual([{ journal_entry_id: writeOff.rows[0]!.entry, entry: writeOff.rows[0]!.entry, requested_by: users.get('accountant')!.principalId, approved_by: users.get('owner')!.principalId, amount: '50000', written_off_on: today() }]);
    // The ageing shows it closed from today, open the day before, and ties to 1200 on both.
    const now = await ageingOf(customerId, today());
    expect([now.totals.totalPesewas, now.totals.ledgerPesewas, now.totals.notAgedPesewas]).toEqual([0, 0, 0]);
    const yesterday = await ageingOf(customerId, addDays(today(), -1));
    expect([yesterday.totals.daysOver90Pesewas, yesterday.totals.totalPesewas, yesterday.totals.ledgerPesewas, yesterday.totals.notAgedPesewas]).toEqual([50_000, 50_000, 50_000, 0]);
    // A replay of the ask answers the same; nothing is written off twice.
    expect((await post('accountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 1, reason: 'Again' })).body.error.details).toEqual([expect.objectContaining({ code: 'NOTHING_OUTSTANDING' })]);
    expect((await admin().query('SELECT 1 FROM platform.audit_event WHERE entity_id = $1 AND action = $2', [asked.body.subject.id, 'WRITE_OFF'])).rowCount).toBe(1);
  });

  it('writes off part of an item to the pesewa; no payment can then reach the part written off, and the rest is paid exactly', async () => {
    const customerId = await account('Part Paid Caterers (TEST)');
    const owed = await invoice(customerId, 50_000);
    clock.set(new Date(clock.now().getTime() + 200 * DAY));
    const asked = await post('accountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 20_001, reason: 'Disputed portion never recoverable' });
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    expect(await settlement(owed.id)).toMatchObject({ outstanding: '29999', written_off: '20001', payment_status: 'UNPAID' });
    const over = await cheque(customerId, [{ billingDocumentId: owed.id, amountPesewas: 30_000 }], 30_000);
    expect([over.status, over.body.error?.code], JSON.stringify(over.body)).toEqual([422, 'ALLOCATION_EXCEEDS_AVAILABLE']);
    const exact = await cheque(customerId, [{ billingDocumentId: owed.id, amountPesewas: 29_999 }], 29_999);
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(await settlement(owed.id)).toMatchObject({ outstanding: '0', written_off: '20001', allocated: '29999', payment_status: 'PART_PAID' });
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 0, badDebts: 20_001 });
    // The database itself refuses an allocation onto the amount written off, whatever the code asks.
    expect(await sqlStateOf(admin().query("SELECT bil.apply_settlement($1, 1, 'APPLY', now())", [owed.id]))).toBe('HK010');
  });

  it('refuses more than is outstanding, nothing, a second ask while one waits, and another branch’s document', async () => {
    const customerId = await account('Rules Traders (TEST)');
    const owed = await invoice(customerId, 10_000);
    const refused = async (who: string, body: object) => (await post(who, '/receivables/write-offs', body)).body.error?.details?.map((d: { code: string }) => d.code);
    expect(await refused('accountant', { billingDocumentId: owed.id, amountPesewas: 10_001, reason: 'x' })).toEqual(['MORE_THAN_OUTSTANDING']);
    expect(await refused('accountant', { billingDocumentId: owed.id, amountPesewas: 0, reason: 'x' })).toEqual(['NOT_POSITIVE']);
    expect((await post('accountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 10_000, reason: 'x' })).status).toBe(202);
    expect(await refused('accountant', { billingDocumentId: owed.id, amountPesewas: 1, reason: 'y' })).toEqual(['APPROVAL_PENDING']);
    expect((await post('temaAccountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 1, reason: 'x' })).status).toBe(404);
    expect((await post('accountant', '/receivables/write-offs', { billingDocumentId: randomUUID(), amountPesewas: 1, reason: 'x' })).status).toBe(404);
  });
});

describe('maker and checker (FR-WHL-012, ADR-0017)', () => {
  it('refuses the ask to every role but the Accountant and the Owner, and the approval to all but another Owner', async () => {
    const customerId = await account('Roles Bar (TEST)');
    const owed = await invoice(customerId, 7_000);
    const body = { billingDocumentId: owed.id, amountPesewas: 7_000, reason: 'Gone away' };
    for (const who of ['manager', 'sales', 'cashier', 'storekeeper']) expect((await post(who, '/receivables/write-offs', body)).status, who).toBe(403);
    const asked = await post('owner', '/receivables/write-offs', body);
    expect(asked.status).toBe(202);
    // The maker is never the checker: the Owner who asked cannot approve it; the Manager and the Accountant may not.
    const self = await approve('owner', asked.body.approvalRequestId as string);
    expect(self.status).not.toBe(200);
    for (const who of ['manager', 'accountant']) expect((await approve(who, asked.body.approvalRequestId as string)).status, who).not.toBe(200);
    expect(await settlement(owed.id)).toMatchObject({ outstanding: '7000', written_off: '0' });
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 7_000, badDebts: 0 });
    expect((await approve('secondOwner', asked.body.approvalRequestId as string)).status).toBe(200);
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 0, badDebts: 7_000 });
  });

  it('is held by the database: no applied ask decided by its maker, no write-off its maker approved or without its approved ask, insert-only', async () => {
    const customerId = await account('Database Lodge (TEST)');
    const owed = await invoice(customerId, 3_000);
    const asked = await post('accountant', '/receivables/write-offs', { billingDocumentId: owed.id, amountPesewas: 3_000, reason: 'Gone away' });
    const requestId = asked.body.subject.id as string;
    const maker = users.get('accountant')!.principalId;
    const owner = users.get('owner')!.principalId;
    expect(await sqlStateOf(app().query("UPDATE whl.bad_debt_write_off_request SET status = 'APPLIED', posted_at = now(), posted_by = $2, version = version + 1 WHERE id = $1", [requestId, maker]))).toBe('23514');
    const entry = (await admin().query<{ id: string }>('SELECT id FROM fin.journal_entry LIMIT 1')).rows[0]!.id;
    const insert = (approvedBy: string) =>
      app().query(
        `INSERT INTO whl.bad_debt_write_off (id, customer_id, billing_document_id, branch_id, amount_pesewas, written_off_on, journal_entry_id, requested_by, approved_by, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, 3000, $5::date, $6, $7, $8, now(), $8)`,
        [requestId, customerId, owed.id, branchId, today(), entry, maker, approvedBy],
      );
    // The trigger refuses a write-off with no approved ask, whoever approved it; beneath it, the check refuses its maker.
    expect(await sqlStateOf(insert(owner))).toBe('HK010');
    expect(await sqlStateOf(insert(maker))).toBe('HK010');
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE whl.bad_debt_write_off DISABLE TRIGGER trg_bad_debt_write_off_check');
      const checked = client.query(
        `INSERT INTO whl.bad_debt_write_off (id, customer_id, billing_document_id, branch_id, amount_pesewas, written_off_on, journal_entry_id, requested_by, approved_by, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, 3000, $5::date, $6, $7, $7, now(), $7)`,
        [requestId, customerId, owed.id, branchId, today(), entry, maker],
      );
      expect(await sqlStateOf(checked)).toBe('23514');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    expect(await sqlStateOf(app().query('UPDATE whl.bad_debt_write_off SET amount_pesewas = 1 WHERE id = $1', [requestId]))).toBe('42501');
    expect(await sqlStateOf(admin().query('UPDATE whl.bad_debt_write_off SET amount_pesewas = 1 WHERE id = $1', [requestId]))).toBe('HK001');
    expect(await sqlStateOf(admin().query('DELETE FROM whl.bad_debt_write_off WHERE id = $1', [requestId]))).toBe('HK001');
    expect(await sqlStateOf(admin().query("UPDATE whl.bad_debt_write_off_request SET reason = 'changed', version = version + 1 WHERE id = $1", [requestId]))).toBe('HK004');
  });
});

describe('after a write-off (ADR-0090)', () => {
  it('raises money the customer pays afterwards for review, posts no recovery, and never releases a system hold by itself', async () => {
    const customerId = await account('Recovery Hotel (TEST)');
    const old = await invoice(customerId, 40_000);
    clock.set(new Date(clock.now().getTime() + 60 * DAY));
    // The overdue job holds the account (the system's hold).
    await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(AccountHolds).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect((await admin().query('SELECT status, hold_automatic FROM whl.business_account WHERE customer_id = $1', [customerId])).rows).toEqual([{ status: 'ON_HOLD', hold_automatic: true }]);
    const asked = await post('accountant', '/receivables/write-offs', { billingDocumentId: old.id, amountPesewas: 40_000, reason: 'Owner of the hotel absconded' });
    expect((await approve('owner', asked.body.approvalRequestId as string)).status).toBe(200);
    const worker = documentWorker(api, database, clock);
    await worker.settle();
    // Nothing is past due any more, yet the hold stays: a written-off debt was never paid.
    const runRelease = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(AccountHolds).releasePaid({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
    expect(await runRelease()).not.toContain(customerId);
    // The customer pays 5,000 on a new invoice: it is applied there, and raised as money from a written-off customer.
    const fresh = await invoice(customerId, 5_000);
    expect((await cheque(customerId, [{ billingDocumentId: fresh.id, amountPesewas: 5_000 }], 5_000)).status).toBe(201);
    await worker.settle();
    expect((await admin().query('SELECT status FROM whl.business_account WHERE customer_id = $1', [customerId])).rows).toEqual([{ status: 'ON_HOLD' }]);
    const raised = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'whl.WrittenOffCustomerPaid' AND subject_id = $1", [customerId]);
    expect(raised.rows.map((r) => r.payload)).toEqual([expect.objectContaining({ customerId, sourceEventType: 'pay.PaymentCleared', amountPesewas: 5_000, writtenOffPesewas: 40_000 })]);
    await worker.settle();
    expect((await admin().query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'whl.WrittenOffCustomerPaid' AND subject_id = $1", [customerId])).rows[0]).toEqual({ n: 1 });
    expect(await ledgerTruth(customerId)).toEqual({ receivable: 0, badDebts: 40_000 });
    expect(await settlement(old.id)).toMatchObject({ outstanding: '0', written_off: '40000', allocated: '0' });
    clock.set(new Date(clock.now().getTime() + DAY));
  });
});
