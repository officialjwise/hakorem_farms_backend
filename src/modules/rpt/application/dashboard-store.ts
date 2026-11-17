import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DayTotal, Period, SpeciesCount } from '../domain/dashboard';
import type { ChannelTotal, ProductSales } from '../domain/sales';

/**
 * The figures the dashboard reads, each from published views only (ADR-0011, ADR-0023): inventory's
 * `pub_stock_value`, `pub_stock_on_hand`, `pub_reorder_level` and `pub_goods_receipt`, and master data's
 * `pub_product`, order management's `pub_completed_sale` and `pub_completed_sale_line`, the ledger's `fin.pub_cash_balance` and `fin.pub_receivable_balance`, and billing's `bil.pub_document`. Never a module's own table. Each call covers exactly the branches it is given; none is an empty sum.
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
  /** Trade receivables (1200) over the branches, debits less credits, from `fin.pub_receivable_balance`. */
  receivablesBalance(tx: Transaction, branchIds: readonly string[]): Promise<bigint>;
  /** The outstanding amount of issued invoices, receipts and debit notes due before `today`, from `bil.pub_document`. */
  overdueOutstanding(tx: Transaction, branchIds: readonly string[], today: string): Promise<bigint>;
  /** Completed orders' gross totals and count per business day they completed on, within the period, from `ord.pub_completed_sale`. */
  salesByDay(tx: Transaction, branchIds: readonly string[], period: Period): Promise<DayTotal[]>;
  /** Completed orders' gross totals and count per channel on one business day, from `ord.pub_completed_sale`. */
  salesByChannel(tx: Transaction, branchIds: readonly string[], date: string): Promise<ChannelTotal[]>;
  /** Each product's completed order lines on one business day, per unit sold, from `ord.pub_completed_sale_line` and `mdm.pub_product`. */
  productSales(tx: Transaction, branchIds: readonly string[], date: string): Promise<ProductSales[]>;
}

export const DASHBOARD_STORE = Symbol('DASHBOARD_STORE');
