import { Money, type Rate } from '@hakorem/kernel';

/** What a run shares (FR-CAP-006, ADR-0028): the period's net profit, what the farm keeps, and the rest. */
export interface DistributableProfit {
  /** The ledger's net profit, or zero when the period made a loss or broke even. */
  readonly netProfit: Money;
  readonly isLoss: boolean;
  readonly retained: Money;
  readonly distributable: Money;
}

/**
 * Net profit is income less cost of sales less expenses for the period, read from the ledger (signed). A loss or a
 * break-even period shares nothing and says so. Otherwise `retained = half_up(net profit x retention rate)`, once, and
 * `distributable = net profit - retained`.
 */
export function distributableProfit(netProfitPesewas: bigint, retention: Rate): DistributableProfit {
  if (netProfitPesewas <= 0n) {
    return { netProfit: Money.zero(), isLoss: netProfitPesewas < 0n, retained: Money.zero(), distributable: Money.zero() };
  }
  const netProfit = Money.ofPesewas(netProfitPesewas);
  const retained = netProfit.timesRate(retention);
  return { netProfit, isLoss: false, retained, distributable: netProfit.minus(retained) };
}
