import { allocate, err, ok, type Money, type Rate, type Result } from '@hakorem/kernel';

/** One investor's weight in a run: unit-days in ten-thousandths (unit-days x 10,000, the integer ADR-0028 names). */
export interface WeightedInvestor {
  readonly investorId: string;
  readonly investorNo: string;
  readonly unitDaysE4: bigint;
}

/** One investor's line of a run, every figure an exact integer. */
export interface AllocatedLine extends WeightedInvestor {
  readonly allocated: Money;
  /** Whether a leftover pesewa landed here: the allocation is above the floor of the exact share. */
  readonly receivedExtraPesewa: boolean;
  readonly withheld: Money;
  readonly netPayable: Money;
}

/** The investor number's value, the tie key (FR-CAP-009): "INV-001" is 1, so INV-1000 follows INV-999. */
export function investorTieKey(investorNo: string): bigint {
  return BigInt(investorNo.replace(/\D/g, ''));
}

/**
 * Allocates a run's distributable amount by unit-days (FR-CAP-008, FR-CAP-009, ADR-0028) through the kernel's
 * `allocate`: the floor of each exact share, the leftover pesewas one at a time to the largest remainders, equal
 * remainders to the lower investor number. The lines sum to the distributable amount exactly. An investor with no
 * unit-days has no line. No unit-days at all is refused, never an equal split; so are two lines of one investor number. Tax withheld is
 * `half_up(allocated x rate)` per investor and net payable is allocated less withheld (FR-CAP-011).
 */
export function allocateDistribution(distributable: Money, investors: readonly WeightedInvestor[], withholding: Rate): Result<AllocatedLine[], 'NO_UNIT_DAYS' | 'DUPLICATE_INVESTOR'> {
  const weighted = investors.filter((i) => i.unitDaysE4 > 0n);
  const totalWeight = weighted.reduce((sum, i) => sum + i.unitDaysE4, 0n);
  if (totalWeight === 0n) return err('NO_UNIT_DAYS');
  const parts = allocate(
    distributable,
    weighted.map((i) => ({ key: investorTieKey(i.investorNo), weight: i.unitDaysE4 })),
  );
  // With a positive total, allocate refuses only two lines under one investor number.
  if (!parts.ok) return err('DUPLICATE_INVESTOR');
  return ok(
    weighted.map((investor, index) => {
      const allocated = parts.value[index]!;
      const floor = (distributable.pesewas * investor.unitDaysE4) / totalWeight;
      const withheld = allocated.timesRate(withholding);
      return { ...investor, allocated, receivedExtraPesewa: allocated.pesewas > floor, withheld, netPayable: allocated.minus(withheld) };
    }),
  );
}
