import { describe, expect, it } from 'vitest';
import { balanceSheet, cashFlow, cashPosition, isCashAccount, profitAndLoss, type CashBalance, type StatementAccount } from './statements';

type Type = StatementAccount['type'];

/** One account's figures: opening and in-range debits and credits, and the in-range part posted by closing entries. */
const account = (code: string, type: Type, figures: { od?: bigint; oc?: bigint; d?: bigint; c?: bigint; cd?: bigint; cc?: bigint } = {}): StatementAccount => ({
  accountId: `acct-${code}`,
  code,
  name: `Account ${code}`,
  type,
  cashFlowCategory: null,
  openingDebit: figures.od ?? 0n,
  openingCredit: figures.oc ?? 0n,
  debit: figures.d ?? 0n,
  credit: figures.c ?? 0n,
  closingEntryDebit: figures.cd ?? 0n,
  closingEntryCredit: figures.cc ?? 0n,
});

const section = (statement: { sections: readonly { key: string; total: bigint; rows: readonly { code: string | null; amount: bigint }[] }[] }, key: string) => {
  const found = statement.sections.find((s) => s.key === key);
  if (found === undefined) throw new Error(`no section ${key}`);
  return { total: found.total, rows: found.rows.map((r) => [r.code, r.amount]) };
};

describe('profit and loss (FR-FIN-012)', () => {
  // SRS FR-FIN-006's goat sale: Dr 1200 94,000, Dr 4210 5,000, Cr 4000 90,000, Cr 4020 9,000; cost Dr 5000 71,400, Cr 1310.
  const sale = [
    account('1200', 'ASSET', { d: 94_000n }),
    account('1310', 'ASSET', { od: 100_000n, c: 71_400n }),
    account('2000', 'LIABILITY', { c: 2_600n }),
    account('3900', 'EQUITY', { oc: 100_000n }),
    account('4000', 'INCOME', { c: 90_000n }),
    account('4020', 'INCOME', { c: 9_000n }),
    account('4210', 'INCOME', { d: 5_000n }),
    account('5000', 'COST_OF_SALES', { d: 71_400n }),
    account('6800', 'EXPENSE', { d: 2_600n }),
  ];

  it('nets income, cost of sales and expenses to the net profit, a contra income account as a negative row', () => {
    const pl = profitAndLoss(sale);
    expect(section(pl, 'INCOME')).toEqual({ total: 94_000n, rows: [['4000', 90_000n], ['4020', 9_000n], ['4210', -5_000n]] });
    expect(section(pl, 'COST_OF_SALES')).toEqual({ total: 71_400n, rows: [['5000', 71_400n]] });
    expect(section(pl, 'GROSS_PROFIT')).toEqual({ total: 22_600n, rows: [] });
    expect(section(pl, 'EXPENSES')).toEqual({ total: 2_600n, rows: [['6800', 2_600n]] });
    expect(section(pl, 'NET_PROFIT')).toEqual({ total: 20_000n, rows: [] });
    expect(pl.netProfit).toBe(20_000n);
    expect(pl.checks).toEqual([
      { name: 'Income less costs equals net profit', passed: true },
      { name: 'Trial balance balanced for the period', passed: true },
    ]);
  });

  it('leaves out what a closing entry posted, so a closed year still shows its profit, and a nil account', () => {
    const closed = [
      account('1000', 'ASSET', { d: 1_501n, c: 500n }),
      account('3100', 'EQUITY', { c: 1_001n }),
      account('3200', 'EQUITY', { d: 1_501n, c: 1_501n }),
      account('4000', 'INCOME', { d: 1_501n, c: 1_501n, cd: 1_501n }),
      account('6200', 'EXPENSE', { d: 500n, c: 500n, cc: 500n }),
      account('6300', 'EXPENSE'),
    ];
    const pl = profitAndLoss(closed);
    expect(section(pl, 'INCOME')).toEqual({ total: 1_501n, rows: [['4000', 1_501n]] });
    expect(section(pl, 'EXPENSES')).toEqual({ total: 500n, rows: [['6200', 500n]] });
    expect(pl.netProfit).toBe(1_001n);
    expect(pl.checks.every((c) => c.passed)).toBe(true);
  });

  it('shows a loss as a negative net profit, and an unbalanced period fails its check', () => {
    const pl = profitAndLoss([account('4000', 'INCOME', { c: 1n }), account('6000', 'EXPENSE', { d: 3n }), account('1000', 'ASSET', { d: 1n })]);
    expect(pl.netProfit).toBe(-2n);
    expect(section(pl, 'NET_PROFIT').total).toBe(-2n);
    expect(pl.checks).toEqual([
      { name: 'Income less costs equals net profit', passed: true },
      { name: 'Trial balance balanced for the period', passed: false },
    ]);
  });
});

describe('the balance sheet (FR-FIN-012)', () => {
  it('has assets equal to liabilities plus equity including the earnings not yet closed', () => {
    const bs = balanceSheet([
      account('1000', 'ASSET', { od: 50_000n, d: 44_000n }),
      account('1310', 'ASSET', { od: 100_000n, c: 71_400n }),
      account('1590', 'ASSET', { c: 10_000n }),
      account('2000', 'LIABILITY', { c: 2_600n }),
      account('3900', 'EQUITY', { oc: 150_000n }),
      account('4000', 'INCOME', { c: 44_000n }),
      account('5000', 'COST_OF_SALES', { d: 71_400n }),
      account('6500', 'EXPENSE', { d: 10_000n }),
      account('6800', 'EXPENSE', { d: 2_600n }),
    ]);
    expect(section(bs, 'ASSETS')).toEqual({ total: 112_600n, rows: [['1000', 94_000n], ['1310', 28_600n], ['1590', -10_000n]] });
    expect(section(bs, 'LIABILITIES')).toEqual({ total: 2_600n, rows: [['2000', 2_600n]] });
    expect(section(bs, 'EQUITY')).toEqual({ total: 110_000n, rows: [['3900', 150_000n], [null, -40_000n]] });
    expect(section(bs, 'LIABILITIES_AND_EQUITY').total).toBe(112_600n);
    expect(bs.checks).toEqual([{ name: 'Assets equal liabilities plus equity', passed: true }]);
  });

  it('shows no earnings row once the year is closed, and fails its check on an unbalanced ledger', () => {
    const closed = balanceSheet([account('1000', 'ASSET', { od: 1_001n }), account('3100', 'EQUITY', { oc: 1_001n }), account('4000', 'INCOME', { od: 1_501n, oc: 1_501n })]);
    expect(section(closed, 'EQUITY').rows).toEqual([['3100', 1_001n]]);
    expect(closed.checks[0]!.passed).toBe(true);
    const broken = balanceSheet([account('1000', 'ASSET', { d: 2n }), account('2000', 'LIABILITY', { c: 1n })]);
    expect(broken.checks[0]!.passed).toBe(false);
  });
});

describe('the cash flow (FR-FIN-013)', () => {
  const opening: CashBalance[] = [{ accountId: 'acct-1010', code: '1010', name: 'Cash, safe', balance: 100_000n }];
  const closing: CashBalance[] = [
    { accountId: 'acct-1010', code: '1010', name: 'Cash, safe', balance: 280_000n },
    { accountId: 'acct-1100', code: '1100', name: 'Bank accounts', balance: 0n },
  ];

  it("reconciles the SRS's opening 100,000, receipts 300,000 and payments 120,000 to a closing 280,000", () => {
    const cf = cashFlow({
      opening,
      closing,
      flows: [
        { accountId: 'acct-4000', code: '4000', name: 'Sales, live animals', category: 'OPERATING', inflow: 300_000n },
        { accountId: 'acct-6800', code: '6800', name: 'Administration', category: null, inflow: -120_000n },
      ],
    });
    expect(section(cf, 'OPENING_CASH')).toEqual({ total: 100_000n, rows: [['1010', 100_000n]] });
    expect(section(cf, 'OPERATING')).toEqual({ total: 180_000n, rows: [['4000', 300_000n], ['6800', -120_000n]] });
    expect(section(cf, 'INVESTING')).toEqual({ total: 0n, rows: [] });
    expect(section(cf, 'FINANCING')).toEqual({ total: 0n, rows: [] });
    expect(section(cf, 'NET_CHANGE').total).toBe(180_000n);
    expect(section(cf, 'CLOSING_CASH')).toEqual({ total: 280_000n, rows: [['1010', 280_000n]] });
    expect(cf.checks).toEqual([{ name: 'Opening cash plus net change equals closing cash', passed: true }]);
  });

  it('puts each counterpart in its category, leaves out a nil one, and fails its check when the flows do not explain the change', () => {
    const cf = cashFlow({
      opening,
      closing,
      flows: [
        { accountId: 'acct-1520', code: '1520', name: 'Cold rooms at cost', category: 'INVESTING', inflow: -20_000n },
        { accountId: 'acct-3000', code: '3000', name: 'Investor capital', category: 'FINANCING', inflow: 200_000n },
        { accountId: 'acct-2000', code: '2000', name: 'Trade payables', category: 'OPERATING', inflow: 0n },
      ],
    });
    expect(section(cf, 'INVESTING')).toEqual({ total: -20_000n, rows: [['1520', -20_000n]] });
    expect(section(cf, 'FINANCING')).toEqual({ total: 200_000n, rows: [['3000', 200_000n]] });
    expect(section(cf, 'OPERATING')).toEqual({ total: 0n, rows: [] });
    expect(cf.checks[0]!.passed).toBe(true);
    const off = cashFlow({ opening, closing, flows: [] });
    expect(off.checks[0]!.passed).toBe(false);
  });
});

describe('the cash accounts and the cash position (FR-RPT-001, A-149)', () => {
  it('counts accounts 1000 to 1130 as cash and nothing either side', () => {
    expect(['0999', '1000', '1010', '1130', '1131', '1200'].map(isCashAccount)).toEqual([false, true, true, true, false, false]);
  });

  it('buckets tills, safe, drivers, bank (with provider clearing and cheques) and mobile money, totalled exactly', () => {
    const position = cashPosition([
      { code: '1000', balance: 742_300n },
      { code: '1010', balance: 900_000n },
      { code: '1020', balance: 154_000n },
      { code: '1100', balance: 6_000_000n },
      { code: '1120', balance: 200_300n },
      { code: '1130', balance: 50_000n },
      { code: '1110', balance: 1_394_400n },
      { code: '1105', balance: -1n },
    ]);
    expect(position).toEqual({ tills: 742_300n, safe: 900_000n, drivers: 154_000n, bank: 6_250_299n, mobileMoney: 1_394_400n, total: 9_440_999n });
  });

  it('keeps an overdrawn bank negative rather than hiding it', () => {
    expect(cashPosition([{ code: '1100', balance: -40_050n }])).toEqual({ tills: 0n, safe: 0n, drivers: 0n, bank: -40_050n, mobileMoney: 0n, total: -40_050n });
  });
});
