import { createHash, randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Payments } from '../../../src/modules/pay';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { ledgerIds, postManualJournal, stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift } from '../../support/till';

/**
 * Customer statements (FR-WHL-009, ADR-0085), the gate of B08 continued 2d: a statement for a period lists the
 * customer's issued documents and their settlement and ties to the ledger's 1200 for the customer's subledger party and
 * period, to the pesewa, asserted against SQL sums taken straight from `bil.billing_document` and `fin.journal_line`,
 * never from the code under test; it is numbered from its own gap-free series, rendered after commit and archived
 * exactly once, also under concurrent requests; every statement operation refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let uow: UnitOfWork;
let worker: DocumentWorker;
let branchId: string;
let today: string;
let yesterday: string;
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
const till = { id: '019a8000-0000-7000-8000-00000000b7a1', code: 'T7' };
let customers = 0;

/** A customer of the farm with nothing posted yet, and its party on 1200 (as the first posting handler would make it). */
async function newCustomer(name: string): Promise<{ id: string; party: string }> {
  const customerId = randomUUID();
  const party = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-8${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  await admin().query("INSERT INTO fin.subledger_party (id, kind, ref_id, display_name) VALUES ($1, 'CUSTOMER', $2, $3)", [party, customerId, name]);
  return { id: customerId, party };
}

/** A zero-rated invoice of exactly the gross, issued today by the Accountant. */
const invoice = (customerId: string, gross: bigint) => issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId, productId: id('eggs') }, gross);

/** A credit note raised by the Accountant and approved by the Owner with step-up, issued today. */
async function creditNote(invoiceId: string, amount: number): Promise<string> {
  const original = await get('accountant', `/billing-documents/${invoiceId}`);
  const asked = await post('accountant', `/billing-documents/${invoiceId}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Cracked trays on delivery', lines: [{ lineId: original.body.lines[0].id, amountPesewas: amount }] });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await stepUp(api.server, as('owner') as TotpSession, clock);
  const approved = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked against the delivery photographs' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return asked.body.subject.id as string;
}

/** Cash taken at the till in the cashier's open shift, all of it allocated to the invoice: a PAY payment like any other. */
function tillPayment(customerId: string, invoiceId: string, amount: bigint) {
  const cashier = actorOf('cashier');
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'statement test', actor: cashier }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: [`JOURNAL:${today.slice(0, 4)}:${branchId}`] }, async (tx) =>
      api.app.get(Payments).recordIn(tx, cashier, {
        branchId,
        channel: 'WHOLESALE',
        methodCode: 'CASH',
        amountPesewas: amount,
        customerId,
        orderDocumentId: null,
        shiftDocumentId: await openTestShift(tx, cashier.principalId, branchId),
        register: till,
        receivedAt: clock.now(),
        allocations: [{ billingDocumentId: invoiceId, amountPesewas: amount }],
      }),
    ),
  );
}

/** The figures taken straight from SQL, never from the code under test. */
async function ledgerTruth(customerId: string, party: string, from: string, to: string) {
  const one = async (sql: string, values: unknown[]) => Number((await admin().query<{ n: string }>(sql, values)).rows[0]!.n);
  const documents = (kinds: string[]) =>
    one(
      `SELECT COALESCE(sum(gross_pesewas), 0)::text AS n FROM bil.billing_document
        WHERE customer_id = $1 AND branch_id = $2 AND status = 'ISSUED' AND kind = ANY($3::text[]) AND issue_date BETWEEN $4::date AND $5::date`,
      [customerId, branchId, kinds, from, to],
    );
  const receivable = (where: string, values: unknown[]) =>
    one(
      `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE a.code = '1200' AND l.subledger_party_id = $1 AND l.branch_id = $2 AND ${where}`,
      [party, branchId, ...values],
    );
  return {
    opening: await receivable('l.posting_date < $3::date', [from]),
    invoiced: await documents(['INVOICE', 'RECEIPT', 'DEBIT_NOTE']),
    credited: await documents(['CREDIT_NOTE']),
    paid: -(await receivable("l.posting_date BETWEEN $3::date AND $4::date AND l.side = 'C' AND e.event_code LIKE 'pay.%'", [from, to])),
    closing: await receivable('l.posting_date <= $3::date', [to]),
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  // The whole file runs on one Accra business day: every date below is read once, and the step-ups and approvals move
  // the clock on by minutes. Always forward: within three hours of a midnight, start just after it instead.
  const DAY = 86_400_000;
  const start = testStartTime().getTime();
  const midnight = Math.ceil(start / DAY) * DAY;
  clock = new ManualClock(new Date(midnight - start < 3 * 3_600_000 ? midnight + 60_000 : start));
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  uow = api.app.get(UnitOfWork);
  worker = documentWorker(api, database, clock);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('eggs', (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id);
  today = toBusinessDate(clock.now());
  yesterday = addDays(today, -1);
  const tema = await createBranch(database, 'TMA');
  ids.set('tema', tema.branchId);
  const people: [string, string, string, boolean, string?][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['temaOwner', 'Yaa Asantewaa', 'OWNER', true, tema.branchId],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const twoBranches = await createUser(database, { name: 'Kojo Antwi', grants: [{ role: 'SALES', branchId }, { role: 'SALES', branchId: tema.branchId }] });
  sessions.set('salesBoth', await login(api.server, twoBranches));
  const shopper = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  sessions.set('customer', await login(api.server, shopper));
  // The seeded day's documents are archived first, so the render tests below start from a quiet outbox.
  await worker.settle();
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a statement balances opening to closing exactly and ties to the ledger (FR-WHL-009, the gate)', () => {
  it('gives closing 180,000 from opening 100,000 by manual journal, invoices 250,000, a credit note of 20,000 and a till payment of 150,000', async () => {
    const akwaaba = await newCustomer('Akwaaba Poultry Traders (TEST)');
    ids.set('akwaaba', akwaaba.id);
    const ledger = await ledgerIds(database);
    // The opening balance is on 1200 against the customer but on no billing document: a manual journal dated yesterday.
    await postManualJournal(api.server, clock, { maker: as('accountant'), checker: as('owner') as TotpSession }, {
      postingDate: yesterday,
      description: 'Balance brought over from the paper ledger (TEST)',
      lines: [
        { accountId: ledger.account('1200'), side: 'D', amountPesewas: 100_000, subledgerPartyId: akwaaba.party },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 100_000 },
      ],
    });
    const first = await invoice(akwaaba.id, 150_000n);
    const second = await invoice(akwaaba.id, 100_000n);
    const credit = await creditNote(second.id, 20_000);
    const paid = await tillPayment(akwaaba.id, first.id, 150_000n);
    expect([paid.status, paid.allocatedPesewas]).toEqual(['CLEARED', 150_000]);

    const made = await post('sales', '/statements', { customerId: akwaaba.id, periodStart: today, periodEnd: today, issue: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const s = made.body;
    expect([s.openingPesewas, s.invoicedPesewas, s.creditedPesewas, s.paidPesewas, s.otherChargesPesewas, s.otherCreditsPesewas, s.closingPesewas, s.closingCreditPesewas]).toEqual([
      100_000, 250_000, 20_000, 150_000, 0, 0, 180_000, 0,
    ]);
    const truth = await ledgerTruth(akwaaba.id, akwaaba.party, today, today);
    expect(truth).toEqual({ opening: 100_000, invoiced: 250_000, credited: 20_000, paid: 150_000, closing: 180_000 });
    expect(truth.opening + truth.invoiced - truth.credited - truth.paid).toBe(truth.closing);
    expect([s.openingPesewas, s.invoicedPesewas, s.creditedPesewas, s.paidPesewas, s.closingPesewas]).toEqual([truth.opening, truth.invoiced, truth.credited, truth.paid, truth.closing]);

    const creditNo = (await admin().query<{ no: string }>('SELECT document_no AS no FROM bil.billing_document WHERE id = $1', [credit])).rows[0]!.no;
    expect(s.lines.map((l: Record<string, unknown>) => [l['kind'], l['reference'], l['debitPesewas'], l['creditPesewas'], l['balancePesewas'], l['balanceSide']])).toEqual([
      ['OPENING', 'Balance brought forward', 0, 0, 100_000, 'D'],
      ['INVOICE', first.documentNo, 150_000, 0, 250_000, 'D'],
      ['INVOICE', second.documentNo, 100_000, 0, 350_000, 'D'],
      ['CREDIT_NOTE', creditNo, 0, 20_000, 330_000, 'D'],
      ['PAYMENT', expect.stringMatching(/^Payment JNL-\d{4}-DDW-\d{6}$/), 0, 150_000, 180_000, 'D'],
    ]);
    expect(s).toMatchObject({ status: 'ISSUED', branchId, issueDate: today, customer: { id: akwaaba.id, name: 'Akwaaba Poultry Traders (TEST)' }, documentId: null, currency: 'GHS' });
    expect(s.statementNo).toMatch(/^STM-\d{4}-DDW-\d{6}$/);
    ids.set('gateStatement', s.id);

    // Yesterday alone: the journal as an adjustment, and nothing of today's documents.
    const before = await post('sales', '/statements', { customerId: akwaaba.id, periodStart: yesterday, periodEnd: yesterday, issue: false });
    expect(before.status).toBe(201);
    expect([before.body.status, before.body.statementNo, before.body.openingPesewas, before.body.otherChargesPesewas, before.body.invoicedPesewas, before.body.closingPesewas]).toEqual(['DRAFT', null, 0, 100_000, 0, 100_000]);
    expect(before.body.lines.map((l: Record<string, unknown>) => l['kind'])).toEqual(['OPENING', 'ADJUSTMENT']);
    expect(before.body.lines[1].reference).toMatch(/^Journal JNL-\d{4}-DDW-\d{6}$/);
  });

  it('shows a customer in credit with a closing balance of zero and the credit apart, tied to 1200’s credit balance', async () => {
    const nkwanta = await newCustomer('Nkwanta Egg Distributors (TEST)');
    const sold = await invoice(nkwanta.id, 50_000n);
    await tillPayment(nkwanta.id, sold.id, 50_000n);
    await creditNote(sold.id, 12_000);
    const made = await post('accountant', '/statements', { customerId: nkwanta.id, branchId, periodStart: today, periodEnd: today, issue: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const truth = await ledgerTruth(nkwanta.id, nkwanta.party, today, today);
    expect(truth).toEqual({ opening: 0, invoiced: 50_000, credited: 12_000, paid: 50_000, closing: -12_000 });
    expect([made.body.closingPesewas, made.body.closingCreditPesewas]).toEqual([0, 12_000]);
    expect(made.body.lines.at(-1)).toMatchObject({ kind: 'CREDIT_NOTE', creditPesewas: 12_000, balancePesewas: 12_000, balanceSide: 'C' });
  });

  it('reads a customer never posted to at the branch as all zero, with only the brought-forward line', async () => {
    const quiet = await newCustomer('Ashaiman Fresh Foods (TEST)');
    const made = await post('sales', '/statements', { customerId: quiet.id, periodStart: yesterday, periodEnd: today, issue: false });
    expect(made.status).toBe(201);
    expect([made.body.openingPesewas, made.body.closingPesewas, made.body.lines.length]).toEqual([0, 0, 1]);
  });
});

describe('numbered from its own series, rendered after commit and archived exactly once (FR-DOC-001, FR-DOC-003, ADR-0015)', () => {
  it('queues the render in the issuing transaction, archives it once with the SHA-256 of its stored bytes after commit, and links it', async () => {
    const statementId = id('gateStatement');
    const jobs = await admin().query<{ status: string }>('SELECT status FROM doc.render_job WHERE business_document_id = $1', [statementId]);
    expect(jobs.rows).toEqual([{ status: 'QUEUED' }]);
    await worker.settle();
    const archived = await admin().query<{ id: string; sha256: Buffer; bucket: string; object_key: string; doc_type: string; document_no: string }>(
      `SELECT a.id, a.sha256, f.bucket, f.object_key, a.doc_type, a.document_no FROM doc.archived_document a JOIN platform.stored_file f ON f.id = a.file_id
        WHERE a.business_document_id = $1`,
      [statementId],
    );
    expect(archived.rows).toHaveLength(1);
    const row = archived.rows[0]!;
    const bytes = await api.app.get<ObjectStorage>(OBJECT_STORAGE).get(row.bucket, row.object_key);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256.toString('hex'));
    expect(bytes.toString('latin1')).toContain('Closing balance GHS 1,800.00');
    const read = await get('sales', `/statements/${statementId}`);
    expect([read.body.documentId, row.doc_type, row.document_no]).toEqual([row.id, 'STATEMENT', read.body.statementNo]);
    // A redelivery and another settle add nothing.
    await worker.settle();
    expect((await admin().query('SELECT 1 FROM doc.archived_document WHERE business_document_id = $1', [statementId])).rows).toHaveLength(1);
  });

  it('answers the issued statement of the same period to five concurrent requests: one number, one render, one archive', async () => {
    const osu = await newCustomer('Osu Cold Store (TEST)');
    await invoice(osu.id, 7_500n);
    const body = { customerId: osu.id, periodStart: today, periodEnd: today, issue: true };
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => post('sales', '/statements', body)));
    expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(new Set(answers.map((a) => a.body.statementNo)).size).toBe(1);
    const issued = await admin().query("SELECT id FROM whl.statement WHERE customer_id = $1 AND status = 'ISSUED'", [osu.id]);
    expect(issued.rows).toHaveLength(1);
    const statementId = answers[0]!.body.id as string;
    expect((await admin().query('SELECT 1 FROM doc.render_job WHERE business_document_id = $1', [statementId])).rows).toHaveLength(1);
    expect((await admin().query('SELECT 1 FROM platform.number_allocation WHERE document_id = $1', [statementId])).rows).toHaveLength(1);
    await worker.settle();
    const again = await post('accountant', '/statements', body);
    expect([again.body.id, again.body.documentId]).toEqual([statementId, expect.any(String)]);
    expect((await admin().query('SELECT 1 FROM doc.archived_document WHERE business_document_id = $1', [statementId])).rows).toHaveLength(1);
  });

  it('numbers concurrent statements of different periods densely, every allocation one statement, a draft taking none', async () => {
    const labadi = await newCustomer('Labadi Chop Bar (TEST)');
    await invoice(labadi.id, 3_000n);
    const periods = [0, 1, 2, 3, 4, 5].map((back) => addDays(today, -back));
    const answers = await Promise.all(periods.map((start) => post('sales', '/statements', { customerId: labadi.id, periodStart: start, periodEnd: today, issue: true })));
    expect(answers.map((a) => a.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const draft = await post('sales', '/statements', { customerId: labadi.id, periodStart: addDays(today, -9), periodEnd: today, issue: false });
    expect([draft.body.status, draft.body.statementNo]).toEqual(['DRAFT', null]);
    const { rows } = await admin().query<{ value: string; next: string; issued: string }>(
      `SELECT a.value::text, s.next_value::text AS next,
              (SELECT count(*) FROM whl.statement w WHERE w.status = 'ISSUED' AND w.branch_id = s.branch_id)::text AS issued
         FROM platform.number_series s JOIN platform.number_allocation a ON a.series_id = s.id
        WHERE s.doc_type = 'STATEMENT' AND s.branch_id = $1 ORDER BY a.value`,
      [branchId],
    );
    expect(rows.map((r) => Number(r.value))).toEqual(rows.map((_, i) => i + 1));
    expect(Number(rows[0]!.next) - 1).toBe(rows.length);
    expect(Number(rows[0]!.issued)).toBe(rows.length);
    expect((await admin().query('SELECT 1 FROM platform.number_allocation WHERE document_id = $1', [draft.body.id])).rows).toHaveLength(0);
    expect((await admin().query('SELECT 1 FROM doc.render_job WHERE business_document_id = $1', [draft.body.id])).rows).toHaveLength(0);
  });

  it('replays a request by its Idempotency-Key and refuses the key with another body', async () => {
    const key = randomUUID();
    const body = { customerId: id('akwaaba'), periodStart: yesterday, periodEnd: today, issue: false };
    const first = await post('sales', '/statements', body, key);
    const replay = await post('sales', '/statements', body, key);
    expect([first.status, replay.status, replay.body.id]).toEqual([201, 201, first.body.id]);
    const reused = await post('sales', '/statements', { ...body, periodStart: today }, key);
    expect([reused.status, reused.body.error.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });
});

describe('the statement rules', () => {
  it('refuses a period that ends before it starts, after today or longer than a year, an unknown customer, and no branch for a caller at two', async () => {
    const refused = async (who: string, body: object) => {
      const answer = await post(who, '/statements', { customerId: id('akwaaba'), periodStart: today, periodEnd: today, issue: true, ...body });
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(answer.body.error.code).toBe('STATEMENT_INVALID');
      return answer.body.error.details.map((d: { field: string; code: string }) => [d.field, d.code]);
    };
    expect(await refused('sales', { periodStart: today, periodEnd: yesterday })).toEqual([['/periodEnd', 'PERIOD_REVERSED']]);
    expect(await refused('sales', { periodEnd: addDays(today, 1) })).toEqual([['/periodEnd', 'PERIOD_NOT_ENDED']]);
    expect(await refused('sales', { periodStart: addDays(today, -366) })).toEqual([['/periodStart', 'PERIOD_TOO_LONG']]);
    expect(await refused('sales', { customerId: randomUUID() })).toEqual([['/customerId', 'CUSTOMER_UNKNOWN']]);
    expect(await refused('salesBoth', {})).toEqual([['/branchId', 'BRANCH_REQUIRED']]);
    const chosen = await post('salesBoth', '/statements', { customerId: id('akwaaba'), branchId, periodStart: today, periodEnd: today, issue: false });
    expect(chosen.status).toBe(201);
  });

  it('holds the rules in the database: written once, totals and balances from its lines, the number allocated to it', async () => {
    const statementId = id('gateStatement');
    const refusal = (sql: string, values: unknown[]) => app().query(sql, values).then(() => 'accepted', (e: { code?: string; constraint?: string }) => `${e.code}:${e.constraint ?? ''}`);
    expect(await refusal('UPDATE whl.statement SET closing_pesewas = closing_pesewas + 1, invoiced_pesewas = invoiced_pesewas + 1, version = version + 1 WHERE id = $1', [statementId])).toBe('HK004:ck_statement_frozen');
    expect(await refusal('UPDATE whl.statement SET archived_document_id = NULL, version = version + 1 WHERE id = $1', [statementId])).toBe('HK004:ck_statement_frozen');
    // The lines are insert-only for every role: the application holds no grant to change them, and the owner is refused by trigger.
    const asOwner = (sql: string) => admin().query(sql, [statementId]).then(() => 'accepted', (e: { code?: string }) => e.code);
    expect(await refusal("UPDATE whl.statement_line SET reference = 'Changed' WHERE statement_id = $1", [statementId])).toBe('42501:');
    expect(await asOwner("UPDATE whl.statement_line SET reference = 'Changed' WHERE statement_id = $1")).toBe('HK001');
    expect(await asOwner('DELETE FROM whl.statement_line WHERE statement_id = $1')).toBe('HK001');
    expect(await refusal('DELETE FROM whl.statement WHERE id = $1', [statementId])).toMatch(/^42501:/);
    const principal = users.get('sales')!.principalId;
    expect(
      await refusal(
        `INSERT INTO whl.statement_line (statement_id, line_no, line_date, kind, reference, debit_pesewas, credit_pesewas, balance_pesewas, balance_side, source_document_id, recorded_at, actor_id)
         SELECT $1, 99, $2::date, 'INVOICE', 'INV-FORGED', 1, 0, 180001, 'D', id, now(), $3 FROM platform.business_document WHERE id = $1`,
        [statementId, today, principal],
      ),
    ).toBe('HK010:ck_statement_totals');

    // A statement whose header does not add up, or whose number the platform never allocated, never commits.
    const customer = id('akwaaba');
    const old = addDays(today, -40);
    const write = async (header: { status: string; no: string | null; closing: number }) => {
      const fresh = randomUUID();
      const client = await app().connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STATEMENT', 'whl', $2, $3)", [fresh, branchId, principal]);
        await client.query(
          `INSERT INTO whl.statement (id, statement_no, customer_id, period_start, period_end, opening_pesewas, opening_credit_pesewas, invoiced_pesewas, credited_pesewas, paid_pesewas,
             other_charges_pesewas, other_credits_pesewas, closing_pesewas, closing_credit_pesewas, issue_date, status, branch_id, created_at, created_by, updated_at, updated_by, posted_at, posted_by)
           VALUES ($1, $2, $3, $4::date, $4::date, 0, 0, 0, 0, 0, 0, 0, $5, 0, $6::date, $7, $8, now(), $9, now(), $9, $10, $11)`,
          [fresh, header.no, customer, old, header.closing, header.status === 'ISSUED' ? today : null, header.status, branchId, principal, header.status === 'ISSUED' ? new Date() : null, header.status === 'ISSUED' ? principal : null],
        );
        await client.query(
          `INSERT INTO whl.statement_line (statement_id, line_no, line_date, kind, reference, debit_pesewas, credit_pesewas, balance_pesewas, balance_side, recorded_at, actor_id)
           VALUES ($1, 1, $2::date, 'OPENING', 'Balance brought forward', 0, 0, 0, 'D', now(), $3)`,
          [fresh, old, principal],
        );
        await client.query('COMMIT');
        return 'accepted';
      } catch (error) {
        await client.query('ROLLBACK');
        return `${(error as { code?: string }).code}:${(error as { constraint?: string }).constraint ?? ''}`;
      } finally {
        client.release();
      }
    };
    expect(await write({ status: 'DRAFT', no: null, closing: 5 })).toBe('23514:ck_statement_balances');
    expect(await write({ status: 'ISSUED', no: 'STM-2099-DDW-000001', closing: 0 })).toBe('HK010:ck_statement_number');
    expect(await write({ status: 'ISSUED', no: null, closing: 0 })).toBe('23514:ck_statement_issued');
  });
});

describe('every statement operation refuses the wrong caller (ADR-0035)', () => {
  it('refuses the roles without the permission, a customer and the Owner of another branch, and lets the Manager in', async () => {
    const statementId = id('gateStatement');
    const body = { customerId: id('akwaaba'), periodStart: today, periodEnd: today, issue: false };
    for (const who of ['cashier', 'storekeeper']) {
      expect((await post(who, '/statements', body)).status, who).toBe(403);
      expect((await get(who, '/statements')).status, who).toBe(403);
      expect((await get(who, `/statements/${statementId}`)).status, who).toBe(403);
    }
    // The Manager grants Sales, so holds its permissions (FR-IAM-022).
    expect((await get('manager', `/statements/${statementId}`)).status).toBe(200);
    expect((await post('manager', '/statements', body)).status).toBe(201);
    // A customer's sign-in is of another realm: no staff statement route answers it.
    expect((await post('customer', '/statements', body)).status).toBe(401);
    expect((await get('customer', '/statements')).status).toBe(401);
    expect((await get('customer', `/statements/${statementId}`)).status).toBe(401);
    // The Owner of Tema reaches nothing of Dodowa's: not the statement, not its row in a list, and cannot produce one there.
    const theirs = await get('temaOwner', `/statements/${statementId}`);
    expect([theirs.status, Object.keys(theirs.body)]).toEqual([403, ['error']]);
    const listed = await get('temaOwner', '/statements');
    expect([listed.status, listed.body.data]).toEqual([200, []]);
    expect((await post('temaOwner', '/statements', { ...body, branchId })).status).toBe(403);
    // Its own branch answers the customer's account there, which holds nothing of Dodowa's.
    const atTema = await post('temaOwner', '/statements', body);
    expect([atTema.status, atTema.body.branchId, atTema.body.openingPesewas, atTema.body.closingPesewas, atTema.body.lines.length]).toEqual([201, id('tema'), 0, 0, 1]);
  });

  it('lists the branch’s statements newest first with their figures and no lines, filtered by customer and period end, paged by a signed cursor', async () => {
    const all = await get('sales', `/statements?customerId=${id('akwaaba')}&limit=2`);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data.every((row: { lines: unknown[]; branchId: string; customer: { id: string } }) => row.lines.length === 0 && row.branchId === branchId && row.customer.id === id('akwaaba'))).toBe(true);
    expect(all.body.data[0].id > all.body.data[1].id).toBe(true);
    expect(all.body.page.hasMore).toBe(true);
    const next = await get('sales', `/statements?customerId=${id('akwaaba')}&limit=2&cursor=${encodeURIComponent(all.body.page.nextCursor)}`);
    expect(next.body.data.every((row: { id: string }) => row.id < all.body.data[1].id)).toBe(true);
    const ended = await get('sales', `/statements?periodEnd=${yesterday}`);
    expect(ended.body.data.length).toBeGreaterThan(0);
    expect(ended.body.data.every((row: { periodEnd: string }) => row.periodEnd === yesterday)).toBe(true);
  });

  it('audits an issued statement with its actor and what it showed', async () => {
    const { rows } = await admin().query<{ module: string; action: string; actor_id: string; recorded: boolean }>(
      `SELECT module, action, actor_id, "after" IS NOT NULL AS recorded FROM platform.audit_event WHERE entity_type = 'Statement' AND entity_id = $1`,
      [id('gateStatement')],
    );
    expect(rows).toEqual([{ module: 'whl', action: 'ISSUE', actor_id: users.get('sales')!.principalId, recorded: true }]);
  });
});
