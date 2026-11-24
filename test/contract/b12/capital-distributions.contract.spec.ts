import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, setPortalPassword, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** CAP's operations (B12, B12 continued) answer in the shapes of contract/openapi.yaml 2.46.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let accountant: TotpSession;
let owner: TotpSession;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}
const get = (path: string) => consoleGet(api.server, accountant, `/v1${path}`);
const post = (path: string, body: object = {}) => consolePost(api.server, accountant, `/v1${path}`).send(body);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { investors: true }));
  const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the CAP operations answer in the contract shapes', () => {
  it('the register, an investor and its change, capital transactions and a withdrawal asked', async () => {
    const investors = await get('/investors');
    expectShape('InvestorPage', investors.body);
    const ama = investors.body.data[0] as { id: string; version: number };
    expectShape('Investor', (await get(`/investors/${ama.id}`)).body);
    await stepUp(api.server, accountant, clock);
    const changed = await consolePatch(api.server, accountant, `/v1/investors/${ama.id}`).send({ version: ama.version, email: 'ama.owusu-ansah@example.com' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expectShape('Investor', changed.body);
    const created = await post('/investors', { kind: 'ENTITY', legalName: 'Volta Growers Cooperative (TEST)', joinedOn: '2026-01-05' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectShape('Investor', created.body);
    expectShape('CapitalRegister', (await get('/capital/register?asOf=2026-09-30')).body);
    const transactions = await get('/capital-transactions');
    expectShape('CapitalTransactionPage', transactions.body);
    expectShape('CapitalTransaction', (await get(`/capital-transactions/${transactions.body.data[0].id as string}`)).body);
    const bank = (await database.pool('admin').query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
    const asked = await post('/capital-transactions', { kind: 'WITHDRAWAL', investorId: ama.id, amountPesewas: 100_000, valueDate: '2026-11-01', bankAccountId: bank });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expectShape('ApprovalPending', asked.body);
    const refused = await post('/capital-transactions', { kind: 'CONTRIBUTION', investorId: ama.id, amountPesewas: 1, unitPricePesewas: 3, valueDate: '2026-11-01', bankAccountId: bank });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });

  it('a run drafted, recomputed, submitted, approved, posted, its schedule and a payment', async () => {
    await stepUp(api.server, accountant, clock);
    for (const month of ['07', '08', '09']) expect((await post(`/finance/periods/01900000-0000-7000-8400-0000002026${month}/lock`)).status).toBe(200);
    const created = await post('/distribution-runs', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expectShape('DistributionRun', created.body);
    const runId = created.body.id as string;
    expectShape('DistributionRun', (await post(`/distribution-runs/${runId}/recompute`)).body);
    expectShape('DistributionRunPage', (await get('/distribution-runs')).body);
    const submitted = await post(`/distribution-runs/${runId}/submit`);
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);
    await stepUp(api.server, owner, clock);
    expect((await consolePost(api.server, owner, `/v1/iam/approvals/${submitted.body.approvalRequestId as string}/approve`).send({ reason: 'Checked' })).status).toBe(200);
    await stepUp(api.server, accountant, clock);
    const posted = await post(`/distribution-runs/${runId}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expectShape('DistributionRun', posted.body);
    await documentWorker(api, database, clock).settle();
    const schedule = await post(`/distribution-runs/${runId}/schedule`);
    expect(schedule.status, JSON.stringify(schedule.body)).toBe(200);
    expectShape('SignedUrl', schedule.body);
    const bank = (await database.pool('admin').query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
    const line = posted.body.lines[0] as { id: string };
    const paid = await post(`/distribution-lines/${line.id}/payments`, { amountPesewas: 1_000, bankAccountId: bank, paidAt: clock.now().toISOString() });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expectShape('DistributionLine', paid.body);
  });

  it('B12 continued: payout details, documents, statements, returns, loans and the investor portal', async () => {
    const ama = (await get('/investors')).body.data[0] as { id: string; version: number };
    const current = (await get(`/investors/${ama.id}`)).body as { version: number };
    await stepUp(api.server, accountant, clock);
    const opened = await consolePatch(api.server, accountant, `/v1/investors/${ama.id}`).send({
      version: current.version,
      createPortalLogin: true,
      idNumber: 'GHA-723456789-3',
      payout: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233244310221' },
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expectShape('Investor', opened.body);
    await stepUp(api.server, owner, clock);
    const revealed = await consoleGet(api.server, owner, `/v1/investors/${ama.id}/payout-details`);
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    expectShape('InvestorPayoutDetails', revealed.body);
    expectShape('InvestorDocumentPage', (await get(`/investors/${ama.id}/documents`)).body);
    expectShape('InvestorStatement', (await get(`/investors/${ama.id}/statement?from=2026-01-01&to=2026-12-31`)).body);
    expectShape('InvestorReturns', (await get(`/investors/${ama.id}/returns?asOf=2026-09-30`)).body);
    expectShape('InvestorReturns', (await get('/capital/returns')).body);
    const bank = (await database.pool('admin').query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
    await stepUp(api.server, accountant, clock);
    const loan = await post('/financing', { kind: 'LOAN', lenderName: 'Agricultural Development Bank', principalPesewas: 100_000, annualRatePercent: '12', startDate: clock.now().toISOString().slice(0, 10), termMonths: 2, bankAccountId: bank });
    expect(loan.status, JSON.stringify(loan.body)).toBe(201);
    expectShape('Financing', loan.body);
    expectShape('FinancingPage', (await get('/financing')).body);
    expectShape('Financing', (await get(`/financing/${loan.body.id as string}`)).body);
    const refused = await post(`/financing/${loan.body.id as string}/repayments`, { principalPesewas: 100, interestPesewas: 0, bankAccountId: bank, paidAt: clock.now().toISOString() });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const principalId = (await database.pool('admin').query<{ principal_id: string }>('SELECT principal_id FROM cap.investor WHERE id = $1', [ama.id])).rows[0]!.principal_id;
    const investor = await login(api.server, await setPortalPassword(database, principalId));
    const mine = (path: string) => consoleGet(api.server, investor, `/v1${path}`);
    expectShape('InvestorPortalSummary', (await mine('/investor/me')).body);
    expectShape('CapitalTransactionPage', (await mine('/investor/capital-transactions')).body);
    expectShape('InvestorDistributionLinePage', (await mine('/investor/distributions')).body);
    expectShape('InvestorStatement', (await mine('/investor/statement?from=2026-01-01&to=2026-12-31')).body);
    expectShape('InvestorDocumentPage', (await mine('/investor/documents')).body);
    const missing = await consolePost(api.server, investor, `/v1/investor/documents/${randomUUID()}/download`).send({});
    expect(missing.status).toBe(404);
    expectShape('Error', missing.body);
  });
});
