import { Money } from '@hakorem/kernel';
import { CHANNELS, sumCounts, type SalesChannel } from './dashboard';

/** Completed orders' gross totals of one channel, as the store sums them. */
export interface ChannelTotal {
  readonly channel: SalesChannel;
  readonly grossPesewas: bigint;
  readonly count: number;
}

/**
 * The day's sales by channel (CR-013): every channel in the contract's order, a channel with no completed order at an
 * exact zero (a real zero, the order core exists), two rows of one channel added together.
 */
export function salesByChannel(rows: readonly ChannelTotal[]): Array<{ readonly channel: SalesChannel; readonly amountPesewas: number; readonly count: number }> {
  return CHANNELS.map((channel) => {
    const mine = rows.filter((row) => row.channel === channel);
    return {
      channel,
      amountPesewas: Money.sum(mine.map((row) => Money.ofPesewas(row.grossPesewas))).toJsonInteger(),
      count: sumCounts(mine),
    };
  });
}

/** One product's completed sales on a day, in one unit, as the store sums them. */
export interface ProductSales {
  readonly productId: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  /** The quantity sold, a decimal string with three places. */
  readonly qty: string;
  readonly grossPesewas: bigint;
}

/** How many products the top movers name. */
export const TOP_MOVERS = 5;

/**
 * Top movers (FR-RPT-001, A-234): the products that took the most on the day by the gross of their completed order
 * lines, the five highest, a tie in SKU order; a product sold in two units is two rows, never added across units.
 */
export function topMovers(rows: readonly ProductSales[]): Array<{ readonly product: { readonly id: string; readonly sku: string; readonly name: string }; readonly qty: string; readonly uom: string; readonly revenuePesewas: number }> {
  return [...rows]
    .sort((a, b) => (a.grossPesewas === b.grossPesewas ? a.sku.localeCompare(b.sku) || a.uom.localeCompare(b.uom) : a.grossPesewas > b.grossPesewas ? -1 : 1))
    .slice(0, TOP_MOVERS)
    .map((row) => ({ product: { id: row.productId, sku: row.sku, name: row.name }, qty: row.qty, uom: row.uom, revenuePesewas: Money.ofPesewas(row.grossPesewas).toJsonInteger() }));
}
