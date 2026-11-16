import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { buildJournalLines, type LedgerAccount, type PostingRule, type SubledgerRef } from './posting';
import { YEAR_CLOSE_AMOUNT_KEYS, yearCloseAmounts, type YearEndBalance } from './year-close';

const investor: SubledgerRef = { kind: 'INVESTOR', refId: 'inv-1', displayName: 'Nana Adjei' };
const balance = (code: string, type: YearEndBalance['type'], pesewas: bigint, subledger: SubledgerRef | null = null): YearEndBalance => ({ accountId: `acct-${code}`, code, type, subledger, balance: pesewas });

/** The seeded rules of `fin.YearClosed` (migration 0138): closed accounts as named, 3200 then 3100 fixed (ADR-0003). */
const rules: PostingRule[] = [
  { amountKey: 'closeDebitToCurrent', side: 'D', accountId: 'acct-3200', determinantType: null, determinantRole: null },
  { amountKey: 'closeDebitToCurrent', side: 'C', accountId: null, determinantType: 'CLOSED_ACCOUNT', determinantRole: 'CLOSED' },
  { amountKey: 'closeCreditToCurrent', side: 'D', accountId: null, determinantType: 'CLOSED_ACCOUNT', determinantRole: 'CLOSED' },
  { amountKey: 'closeCreditToCurrent', side: 'C', accountId: 'acct-3200', determinantType: null, determinantRole: null },
  { amountKey: 'closeDebitToRetained', side: 'D', accountId: 'acct-3100', determinantType: null, determinantRole: null },
  { amountKey: 'closeDebitToRetained', side: 'C', accountId: null, determinantType: 'CLOSED_ACCOUNT', determinantRole: 'CLOSED' },
  { amountKey: 'closeCreditToRetained', side: 'D', accountId: null, determinantType: 'CLOSED_ACCOUNT', determinantRole: 'CLOSED' },
  { amountKey: 'closeCreditToRetained', side: 'C', accountId: 'acct-3100', determinantType: null, determinantRole: null },
  { amountKey: 'earningsToRetained', side: 'D', accountId: 'acct-3200', determinantType: null, determinantRole: null },
  { amountKey: 'earningsToRetained', side: 'C', accountId: 'acct-3100', determinantType: null, determinantRole: null },
  { amountKey: 'lossToRetained', side: 'D', accountId: 'acct-3100', determinantType: null, determinantRole: null },
  { amountKey: 'lossToRetained', side: 'C', accountId: 'acct-3200', determinantType: null, determinantRole: null },
];
const codes = ['3100', '3200', '3300', '4000', '4210', '5000', '6500', '6800'];
const accounts = new Map<string, LedgerAccount>(
  codes.map((code) => [`acct-${code}`, { id: `acct-${code}`, code, subledgerKind: code === '3300' ? 'INVESTOR' : null, postable: true }]),
);

/** Each account's balance after the closing lines, debits less credits. */
function after(balances: readonly YearEndBalance[]): Map<string, bigint> {
  const built = buildJournalLines(yearCloseAmounts(balances), { rules, determinations: [], accounts }, YEAR_CLOSE_AMOUNT_KEYS);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  const result = new Map(balances.map((b) => [b.code, b.balance]));
  for (const line of built.value) {
    result.set(line.accountCode, (result.get(line.accountCode) ?? 0n) + (line.side === 'D' ? line.amount.pesewas : -line.amount.pesewas));
  }
  return result;
}

describe('the year close (FR-FIN-010, ADR-0003 fin.YearClosed)', () => {
  it('closes every income, cost and expense account to 3200, then 3200 to 3100 by the exact profit, leaving both at zero', () => {
    const year = [balance('4000', 'INCOME', -1_000_001n), balance('4210', 'INCOME', 5_000n), balance('5000', 'COST_OF_SALES', 714_000n), balance('6800', 'EXPENSE', 81_000n)];
    const amounts = yearCloseAmounts(year);
    expect(amounts.map((a) => [a.key, a.closedAccountId ?? null, a.amount.pesewas])).toEqual([
      ['closeCreditToCurrent', 'acct-4000', 1_000_001n],
      ['closeDebitToCurrent', 'acct-4210', 5_000n],
      ['closeDebitToCurrent', 'acct-5000', 714_000n],
      ['closeDebitToCurrent', 'acct-6800', 81_000n],
      ['earningsToRetained', null, 200_001n],
    ]);
    const balances = after(year);
    expect([...balances].filter(([, b]) => b !== 0n)).toEqual([['3100', -200_001n]]);
  });

  it('closes a loss from 3200 to 3100, takes in what 3200 already held, and closes 3300 per investor to 3100', () => {
    const year = [
      balance('3200', 'EQUITY', -1_000n),
      balance('4000', 'INCOME', -10_000n),
      balance('6500', 'EXPENSE', 12_001n),
      balance('3300', 'EQUITY', 7_000n, investor),
    ];
    const amounts = yearCloseAmounts(year);
    expect(amounts.map((a) => [a.key, a.amount.pesewas, a.subledgers ?? []])).toEqual([
      ['closeCreditToCurrent', 10_000n, []],
      ['closeDebitToCurrent', 12_001n, []],
      ['lossToRetained', 1_001n, []],
      ['closeDebitToRetained', 7_000n, [investor]],
    ]);
    const balances = after(year);
    expect([...balances].filter(([, b]) => b !== 0n)).toEqual([['3100', 8_001n]]);
  });

  it('closes a credit balance on 3300 to 3100 too, ignores balance sheet accounts and nil balances, and posts nothing for an empty year', () => {
    const amounts = yearCloseAmounts([balance('3300', 'EQUITY', -50n, investor), balance('1000', 'ASSET', 9_000n), balance('6800', 'EXPENSE', 0n), balance('3200', 'EQUITY', 0n)]);
    expect(amounts.map((a) => [a.key, a.amount.pesewas])).toEqual([['closeCreditToRetained', 50n]]);
    expect(yearCloseAmounts([])).toEqual([]);
    expect(yearCloseAmounts([balance('3200', 'EQUITY', 0n)])).toEqual([]);
  });

  it('carries the party of a control account it closes', () => {
    const party: SubledgerRef = { kind: 'CUSTOMER', refId: 'c-1', displayName: 'Royal Palm Hotel' };
    const [first] = yearCloseAmounts([balance('4200', 'INCOME', 300n, party)]);
    expect(first).toEqual({ key: 'closeDebitToCurrent', amount: Money.ofPesewas(300n), closedAccountId: 'acct-4200', subledgers: [party], memo: 'Year close: 4200' });
  });
});
