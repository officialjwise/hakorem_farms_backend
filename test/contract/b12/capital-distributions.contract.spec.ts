import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { documentWorker } from '../../support/documents';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** CAP's investor register, capital and distribution operations (B12) answer in the shapes of contract/openapi.yaml 2.45.0. */
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
});
