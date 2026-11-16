import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SubledgerRef } from '../domain/posting';
import type { CashFlowLine, StatementAccount } from '../domain/statements';
import type { YearEndBalance } from '../domain/year-close';

export const STATEMENT_STORE = Symbol('STATEMENT_STORE');

/** A range of business dates, both ends included, over one branch or (null) every branch. */
export interface StatementRange {
  readonly from: string;
  readonly to: string;
  readonly branchId: string | null;
}

/** A period's projected balance that no longer equals its lines (FR-FIN-016): reported, never corrected. */
export interface PeriodBalanceDrift {
  readonly periodId: string;
  readonly accountId: string;
  readonly branchId: string;
  readonly projectedDebitPesewas: bigint;
  readonly projectedCreditPesewas: bigint;
  readonly lineDebitPesewas: bigint;
  readonly lineCreditPesewas: bigint;
}

/**
 * The statements' reads (ADR-0058). A LOCKED or CLOSED period that lies wholly inside a part of the range is read from
 * `fin.period_balance` (computed by the database when it locked or closed); every other line is read from the journal.
 */
export interface StatementStore {
  /** Every live account, in code order, with its lines summed before the range and within it. */
  accounts(tx: Transaction, range: StatementRange): Promise<StatementAccount[]>;
  /** The accounts on the other side of the cash lines within the range, each with what it brought in. */
  cashFlowLines(tx: Transaction, range: StatementRange, cash: { readonly from: string; readonly to: string }): Promise<CashFlowLine[]>;
  /** Each branch's non-nil balances on income, cost, expense, 3200 and 3300 accounts up to `date`, per party. */
  yearEndBalances(tx: Transaction, date: string, codes: readonly string[]): Promise<(YearEndBalance & { readonly branchId: string })[]>;
  /** OPEN periods that have started by `date`. */
  openPeriodsUpTo(tx: Transaction, date: string): Promise<string[]>;
  /** Recomputes the projection of each period (the nightly job); returns the rows written. */
  refreshPeriodBalances(tx: Transaction, periodIds: readonly string[]): Promise<number>;
  /** Rows of LOCKED or CLOSED periods whose projection differs from their lines. */
  periodBalanceDrift(tx: Transaction): Promise<PeriodBalanceDrift[]>;
}

export type { SubledgerRef };
