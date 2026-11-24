import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, setPortalPassword, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * UAT scenario 4, investor distribution (docs/UAT.md section 8), run at the desk against the seeded farm with its
 * investors (UAT section 3.5, `farm-cap.ts`): the hand calculation of part A, then part B through the API. Efua Asante
 * is the Accountant who runs it; Akua Mensah is the Owner who approves. The period is 1 July to 30 September 2026, 92
 * days; net profit GHS 41,666.70; 40 percent kept; GHS 25,000.02 shared by unit-days with largest remainder. Every
 * figure is the script's, to the pesewa, and every ledger figure is read back from FIN's own tables in SQL. Steps 4.10
 * and 4.11 run through the investor portal (B12 continued): each investor signs in and reads only their own figures.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let efua: TotpSession;
let akua: TotpSession;
let manager: TestSession;
const admin = () => database.pool('admin');
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const periodId = (month: number) => `01900000-0000-7000-8400-0000002026${String(month).padStart(2, '0')}`;
const Q3 = { periodStart: '2026-07-01', periodEnd: '2026-09-30' };
const SEED_PASSWORD = `Seed-${randomUUID()}`;
let runId: string;

/** An account's lines over the run's journal, per investor, straight from the ledger. */
async function runJournal(code: string, eventCode: string, subjectId: string): Promise<Array<{ side: string; amount: number; investor: string | null }>> {
  const { rows } = await admin().query<{ side: string; amount: string; investor: string | null }>(
    `SELECT l.side, l.amount_pesewas::text AS amount, i.legal_name AS investor
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
       LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id LEFT JOIN cap.investor i ON i.id = p.ref_id
      WHERE a.code = $1 AND e.event_code = $2 AND e.event_subject_id = $3 ORDER BY i.investor_no`,
    [code, eventCode, subjectId],
  );
  return rows.map((r) => ({ side: r.side, amount: Number(r.amount), investor: r.investor }));
}

/** An investor's balance on an account (debits less credits), over the whole ledger. */
async function investorBalance(code: string, name: string): Promise<number> {
  const { rows } = await admin().query<{ n: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party p ON p.id = l.subledger_party_id JOIN cap.investor i ON i.id = p.ref_id
      WHERE a.code = $1 AND i.legal_name = $2`,
    [code, name],
  );
  return Number(rows[0]!.n);
}

async function trialBalanceIsZero(): Promise<boolean> {
  const { rows } = await admin().query<{ d: string; c: string }>(
    "SELECT COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'D'), 0)::text AS d, COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'C'), 0)::text AS c FROM fin.journal_line",
  );
  return rows[0]!.d === rows[0]!.c;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }, { investors: true }));
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  efua = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  akua = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('UAT scenario 4: investor distribution (docs/UAT.md section 8)', () => {
  it('4.1: the capital register as of 30 September 2026 shows 4,200 units and GHS 420,000.00 paid in', async () => {
    const register = await get(efua, '/capital/register?asOf=2026-09-30');
    expect(register.status, JSON.stringify(register.body)).toBe(200);
    expect(register.body.data.map((h: { investor: { investorNo: string; name: string }; units: string; sharePercent: string; netCapitalPesewas: number }) => [h.investor.investorNo, h.investor.name, h.units, h.sharePercent, h.netCapitalPesewas])).toEqual([
      ['INV-001', 'Ama Owusu-Ansah', '1000.0000', '23.8095', 10_000_000],
      ['INV-002', 'Kofi Ampofo', '500.0000', '11.9048', 5_000_000],
      ['INV-003', 'Esi Bonsu', '500.0000', '11.9048', 5_000_000],
      ['INV-004', 'Yaw Frimpong', '200.0000', '4.7619', 2_000_000],
      ['INV-005', 'Akwaaba Diaspora Agro Fund', '2000.0000', '47.6190', 20_000_000],
    ]);
    expect([register.body.totalUnits, register.body.totalNetCapitalPesewas, register.body.asOf]).toEqual(['4200.0000', 42_000_000, '2026-09-30']);
    // Before Akwaaba's 15 July contribution, as at 14 July 2026: Ama 1,000, Esi's first 250 and Yaw 200.
    const july = await get(efua, '/capital/register?asOf=2026-07-14');
    expect(july.body.totalUnits).toBe('1450.0000');
    // Investor data is confidential: the Manager reads none of it (A-381).
    expect((await get(manager, '/capital/register?asOf=2026-09-30')).status).toBe(403);
    expect((await get(manager, '/investors')).status).toBe(403);
  });

  it('4.2: the income statement for 1 July to 30 September 2026 shows net profit GHS 41,666.70', async () => {
    const pl = await get(efua, '/finance/profit-and-loss?from=2026-07-01&to=2026-09-30');
    expect(pl.status, JSON.stringify(pl.body)).toBe(200);
    const net = (pl.body.sections as Array<{ key: string; totalPesewas: number; totalIsNegative: boolean }>).find((s) => s.key === 'NET_PROFIT')!;
    expect([net.totalPesewas, net.totalIsNegative]).toEqual([4_166_670, false]);
  });

  it('4.3: a run is refused while the three months are open; Efua locks July, August and September', async () => {
    const refused = await post(efua, '/distribution-runs', Q3);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'DISTRIBUTION_RUN_INVALID', details: [{ field: '/periodEnd', code: 'PERIOD_NOT_LOCKED' }] });
    expect((await admin().query('SELECT count(*)::int AS n FROM cap.distribution_run')).rows[0].n).toBe(0);
    await stepUp(api.server, efua, clock);
    for (const month of [7, 8, 9]) {
      const locked = await post(efua, `/finance/periods/${periodId(month)}/lock`);
      expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    }
  });

  it('4.4 and 4.5: the draft run matches the hand calculation of part A to the pesewa', async () => {
    const created = await post(efua, '/distribution-runs', Q3);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    runId = created.body.id as string;
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
      daysInPeriod: 92,
      netProfitPesewas: 4_166_670,
      isLoss: false,
      retentionRatePercent: '40.00',
      retainedPesewas: 1_666_668,
      distributablePesewas: 2_500_002,
      allocationMethod: 'UNIT_DAYS',
      totalUnitDays: '320400.0000',
      withholdingRatePercent: '0.00',
      paidPesewas: 0,
      currency: 'GHS',
    });
    expect(created.body.runNo).toMatch(/^DST-\d{4}-DDW-\d{6}$/);
    expect(created.body.dayCountConvention).toContain('the contribution day counts, the withdrawal day does not');
    const lines = created.body.lines as Array<{ investor: { name: string }; unitDays: string; allocatedPesewas: number; receivedExtraPesewa: boolean; withheldPesewas: number; netPayablePesewas: number }>;
    expect(lines.map((l) => [l.investor.name, l.unitDays, l.allocatedPesewas, l.receivedExtraPesewa, l.withheldPesewas, l.netPayablePesewas])).toEqual([
      ['Ama Owusu-Ansah', '92000.0000', 717_853, false, 0, 717_853],
      ['Kofi Ampofo', '23500.0000', 183_365, true, 0, 183_365],
      ['Esi Bonsu', '30500.0000', 237_984, true, 0, 237_984],
      ['Yaw Frimpong', '18400.0000', 143_571, true, 0, 143_571],
      ['Akwaaba Diaspora Agro Fund', '156000.0000', 1_217_229, false, 0, 1_217_229],
    ]);
    expect(lines.reduce((sum, l) => sum + l.allocatedPesewas, 0)).toBe(2_500_002);
  });

  it('4.6 and 4.7: Efua submits and cannot approve her own run; Akua approves only with a fresh code', async () => {
    const submitted = await post(efua, `/distribution-runs/${runId}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'INVESTOR_DISTRIBUTION', subject: { id: runId, docType: 'DISTRIBUTION_RUN' } });
    const approval = submitted.body.approvalRequestId as string;
    await stepUp(api.server, efua, clock);
    expect((await post(efua, `/iam/approvals/${approval}/approve`, { reason: 'Mine' })).status).toBe(403);
    expect((await get(efua, `/distribution-runs/${runId}`)).body.status).toBe('PENDING_APPROVAL');
    clock.advanceBy(6 * 60_000);
    const stale = await post(akua, `/iam/approvals/${approval}/approve`, { reason: 'Checked against the hand calculation' });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    await stepUp(api.server, akua, clock);
    const approved = await post(akua, `/iam/approvals/${approval}/approve`, { reason: 'Checked against the hand calculation' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const run = await admin().query<{ status: string; approved_by: string; created_by: string }>('SELECT status, approved_by, created_by FROM cap.distribution_run WHERE id = $1', [runId]);
    expect(run.rows[0]!.status).toBe('APPROVED');
    expect(run.rows[0]!.approved_by).not.toBe(run.rows[0]!.created_by);
    // The schedule archived at submission is the approved one, and is served once rendered.
    await documentWorker(api, database, clock).settle();
    const schedule = await post(efua, `/distribution-runs/${runId}/schedule`);
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    expect(schedule.body.url).toEqual(expect.any(String));
  });

  it('4.8: posted, 3300 is debited GHS 25,000.02 and 2300 credited each investor’s share; nothing for what is kept; the trial balance balances', async () => {
    await stepUp(api.server, efua, clock);
    const posted = await post(efua, `/distribution-runs/${runId}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.status).toBe('POSTED');
    const debits = await runJournal('3300', 'cap.DistributionDeclared', runId);
    expect(debits.every((l) => l.side === 'D')).toBe(true);
    expect(debits.reduce((sum, l) => sum + l.amount, 0)).toBe(2_500_002);
    expect(await runJournal('2300', 'cap.DistributionDeclared', runId)).toEqual([
      { side: 'C', amount: 717_853, investor: 'Ama Owusu-Ansah' },
      { side: 'C', amount: 183_365, investor: 'Kofi Ampofo' },
      { side: 'C', amount: 237_984, investor: 'Esi Bonsu' },
      { side: 'C', amount: 143_571, investor: 'Yaw Frimpong' },
      { side: 'C', amount: 1_217_229, investor: 'Akwaaba Diaspora Agro Fund' },
    ]);
    const accounts = await admin().query<{ code: string }>(
      "SELECT DISTINCT a.code FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id WHERE e.event_code = 'cap.DistributionDeclared' ORDER BY 1",
    );
    expect(accounts.rows.map((r) => r.code)).toEqual(['2300', '3300']);
    expect(await trialBalanceIsZero()).toBe(true);
  });

  it('4.9: paid, Yaw by mobile money and the rest by bank; 2300 returns to nil for every investor and the run is paid', async () => {
    const bank = (await admin().query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
    const momo = (await admin().query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'MTN MoMo merchant wallet (SEED)'")).rows[0]!.id;
    await stepUp(api.server, efua, clock);
    const run = (await get(efua, `/distribution-runs/${runId}`)).body as { lines: Array<{ id: string; investor: { name: string }; netPayablePesewas: number }> };
    for (const line of run.lines) {
      const paid = await post(efua, `/distribution-lines/${line.id}/payments`, { amountPesewas: line.netPayablePesewas, bankAccountId: line.investor.name === 'Yaw Frimpong' ? momo : bank, externalReference: `UAT4-${line.investor.name.slice(0, 3)}` });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.paidPesewas).toBe(line.netPayablePesewas);
      expect(await investorBalance('2300', line.investor.name)).toBe(0);
    }
    const paidRun = await get(efua, `/distribution-runs/${runId}`);
    expect([paidRun.body.status, paidRun.body.paidPesewas]).toEqual(['PAID', 2_500_002]);
    const momoLeg = await admin().query<{ code: string; amount: string }>(
      `SELECT a.code, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
        WHERE e.event_code = 'cap.DistributionPaid' AND l.side = 'C' AND a.code = '1110'`,
    );
    expect(momoLeg.rows).toEqual([{ code: '1110', amount: '143571' }]);
    expect(await trialBalanceIsZero()).toBe(true);
  });

  /** Access tokens last ten minutes and the clock has moved on: the console refreshes its sessions, as a browser does. */
  async function refreshStaff(): Promise<void> {
    for (const session of [efua, akua]) {
      const refreshed = await request(api.server).post('/v1/auth/refresh').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      session.jar.store(refreshed.headers['set-cookie']);
    }
  }

  /** Efua opens the investor's portal login; the investor sets a password (the reset, done here in SQL) and signs in. */
  async function portalSession(name: string): Promise<TestSession> {
    await refreshStaff();
    const investor = (await get(efua, '/investors')).body.data.find((i: { legalName: string }) => i.legalName === name) as { id: string; version: number };
    await stepUp(api.server, efua, clock);
    const opened = await consolePatch(api.server, efua, `/v1/investors/${investor.id}`).send({ version: investor.version, createPortalLogin: true });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.hasPortalLogin).toBe(true);
    const principalId = (await admin().query<{ principal_id: string }>('SELECT principal_id FROM cap.investor WHERE id = $1', [investor.id])).rows[0]!.principal_id;
    return login(api.server, await setPortalPassword(database, principalId), 'Phone');
  }
  const others = ['Kofi Ampofo', 'Esi Bonsu', 'Yaw Frimpong', 'Akwaaba Diaspora Agro Fund', 'Ama Owusu-Ansah'];

  it('4.10: Ama signs in to the portal and sees her own 1,000 units, her GHS 7,178.53 and her statement, and nobody else', async () => {
    const ama = await portalSession('Ama Owusu-Ansah');
    const me = await get(ama, '/investor/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect([me.body.investor.name, me.body.units, me.body.allocatedPesewas, me.body.paidPesewas, me.body.outstandingPesewas, me.body.contributedPesewas]).toEqual([
      'Ama Owusu-Ansah',
      '1000.0000',
      717_853,
      717_853,
      0,
      10_000_000,
    ]);
    const distributions = await get(ama, '/investor/distributions');
    expect(distributions.body.data.map((l: { periodStart: string; periodEnd: string; allocatedPesewas: number; status: string }) => [l.periodStart, l.periodEnd, l.allocatedPesewas, l.status])).toEqual([
      ['2026-07-01', '2026-09-30', 717_853, 'PAID'],
    ]);
    const statement = await get(ama, '/investor/statement?from=2025-06-01&to=2099-12-31');
    expect(statement.status, JSON.stringify(statement.body)).toBe(200);
    expect([statement.body.openingCapitalPesewas, statement.body.closingCapitalPesewas, statement.body.allocatedInPeriodPesewas, statement.body.paidInPeriodPesewas]).toEqual([0, 10_000_000, 717_853, 717_853]);
    expect(statement.body.lines.map((l: { kind: string; amountPesewas: number; direction: string }) => [l.kind, l.amountPesewas, l.direction])).toEqual([
      ['CONTRIBUTION', 10_000_000, 'IN'],
      ['DISTRIBUTION_ALLOCATED', 717_853, 'IN'],
      ['DISTRIBUTION_PAID', 717_853, 'OUT'],
    ]);
    // FR-CAP-013: the statement ties to Ama's subledgers: 3000 is her net capital, 2300 what is allocated less paid.
    expect(0 - (await investorBalance('3000', 'Ama Owusu-Ansah'))).toBe(statement.body.closingCapitalPesewas);
    expect(0 - (await investorBalance('2300', 'Ama Owusu-Ansah'))).toBe(statement.body.allocatedInPeriodPesewas - statement.body.paidInPeriodPesewas);
    // The Accountant reads the same statement.
    const desk = await get(efua, `/investors/${me.body.investor.id}/statement?from=2025-06-01&to=2099-12-31`);
    expect(desk.body).toEqual(statement.body);
    // She cannot see any other investor's name or figures: not in her answers, and not through the staff reads.
    const transactions = await get(ama, '/investor/capital-transactions');
    expect(transactions.body.data.map((t: { investor: { name: string }; amountPesewas: number }) => [t.investor.name, t.amountPesewas])).toEqual([['Ama Owusu-Ansah', 10_000_000]]);
    for (const body of [me.body, distributions.body, statement.body, transactions.body]) {
      for (const name of others.filter((n) => n !== 'Ama Owusu-Ansah')) expect(JSON.stringify(body)).not.toContain(name);
    }
    expect((await get(ama, '/investors')).status).toBe(401);
    expect((await get(ama, '/capital/register')).status).toBe(401);
    expect((await get(ama, `/distribution-runs/${runId}`)).status).toBe(401);
    // A staff session is not an investor: the portal refuses it.
    expect((await get(efua, '/investor/me')).status).toBe(401);
  });

  it('4.11: Kofi signs in and sees GHS 1,833.65 and 500 units, and nothing of Ama’s', async () => {
    const kofi = await portalSession('Kofi Ampofo');
    const me = await get(kofi, '/investor/me');
    expect([me.body.investor.name, me.body.units, me.body.allocatedPesewas, me.body.paidPesewas]).toEqual(['Kofi Ampofo', '500.0000', 183_365, 183_365]);
    const distributions = await get(kofi, '/investor/distributions');
    expect(distributions.body.data.map((l: { allocatedPesewas: number }) => l.allocatedPesewas)).toEqual([183_365]);
    for (const body of [me.body, distributions.body, (await get(kofi, '/investor/statement?from=2025-01-01&to=2099-12-31')).body]) {
      expect(JSON.stringify(body)).not.toContain('Ama Owusu-Ansah');
      expect(JSON.stringify(body)).not.toContain('717853');
    }
  });

  it('4.12: the same run is posted once and approved once', async () => {
    await refreshStaff();
    await stepUp(api.server, efua, clock);
    const again = await post(efua, `/distribution-runs/${runId}/post`);
    expect(again.status).toBe(422);
    expect(again.body.error.details[0].code).toBe('RUN_NOT_APPROVED');
    const approval = (await admin().query<{ approval_request_id: string }>('SELECT approval_request_id FROM cap.distribution_run WHERE id = $1', [runId])).rows[0]!.approval_request_id;
    await stepUp(api.server, akua, clock);
    const reapproved = await post(akua, `/iam/approvals/${approval}/approve`, { reason: 'Again' });
    expect([409, 422]).toContain(reapproved.status);
    expect((await admin().query("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'cap.DistributionDeclared'")).rows[0].n).toBe(1);
    // And a second run over the same quarter is refused: profit is distributed once.
    const second = await post(efua, '/distribution-runs', Q3);
    expect(second.status).toBe(422);
    expect(second.body.error.details.map((d: { code: string }) => d.code)).toEqual(['PERIOD_ALREADY_DISTRIBUTED']);
  });
});
