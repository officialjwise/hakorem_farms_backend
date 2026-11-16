import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AccountType } from '../domain/accounts';
import type { PeriodFacts } from '../domain/period';
import type { Side, SubledgerKind } from '../domain/posting';

export const CHART_STORE = Symbol('CHART_STORE');

export type CashFlowCategory = 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalSide: Side;
  readonly parentId: string | null;
  readonly isPostable: boolean;
  readonly subledgerKind: SubledgerKind | null;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly status: 'ACTIVE' | 'CLOSED';
  readonly version: number;
}

export interface AccountFilters {
  readonly type: AccountType | null;
  readonly postableOnly: boolean;
}

export interface PeriodRow extends PeriodFacts {
  readonly fiscalYear: number;
  readonly periodNo: number;
  readonly lockedAt: Date | null;
  readonly lockedBy: string | null;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  readonly version: number;
}

export interface PeriodFilters {
  readonly fiscalYear: number | null;
  readonly status: PeriodFacts['status'] | null;
}

/** One request to reopen a locked period (`fin.period_reopen`, migration 0126). */
export interface ReopenRow {
  readonly id: string;
  readonly periodId: string;
  readonly branchId: string;
  readonly reason: string;
  readonly status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';
  readonly approvalRequestId: string;
  readonly createdBy: string;
  readonly version: number;
}

/** The chart of accounts and the accounting periods in PostgreSQL. The triggers of 0123 and 0126 decide too. */
export interface ChartStore {
  /** Accounts in code order, after `afterCode` when given. */
  accounts(tx: Transaction, filters: AccountFilters, afterCode: string | null, limit: number): Promise<AccountRow[]>;
  account(tx: Transaction, id: string, forUpdate: boolean): Promise<AccountRow | null>;
  codeTaken(tx: Transaction, code: string): Promise<boolean>;
  insertAccount(tx: Transaction, row: AccountRow, actorId: string): Promise<void>;
  /** Writes the name and status at the next version. */
  updateAccount(tx: Transaction, id: string, change: { readonly name: string; readonly status: 'ACTIVE' | 'CLOSED' }, actorId: string): Promise<void>;
  /** Debits less credits of the account over the whole ledger (index ix_journal_line_account_date). */
  accountBalance(tx: Transaction, id: string): Promise<bigint>;
  /** A posting rule or account determination in force on the date names the account. */
  accountNamedInForce(tx: Transaction, id: string, date: string): Promise<boolean>;
  /** Periods newest first, before `beforeStart` when given. */
  periods(tx: Transaction, filters: PeriodFilters, beforeStart: string | null, limit: number): Promise<PeriodRow[]>;
  period(tx: Transaction, id: string, forUpdate: boolean): Promise<PeriodRow | null>;
  /** Every period, as the close-order rule reads them. */
  allPeriods(tx: Transaction): Promise<PeriodFacts[]>;
  lockPeriod(tx: Transaction, id: string, actorId: string, at: Date): Promise<void>;
  closePeriod(tx: Transaction, id: string, actorId: string, at: Date): Promise<void>;
  reopenPeriod(tx: Transaction, id: string, actorId: string): Promise<void>;
  pendingReopenOf(tx: Transaction, periodId: string): Promise<ReopenRow | null>;
  insertReopen(tx: Transaction, row: ReopenRow): Promise<void>;
  reopenRequest(tx: Transaction, id: string, forUpdate: boolean): Promise<ReopenRow | null>;
  decideReopen(tx: Transaction, id: string, status: 'POSTED' | 'REJECTED', decidedBy: string, at: Date): Promise<void>;
}
