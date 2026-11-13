import { AllocationError } from './kernel-error';
import { Money } from './money';
import { err, ok, type Result } from './result';

/** One share of an allocation: a non-negative integer weight and a stable key that breaks ties, lowest first. */
export interface AllocationShare {
  readonly key: bigint;
  readonly weight: bigint;
}

/**
 * The only way to split an amount (ADR-0001, ADR-0028): largest remainder on integer pesewas.
 *
 * 1. Each share's exact part is total x weight / sum of weights; take the floor of each.
 * 2. Hand the leftover pesewas, one each, to the shares with the largest remainders (total x weight) mod sum.
 * 3. Break equal remainders by key, lowest first.
 *
 * The parts are returned in the order of `shares` and always sum to `total` exactly.
 */
export function allocate(total: Money, shares: readonly AllocationShare[]): Result<Money[], AllocationError> {
  if (shares.length === 0) {
    return err(new AllocationError('ALLOCATION_NO_PARTS'));
  }
  if (new Set(shares.map((share) => share.key)).size !== shares.length) {
    return err(new AllocationError('ALLOCATION_DUPLICATE_KEY'));
  }
  if (shares.some((share) => share.weight < 0n)) {
    return err(new AllocationError('ALLOCATION_NEGATIVE_WEIGHT'));
  }
  const weightSum = shares.reduce((sum, share) => sum + share.weight, 0n);
  if (weightSum === 0n) {
    return err(new AllocationError('ALLOCATION_ALL_WEIGHTS_ZERO'));
  }

  const parts = shares.map((share, index) => {
    const product = total.pesewas * share.weight;
    return { index, key: share.key, floor: product / weightSum, remainder: product % weightSum };
  });

  let leftover = total.pesewas - parts.reduce((sum, part) => sum + part.floor, 0n);
  const byLargestRemainder = [...parts].sort((a, b) => {
    if (a.remainder !== b.remainder) {
      return a.remainder > b.remainder ? -1 : 1;
    }
    return a.key < b.key ? -1 : 1;
  });

  const amounts = parts.map((part) => part.floor);
  for (const part of byLargestRemainder) {
    if (leftover === 0n) {
      break;
    }
    amounts[part.index] = part.floor + 1n;
    leftover -= 1n;
  }
  return ok(amounts.map((pesewas) => Money.ofPesewas(pesewas)));
}
