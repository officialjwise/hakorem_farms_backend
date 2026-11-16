import { Money } from '@hakorem/kernel';
import type { PostingAmount, SubledgerRef } from './posting';

/** Current year earnings, retained earnings and distributions declared (ADR-0003). */
export const CURRENT_EARNINGS_CODE = '3200';
export const RETAINED_EARNINGS_CODE = '3100';
export const DISTRIBUTIONS_DECLARED_CODE = '3300';

/** The named amounts of `fin.YearClosed` (migration 0138): what each closes, and to where. */
export const YEAR_CLOSE_AMOUNT_KEYS = ['closeDebitToCurrent', 'closeCreditToCurrent', 'closeDebitToRetained', 'closeCreditToRetained', 'earningsToRetained', 'lossToRetained'] as const;

/** The account types the profit and loss is made of: each is closed to current year earnings at the year end. */
export const PROFIT_AND_LOSS_TYPES: ReadonlySet<string> = new Set(['INCOME', 'COST_OF_SALES', 'EXPENSE']);

/** One account's balance (debits less credits) at one branch and party on the last day of the year. */
export interface YearEndBalance {
  readonly accountId: string;
  readonly code: string;
  readonly type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';
  readonly subledger: SubledgerRef | null;
  readonly balance: bigint;
}

function closing(key: 'Current' | 'Retained', b: YearEndBalance): PostingAmount {
  return {
    key: b.balance > 0n ? `closeDebitTo${key}` : `closeCreditTo${key}`,
    amount: Money.ofPesewas(b.balance > 0n ? b.balance : -b.balance),
    closedAccountId: b.accountId,
    subledgers: b.subledger === null ? [] : [b.subledger],
    memo: `Year close: ${b.code}`,
  };
}

/**
 * The year close of one branch (FR-FIN-010, ADR-0003 row `fin.YearClosed`, ADR-0058), from the balances on the last day
 * of the year: every income, cost of sales and expense account is closed to 3200 at its exact balance; 3200, with what
 * it already held, is then closed to 3100 by the exact profit (or loss); distributions declared (3300) are closed to
 * 3100 per investor. Afterwards every one of those accounts is at nil and 3100 has moved by the profit less the
 * distributions. Nothing is rounded: every amount is a balance. A branch with nothing to close posts nothing.
 */
export function yearCloseAmounts(balances: readonly YearEndBalance[]): PostingAmount[] {
  const live = balances.filter((b) => b.balance !== 0n);
  const profitAndLoss = live.filter((b) => PROFIT_AND_LOSS_TYPES.has(b.type));
  const amounts = profitAndLoss.map((b) => closing('Current', b));
  const earnings = live.filter((b) => b.code === CURRENT_EARNINGS_CODE).reduce((sum, b) => sum + b.balance, 0n) + profitAndLoss.reduce((sum, b) => sum + b.balance, 0n);
  if (earnings < 0n) {
    amounts.push({ key: 'earningsToRetained', amount: Money.ofPesewas(-earnings), memo: 'Year close: profit to retained earnings' });
  } else if (earnings > 0n) {
    amounts.push({ key: 'lossToRetained', amount: Money.ofPesewas(earnings), memo: 'Year close: loss to retained earnings' });
  }
  amounts.push(...live.filter((b) => b.code === DISTRIBUTIONS_DECLARED_CODE).map((b) => closing('Retained', b)));
  return amounts;
}
