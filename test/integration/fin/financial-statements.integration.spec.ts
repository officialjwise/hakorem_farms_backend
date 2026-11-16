import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_STOCK_RECEIVED_AT } from '../../../src/seed/farm-inv';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, type TotpSession } from '../../support/fin';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { SYSTEM_PRINCIPAL, consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B08 continued 1c gate for the statements (FR-FIN-011 to FR-FIN-013, ADR-0058): on the seeded trading day the
 * trial balance, profit and loss, balance sheet and cash flow tie to each other to the pesewa, every figure checked
 * against sums taken here straight from `fin.journal_line` in SQL, never from the code under test; the SRS's cash flow
 * (opening 100,000, receipts 300,000, payments 120,000, closing 280,000) reconciles; a locked period is read from its
 * period balances, exactly as its lines; and every statement refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let accountant: TotpSession;
const others = new Map<string, TestSession>();
let branchId: string;
let testBranchId: string;

const SEED_FROM = toBusinessDate(SEED_STOCK_RECEIVED_AT);
let seedTo: string;
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const admin = () => database.pool('admin');

interface Section {
  readonly key: string;
  readonly rows: { account: { code: string } | null; label: string; amountPesewas: number; isNegative: boolean }[];
  readonly totalPesewas: number;
  readonly totalIsNegative: boolean;
}
const signed = (amount: number, negative: boolean): bigint => (negative ? -BigInt(amount) : BigInt(amount));
const total = (sections: readonly Section[], key: string): bigint => {
  const section = sections.find((s) => s.key === key)!;
  return signed(section.totalPesewas, section.totalIsNegative);
};
const rowsOf = (sections: readonly Section[], key: string): [string | null, bigint][] =>
  sections.find((s) => s.key === key)!.rows.map((r) => [r.account?.code ?? null, signed(r.amountPesewas, r.isNegative)]);

/** Debits less credits per account code, from the journal lines alone, between two dates (both included). */
async function sqlBalances(from: string, to: string, options: { excludeClosing?: boolean; branchId?: string } = {}): Promise<Map<string, bigint>> {
  const { rows } = await admin().query<{ code: string; balance: string }>(
    `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS balance
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.journal_entry e ON e.id = l.journal_entry_id
      WHERE l.posting_date BETWEEN $1::date AND $2::date AND (NOT $3 OR e.kind <> 'CLOSING') AND ($4::uuid IS NULL OR l.branch_id = $4::uuid)
      GROUP BY a.code`,
    [from, to, options.excludeClosing ?? false, options.branchId ?? null],
  );
  return new Map(rows.map((r) => [r.code, BigInt(r.balance)]));
}

/** The sum of the balances whose account code starts with one of the classes. */
const byClass = (balances: Map<string, bigint>, classes: string): bigint => [...balances].filter(([code]) => classes.includes(code[0]!)).reduce((sum, [, b]) => sum + b, 0n);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  seedTo = toBusinessDate(clock.now());
  const branches = new Map((await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.branch')).rows.map((r) => [r.code, r.id] as const));
  branchId = branches.get('DDW')!;
  testBranchId = branches.get('TST')!;
  // Three days on, so the journals below can be dated after the seeded trading day and before today.
  clock.advanceBy(3 * 86_400_000);
  const now = () => clock.now();
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), now);
  for (const [name, role] of [
    ['manager', 'MANAGER'],
    ['storekeeper', 'STOREKEEPER'],
    ['cashier', 'CASHIER'],
    ['sales', 'SALES'],
    ['farmHand', 'FARM_HAND'],
    ['driver', 'DRIVER'],
  ] as const satisfies readonly (readonly [string, RoleCode])[]) {
    const user = await createUser(database, { name: `Staff ${name}`, grants: [{ role, branchId }] });
    others.set(name, role === 'MANAGER' ? await enrolAndLogin(api.server, user, now) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the four statements tie to each other on the seeded trading day, to the pesewa (FR-FIN-011, FR-FIN-012, FR-FIN-013)', () => {
  it('has a trial balance whose totals and every account equal the journal lines summed in SQL, and that balances', async () => {
    const { rows } = await admin().query<{ d: string; c: string; lines: number }>(
      `SELECT COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'D'), 0)::text AS d, COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'C'), 0)::text AS c, count(*)::int AS lines
         FROM fin.journal_line WHERE posting_date BETWEEN $1::date AND $2::date`,
      [SEED_FROM, seedTo],
    );
    expect(rows[0]!.lines).toBeGreaterThan(20);
    const tb = await get(accountant, `/finance/trial-balance?from=${SEED_FROM}&to=${seedTo}&limit=100`);
    expect(tb.status, JSON.stringify(tb.body)).toBe(200);
    expect(tb.body).toMatchObject({ from: SEED_FROM, to: seedTo, branchId: null, balanced: true, currency: 'GHS', page: { hasMore: false, nextCursor: null } });
    expect(BigInt(tb.body.totalDebitPesewas)).toBe(BigInt(rows[0]!.d));
    expect(BigInt(tb.body.totalCreditPesewas)).toBe(BigInt(rows[0]!.d));
    expect(BigInt(rows[0]!.c)).toBe(BigInt(rows[0]!.d));
    // Closing balances run from the first line; the seeded fixed assets' cost journal (January) is the only opening.
    const balances = await sqlBalances('2000-01-01', seedTo);
    const opening = await sqlBalances('2000-01-01', new Date(Date.parse(`${SEED_FROM}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    expect([...opening.keys()].sort()).toEqual(['1510', '1520', '1530', '1540', '3900']);
    const listed = tb.body.data as { account: { code: string }; type: string; openingDebitPesewas: number; openingCreditPesewas: number; closingDebitPesewas: number; closingCreditPesewas: number }[];
    expect(listed.map((r) => r.account.code)).toEqual([...balances.keys()].sort());
    for (const row of listed) {
      expect([row.account.code, BigInt(row.closingDebitPesewas) - BigInt(row.closingCreditPesewas)]).toEqual([row.account.code, balances.get(row.account.code)]);
      expect([row.account.code, BigInt(row.openingDebitPesewas) - BigInt(row.openingCreditPesewas)]).toEqual([row.account.code, opening.get(row.account.code) ?? 0n]);
    }
    expect(listed.find((r) => r.account.code === '6800')!.type).toBe('EXPENSE');
  });

  it('has a profit and loss whose net profit is the 4xxx credits less the 5xxx and 6xxx debits, and equals the trial balance', async () => {
    const balances = await sqlBalances(SEED_FROM, seedTo, { excludeClosing: true });
    const pl = await get(owner, `/finance/profit-and-loss?from=${SEED_FROM}&to=${seedTo}`);
    expect(pl.status).toBe(200);
    expect(pl.body).toMatchObject({ statement: 'PROFIT_AND_LOSS', from: SEED_FROM, to: seedTo, asOfDate: null, branchId: null, currency: 'GHS' });
    const sections = pl.body.sections as Section[];
    expect(sections.map((s) => s.key)).toEqual(['INCOME', 'COST_OF_SALES', 'GROSS_PROFIT', 'EXPENSES', 'NET_PROFIT']);
    expect(total(sections, 'INCOME')).toBe(-byClass(balances, '4'));
    expect(total(sections, 'COST_OF_SALES')).toBe(byClass(balances, '5'));
    expect(total(sections, 'EXPENSES')).toBe(byClass(balances, '6'));
    expect(total(sections, 'NET_PROFIT')).toBe(-byClass(balances, '456'));
    // The seeded expense invoice to administration, less its credit note; and eggs at standard cost against 5210.
    expect(rowsOf(sections, 'EXPENSES').find(([code]) => code === '6800')![1]).toBe(balances.get('6800'));
    expect(rowsOf(sections, 'COST_OF_SALES').find(([code]) => code === '5210')![1]).toBe(balances.get('5210'));
    expect(total(sections, 'NET_PROFIT')).not.toBe(0n);
    expect(pl.body.checks).toEqual([
      { name: 'Income less costs equals net profit', passed: true },
      { name: 'Trial balance balanced for the period', passed: true },
    ]);
  });

  it('has a balance sheet where assets equal liabilities plus equity including the period\'s profit, each from the lines', async () => {
    const balances = await sqlBalances('2000-01-01', seedTo);
    const bs = await get(accountant, `/finance/balance-sheet?asOf=${seedTo}`);
    expect(bs.status).toBe(200);
    expect(bs.body).toMatchObject({ statement: 'BALANCE_SHEET', from: null, to: null, asOfDate: seedTo, branchId: null });
    const sections = bs.body.sections as Section[];
    const assets = byClass(balances, '1');
    const liabilities = -byClass(balances, '2');
    const equityAccounts = -byClass(balances, '3');
    const profit = -byClass(balances, '456');
    expect(total(sections, 'ASSETS')).toBe(assets);
    expect(total(sections, 'LIABILITIES')).toBe(liabilities);
    expect(total(sections, 'EQUITY')).toBe(equityAccounts + profit);
    expect(rowsOf(sections, 'EQUITY').find(([code]) => code === null)![1]).toBe(profit);
    expect(total(sections, 'LIABILITIES_AND_EQUITY')).toBe(liabilities + equityAccounts + profit);
    expect(assets).toBe(liabilities + equityAccounts + profit);
    expect(assets).toBeGreaterThan(0n);
    expect(bs.body.checks).toEqual([{ name: 'Assets equal liabilities plus equity', passed: true }]);
    // The trial balance's closing balances say the same, account by account.
    const tb = await get(accountant, `/finance/trial-balance?from=${seedTo}&to=${seedTo}&limit=100`);
    const closing = (tb.body.data as { account: { code: string }; closingDebitPesewas: number; closingCreditPesewas: number }[]).filter((r) => r.account.code.startsWith('1'));
    expect(closing.reduce((sum, r) => sum + BigInt(r.closingDebitPesewas) - BigInt(r.closingCreditPesewas), 0n)).toBe(assets);
  });

  it('has a cash flow whose opening plus net flow equals the closing cash on accounts 1000 to 1130, as the lines say', async () => {
    const cash = async (to: string) =>
      BigInt(
        (
          await admin().query<{ cash: string }>(
            `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS cash
               FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code BETWEEN '1000' AND '1130' AND l.posting_date <= $1::date`,
            [to],
          )
        ).rows[0]!.cash,
      );
    const cf = await get(accountant, `/finance/cash-flow?from=${SEED_FROM}&to=${seedTo}`);
    expect(cf.status).toBe(200);
    const sections = cf.body.sections as Section[];
    expect(sections.map((s) => s.key)).toEqual(['OPENING_CASH', 'OPERATING', 'INVESTING', 'FINANCING', 'NET_CHANGE', 'CLOSING_CASH']);
    expect(total(sections, 'OPENING_CASH') + total(sections, 'NET_CHANGE')).toBe(total(sections, 'CLOSING_CASH'));
    expect(total(sections, 'CLOSING_CASH')).toBe(await cash(seedTo));
    expect(cf.body.checks).toEqual([{ name: 'Opening cash plus net change equals closing cash', passed: true }]);
  });
});

describe('the statements still tie with the seeded fixed assets and a posted depreciation run (FR-FIN-014, FR-FIN-015, ADR-0059)', () => {
  it('carries the seeded assets at cost on 1510 to 1540, as the register says, and still ties once October\'s run has posted', async () => {
    const register = await admin().query<{ code: string; cost: string }>(
      `SELECT CASE category WHEN 'VEHICLE' THEN '1510' WHEN 'COLD_ROOM' THEN '1520' WHEN 'HOUSING' THEN '1530' ELSE '1540' END AS code, sum(cost_pesewas)::text AS cost
         FROM fin.fixed_asset WHERE status <> 'DISPOSED' GROUP BY 1 ORDER BY 1`,
    );
    expect(register.rows.map((r) => r.code)).toEqual(['1510', '1520', '1530', '1540']);
    const before = await sqlBalances('2000-01-01', seedTo);
    for (const row of register.rows) expect(before.get(row.code), row.code).toBe(BigInt(row.cost));
    const october = (await admin().query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE fiscal_year = 2026 AND period_no = 10')).rows[0]!.id;
    const run = await post(accountant, '/finance/depreciation-runs', { periodId: october });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await post(owner, `/finance/depreciation-runs/${run.body.id as string}/post`)).status).toBe(200);
    const charged = BigInt(run.body.totalPesewas as number);
    expect(charged).toBeGreaterThan(0n);
    const balances = await sqlBalances('2000-01-01', seedTo);
    expect(balances.get('1590')).toBe(-charged);
    expect(balances.get('6500')).toBe(charged);
    const pl = (await get(owner, `/finance/profit-and-loss?from=2026-01-01&to=${seedTo}`)).body;
    expect(rowsOf(pl.sections as Section[], 'EXPENSES').find(([code]) => code === '6500')![1]).toBe(charged);
    expect(total(pl.sections as Section[], 'NET_PROFIT')).toBe(-byClass(await sqlBalances('2026-01-01', seedTo, { excludeClosing: true }), '456'));
    const bs = (await get(accountant, `/finance/balance-sheet?asOf=${seedTo}`)).body;
    const sections = bs.sections as Section[];
    expect(rowsOf(sections, 'ASSETS').find(([code]) => code === '1590')![1]).toBe(-charged);
    expect(total(sections, 'ASSETS')).toBe(byClass(balances, '1'));
    expect(total(sections, 'ASSETS')).toBe(total(sections, 'LIABILITIES_AND_EQUITY'));
    expect(bs.checks).toEqual([{ name: 'Assets equal liabilities plus equity', passed: true }]);
    const tb = (await get(accountant, `/finance/trial-balance?from=2026-01-01&to=${seedTo}&limit=100`)).body;
    expect(tb.totalDebitPesewas).toBe(tb.totalCreditPesewas);
    expect(tb.balanced).toBe(true);
  });
});

describe("the SRS's cash flow, and the statements after cash has moved (FR-FIN-013)", () => {
  const opening = () => toBusinessDate(new Date(clock.now().getTime() - 2 * 86_400_000));
  const day = () => toBusinessDate(new Date(clock.now().getTime() - 86_400_000));

  it('reconciles an opening 100,000, receipts 300,000 and payments 120,000 to a closing 280,000 equal to the cash accounts', async () => {
    const ledger = await ledgerIds(database);
    const people = { maker: accountant, checker: owner };
    await postManualJournal(api.server, clock, people, {
      kind: 'OPENING',
      postingDate: opening(),
      description: 'Opening cash in the safe',
      lines: [
        { accountId: ledger.account('1010'), side: 'D', amountPesewas: 100_000 },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 100_000 },
      ],
    });
    await postManualJournal(api.server, clock, people, {
      postingDate: day(),
      description: 'Walk-in goat sales banked to the safe',
      lines: [
        { accountId: ledger.account('1010'), side: 'D', amountPesewas: 300_000 },
        { accountId: ledger.account('4000'), side: 'C', amountPesewas: 300_000 },
      ],
    });
    await postManualJournal(api.server, clock, people, {
      postingDate: day(),
      description: 'Cold room repair, 100,000, and a compressor, 20,000, paid from the safe',
      lines: [
        { accountId: ledger.account('6300'), side: 'D', amountPesewas: 100_000 },
        { accountId: ledger.account('1520'), side: 'D', amountPesewas: 20_000 },
        { accountId: ledger.account('1010'), side: 'C', amountPesewas: 120_000 },
      ],
    });
    const cf = await get(owner, `/finance/cash-flow?from=${day()}&to=${day()}`);
    const sections = cf.body.sections as Section[];
    expect(total(sections, 'OPENING_CASH')).toBe(100_000n);
    expect(rowsOf(sections, 'OPERATING')).toEqual([
      ['4000', 300_000n],
      ['6300', -100_000n],
    ]);
    expect(rowsOf(sections, 'INVESTING')).toEqual([['1520', -20_000n]]);
    expect(total(sections, 'FINANCING')).toBe(0n);
    expect(total(sections, 'NET_CHANGE')).toBe(180_000n);
    expect(rowsOf(sections, 'CLOSING_CASH')).toEqual([['1010', 280_000n]]);
    expect(cf.body.checks[0].passed).toBe(true);
    const balances = await sqlBalances('2000-01-01', day());
    expect(byClass(new Map([...balances].filter(([code]) => code >= '1000' && code <= '1130')), '1')).toBe(280_000n);
    // The opening journal is a financing inflow on its own day.
    const first = await get(owner, `/finance/cash-flow?from=${opening()}&to=${opening()}`);
    expect(rowsOf(first.body.sections as Section[], 'FINANCING')).toEqual([['3900', 100_000n]]);
    const pl = await get(owner, `/finance/profit-and-loss?from=${day()}&to=${day()}`);
    expect(total(pl.body.sections as Section[], 'NET_PROFIT')).toBe(200_000n);
  });

  it('narrows every statement to one branch, and a branch where nothing posted is all nil and balanced', async () => {
    const own = await get(owner, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&branchId=${branchId}&limit=100`);
    const all = await get(owner, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&limit=100`);
    expect(own.body.totalDebitPesewas).toBe(all.body.totalDebitPesewas);
    expect((await get(owner, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&branchId=${testBranchId}`)).status).toBe(403);
    const { rows } = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_line WHERE branch_id = $1', [testBranchId]);
    expect(rows[0]!.n).toBe(0);
  });

  it('pages the trial balance by account code without skipping or repeating, totals over the whole filter', async () => {
    const whole = await get(accountant, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&limit=100`);
    const codes: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await get(accountant, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(page.status).toBe(200);
      expect(page.body.totalDebitPesewas).toBe(whole.body.totalDebitPesewas);
      codes.push(...(page.body.data as { account: { code: string } }[]).map((r) => r.account.code));
      cursor = page.body.page.nextCursor as string | null;
    } while (cursor !== null);
    expect(codes).toEqual((whole.body.data as { account: { code: string } }[]).map((r) => r.account.code));
    const zero = await get(accountant, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&limit=100&includeZero=true`);
    expect(zero.body.data.length).toBeGreaterThan(whole.body.data.length);
    expect((await get(accountant, `/finance/trial-balance?from=${day()}&to=${SEED_FROM}`)).status).toBe(400);
    expect((await get(accountant, `/finance/trial-balance?from=${SEED_FROM}&to=${day()}&cursor=forged`)).status).toBe(400);
  });
});

describe('a locked period is read from its period balances, exactly as its lines (ADR-0058)', () => {
  it('computes the period balances when the period locks, and answers the same statements from them', async () => {
    // September: nothing posts into it on the seeded farm (October carries the depreciation run above).
    const period = (await admin().query<{ id: string; start_date: string; end_date: string }>("SELECT id, start_date::text, end_date::text FROM fin.accounting_period WHERE start_date = '2026-09-01'")).rows[0]!;
    const before = await get(accountant, `/finance/trial-balance?from=2026-09-01&to=${toBusinessDate(clock.now())}&limit=100`);
    expect((await consolePostAs(accountant, `/finance/periods/${period.id}/lock`)).status).toBe(200);
    const projected = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.period_balance WHERE period_id = $1', [period.id]);
    expect(projected.rows[0]!.n).toBe(0);
    const after = await get(accountant, `/finance/trial-balance?from=2026-09-01&to=${toBusinessDate(clock.now())}&limit=100`);
    expect(after.body.data).toEqual(before.body.data);
  });

  it('reads a locked period with lines from its balances: a tampered row changes the statement, and the nightly check reports it', async () => {
    const november = (await admin().query<{ id: string }>("SELECT id FROM fin.accounting_period WHERE start_date = '2026-11-01'")).rows[0]!;
    const range = `from=2026-11-01&to=2026-11-30`;
    const before = await get(accountant, `/finance/trial-balance?${range}&limit=100`);
    expect((await consolePostAs(accountant, `/finance/periods/${november.id}/lock`)).status).toBe(200);
    const { rows } = await admin().query<{ account_code: string; d: string; c: string }>(
      `SELECT a.code AS account_code, sum(b.debit_total_pesewas)::text AS d, sum(b.credit_total_pesewas)::text AS c
         FROM fin.period_balance b JOIN fin.account a ON a.id = b.account_id WHERE b.period_id = $1 GROUP BY a.code ORDER BY a.code`,
      [november.id],
    );
    const lines = await sqlBalances('2026-11-01', '2026-11-30');
    expect(new Map(rows.map((r) => [r.account_code, BigInt(r.d) - BigInt(r.c)]))).toEqual(lines);
    const locked = await get(accountant, `/finance/trial-balance?${range}&limit=100`);
    expect(locked.body.data).toEqual(before.body.data);
    expect(locked.body.totalDebitPesewas).toBe(before.body.totalDebitPesewas);
    // A superuser's edit of the projection shows the statement reads it, and is reported, never corrected.
    await admin().query("UPDATE fin.period_balance SET debit_total_pesewas = debit_total_pesewas + 1 WHERE period_id = $1 AND account_id = (SELECT id FROM fin.account WHERE code = '6800')", [november.id]);
    const tampered = await get(accountant, `/finance/trial-balance?${range}&limit=100`);
    expect(tampered.body.totalDebitPesewas).toBe(before.body.totalDebitPesewas + 1);
    expect(tampered.body.balanced).toBe(false);
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () =>
      api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null }),
    );
    expect(report.clean).toBe(false);
    const account6800 = (await admin().query<{ id: string }>("SELECT id FROM fin.account WHERE code = '6800'")).rows[0]!.id;
    expect(report.periodBalanceDrift).toHaveLength(1);
    const drift = report.periodBalanceDrift[0]!;
    expect([drift.periodId, drift.accountId, drift.branchId]).toEqual([november.id, account6800, branchId]);
    expect(drift.projectedDebitPesewas - drift.lineDebitPesewas).toBe(1n);
    expect(drift.projectedCreditPesewas).toBe(drift.lineCreditPesewas);
    await admin().query("UPDATE fin.period_balance SET debit_total_pesewas = debit_total_pesewas - 1 WHERE period_id = $1 AND account_id = (SELECT id FROM fin.account WHERE code = '6800')", [november.id]);
  });
});

describe('every statement refuses the wrong role (ADR-0017, ADR-0035)', () => {
  const paths = () => [
    `/finance/trial-balance?from=${SEED_FROM}&to=${seedTo}`,
    `/finance/profit-and-loss?from=${SEED_FROM}&to=${seedTo}`,
    `/finance/balance-sheet?asOf=${seedTo}`,
    `/finance/cash-flow?from=${SEED_FROM}&to=${seedTo}`,
  ];
  for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} every statement with 403`, async () => {
      for (const path of paths()) {
        const refused = await get(others.get(who)!, path);
        expect(refused.status, path).toBe(403);
        expect(refused.body.error.code).toBe('FORBIDDEN');
      }
    });
  }

  it('answers the Owner and the Accountant', async () => {
    for (const session of [owner, accountant]) for (const path of paths()) expect((await get(session, path)).status, path).toBe(200);
  });
});

function consolePostAs(session: TestSession, path: string) {
  return consolePost(api.server, session, `/v1${path}`).send({});
}
