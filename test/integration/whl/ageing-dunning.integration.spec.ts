import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkTemplateBody, renderTemplate } from '../../../src/modules/doc/domain/templates';
import { Payments } from '../../../src/modules/pay';
import { Dunning } from '../../../src/modules/whl';
import { runAsSystem, runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift } from '../../support/till';

/**
 * Receivables ageing, the statement's ageing summary and dunning (FR-WHL-009 to FR-WHL-011, ADR-0089), the gate of B10
 * continued 2 as split: ageing by Current, 1 to 30, 31 to 60, 61 to 90 and over 90 days from due dates and allocations,
 * as at a date taken as input, equals SQL sums taken straight from BIL's and PAY's own tables and ties to 1200 taken
 * straight from FIN's; the customer statement carries its ageing summary, tied by the database to its closing; each
 * dunning level reaches an invoice at most once however often the job runs, also run twice at once and stopped midway;
 * every read and write refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let uow: UnitOfWork;
let branchId: string;
let start: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object, key: string = randomUUID()) => consolePut(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const today = () => toBusinessDate(clock.now());
const DAY = 86_400_000;
const till = { id: '019a8000-0000-7000-8000-00000000c7a1', code: 'T8' };
const BUCKETS = ['currentPesewas', 'days1To30Pesewas', 'days31To60Pesewas', 'days61To90Pesewas', 'daysOver90Pesewas', 'totalPesewas'] as const;
let customers = 0;

/** A business customer with its party on 1200 and, unless told otherwise, an account at Dodowa opened by the Owner with a nil limit. */
async function customer(name: string, options: { account?: boolean; manager?: string } = {}): Promise<{ id: string; party: string }> {
  const customerId = randomUUID();
  const party = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [customerId, `C-7${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  await admin().query("INSERT INTO fin.subledger_party (id, kind, ref_id, display_name) VALUES ($1, 'CUSTOMER', $2, $3)", [party, customerId, name]);
  if (options.account !== false) await openAccount(customerId, options.manager);
  return { id: customerId, party };
}

async function openAccount(customerId: string, manager?: string): Promise<void> {
  const opened = await post('owner', '/business-accounts', { customerId, branchId, creditLimitPesewas: 0, paymentTermsDays: 30, ...(manager === undefined ? {} : { accountManagerId: users.get(manager)!.principalId }) });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
}

const invoice = (customerId: string, gross: number, dueDate: string) => issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId, productId: id('goat') }, BigInt(gross), dueDate);

/** Cash taken at the till in the cashier's own shift, all of it allocated to the invoice, today by the application clock. */
function pay(customerId: string, invoiceId: string, amount: number) {
  const cashier = actorOf('cashier');
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'ageing test', actor: cashier }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: [`JOURNAL:${today().slice(0, 4)}:${branchId}`] }, async (tx) =>
      api.app.get(Payments).recordIn(tx, cashier, {
        branchId,
        channel: 'WHOLESALE',
        methodCode: 'CASH',
        amountPesewas: BigInt(amount),
        customerId,
        orderDocumentId: null,
        shiftDocumentId: await openTestShift(tx, cashier.principalId, branchId, till),
        register: till,
        receivedAt: clock.now(),
        allocations: [{ billingDocumentId: invoiceId, amountPesewas: BigInt(amount) }],
      }),
    ),
  );
}

async function creditNote(invoiceId: string, amount: number): Promise<void> {
  const original = await get('accountant', `/billing-documents/${invoiceId}`);
  const asked = await post('accountant', `/billing-documents/${invoiceId}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Two goats returned lame', lines: [{ lineId: original.body.lines[0].id, amountPesewas: amount }] });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await stepUp(api.server, as('owner') as TotpSession, clock);
  expect((await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked' })).status).toBe(200);
}

/**
 * The buckets straight from SQL: BIL's issued documents to the customer by the date, less their credit notes issued by
 * then and PAY's allocations dated by then, each balance in the band of the days from its due date (or issue date).
 */
async function bucketsTruth(customerId: string | null, asOf: string): Promise<Record<(typeof BUCKETS)[number], number>> {
  const { rows } = await admin().query<Record<string, string>>(
    `WITH d AS (
       SELECT $2::date - COALESCE(d.due_date, d.issue_date) AS days,
              d.gross_pesewas
              - COALESCE((SELECT sum(c.gross_pesewas) FROM bil.billing_document c WHERE c.original_document_id = d.id AND c.kind = 'CREDIT_NOTE' AND c.status = 'ISSUED' AND c.issue_date <= $2::date), 0)
              - COALESCE((SELECT sum(CASE a.direction WHEN 'APPLY' THEN a.amount_pesewas ELSE -a.amount_pesewas END) FROM pay.payment_allocation a
                           WHERE a.billing_document_id = d.id AND a.allocated_on <= $2::date), 0) AS balance
         FROM bil.billing_document d
        WHERE d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'DEBIT_NOTE') AND d.customer_id IS NOT NULL AND d.branch_id = $3
          AND ($1::uuid IS NULL OR d.customer_id = $1) AND d.issue_date <= $2::date)
     SELECT COALESCE(sum(balance) FILTER (WHERE days <= 0), 0)::text AS "currentPesewas",
            COALESCE(sum(balance) FILTER (WHERE days BETWEEN 1 AND 30), 0)::text AS "days1To30Pesewas",
            COALESCE(sum(balance) FILTER (WHERE days BETWEEN 31 AND 60), 0)::text AS "days31To60Pesewas",
            COALESCE(sum(balance) FILTER (WHERE days BETWEEN 61 AND 90), 0)::text AS "days61To90Pesewas",
            COALESCE(sum(balance) FILTER (WHERE days > 90), 0)::text AS "daysOver90Pesewas",
            COALESCE(sum(balance), 0)::text AS "totalPesewas"
       FROM d WHERE balance > 0`,
    [customerId, asOf, branchId],
  );
  return Object.fromEntries(BUCKETS.map((k) => [k, Number(rows[0]![k])])) as Record<(typeof BUCKETS)[number], number>;
}

/** The customer's (or every customer's) 1200 at Dodowa as at the date, straight from FIN's lines: debits less credits. */
async function receivablesTruth(customerId: string | null, asOf: string): Promise<number> {
  const { rows } = await admin().query<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party p ON p.id = l.subledger_party_id AND p.kind = 'CUSTOMER'
      WHERE a.code = '1200' AND l.branch_id = $1 AND l.posting_date <= $2::date AND ($3::uuid IS NULL OR p.ref_id = $3)`,
    [branchId, asOf, customerId],
  );
  return Number(rows[0]!.n);
}

async function ageingOf(who: string, customerId: string, asOf: string) {
  const response = await get(who, `/receivables/ageing?customerId=${customerId}&asOf=${asOf}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { row: response.body.data[0] as Record<string, number> | undefined, body: response.body };
}

/** The row and the report's totals each equal the SQL buckets and tie to 1200: total plus not aged less not aged credit is the ledger. */
async function expectTies(customerId: string, asOf: string) {
  const { row, body } = await ageingOf('accountant', customerId, asOf);
  const truth = await bucketsTruth(customerId, asOf);
  const ledger = await receivablesTruth(customerId, asOf);
  const figures = row ?? body.totals;
  for (const k of BUCKETS) expect(figures[k], `${k} as at ${asOf}`).toBe(truth[k]);
  expect(figures['ledgerPesewas']! - figures['ledgerCreditPesewas']!).toBe(ledger);
  expect(figures['totalPesewas']! + figures['notAgedPesewas']! - figures['notAgedCreditPesewas']!).toBe(ledger);
  return figures;
}

const runDunning = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(Dunning).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
const notices = async (documentId: string) =>
  (await admin().query<{ id: string; level: number; days_past_due: number; outstanding: string }>('SELECT id, level, days_past_due, outstanding_pesewas::text AS outstanding FROM whl.dunning_notice WHERE billing_document_id = $1 ORDER BY level', [documentId])).rows;
const queued = async (noticeId: string) => Number((await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'whl.DunningNoticeDue' AND subject_id = $1", [noticeId])).rows[0]!.n);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  // The dunning tests move the clock on by weeks: the sessions live long enough (test settings only).
  const long = String(90 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  uow = api.app.get(UnitOfWork);
  start = today();
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('goat', (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).rows[0]!.id);
  const tema = await createBranch(database, 'TMA');
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
  const shopper = await createUser(database, { name: 'Abena Kyei', realm: 'CUSTOMER' });
  sessions.set('customer', await login(api.server, shopper));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('ageing as at a date (FR-WHL-010, SA-21, ADR-0089: exact pesewas, tied to SQL and to 1200)', () => {
  it('ages FR-WHL-010: 80,000 due in 30 days, 30,000 paid, through every band from its first day to its last', async () => {
    const funeral = await customer('Ofori Funeral Caterers (TEST)', { manager: 'sales' });
    ids.set('funeral', funeral.id);
    const due = addDays(start, 30);
    const owed = await invoice(funeral.id, 80_000, due);
    await pay(funeral.id, owed.id, 30_000);
    const expected: [string, (typeof BUCKETS)[number]][] = [
      [start, 'currentPesewas'],
      [due, 'currentPesewas'],
      [addDays(due, 1), 'days1To30Pesewas'],
      [addDays(due, 30), 'days1To30Pesewas'],
      [addDays(due, 31), 'days31To60Pesewas'],
      [addDays(due, 60), 'days31To60Pesewas'],
      [addDays(due, 61), 'days61To90Pesewas'],
      [addDays(due, 90), 'days61To90Pesewas'],
      [addDays(due, 91), 'daysOver90Pesewas'],
    ];
    for (const [asOf, bucket] of expected) {
      const figures = await expectTies(funeral.id, asOf);
      expect([figures[bucket], figures['totalPesewas'], figures['ledgerPesewas'], figures['notAgedPesewas']], `as at ${asOf}`).toEqual([50_000, 50_000, 50_000, 0]);
    }
    const before = await ageingOf('accountant', funeral.id, addDays(start, -1));
    expect([before.body.data, before.body.totals.totalPesewas]).toEqual([[], 0]);
    const read = (await ageingOf('sales', funeral.id, addDays(due, 30))).row!;
    expect(read).toMatchObject({ customer: { id: funeral.id, name: 'Ofori Funeral Caterers (TEST)' }, creditLimitPesewas: 0, onHold: false });
  });

  it('shows what 1200 holds beyond the open items, an opening balance by journal, as not aged, never in a bucket', async () => {
    const paper = await customer('Adenta Paper Ledger Traders (TEST)');
    ids.set('paper', paper.id);
    const ledger = await ledgerIds(database);
    await postManualJournal(api.server, clock, { maker: as('accountant'), checker: as('owner') as TotpSession }, {
      postingDate: addDays(start, -1),
      description: 'Balance brought over from the paper ledger (TEST)',
      lines: [
        { accountId: ledger.account('1200'), side: 'D', amountPesewas: 100_000, subledgerPartyId: paper.party },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 100_000 },
      ],
    });
    await invoice(paper.id, 40_001, start);
    const figures = await expectTies(paper.id, start);
    expect([figures['currentPesewas'], figures['totalPesewas'], figures['ledgerPesewas'], figures['notAgedPesewas'], figures['notAgedCreditPesewas']]).toEqual([40_001, 40_001, 140_001, 100_000, 0]);
    const yesterday = await expectTies(paper.id, addDays(start, -1));
    expect([yesterday['totalPesewas'], yesterday['notAgedPesewas']]).toEqual([0, 100_000]);
  });

  it('takes a credit note off from its own date and a payment from the day it was applied, by the application clock', async () => {
    const later = await customer('Kpone Cold Rooms (TEST)');
    ids.set('later', later.id);
    const owed = await invoice(later.id, 100_000, addDays(start, 14));
    await creditNote(owed.id, 20_000);
    clock.set(new Date(clock.now().getTime() + 10 * DAY));
    await pay(later.id, owed.id, 30_000);
    const dated = await admin().query<{ allocated_on: string }>('SELECT allocated_on::text FROM pay.payment_allocation WHERE billing_document_id = $1', [owed.id]);
    expect(dated.rows).toEqual([{ allocated_on: addDays(start, 10) }]);
    expect((await expectTies(later.id, addDays(start, 9)))['currentPesewas']).toBe(80_000);
    expect((await expectTies(later.id, addDays(start, 10)))['currentPesewas']).toBe(50_000);
    expect((await expectTies(later.id, addDays(start, 15)))['days1To30Pesewas']).toBe(50_000);
  });

  it('totals every customer the filter matches, page by page by name, and ties the whole branch to 1200', async () => {
    const asOf = addDays(start, 45);
    const seen: Record<string, number>[] = [];
    let cursor: string | null = null;
    let totals: Record<string, number> | null = null;
    let otherParties = 0;
    let otherPartiesCredit = 0;
    do {
      const page = await get('accountant', `/receivables/ageing?asOf=${asOf}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect(page.body.data.length).toBeLessThanOrEqual(2);
      if (totals !== null) expect(page.body.totals).toEqual(totals);
      totals = page.body.totals as Record<string, number>;
      otherParties = page.body.otherPartiesPesewas as number;
      otherPartiesCredit = page.body.otherPartiesCreditPesewas as number;
      seen.push(...(page.body.data as Record<string, number>[]));
      cursor = page.body.page.nextCursor as string | null;
    } while (cursor !== null);
    const names = seen.map((r) => (r['customer'] as unknown as { name: string }).name);
    expect(names).toEqual([...names].sort());
    // The till's walk-in customer is no customer of MDM: its 1200 is in the totals as not aged, on no row.
    const others = { ledgerPesewas: otherParties, ledgerCreditPesewas: otherPartiesCredit, notAgedPesewas: otherParties, notAgedCreditPesewas: otherPartiesCredit } as Record<string, number>;
    for (const k of [...BUCKETS, 'ledgerPesewas', 'ledgerCreditPesewas', 'notAgedPesewas', 'notAgedCreditPesewas']) expect(totals![k], k).toBe(seen.reduce((sum, r) => sum + r[k]!, others[k] ?? 0));
    const truth = await bucketsTruth(null, asOf);
    for (const k of BUCKETS) expect(totals![k], k).toBe(truth[k]);
    const ledger = await receivablesTruth(null, asOf);
    expect(totals!['totalPesewas']! + totals!['notAgedPesewas']! - totals!['notAgedCreditPesewas']!).toBe(ledger);
    expect(totals!['ledgerPesewas']! - totals!['ledgerCreditPesewas']!).toBe(ledger);
    const managed = await get('manager', `/receivables/ageing?asOf=${asOf}&accountManagerId=${users.get('sales')!.principalId}`);
    expect(managed.body.data.map((r: { customer: { id: string } }) => r.customer.id)).toEqual([id('funeral')]);
  });

  it('is read by the Owner, the Manager, Sales and the Accountant at their branch only; the Cashier and the Storekeeper are refused', async () => {
    for (const who of ['owner', 'manager', 'sales', 'accountant']) expect((await get(who, '/receivables/ageing')).status, who).toBe(200);
    for (const who of ['cashier', 'storekeeper']) expect((await get(who, '/receivables/ageing')).status, who).toBe(403);
    expect((await get('customer', '/receivables/ageing')).status).toBe(401);
    const elsewhere = await get('temaOwner', `/receivables/ageing?customerId=${id('funeral')}&asOf=${addDays(start, 45)}`);
    expect([elsewhere.status, elsewhere.body.data, elsewhere.body.totals.totalPesewas]).toEqual([200, [], 0]);
  });
});

describe('the statement carries its ageing summary (FR-WHL-009, A-300 (i))', () => {
  it('ages the statement as at its period end at its branch, tied by the database to its closing', async () => {
    for (const name of ['paper', 'later']) {
      const made = await post('accountant', '/statements', { customerId: id(name), branchId, periodStart: addDays(today(), -20), periodEnd: today(), issue: true });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const { row } = await ageingOf('accountant', id(name), today());
      expect(made.body.ageing).toEqual({
        asOf: today(),
        currentPesewas: row!['currentPesewas'],
        days1To30Pesewas: row!['days1To30Pesewas'],
        days31To60Pesewas: row!['days31To60Pesewas'],
        days61To90Pesewas: row!['days61To90Pesewas'],
        daysOver90Pesewas: row!['daysOver90Pesewas'],
        totalPesewas: row!['totalPesewas'],
        notAgedPesewas: row!['notAgedPesewas'],
        notAgedCreditPesewas: row!['notAgedCreditPesewas'],
      });
      expect(made.body.ageing.totalPesewas + made.body.ageing.notAgedPesewas - made.body.ageing.notAgedCreditPesewas).toBe(made.body.closingPesewas - made.body.closingCreditPesewas);
      expect(made.body.closingPesewas - made.body.closingCreditPesewas).toBe(await receivablesTruth(id(name), today()));
      ids.set(`statement:${name}`, made.body.id as string);
      expect((await get('sales', `/statements/${made.body.id as string}`)).body.ageing).toEqual(made.body.ageing);
    }
    expect((await get('accountant', `/statements/${id('statement:paper')}`)).body.ageing).toMatchObject({ currentPesewas: 0, days1To30Pesewas: 40_001, notAgedPesewas: 100_000 });
  });

  it('prints the summary with version 2 of the statement template, a body DOC accepts, version 1 retired', async () => {
    const versions = await admin().query<{ version_no: number; status: string; body: string }>(
      "SELECT v.version_no, v.status, v.body FROM doc.template_version v JOIN doc.template t ON t.id = v.template_id WHERE t.doc_type = 'STATEMENT' ORDER BY v.version_no",
    );
    expect(versions.rows.map((v) => [v.version_no, v.status])).toEqual([[1, 'RETIRED'], [2, 'ACTIVE']]);
    expect(checkTemplateBody(versions.rows[1]!.body)).toEqual([]);
    const printed = renderTemplate(versions.rows[1]!.body, { ageing: { asOf: '2026-10-31', current: 'GHS 1.00', hasNotAged: true, notAged: 'GHS 2.00 CR' } });
    expect(printed).toContain('Ageing as at 2026-10-31');
    expect(printed).toContain('Not on any open invoice: GHS 2.00 CR');
  });

  it('refuses an ageing summary changed afterwards, and one that does not tie to the closing', async () => {
    expect(await sqlStateOf(app().query('UPDATE whl.statement SET ageing_current_pesewas = ageing_current_pesewas + 1 WHERE id = $1', [id('statement:paper')]))).toBe('HK004');
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      const copy = randomUUID();
      await client.query(
        'INSERT INTO platform.business_document SELECT (jsonb_populate_record(NULL::platform.business_document, to_jsonb(b) || jsonb_build_object(\'id\', $2::uuid))).* FROM platform.business_document b WHERE b.id = $1',
        [id('statement:paper'), copy],
      );
      const refused = await sqlStateOf(
        client.query(
          `INSERT INTO whl.statement SELECT (jsonb_populate_record(NULL::whl.statement, to_jsonb(s) || jsonb_build_object('id', $2::uuid, 'status', 'DRAFT', 'statement_no', NULL, 'issue_date', NULL,
             'posted_at', NULL, 'posted_by', NULL, 'archived_document_id', NULL, 'ageing_current_pesewas', s.ageing_current_pesewas + 1))).* FROM whl.statement s WHERE s.id = $1`,
          [id('statement:paper'), copy],
        ),
      );
      expect(refused).toBe(SQLSTATE.checkViolation);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('dunning (FR-WHL-011, A-318): each level reaches an invoice once however often the job runs', () => {
  it('reads the seeded levels; only the Owner or a Manager replaces them, a broken set refused', async () => {
    const seeded = await get('accountant', '/dunning-policy');
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.map((l: { level: number; daysOverdue: number; channels: string[] }) => [l.level, l.daysOverdue, l.channels])).toEqual([
      [1, 7, ['SMS']],
      [2, 14, ['SMS']],
      [3, 30, ['SMS', 'EMAIL']],
    ]);
    for (const who of ['cashier', 'storekeeper']) expect((await get(who, '/dunning-policy')).status, who).toBe(403);
    const levels = seeded.body.data as object[];
    for (const who of ['accountant', 'sales', 'cashier']) expect((await put(who, '/dunning-policy', { levels })).status, who).toBe(403);
    const gap = await put('manager', '/dunning-policy', { levels: [levels[0], { ...levels[2]!, level: 3 }] });
    expect([gap.status, gap.body.error.code, gap.body.error.details[0].code]).toEqual([422, 'DUNNING_POLICY_INVALID', 'LEVELS_NOT_CONSECUTIVE']);
    const twice = await put('manager', '/dunning-policy', { levels: [{ ...levels[0]!, channels: ['SMS', 'SMS'] }] });
    expect(twice.body.error.details[0].code).toBe('CHANNEL_REPEATED');
    const key = randomUUID();
    const replaced = await put('manager', '/dunning-policy', { levels: [...levels].reverse() }, key);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.data).toEqual(levels);
    expect((await put('manager', '/dunning-policy', { levels: [...levels].reverse() }, key)).body).toEqual(replaced.body);
    const audited = await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.audit_event WHERE module = 'whl' AND entity_type = 'DunningPolicy' AND action = 'REPLACE'");
    expect(Number(audited.rows[0]!.n)).toBe(2);
    expect((await get('owner', '/dunning-policy')).body.data).toEqual(levels);
  });

  it('sends level 1 at 7 days once, also run twice and twice at once, level 2 at 14 and level 3 at 30; a paid invoice none', async () => {
    const late = await customer('Prampram Hotel Supplies (TEST)');
    const owed = await invoice(late.id, 60_000, today());
    const settled = await invoice(late.id, 25_000, today());
    await pay(late.id, settled.id, 25_000);
    // A customer with no business account yet: it is opened at 31 days, so its first run finds level 3 reached.
    const sleeper = await customer('Dawhenya Fish Market (TEST)', { account: false });
    const sleeping = await invoice(sleeper.id, 9_999, today());
    const dueOn = today();
    ids.set('late', late.id);
    ids.set('owed', owed.id);
    ids.set('sleeping', sleeping.id);

    clock.set(new Date(Date.parse(`${addDays(dueOn, 6)}T09:00:00Z`)));
    await runDunning();
    expect(await notices(owed.id)).toEqual([]);

    clock.set(new Date(Date.parse(`${addDays(dueOn, 7)}T09:00:00Z`)));
    await runDunning();
    await runDunning();
    await Promise.all([runDunning(), runDunning()]);
    const first = await notices(owed.id);
    expect(first.map((n) => [n.level, n.days_past_due, n.outstanding])).toEqual([[1, 7, '60000']]);
    expect(await queued(first[0]!.id)).toBe(1);
    expect(await notices(settled.id)).toEqual([]);
    expect(await notices(sleeping.id)).toEqual([]);

    clock.set(new Date(Date.parse(`${addDays(dueOn, 14)}T09:00:00Z`)));
    await runDunning();
    await runDunning();
    expect((await notices(owed.id)).map((n) => [n.level, n.days_past_due])).toEqual([[1, 7], [2, 14]]);

    clock.set(new Date(Date.parse(`${addDays(dueOn, 31)}T09:00:00Z`)));
    await openAccount(sleeper.id);
    await runDunning();
    await runDunning();
    expect((await notices(owed.id)).map((n) => n.level)).toEqual([1, 2, 3]);
    expect((await notices(sleeping.id)).map((n) => [n.level, n.days_past_due, n.outstanding])).toEqual([[3, 31, '9999']]);
    for (const n of [...(await notices(owed.id)), ...(await notices(sleeping.id))]) expect(await queued(n.id)).toBe(1);
    const event = await admin().query<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'whl.DunningNoticeDue' AND subject_id = $1", [(await notices(sleeping.id))[0]!.id]);
    expect(event.rows[0]!.payload).toMatchObject({ customerId: sleeper.id, billingDocumentId: sleeping.id, documentNo: sleeping.documentNo, level: 3, daysPastDue: 31, outstandingPesewas: 9_999, channels: ['SMS', 'EMAIL'], templateCode: 'PAYMENT_REMINDER_3' });
  });

  it('lists the reminders at the reader’s branch, newest first, to the Accountant and Sales; the Cashier is refused', async () => {
    const listed = await get('accountant', `/dunning-notices?customerId=${id('late')}`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data.map((n: { level: number; daysPastDue: number; outstandingPesewas: number; channels: string[]; billingDocument: { id: string; docType: string } }) => [n.level, n.daysPastDue, n.outstandingPesewas, n.channels, n.billingDocument.id, n.billingDocument.docType])).toEqual([
      [3, 31, 60_000, ['SMS', 'EMAIL'], id('owed'), 'INVOICE'],
      [2, 14, 60_000, ['SMS'], id('owed'), 'INVOICE'],
      [1, 7, 60_000, ['SMS'], id('owed'), 'INVOICE'],
    ]);
    const paged = await get('sales', `/dunning-notices?customerId=${id('late')}&limit=2`);
    expect([paged.body.data.length, paged.body.page.hasMore]).toEqual([2, true]);
    const rest = await get('sales', `/dunning-notices?customerId=${id('late')}&limit=2&cursor=${encodeURIComponent(paged.body.page.nextCursor as string)}`);
    expect(rest.body.data.map((n: { level: number }) => n.level)).toEqual([1]);
    expect((await get('cashier', '/dunning-notices')).status).toBe(403);
    expect((await get('temaOwner', `/dunning-notices?customerId=${id('late')}`)).body.data).toEqual([]);
  });

  it('leaves each account done or untouched when a run stops midway, and the next run finishes it once', async () => {
    const one = await customer('Ningo Egg Distributors (TEST)');
    const two = await customer('Ada Foah Lodges (TEST)');
    const docs = new Map([
      [one.id, (await invoice(one.id, 12_000, today())).id],
      [two.id, (await invoice(two.id, 13_000, today())).id],
    ]);
    const [first, second] = [one.id, two.id].sort();
    clock.set(new Date(clock.now().getTime() + 7 * DAY));
    await admin().query(`CREATE FUNCTION public.test_dunning_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.customer_id = '${second!}' THEN RAISE EXCEPTION 'the worker stopped'; END IF; RETURN NEW; END $$`);
    await admin().query('CREATE TRIGGER trg_test_dunning_crash AFTER INSERT ON whl.dunning_notice FOR EACH ROW EXECUTE FUNCTION public.test_dunning_crash()');
    try {
      await expect(runDunning()).rejects.toThrow();
    } finally {
      await admin().query('DROP TRIGGER trg_test_dunning_crash ON whl.dunning_notice');
      await admin().query('DROP FUNCTION public.test_dunning_crash()');
    }
    const done = await notices(docs.get(first!)!);
    expect(done.map((n) => n.level)).toEqual([1]);
    expect(await queued(done[0]!.id)).toBe(1);
    expect(await notices(docs.get(second!)!)).toEqual([]);
    expect(Number((await admin().query<{ n: string }>("SELECT count(*)::text AS n FROM platform.outbox_message WHERE event_type = 'whl.DunningNoticeDue' AND payload->>'customerId' = $1", [second])).rows[0]!.n)).toBe(0);
    await runDunning();
    await runDunning();
    for (const documentId of docs.values()) {
      const sent = await notices(documentId);
      expect(sent.map((n) => n.level)).toEqual([1]);
      expect(await queued(sent[0]!.id)).toBe(1);
    }
  });

  it('holds each level once and never below a level passed in the database, and never changes a notice', async () => {
    const [sent] = await notices(id('sleeping'));
    const again = (level: number) =>
      app().query(
        `INSERT INTO whl.dunning_notice (id, customer_id, billing_document_id, branch_id, level, days_past_due, outstanding_pesewas, channels, template_code, notice_date, queued_at, actor_id)
         SELECT $2, customer_id, billing_document_id, branch_id, $3, days_past_due, outstanding_pesewas, channels, template_code, notice_date, queued_at, actor_id FROM whl.dunning_notice WHERE id = $1`,
        [sent!.id, randomUUID(), level],
      );
    expect(await sqlStateOf(again(3))).toBe('HK010');
    expect(await sqlStateOf(again(1))).toBe('HK010');
    expect(await sqlStateOf(app().query('UPDATE whl.dunning_notice SET level = 2 WHERE id = $1', [sent!.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('UPDATE whl.dunning_notice SET level = 2 WHERE id = $1', [sent!.id]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin().query('DELETE FROM whl.dunning_notice WHERE id = $1', [sent!.id]))).toBe(SQLSTATE.ledgerImmutable);
  });
});
