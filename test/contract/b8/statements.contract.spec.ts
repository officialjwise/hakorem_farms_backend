import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import { ledgerIds, postManualJournal, type TotpSession } from '../../support/fin';
import { consoleGet, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 1c operations answer in the shapes of contract/openapi.yaml, with cash moved and a period locked. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let accountant: TotpSession;
let today: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const branchId = (await createBranch(database)).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  today = toBusinessDate(clock.now());
  const ledger = await ledgerIds(database);
  await postManualJournal(api.server, clock, { maker: accountant, checker: owner }, {
    postingDate: today,
    description: 'Goat sales into the safe, a repair and a cold room compressor paid from it',
    lines: [
      { accountId: ledger.account('1010'), side: 'D', amountPesewas: 300_000 },
      { accountId: ledger.account('4000'), side: 'C', amountPesewas: 300_000 },
      { accountId: ledger.account('6300'), side: 'D', amountPesewas: 100_000 },
      { accountId: ledger.account('1520'), side: 'D', amountPesewas: 420_000 },
      { accountId: ledger.account('1010'), side: 'C', amountPesewas: 520_000 },
    ],
  });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 1c operations answer in the contract shapes', () => {
  it('the trial balance, profit and loss, balance sheet and cash flow, each a negative figure included', async () => {
    const tb = await consoleGet(api.server, accountant, `/v1/finance/trial-balance?from=${today}&to=${today}&limit=2`);
    expect(tb.status).toBe(200);
    expectShape('TrialBalance', tb.body);
    expect(tb.body.page.hasMore).toBe(true);
    for (const path of [`profit-and-loss?from=${today}&to=${today}`, `balance-sheet?asOf=${today}`, `cash-flow?from=${today}&to=${today}`]) {
      const statement = await consoleGet(api.server, owner, `/v1/finance/${path}`);
      expect(statement.status, path).toBe(200);
      expectShape('FinancialStatement', statement.body);
    }
    const cash = await consoleGet(api.server, owner, `/v1/finance/cash-flow?from=${today}&to=${today}`);
    expect(cash.body.sections.find((s: { key: string }) => s.key === 'CLOSING_CASH').totalIsNegative).toBe(true);
    const refused = await consoleGet(api.server, owner, `/v1/finance/profit-and-loss?from=${today}&to=2020-01-01`);
    expect(refused.status).toBe(400);
    expectShape('Error', refused.body);
  });

  it('the cash position tile and the dashboard carrying it, an overdrawn safe named as negative', async () => {
    const tile = await consoleGet(api.server, owner, '/v1/dashboard/tiles/cash-position');
    expect(tile.status).toBe(200);
    expectShape('CashPositionTile', tile.body);
    expect(tile.body.cash).toMatchObject({ safePesewas: 220_000, totalPesewas: 220_000, negativeFigures: ['safePesewas', 'totalPesewas'] });
    const dashboard = await consoleGet(api.server, owner, '/v1/dashboard/owner');
    expect(dashboard.status).toBe(200);
    expectShape('OwnerDashboard', dashboard.body);
  });
});
