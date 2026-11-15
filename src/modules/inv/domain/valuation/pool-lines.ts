import { allocate, halfUpDivide, Money, type Quantity, type Result } from '@hakorem/kernel';
import type { CostPool } from './cost-pool';

const THOUSANDTHS = 1_000n;

/** One stock balance line of a pool: where part of the pool's quantity sits. */
export interface PoolLine {
  /** A stable key that breaks ties in the allocation, lowest first. */
  readonly key: bigint;
  readonly qty: Quantity;
}

/**
 * The value at cost of each line of one pool (CR-001): the pool's value split by `allocate` over the lines in
 * proportion to their quantity, so the lines sum to the pool exactly and no pesewa is made or lost. A line at or
 * below zero (an allowed offline sale past zero) holds no value. A pool with no value, or no line holding stock,
 * values every line at zero.
 */
export function valueLines(pool: CostPool, lines: readonly PoolLine[]): Money[] {
  if (lines.length === 0) {
    return [];
  }
  const shares = lines.map((line) => ({ key: line.key, weight: line.qty.thousandths > 0n ? line.qty.thousandths : 0n }));
  if (pool.value.isZero() || shares.every((share) => share.weight === 0n)) {
    return lines.map(() => Money.zero());
  }
  return unwrap(allocate(pool.value, shares));
}

/** Cost per base unit, for display beside the line: the pool's value over its quantity, half-up once; zero when empty. */
export function unitCost(pool: CostPool): Money {
  if (pool.qty.thousandths <= 0n) {
    return Money.zero();
  }
  return Money.ofPesewas(halfUpDivide(pool.value.pesewas * THOUSANDTHS, pool.qty.thousandths));
}

/** A value split into `count` equal shares by `allocate`, the leftover pesewas to the first shares (tag order). */
export function splitEvenly(value: Money, count: number): Money[] {
  if (count < 1) {
    throw new RangeError('a split needs at least one part');
  }
  if (value.isZero()) {
    return Array.from({ length: count }, () => Money.zero());
  }
  return unwrap(allocate(value, Array.from({ length: count }, (_, index) => ({ key: BigInt(index), weight: 1n }))));
}

/** An allocation's parts, or its error thrown: a caller that passed two lines with one key has a bug. */
function unwrap(parts: Result<Money[], Error>): Money[] {
  if (!parts.ok) {
    throw parts.error;
  }
  return parts.value;
}
