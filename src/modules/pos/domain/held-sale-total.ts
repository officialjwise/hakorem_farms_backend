import { Money } from '@hakorem/kernel';

/** What a held sale's lines come to: each line extended and rounded once by the pricing engine, summed exactly (ADR-0001). */
export function heldTotal(lineTotals: readonly Money[]): Money {
  return Money.sum(lineTotals);
}
