/**
 * Order splitting (owner, 2026-11-15; A-168; THREAT_MODEL case 20): one maker raising several orders to one supplier,
 * each just under the approval limit, within a few days, so that none reaches a second person. PUR publishes the rule
 * (`PurchaseOrders.splitSuspectsIn`) for B12's daily exception report. Pure: amounts are integer pesewas.
 */
export interface SubmittedOrder {
  readonly id: string;
  readonly supplierId: string;
  readonly makerId: string;
  readonly submittedAt: Date;
  readonly grossPesewas: bigint;
  /** The approval limit the order was judged against when it was submitted: approval is needed above it. */
  readonly limitPesewas: bigint;
}

export interface SplitSuspect {
  readonly supplierId: string;
  readonly makerId: string;
  readonly orderIds: readonly string[];
  readonly totalPesewas: bigint;
  readonly firstAt: Date;
  readonly lastAt: Date;
}

/**
 * The window, the "just under" margin and how many orders make a pattern (A-168, conservative, the owner to confirm):
 * at least two orders within seven days, each at or below its limit and no more than 20 percent under it, together
 * above the limit.
 */
export const SPLIT_POLICY = { windowDays: 7, marginPercent: 20n, minOrders: 2 } as const;

const DAY_MS = 86_400_000;
const PERCENT = 100n;

function justUnder(order: SubmittedOrder): boolean {
  return order.grossPesewas <= order.limitPesewas && order.grossPesewas * PERCENT >= order.limitPesewas * (PERCENT - SPLIT_POLICY.marginPercent);
}

/** Each run of orders by one maker to one supplier that looks split, earliest first. */
export function flagOrderSplitting(orders: readonly SubmittedOrder[]): SplitSuspect[] {
  const groups = new Map<string, SubmittedOrder[]>();
  for (const order of orders.filter(justUnder)) {
    const key = `${order.supplierId}/${order.makerId}`;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const suspects: SplitSuspect[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
    let i = 0;
    while (i < sorted.length) {
      const first = sorted[i]!;
      const run = sorted.slice(i).filter((o) => o.submittedAt.getTime() - first.submittedAt.getTime() <= SPLIT_POLICY.windowDays * DAY_MS);
      const total = run.reduce((sum, o) => sum + o.grossPesewas, 0n);
      const limit = run.reduce((max, o) => (o.limitPesewas > max ? o.limitPesewas : max), 0n);
      if (run.length >= SPLIT_POLICY.minOrders && total > limit) {
        suspects.push({ supplierId: first.supplierId, makerId: first.makerId, orderIds: run.map((o) => o.id), totalPesewas: total, firstAt: first.submittedAt, lastAt: run.at(-1)!.submittedAt });
        i += run.length;
      } else {
        i += 1;
      }
    }
  }
  return suspects.sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
}

/** Where a search for runs ending in a window must start, so a run that began before the window is seen whole. */
export function splitLookbackStart(from: Date): Date {
  return new Date(from.getTime() - SPLIT_POLICY.windowDays * DAY_MS);
}
