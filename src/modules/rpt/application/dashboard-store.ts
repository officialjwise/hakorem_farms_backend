import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DayTotal, Period, SpeciesCount } from '../domain/dashboard';

/**
 * The figures the dashboard reads, each from published views only (ADR-0011, ADR-0023): inventory's
 * `pub_stock_value`, `pub_stock_on_hand`, `pub_reorder_level` and `pub_goods_receipt`, and master data's
 * `pub_product`, and the ledger's `fin.pub_cash_balance`. Never a module's own table. Each call covers exactly the branches it is given; none is an empty sum.
 */
export interface DashboardStore {
  /** The value at cost of every cost pool of the branches, in pesewas. */
  stockValueAtCost(tx: Transaction, branchIds: readonly string[]): Promise<bigint>;
  /** Serialised stock units with positive stock on hand at a physical location of the branches, per species. */
  animalsOnHand(tx: Transaction, branchIds: readonly string[]): Promise<SpeciesCount[]>;
  /** The distinct products at or below a reorder point in the branches. */
  lowStockProducts(tx: Transaction, branchIds: readonly string[]): Promise<number>;
  /** Posted purchase receipts' value at cost and count per business day received, within the period. */
  purchasesByDay(tx: Transaction, branchIds: readonly string[], period: Period): Promise<DayTotal[]>;
  /** Each cash and bank account's balance (debits less credits) over the branches, from `fin.pub_cash_balance`. */
  cashBalances(tx: Transaction, branchIds: readonly string[]): Promise<{ readonly code: string; readonly balance: bigint }[]>;
}

export const DASHBOARD_STORE = Symbol('DASHBOARD_STORE');
