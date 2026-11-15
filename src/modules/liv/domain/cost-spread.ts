import { allocate, err, ok, Quantity, type Money, type Result } from '@hakorem/kernel';

/** One stock unit sharing a cost: an animal (one head) or a flock (its head on hand), for the days it was there. */
export interface HeadDayShare {
  readonly stockUnitId: string;
  /** The tag or batch number: the stable order the shares are keyed in, so a tie always falls the same way. */
  readonly identifier: string;
  readonly headDays: bigint;
}

export interface SpreadPart {
  readonly stockUnitId: string;
  readonly identifier: string;
  readonly headDays: bigint;
  readonly amount: Money;
}

export type SpreadRefusal = 'NO_ANIMALS_HERE' | 'UNIT_REPEATED';

export type Treatment = 'CAPITALISED' | 'EXPENSED';

const THOUSANDTHS_PER_HEAD = 1_000n;

/**
 * Spreads a feed issue's or a treatment's cost across the animals and flocks it served by head-days (FR-LIV-009,
 * FR-LIV-015, ADR-0018), through the kernel's `allocate` only: the floor of each exact share, the leftover pesewas to
 * the largest remainders, equal remainders to the lowest key. The shares are keyed in identifier order (then id), so
 * the leftover of 9,001 over three equal animals goes to the first tag. The parts always sum to `total` exactly and
 * come back in that order. Refused when nothing with a head-day is there to carry the cost, or a unit repeats.
 */
export function spreadByHeadDays(total: Money, shares: readonly HeadDayShare[]): Result<SpreadPart[], SpreadRefusal> {
  if (shares.length === 0 || shares.some((share) => share.headDays <= 0n)) return err('NO_ANIMALS_HERE');
  if (new Set(shares.map((share) => share.stockUnitId)).size !== shares.length) return err('UNIT_REPEATED');
  const ordered = [...shares].sort((a, b) => (a.identifier === b.identifier ? (a.stockUnitId < b.stockUnitId ? -1 : 1) : a.identifier < b.identifier ? -1 : 1));
  // The weights are positive and the keys distinct, so the kernel cannot refuse.
  const parts = allocate(
    total,
    ordered.map((share, index) => ({ key: BigInt(index), weight: share.headDays })),
  ) as { readonly ok: true; readonly value: Money[] };
  return ok(ordered.map((share, index) => ({ stockUnitId: share.stockUnitId, identifier: share.identifier, headDays: share.headDays, amount: parts.value[index]! })));
}

/** The whole head a unit has on hand for one day: an animal is one, a flock its head on hand, a part head not counted. */
export function headOf(tracking: 'SERIAL' | 'LOT', onHandQty: string): bigint {
  if (tracking === 'SERIAL') return 1n;
  const thousandths = Quantity.parse(onHandQty).thousandths;
  return thousandths <= 0n ? 0n : thousandths / THOUSANDTHS_PER_HEAD;
}

/**
 * Feed and veterinary cost is capitalised onto growing stock and expensed for breeding stock (ADR-0018, A-025). A laying
 * flock is kept to produce, not to be sold, so it is treated as breeding stock (A-159).
 */
export function treatmentOf(purpose: 'GROWING' | 'BREEDING' | 'LAYING'): Treatment {
  return purpose === 'GROWING' ? 'CAPITALISED' : 'EXPENSED';
}
