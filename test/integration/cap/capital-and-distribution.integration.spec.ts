import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Capital and distributions (FR-CAP-001, FR-CAP-003 to FR-CAP-012, ADR-0028), the gate of B12: ADR-0028's Test 1 run
 * through the API over a 90-day period of the seeded farm (no seeded investors), its posting tied to the ledger exactly
 * (Test 5), withdrawals with approval, the maker never the checker, the wrong roles refused, and the database refusing
 * what the application would never write. The 90 days end on the last day of the third month after the clock's, so
 * every date is the clock's (ADR-0067); the clock then moves to the next month, so the period has ended and its
 * months can be locked. Every ledger figure is read back from FIN's own tables in SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let accountant: TotpSession;
let owner: TotpSession;
let manager: TestSession;
let cashier: TestSession;
let temaOwner: TotpSession;
let bank: string;
let period: { start: string; end: string };
let months: string[];
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const GHS_100 = 10_000;
const SEED_PASSWORD = `Seed-${randomUUID()}`;

async function approve(who: TotpSession, approvalRequestId: string) {
  await stepUp(api.server, who, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the bank advice' });
}
/** Recording capital needs a fresh step-up (cap.capital.record): each call takes one. */
async function contribute(investor: string, units: number, valueDate: string) {
  await stepUp(api.server, accountant, clock);
  return post(accountant, '/capital-transactions', { kind: 'CONTRIBUTION', investorId: id(investor), amountPesewas: units * GHS_100, valueDate, bankAccountId: bank });
}
async function withdraw(investor: string, units: number, valueDate: string) {
  await stepUp(api.server, accountant, clock);
  return post(accountant, '/capital-transactions', { kind: 'WITHDRAWAL', investorId: id(investor), amountPesewas: units * GHS_100, valueDate, bankAccountId: bank });
}
const unitsAt = async (investor: string, asOf: string) =>
  ((await get(owner, `/capital/register?asOf=${asOf}`)).body.data as Array<{ investor: { id: string }; units: string }>).find((h) => h.investor.id === id(investor))?.units ?? null;

/** Lines of one journal entry on one account, with the investor they name. */
async function entryLines(code: string, eventCode: string, subjectId: string): Promise<Array<[string, number, string | null]>> {
  const { rows } = await admin().query<{ side: string; amount: string; investor: string | null }>(
    `SELECT l.side, l.amount_pesewas::text AS amount, i.investor_no AS investor
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id LEFT JOIN cap.investor i ON i.id = p.ref_id
      WHERE a.code = $1 AND e.event_code = $2 AND e.event_subject_id = $3 ORDER BY i.investor_no NULLS LAST`,
    [code, eventCode, subjectId],
  );
  return rows.map((r) => [r.side, Number(r.amount), r.investor]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const long = String(800 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  bank = (await admin().query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
  const tema = await createBranch(database, 'TMA');
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
  temaOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'OWNER', branchId: tema.branchId }] }), () => clock.now());
  // ADR-0028 Test 1's 90 days, ending on the last day of the third month after the clock's.
  const now = clock.now();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 0)).toISOString().slice(0, 10);
  period = { start: addDays(end, -89), end };
  months = [];
  for (let day = period.start; day <= period.end; day = addDays(day, 1)) if (!months.includes(day.slice(0, 7))) months.push(day.slice(0, 7));
  clock.set(new Date(`${addDays(end, 2)}T09:00:00Z`));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the investor register (FR-CAP-001)', () => {
  it('numbers investors INV-001 onwards in order, and refuses every role that does not keep the investor books', async () => {
    const unstepped = await post(accountant, '/investors', { kind: 'INDIVIDUAL', legalName: 'No code', joinedOn: period.start });
    expect([unstepped.status, unstepped.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await stepUp(api.server, accountant, clock);
    for (const [name, legalName] of [
      ['ama', 'Ama Owusu-Ansah'],
      ['kofi', 'Kofi Ampofo'],
      ['esi', 'Esi Bonsu'],
      ['yaa', 'Yaa Dufie'],
    ] as const) {
      const created = await post(accountant, '/investors', { kind: 'INDIVIDUAL', legalName, phone: '+233200000399', joinedOn: addDays(period.start, -30) });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.set(name, created.body.id as string);
    }
    const listed = await get(owner, '/investors');
    expect(listed.body.data.map((i: { investorNo: string; units: string; status: string }) => [i.investorNo, i.units, i.status])).toEqual([
      ['INV-001', '0.0000', 'ACTIVE'],
      ['INV-002', '0.0000', 'ACTIVE'],
      ['INV-003', '0.0000', 'ACTIVE'],
      ['INV-004', '0.0000', 'ACTIVE'],
    ]);
    for (const who of [manager, cashier, temaOwner]) {
      expect((await get(who, '/investors')).status).toBe(403);
      expect((await get(who, `/investors/${id('ama')}`)).status).toBe(403);
      expect((await post(who, '/investors', { kind: 'ENTITY', legalName: 'Nobody', joinedOn: period.start })).status).toBe(403);
      expect((await get(who, '/capital/register')).status).toBe(403);
      expect((await contributeAs(who, 'ama', 1, period.start)).status).toBe(403);
    }
    expect((await admin().query('SELECT count(*)::int AS n FROM cap.investor')).rows[0].n).toBe(4);
    // An investor is never deleted (FR-CAP-001), and the version guards an edit.
    expect(await sqlStateOf(admin().query('UPDATE cap.investor SET deleted_at = now(), deleted_by = created_by, delete_reason = $2, version = version + 1 WHERE id = $1', [id('yaa'), 'gone']))).toBe(SQLSTATE.checkViolation);
    const stale = await consolePatch(api.server, accountant, `/v1/investors/${id('yaa')}`).send({ version: 7, email: 'yaa@example.com' });
    expect(stale.status).toBe(409);
    // Payout details are judged since B12 continued (2.46.0, LOUD: FIELD_NOT_YET_SUPPORTED retired): incomplete ones are
    // refused, and nothing is written.
    const payout = await post(accountant, '/investors', { kind: 'INDIVIDUAL', legalName: 'Too soon', joinedOn: period.start, payout: { method: 'BANK' } });
    expect([payout.status, payout.body.error.details.map((d: { field: string; code: string }) => [d.field, d.code])]).toEqual([
      422,
      [
        ['/payout/bankName', 'REQUIRED'],
        ['/payout/accountName', 'REQUIRED'],
        ['/payout/accountNumber', 'REQUIRED'],
      ],
    ]);
    expect((await admin().query('SELECT count(*)::int AS n FROM cap.investor')).rows[0].n).toBe(4);
  });
});

function contributeAs(who: TestSession, investor: string, units: number, valueDate: string) {
  return post(who, '/capital-transactions', { kind: 'CONTRIBUTION', investorId: id(investor), amountPesewas: units * GHS_100, valueDate, bankAccountId: bank });
}

describe('capital contributions (FR-CAP-003)', () => {
  it('issues units at the value date and posts to 3000', async () => {
    const ama = await contribute('ama', 1_000, addDays(period.start, -10));
    expect(ama.status, JSON.stringify(ama.body)).toBe(201);
    expect(ama.body).toMatchObject({ kind: 'CONTRIBUTION', amountPesewas: 10_000_000, unitPricePesewas: GHS_100, units: '1000.0000', valueDate: addDays(period.start, -10), currency: 'GHS' });
    expect(ama.body.transactionNo).toMatch(/^CAP-\d{4}-DDW-\d{6}$/);
    expect(await entryLines('3000', 'cap.CapitalContributed', ama.body.id as string)).toEqual([['C', 10_000_000, 'INV-001']]);
    expect(await entryLines('1100', 'cap.CapitalContributed', ama.body.id as string)).toEqual([['D', 10_000_000, null]]);
    expect((await contribute('kofi', 500, addDays(period.end, -44))).status).toBe(201);
    expect((await contribute('esi', 250, addDays(period.start, -10))).status).toBe(201);
    expect((await contribute('esi', 250, addDays(period.end, -30))).status).toBe(201);
    expect((await contribute('yaa', 500, addDays(period.start, -20))).status).toBe(201);
    expect(await unitsAt('kofi', addDays(period.end, -45))).toBeNull();
    expect(await unitsAt('kofi', addDays(period.end, -44))).toBe('500.0000');
  });

  it('refuses units that do not divide exactly, a value date after today, an unknown account and a closed period, writing nothing', async () => {
    const before = (await admin().query('SELECT count(*)::int AS n FROM cap.capital_transaction')).rows[0].n;
    await stepUp(api.server, accountant, clock);
    const odd = await post(accountant, '/capital-transactions', { kind: 'CONTRIBUTION', investorId: id('ama'), amountPesewas: 1, unitPricePesewas: 3, valueDate: period.start, bankAccountId: bank });
    expect([odd.status, odd.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['UNITS_NOT_EXACT']]);
    const future = await contribute('ama', 1, addDays(period.end, 30));
    expect(future.body.error.details.map((d: { code: string }) => d.code)).toEqual(['VALUE_DATE_IN_FUTURE']);
    await stepUp(api.server, accountant, clock);
    const unknown = await post(accountant, '/capital-transactions', { kind: 'CONTRIBUTION', investorId: id('ama'), amountPesewas: GHS_100, valueDate: period.start, bankAccountId: randomUUID() });
    expect(unknown.body.error.details.map((d: { code: string }) => d.code)).toEqual(['BANK_ACCOUNT_UNKNOWN']);
    expect((await admin().query('SELECT count(*)::int AS n FROM cap.capital_transaction')).rows[0].n).toBe(before);
  });
});

describe('capital withdrawals (FR-CAP-004)', () => {
  it('cannot exceed the holding and needs approval by someone other than the maker, with step-up', async () => {
    const tooMany = await withdraw('yaa', 600, addDays(period.start, -15));
    expect([tooMany.status, tooMany.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['MORE_THAN_HELD']]);
    const asked = await withdraw('yaa', 100, addDays(period.start, -15));
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'CAPITAL_WITHDRAWAL', subject: { docType: 'CAPITAL_WITHDRAWAL', number: null } });
    expect(await unitsAt('yaa', addDays(period.start, -15))).toBe('500.0000');
    const approval = asked.body.approvalRequestId as string;
    // The Accountant who asked holds no checker's permission; the Owner needs a fresh code.
    await stepUp(api.server, accountant, clock);
    expect((await post(accountant, `/iam/approvals/${approval}/approve`, { reason: 'Mine' })).status).toBe(403);
    clock.advanceBy(6 * 60_000);
    const stale = await post(owner, `/iam/approvals/${approval}/approve`, { reason: 'No code' });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect((await approve(owner, approval)).status).toBe(200);
    expect(await unitsAt('yaa', addDays(period.start, -16))).toBe('500.0000');
    expect(await unitsAt('yaa', addDays(period.start, -15))).toBe('400.0000');
    const written = await admin().query<{ id: string; actor_id: string }>("SELECT id, actor_id FROM cap.capital_transaction WHERE kind = 'WITHDRAWAL'");
    expect(await entryLines('3000', 'cap.CapitalWithdrawn', written.rows[0]!.id)).toEqual([['D', 1_000_000, 'INV-004']]);
  });

  it('is refused by the database when it would redeem more units than are held on its value date', async () => {
    // Two asks of 300 each pass on their own; once the first is applied the second would redeem 300 of the 100 left.
    const first = await withdraw('yaa', 300, addDays(period.start, -12));
    const second = await withdraw('yaa', 300, addDays(period.start, -12));
    expect([first.status, second.status]).toEqual([202, 202]);
    expect((await approve(owner, first.body.approvalRequestId as string)).status).toBe(200);
    const late = await approve(owner, second.body.approvalRequestId as string);
    expect([late.status, late.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['MORE_THAN_HELD']]);
    // The database holds the rule without the application: the second request applied by hand, its transaction refused.
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      const request = second.body.subject.id as string;
      const ownerPrincipal = (await client.query<{ posted_by: string }>("SELECT posted_by FROM cap.capital_withdrawal_request WHERE status = 'APPLIED' LIMIT 1")).rows[0]!.posted_by;
      await client.query("UPDATE cap.capital_withdrawal_request SET status = 'APPLIED', posted_at = now(), posted_by = $2, version = version + 1 WHERE id = $1", [request, ownerPrincipal]);
      const txId = randomUUID();
      const journalId = randomUUID();
      await client.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'CAPITAL_TRANSACTION', 'cap', $2, $3), ($4, 'JOURNAL', 'fin', $2, $3)", [txId, branchId, ownerPrincipal, journalId]);
      const no = (await client.query<{ n: string }>("SELECT platform.allocate_number(platform.open_number_series('CAPITAL_TRANSACTION', 2030, $1, 'DDW', ''), $2) AS n", [branchId, txId])).rows[0]!.n;
      const state = await sqlStateOf(
        client.query(
          `INSERT INTO cap.capital_transaction (id, transaction_no, investor_id, branch_id, kind, amount_pesewas, value_date, posting_date, unit_price_pesewas, units, bank_account_id,
             approval_request_id, withdrawal_request_id, journal_entry_id, recorded_at, actor_id)
           SELECT $1, $2, q.investor_id, q.branch_id, 'WITHDRAWAL', q.amount_pesewas, q.value_date, q.value_date, q.unit_price_pesewas, q.units, q.bank_account_id, q.approval_request_id, q.id, $3, now(), $4
             FROM cap.capital_withdrawal_request q WHERE q.id = $5`,
          [txId, no, journalId, ownerPrincipal, request],
        ),
      );
      expect(state).toBe('HK010');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // A capital transaction is never changed or removed.
    expect(await sqlStateOf(admin().query("UPDATE cap.capital_transaction SET amount_pesewas = 1 WHERE kind = 'CONTRIBUTION'"))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin().query('DELETE FROM cap.capital_transaction'))).toBe(SQLSTATE.ledgerImmutable);
    // The last 100 units go before the period: Yaa holds nothing in it and has no line.
    const rest = await withdraw('yaa', 100, addDays(period.start, -5));
    expect((await approve(owner, rest.body.approvalRequestId as string)).status).toBe(200);
    expect(await unitsAt('yaa', period.start)).toBe('0.0000');
  });
});

describe('a distribution run (ADR-0028, FR-CAP-006 to FR-CAP-012)', () => {
  let runId: string;
  let lines: Array<{ id: string; investor: { investorNo: string }; unitDays: string; allocatedPesewas: number; receivedExtraPesewa: boolean; netPayablePesewas: number }>;

  it('is refused over periods still open; the net profit of 1,666,668 comes from the ledger once they are locked', async () => {
    const { account, bankParty } = await ledgerIds(database);
    await postManualJournal(api.server, clock, { maker: accountant, checker: owner }, {
      postingDate: period.end,
      description: 'Takings for the quarter (TEST)',
      lines: [
        { accountId: account('1100'), side: 'D', amountPesewas: 1_666_668, subledgerPartyId: bankParty('GCB current account (SEED)') },
        { accountId: account('4000'), side: 'C', amountPesewas: 1_666_668 },
      ],
    });
    const open = await post(accountant, '/distribution-runs', { periodStart: period.start, periodEnd: period.end });
    expect([open.status, open.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['PERIOD_NOT_LOCKED']]);
    await stepUp(api.server, accountant, clock);
    for (const month of months) {
      const locked = await post(accountant, `/finance/periods/01900000-0000-7000-8400-000000${month.replace('-', '')}/lock`);
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    }
    // A contribution dated in a locked period is refused (FR-CAP-003).
    const late = await contribute('kofi', 1, addDays(period.end, -1));
    expect(late.body.error.details.map((d: { code: string }) => d.code)).toEqual(['PERIOD_NOT_OPEN']);
  });

  it('allocates an awkward amount across three investors without creating or losing a pesewa', async () => {
    const created = await post(accountant, '/distribution-runs', { periodStart: period.start, periodEnd: period.end });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    runId = created.body.id as string;
    expect(created.body).toMatchObject({ daysInPeriod: 90, netProfitPesewas: 1_666_668, retainedPesewas: 666_667, distributablePesewas: 1_000_001, totalUnitDays: '142750.0000', status: 'DRAFT' });
    lines = created.body.lines;
    expect(lines.map((l) => [l.investor.investorNo, l.unitDays, l.allocatedPesewas, l.receivedExtraPesewa])).toEqual([
      ['INV-001', '90000.0000', 630_474, true],
      ['INV-002', '22500.0000', 157_618, false],
      ['INV-003', '30250.0000', 211_909, false],
    ]);
    expect(lines.reduce((sum, l) => sum + l.allocatedPesewas, 0)).toBe(1_000_001);
    for (const who of [manager, cashier, temaOwner]) expect((await get(who, `/distribution-runs/${runId}`)).status).toBe(403);
    expect((await post(manager, '/distribution-runs', { periodStart: period.start, periodEnd: period.end })).status).toBe(403);
    // Recomputed while a draft, it reaches the same figures from the ledger and the register as they stand.
    const again = await post(accountant, `/distribution-runs/${runId}/recompute`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.lines.map((l: { allocatedPesewas: number }) => l.allocatedPesewas)).toEqual([630_474, 157_618, 211_909]);
    lines = again.body.lines;
  });

  it('needs a different approver with step-up, and an approved run is never recomputed', async () => {
    const submitted = await post(accountant, `/distribution-runs/${runId}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    const recompute = await post(accountant, `/distribution-runs/${runId}/recompute`);
    expect([recompute.status, recompute.body.error.details[0].code]).toEqual([422, 'RUN_NOT_EDITABLE']);
    await stepUp(api.server, accountant, clock);
    expect((await post(accountant, `/distribution-runs/${runId}/post`)).body.error.details[0].code).toBe('RUN_NOT_APPROVED');
    expect((await post(accountant, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'Mine' })).status).toBe(403);
    expect((await approve(owner, submitted.body.approvalRequestId as string)).status).toBe(200);
    expect((await post(accountant, `/distribution-runs/${runId}/recompute`)).status).toBe(422);
    // The database: the maker is never the checker, and an approved run's figures never move.
    expect(await sqlStateOf(admin().query('UPDATE cap.distribution_run SET approved_by = created_by, version = version + 1 WHERE id = $1', [runId]))).toBe('HK004');
    expect(await sqlStateOf(admin().query('UPDATE cap.distribution_run SET distributable_pesewas = 1, net_profit_pesewas = 666668, version = version + 1 WHERE id = $1', [runId]))).toBe('HK004');
  });

  it('the posted distribution ties to the ledger', async () => {
    await stepUp(api.server, accountant, clock);
    const posted = await post(accountant, `/distribution-runs/${runId}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const debits = await entryLines('3300', 'cap.DistributionDeclared', runId);
    expect(debits).toEqual([
      ['D', 630_474, 'INV-001'],
      ['D', 157_618, 'INV-002'],
      ['D', 211_909, 'INV-003'],
    ]);
    expect(debits.reduce((sum, [, amount]) => sum + amount, 0)).toBe(1_000_001);
    expect(await entryLines('2300', 'cap.DistributionDeclared', runId)).toEqual([
      ['C', 630_474, 'INV-001'],
      ['C', 157_618, 'INV-002'],
      ['C', 211_909, 'INV-003'],
    ]);
    const tb = await admin().query<{ d: string; c: string }>(
      "SELECT sum(amount_pesewas) FILTER (WHERE side = 'D')::text AS d, sum(amount_pesewas) FILTER (WHERE side = 'C')::text AS c FROM fin.journal_line",
    );
    expect(tb.rows[0]!.d).toBe(tb.rows[0]!.c);
    const run = await admin().query<{ journal_entry_id: string; status: string }>('SELECT journal_entry_id, status FROM cap.distribution_run WHERE id = $1', [runId]);
    expect(run.rows[0]!.status).toBe('POSTED');
    expect(run.rows[0]!.journal_entry_id).toEqual(expect.any(String));
  });

  it('cannot exceed net payable', async () => {
    const ama = lines[0]!;
    clock.advanceBy(6 * 60_000);
    const unstepped = await post(owner, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 1, bankAccountId: bank });
    expect([unstepped.status, unstepped.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    await stepUp(api.server, accountant, clock);
    const first = await post(accountant, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 300_000, bankAccountId: bank, externalReference: 'TEST-AMA-1' });
    expect([first.status, first.body.paidPesewas]).toEqual([201, 300_000]);
    const over = await post(accountant, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 330_475, bankAccountId: bank, externalReference: 'TEST-AMA-2' });
    expect([over.status, over.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['MORE_THAN_PAYABLE']]);
    const reused = await post(accountant, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 1, bankAccountId: bank, externalReference: 'TEST-AMA-1' });
    expect(reused.status).toBe(409);
    expect((await post(manager, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 1, bankAccountId: bank })).status).toBe(403);
    const rest = await post(accountant, `/distribution-lines/${ama.id}/payments`, { amountPesewas: 330_474, bankAccountId: bank, externalReference: 'TEST-AMA-2' });
    expect([rest.status, rest.body.paidPesewas]).toEqual([201, 630_474]);
    // The database refuses a line paid above its net payable, whoever writes it.
    expect(await sqlStateOf(admin().query('UPDATE cap.distribution_line SET paid_pesewas = paid_pesewas + 1 WHERE id = $1', [ama.id]))).toBe(SQLSTATE.checkViolation);
    expect((await get(accountant, `/distribution-runs/${runId}`)).body.status).toBe('POSTED');
    for (const line of lines.slice(1)) expect((await post(accountant, `/distribution-lines/${line.id}/payments`, { amountPesewas: line.netPayablePesewas, bankAccountId: bank })).status).toBe(201);
    const paid = await get(accountant, `/distribution-runs/${runId}`);
    expect([paid.body.status, paid.body.paidPesewas]).toEqual(['PAID', 1_000_001]);
    const payable = await admin().query<{ n: string }>(
      "SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code = '2300'",
    );
    expect(payable.rows[0]!.n).toBe('0');
  });

  it('distributes a period once', async () => {
    const twice = await post(accountant, '/distribution-runs', { periodStart: addDays(period.start, 10), periodEnd: period.end });
    expect(twice.body.error.details.map((d: { code: string }) => d.code)).toEqual(['PERIOD_ALREADY_DISTRIBUTED']);
  });
});
