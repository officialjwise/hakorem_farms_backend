import { allocate, err, ok, Quantity, type Money, type Result } from '@hakorem/kernel';

/** One stock unit sharing a run's amount, with its integer allocation weight (head-days, or one each for EQUAL). */
export interface AllocationShare {
  readonly stockUnitId: string;
  /** The tag or batch number: the stable order the shares are keyed in, so a tie always falls the same way. */
  readonly identifier: string;
  readonly weight: bigint;
}

export interface AllocationPart extends AllocationShare {
  readonly amount: Money;
}

export type AllocationRefusal = 'NO_ANIMALS_IN_SCOPE' | 'UNIT_REPEATED';

export type Treatment = 'CAPITALISED' | 'EXPENSED';

export type RunRefusal = 'MAKER_CANNOT_CHECK' | 'ALREADY_POSTED';

const THOUSANDTHS_PER_HEAD = 1_000n;

/**
 * Spreads a period's labour or overhead over the stock units of its scope (FR-CST-002, ADR-0018) through the kernel's
 * `allocate` only: the floor of each exact share, the leftover pesewas to the largest remainders, equal remainders to
 * the lowest key. The shares are keyed in identifier order, then id, so 30,001 over 10, 10 and 5 head-days is 12,001,
 * 12,000 and 6,000 with the pesewa on the first tag. The parts sum to the amount exactly and come back in that order.
 * Refused when nothing with a weight is in scope, or a unit is named twice.
 */
export function spreadOverhead(total: Money, shares: readonly AllocationShare[]): Result<AllocationPart[], AllocationRefusal> {
  if (shares.length === 0 || shares.some((share) => share.weight <= 0n)) return err('NO_ANIMALS_IN_SCOPE');
  if (new Set(shares.map((share) => share.stockUnitId)).size !== shares.length) return err('UNIT_REPEATED');
  const ordered = [...shares].sort((a, b) => (a.identifier === b.identifier ? (a.stockUnitId < b.stockUnitId ? -1 : 1) : a.identifier < b.identifier ? -1 : 1));
  // The weights are positive and the keys distinct, so the kernel cannot refuse.
  const parts = allocate(
    total,
    ordered.map((share, index) => ({ key: BigInt(index), weight: share.weight })),
  ) as { readonly ok: true; readonly value: Money[] };
  return ok(ordered.map((share, index) => ({ ...share, amount: parts.value[index]! })));
}

/**
 * A unit's head-days over a period: the whole head it had on hand in scope at the end of each day, summed. An animal
 * counts one on a day it was there; a flock its whole head on hand, a part head not counted (as LIV's feed spread).
 */
export function headDaysOf(tracking: 'SERIAL' | 'LOT', dailyOnHand: readonly string[]): bigint {
  let total = 0n;
  for (const qty of dailyOnHand) {
    const thousandths = Quantity.parse(qty).thousandths;
    if (thousandths <= 0n) continue;
    total += tracking === 'SERIAL' ? 1n : thousandths / THOUSANDTHS_PER_HEAD;
  }
  return total;
}

/**
 * Labour and overhead are capitalised onto growing stock and left in the period's cost for breeding stock (ADR-0018,
 * A-025); a laying flock is kept to produce, so it is breeding stock (A-159).
 */
export function treatmentOf(purpose: 'GROWING' | 'BREEDING' | 'LAYING'): Treatment {
  return purpose === 'GROWING' ? 'CAPITALISED' : 'EXPENSED';
}

/** A run is posted once, from a draft, by someone other than the person who created it (FR-CST-002, ADR-0017). */
export function judgePost(run: { readonly status: 'DRAFT' | 'POSTED'; readonly createdBy: string }, posterId: string): RunRefusal | null {
  if (run.status !== 'DRAFT') return 'ALREADY_POSTED';
  return run.createdBy === posterId ? 'MAKER_CANNOT_CHECK' : null;
}
