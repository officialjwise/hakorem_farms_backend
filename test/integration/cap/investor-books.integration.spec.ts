import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Financing } from '../../../src/modules/cap';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, setPortalPassword, testStartTime, type TestSession, SYSTEM_PRINCIPAL } from '../../support/iam';
import { sqlStateOf, SQLSTATE } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The rest of CAP (B12 continued, ADR-0101): payout details and the identity number sealed (FR-CAP-002), investor
 * documents and the portal's isolation (FR-IAM-013, FR-CAP-013), return metrics (FR-CAP-014) and loans and grants
 * (FR-CAP-015), over the seeded farm without its investors. The loan is FR-CAP-015's acceptance exactly: 100,000 at 12
 * percent for a 31-day month accrues 1,019, and a repayment of 5,000 clears 1,019 interest then 3,981 principal. The
 * loan starts on the first day of the first 31-day month after the clock's (ADR-0067); the clock is moved into it.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let accountant: TotpSession;
let owner: TotpSession;
let manager: TotpSession;
let bank: string;
const admin = () => database.pool('admin');
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const patch = (who: TestSession, path: string, body: object) => consolePatch(api.server, who, `/v1${path}`).send(body);
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const SEED_PASSWORD = `Seed-${randomUUID()}`;
const SCHEDULER = { principalId: '01900000-0000-7000-8000-000000000004', displayName: 'Scheduler' };
/** The daily job as the worker runs it: as the Scheduler. */
const accrueAll = () => runAsSystem(SCHEDULER, randomUUID(), () => api.app.get(Financing).accrueAll(SCHEDULER));
const ACCOUNT_NUMBER = '1020304051180';
let abena: { id: string; version: number };
let kwesi: { id: string };
let loanMonth: string;

async function approve(who: TotpSession, approvalRequestId: string) {
  await stepUp(api.server, who, clock);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the signed form' });
}

/** The lines of one journal entry, by account and subledger party, straight from the ledger. */
async function entryLines(eventCode: string, subjectId: string): Promise<Array<[string, string, number, string | null]>> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string; ref: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, p.ref_id::text AS ref
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id AND p.kind = 'INVESTOR'
      WHERE e.event_code = $1 AND e.event_subject_id = $2 ORDER BY l.side DESC, a.code`,
    [eventCode, subjectId],
  );
  return rows.map((r) => [r.code, r.side, Number(r.amount), r.ref]);
}

async function trialBalanceIsZero(): Promise<boolean> {
  const { rows } = await admin().query<{ d: string; c: string }>(
    "SELECT COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'D'), 0)::text AS d, COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'C'), 0)::text AS c FROM fin.journal_line",
  );
  return rows[0]!.d === rows[0]!.c;
}

async function upload(who: TestSession, name: string): Promise<string> {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 32), Buffer.from('\n%%EOF\n')]);
  const uploaded = await consolePost(api.server, who, '/v1/files').field('purpose', 'INVESTOR_DOCUMENT').attach('file', pdf, name);
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  // The scanner's verdict, as the worker records it (hk_worker is the only role that may).
  await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [uploaded.body.id]);
  return uploaded.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const long = String(800 * 86_400);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long, AUTH_CUSTOMER_REFRESH_IDLE_SECONDS: long } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  bank = (await admin().query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  // The first month after the clock's with 31 days.
  const now = clock.now();
  for (let ahead = 1; ; ahead += 1) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ahead, 1));
    if (new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate() === 31) {
      loanMonth = first.toISOString().slice(0, 7);
      break;
    }
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('payout details and the identity number are sealed (FR-CAP-002)', () => {
  it('stores ciphertext, shows only the masked form, and puts the details in force only when a different person approves', async () => {
    await stepUp(api.server, accountant, clock);
    const created = await post(accountant, '/investors', {
      kind: 'INDIVIDUAL',
      legalName: 'Abena Owusu',
      phone: '+233200000411',
      joinedOn: addDays(`${loanMonth}-01`, -120),
      idNumber: 'gha-723456789-3',
      payout: { method: 'BANK', bankName: 'GCB', accountName: 'Abena Owusu', accountNumber: ACCOUNT_NUMBER },
      createPortalLogin: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect([created.body.idNumberMasked, created.body.payoutMethod, created.body.payoutDetailsMasked, created.body.hasPortalLogin]).toEqual(['****89-3', null, null, true]);
    const approvalId = created.body.pendingPayoutApprovalRequestId as string;
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
    abena = { id: created.body.id, version: created.body.version };
    // A dump of the investor tables shows ciphertext: neither the account number nor the identity number is in clear.
    const dump = await admin().query<{ id_clear: boolean; payout_clear: boolean }>(
      `SELECT position(convert_to('723456789', 'UTF8') IN i.id_number_enc) > 0 AS id_clear, position(convert_to($2, 'UTF8') IN c.details_enc) > 0 AS payout_clear
         FROM cap.investor i JOIN cap.investor_payout_change c ON c.investor_id = i.id WHERE i.id = $1`,
      [abena.id, ACCOUNT_NUMBER],
    );
    expect(dump.rows).toEqual([{ id_clear: false, payout_clear: false }]);
    expect(JSON.stringify(created.body)).not.toContain(ACCOUNT_NUMBER);
    // The Accountant, who asked, cannot approve; the Owner approves with a fresh code.
    expect((await approve(accountant, approvalId)).status).toBe(403);
    const approved = await approve(owner, approvalId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = await get(accountant, `/investors/${abena.id}`);
    expect([after.body.payoutMethod, after.body.payoutDetailsMasked, after.body.pendingPayoutApprovalRequestId]).toEqual(['BANK', 'GCB, ****1180', null]);
    abena.version = after.body.version;
  });

  it('reveals the details in full only to the payout permission with step-up, and audits each decryption', async () => {
    expect((await get(accountant, `/investors/${abena.id}/payout-details`)).status).toBe(403);
    expect((await get(manager, `/investors/${abena.id}/payout-details`)).status).toBe(403);
    await stepUp(api.server, owner, clock);
    const revealed = await get(owner, `/investors/${abena.id}/payout-details`);
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    expect(revealed.body).toEqual({ investorId: abena.id, idNumber: 'GHA-723456789-3', inForce: { method: 'BANK', bankName: 'GCB', accountName: 'Abena Owusu', accountNumber: ACCOUNT_NUMBER }, pending: null });
    const audited = await admin().query("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'DECRYPT' AND entity_type = 'InvestorPayoutDetails' AND entity_id = $1", [abena.id]);
    expect(audited.rows[0].n).toBe(1);
  });

  it('never lets the person who asked for a change approve it, and keeps one change waiting at a time', async () => {
    await stepUp(api.server, owner, clock);
    const asked = await patch(owner, `/investors/${abena.id}`, { version: abena.version, payout: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233244310221' } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.payoutDetailsMasked).toBe('GCB, ****1180');
    const own = await approve(owner, asked.body.pendingPayoutApprovalRequestId);
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe('MAKER_CANNOT_CHECK');
    await stepUp(api.server, accountant, clock);
    const second = await patch(accountant, `/investors/${abena.id}`, { version: asked.body.version, payout: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233244310222' } });
    expect([second.status, second.body.error?.details?.[0]?.code]).toEqual([422, 'PAYOUT_CHANGE_PENDING']);
    // The database refuses the change applied by its own maker, whatever the application does.
    const state = await sqlStateOf(
      admin().query("UPDATE cap.investor_payout_change SET status = 'APPLIED', posted_at = now(), posted_by = created_by, version = version + 1 WHERE investor_id = $1 AND status = 'PENDING_APPROVAL'", [abena.id]),
    );
    expect(state).toBe(SQLSTATE.checkViolation);
    const malformed = await patch(accountant, `/investors/${abena.id}`, { version: asked.body.version, payout: { method: 'BANK', bankName: 'GCB', accountNumber: '12' } });
    expect(malformed.body.error.details.map((d: { code: string }) => d.code)).toEqual(['REQUIRED', 'ACCOUNT_NUMBER_INVALID', 'PAYOUT_CHANGE_PENDING']);
  });
});

describe('investor documents and the portal (FR-CAP-002, FR-IAM-013)', () => {
  it('keeps a document privately for its investor: she lists and downloads it, another investor cannot', async () => {
    await stepUp(api.server, accountant, clock);
    const other = await post(accountant, '/investors', { kind: 'INDIVIDUAL', legalName: 'Kwesi Mensah', phone: '+233200000412', joinedOn: addDays(`${loanMonth}-01`, -120), createPortalLogin: true });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    kwesi = { id: other.body.id };
    const fileId = await upload(accountant, 'abena-agreement.pdf');
    await stepUp(api.server, accountant, clock);
    const added = await post(accountant, `/investors/${abena.id}/documents`, { kind: 'AGREEMENT', name: 'Investment agreement', fileId });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await post(accountant, `/investors/${abena.id}/documents`, { kind: 'OTHER', name: 'Not scanned', fileId: randomUUID() })).body.error.details[0].code).toBe('FILE_NOT_USABLE');
    expect((await get(manager, `/investors/${abena.id}/documents`)).status).toBe(403);
    const principal = async (investorId: string) => (await admin().query<{ principal_id: string }>('SELECT principal_id FROM cap.investor WHERE id = $1', [investorId])).rows[0]!.principal_id;
    const her = await login(api.server, await setPortalPassword(database, await principal(abena.id)));
    const him = await login(api.server, await setPortalPassword(database, await principal(kwesi.id)));
    const mine = await get(her, '/investor/documents');
    expect(mine.body.data.map((d: { id: string; kind: string }) => [d.id, d.kind])).toEqual([[added.body.id, 'AGREEMENT']]);
    const link = await consolePost(api.server, her, `/v1/investor/documents/${added.body.id}/download`).send({});
    expect(link.status, JSON.stringify(link.body)).toBe(200);
    expect(link.body.url).toMatch(/^https?:\/\//);
    expect((await admin().query("SELECT count(*)::int AS n FROM platform.file_access_log WHERE file_id = $1 AND purpose = 'INVESTOR_DOCUMENT'", [fileId])).rows[0].n).toBe(1);
    expect((await get(him, '/investor/documents')).body.data).toEqual([]);
    const theirs = await consolePost(api.server, him, `/v1/investor/documents/${added.body.id}/download`).send({});
    const madeUp = await consolePost(api.server, him, `/v1/investor/documents/${randomUUID()}/download`).send({});
    // Another investor's document answers exactly as a made-up one: nothing tells them it exists.
    expect([theirs.status, madeUp.status, theirs.body.error.code, madeUp.body.error.code]).toEqual([404, 404, 'NOT_FOUND', 'NOT_FOUND']);
    expect(JSON.stringify(theirs.body)).not.toContain(added.body.id);
    expect((await consolePost(api.server, accountant, `/v1/investor/documents/${added.body.id}/download`).send({})).status).toBe(401);
    expect((await request(api.server).post(`/v1/investor/documents/${added.body.id}/download`).set('Origin', TEST_ORIGIN).send({})).status).toBe(401);
    expect((await get(him, '/investor/me')).body.investor.name).toBe('Kwesi Mensah');
    // An investor session reads nothing of the staff side.
    expect((await get(her, `/investors/${kwesi.id}`)).status).toBe(401);
  });
});

describe('return metrics (FR-CAP-014)', () => {
  it('answers ROI, payback and IRR per investor and overall, to the Owner and the Accountant only', async () => {
    const returns = await get(accountant, `/investors/${abena.id}/returns`);
    expect(returns.status, JSON.stringify(returns.body)).toBe(200);
    expect([returns.body.contributedPesewas, returns.body.distributedPesewas, returns.body.roiPercent, returns.body.paybackMonths, returns.body.irrPercent]).toEqual([0, 0, null, null, null]);
    expect((await get(owner, '/capital/returns')).status).toBe(200);
    expect((await get(manager, `/investors/${abena.id}/returns`)).status).toBe(403);
    expect((await get(manager, '/capital/returns')).status).toBe(403);
  });
});

describe('loans and grants (FR-CAP-015)', () => {
  let loan: { id: string; approvalRequestId: string };
  let grant: { id: string; approvalRequestId: string };

  it('records a loan as a draft that only someone else approves, and draws it into the bank against the lender', async () => {
    clock.set(new Date(`${loanMonth}-01T09:00:00Z`));
    expect((await post(manager, '/financing', {})).status).toBe(400);
    await stepUp(api.server, manager, clock);
    expect((await post(manager, '/financing', { kind: 'LOAN', lenderName: 'Agricultural Development Bank', principalPesewas: 100_000, annualRatePercent: '12', startDate: `${loanMonth}-01`, bankAccountId: bank })).status).toBe(403);
    await stepUp(api.server, accountant, clock);
    const flat = await post(accountant, '/financing', { kind: 'LOAN', lenderName: 'Agricultural Development Bank', principalPesewas: 100_000, annualRatePercent: '12', interestBasis: 'FLAT', startDate: `${loanMonth}-01`, bankAccountId: bank });
    expect(flat.body.error.details.map((d: { code: string }) => d.code)).toEqual(['INTEREST_BASIS_NOT_SUPPORTED']);
    const created = await post(accountant, '/financing', { kind: 'LOAN', lenderName: 'Agricultural Development Bank', principalPesewas: 100_000, annualRatePercent: '12', startDate: `${loanMonth}-01`, termMonths: 3, bankAccountId: bank });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect([created.body.status, created.body.outstandingPesewas, created.body.financingNo]).toEqual(['DRAFT', 100_000, expect.stringMatching(/^FNC-/)]);
    expect(created.body.schedule.map((i: { principalDuePesewas: number }) => i.principalDuePesewas)).toEqual([33_334, 33_333, 33_333]);
    expect(created.body.schedule[0].interestDuePesewas).toBe(1_019);
    loan = created.body;
    expect((await admin().query("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'cap.LoanDrawn'")).rows[0].n).toBe(0);
    expect((await approve(accountant, loan.approvalRequestId)).status).toBe(403);
    const approved = await approve(owner, loan.approvalRequestId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await get(accountant, `/financing/${loan.id}`)).body.status).toBe('ACTIVE');
    // Dr 1100 the bank, Cr 2400 against the lender, who is not an investor: the financing itself is the party (ADR-0101).
    expect(await entryLines('cap.LoanDrawn', loan.id)).toEqual([
      ['1100', 'D', 100_000, null],
      ['2400', 'C', 100_000, loan.id],
    ]);
    expect((await get(manager, '/financing')).status).toBe(403);
  });

  it('accrues half_up(100,000 x 0.12 x 31 / 365) = 1,019 for the month, once, on its last day', async () => {
    const [y, m] = loanMonth.split('-').map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const nextDay = addDays(monthEnd, 1);
    clock.set(new Date(`${nextDay}T09:00:00Z`));
    await accrueAll();
    await accrueAll();
    const accruals = await admin().query<{ amount: string; month_end: string; posting_date: string }>(
      `SELECT a.amount_pesewas::text AS amount, a.month_end::text AS month_end, e.posting_date::text AS posting_date
         FROM cap.financing_accrual a JOIN fin.journal_entry e ON e.id = a.journal_entry_id WHERE a.financing_id = $1`,
      [loan.id],
    );
    expect(accruals.rows).toEqual([{ amount: '1019', month_end: monthEnd, posting_date: monthEnd }]);
    const accrualId = (await admin().query<{ id: string }>('SELECT id FROM cap.financing_accrual WHERE financing_id = $1', [loan.id])).rows[0]!.id;
    expect(await entryLines('cap.InterestAccrued', accrualId)).toEqual([
      ['6930', 'D', 1_019, null],
      ['2410', 'C', 1_019, null],
    ]);
    expect((await get(accountant, `/financing/${loan.id}`)).body.accruedInterestPesewas).toBe(1_019);
  });

  it('applies a repayment of 5,000 to the 1,019 of interest first, then 3,981 of principal', async () => {
    const paidAt = clock.now().toISOString();
    await stepUp(api.server, accountant, clock);
    const principalFirst = await post(accountant, `/financing/${loan.id}/repayments`, { principalPesewas: 4_000, interestPesewas: 1_000, bankAccountId: bank, paidAt });
    expect(principalFirst.body.error.details.map((d: { code: string }) => d.code)).toEqual(['INTEREST_FIRST']);
    const tooMuchInterest = await post(accountant, `/financing/${loan.id}/repayments`, { principalPesewas: 0, interestPesewas: 1_020, bankAccountId: bank, paidAt });
    expect(tooMuchInterest.body.error.details.map((d: { code: string }) => d.code)).toEqual(['MORE_THAN_ACCRUED']);
    const repaid = await post(accountant, `/financing/${loan.id}/repayments`, { principalPesewas: 3_981, interestPesewas: 1_019, bankAccountId: bank, externalReference: 'ADB-REPAY-001', paidAt });
    expect(repaid.status, JSON.stringify(repaid.body)).toBe(201);
    expect([repaid.body.outstandingPesewas, repaid.body.accruedInterestPesewas, repaid.body.schedule[0].paidPesewas, repaid.body.status]).toEqual([96_019, 0, 5_000, 'ACTIVE']);
    const repaymentId = (await admin().query<{ id: string }>('SELECT id FROM cap.financing_repayment WHERE financing_id = $1', [loan.id])).rows[0]!.id;
    expect(await entryLines('cap.LoanRepaid', repaymentId)).toEqual([
      ['2400', 'D', 3_981, loan.id],
      ['2410', 'D', 1_019, null],
      ['1100', 'C', 5_000, null],
    ]);
    expect((await post(accountant, `/financing/${loan.id}/repayments`, { principalPesewas: 1, interestPesewas: 0, bankAccountId: bank, externalReference: 'ADB-REPAY-001', paidAt })).status).toBe(409);
    expect((await post(accountant, `/financing/${loan.id}/repayments`, { principalPesewas: 96_020, interestPesewas: 0, bankAccountId: bank, paidAt })).body.error.details[0].code).toBe('MORE_THAN_OUTSTANDING');
    // The database refuses more than is owed, and never changes a repayment.
    const user = (await admin().query<{ actor_id: string; journal_entry_id: string }>('SELECT actor_id, journal_entry_id FROM cap.financing_repayment WHERE id = $1', [repaymentId])).rows[0]!;
    const overpaid = await sqlStateOf(
      database.pool('app').query(
        `INSERT INTO cap.financing_repayment (id, financing_id, principal_pesewas, interest_pesewas, bank_account_id, paid_at, value_date, journal_entry_id, recorded_at, actor_id)
         VALUES ($1, $2, 96020, 0, $3, now(), CURRENT_DATE, $4, now(), $5)`,
        [randomUUID(), loan.id, bank, user.journal_entry_id, user.actor_id],
      ),
    );
    expect(overpaid).toBe('HK010');
    expect(await sqlStateOf(admin().query('UPDATE cap.financing_repayment SET interest_pesewas = 0 WHERE id = $1', [repaymentId]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await trialBalanceIsZero()).toBe(true);
  });

  it('receives a grant into deferred income and recognises it in equal monthly parts', async () => {
    const start = addDays(clock.now().toISOString().slice(0, 10), -1);
    await stepUp(api.server, accountant, clock);
    const interest = await post(accountant, '/financing', { kind: 'GRANT', lenderName: 'Ghana Poultry Project', principalPesewas: 30_001, annualRatePercent: '5', startDate: start, bankAccountId: bank });
    expect(interest.body.error.details.map((d: { code: string }) => d.code)).toEqual(['GRANT_HAS_NO_INTEREST', 'TERM_REQUIRED']);
    const created = await post(accountant, '/financing', { kind: 'GRANT', lenderName: 'Ghana Poultry Project', principalPesewas: 30_001, startDate: start, termMonths: 3, bankAccountId: bank });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    grant = created.body;
    expect((await approve(owner, grant.approvalRequestId)).status).toBe(200);
    expect(await entryLines('cap.GrantReceived', grant.id)).toEqual([
      ['1100', 'D', 30_001, null],
      ['2450', 'C', 30_001, null],
    ]);
    // It started yesterday, the last day of a month: that month (one day of it) has finished, and takes the first part.
    await accrueAll();
    const recognised = await admin().query<{ id: string; amount: string }>("SELECT id, amount_pesewas::text AS amount FROM cap.financing_accrual WHERE financing_id = $1 AND kind = 'RECOGNITION'", [grant.id]);
    expect(recognised.rows.map((r) => r.amount)).toEqual(['10001']);
    expect(await entryLines('cap.GrantRecognised', recognised.rows[0]!.id)).toEqual([
      ['2450', 'D', 10_001, null],
      ['4910', 'C', 10_001, null],
    ]);
    const after = await get(accountant, `/financing/${grant.id}`);
    expect([after.body.outstandingPesewas, after.body.status]).toEqual([20_000, 'ACTIVE']);
    await stepUp(api.server, accountant, clock);
    expect((await post(accountant, `/financing/${grant.id}/repayments`, { principalPesewas: 1, interestPesewas: 0, bankAccountId: bank, paidAt: clock.now().toISOString() })).body.error.details[0].code).toBe('NOT_A_LOAN');
    expect(await trialBalanceIsZero()).toBe(true);
  });

  it('publishes each finished month the job could not accrue, its period not open, for the exception report (abuse case 71), posting nothing', async () => {
    const accruals = async () => Number((await admin().query<{ n: string }>('SELECT count(*)::text AS n FROM cap.financing_accrual')).rows[0]!.n);
    await stepUp(api.server, accountant, clock);
    const created = await post(accountant, '/financing', { kind: 'LOAN', lenderName: 'Adinkra Rural Bank', principalPesewas: 50_000, annualRatePercent: '10', startDate: clock.now().toISOString().slice(0, 10), bankAccountId: bank });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await approve(owner, created.body.approvalRequestId)).status).toBe(200);
    const before = await accruals();
    // The new loan's first month finishes, but its period has been locked: the job cannot accrue it.
    const start = clock.now().toISOString().slice(0, 10);
    const [y, m] = start.split('-').map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    await database.pool('app').query(
      "UPDATE fin.accounting_period SET status = 'LOCKED', locked_at = now(), locked_by = $1, version = version + 1 WHERE start_date <= $2::date AND end_date >= $2::date AND status = 'OPEN'",
      [SYSTEM_PRINCIPAL, monthEnd],
    );
    clock.set(new Date(`${addDays(monthEnd, 1)}T09:00:00Z`));
    const run = await accrueAll();
    expect(run.blocked).toBeGreaterThan(0);
    const published = await admin().query<{ payload: { financingId: string; financingNo: string; monthEnd: string; branchId: string } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'cap.FinancingAccrualBlocked' ORDER BY id",
    );
    expect(published.rows).toHaveLength(run.blocked);
    expect(published.rows.map((r) => [r.payload.financingId, r.payload.monthEnd])).toContainEqual([created.body.id, monthEnd]);
    expect(published.rows[0]!.payload).toMatchObject({ financingId: expect.any(String), financingNo: expect.any(String), monthEnd: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), branchId: expect.any(String) });
    expect(await accruals()).toBeGreaterThanOrEqual(before);
    expect(await trialBalanceIsZero()).toBe(true);
  });
});
