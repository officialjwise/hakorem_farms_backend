import { halfUpDivide, Money, Quantity } from '@hakorem/kernel';

/**
 * A cost pool (ADR-0018): the quantity and total value of one stock unit (specific identification) or of one
 * untracked product at one branch (moving weighted average). Never a stored rate. Quantity is signed, for the
 * allowed-negative offline case; value is never negative, and a pool with no quantity has no value.
 *
 * The movement trigger in migration 0043 (`inv.movement_value`, `inv.apply_movement`) applies the same rules in the
 * database, which is authoritative; this is the rule the application uses to value a line before it posts it (an
 * adjustment against its approval threshold, a stock-take variance) and the rule the unit tests pin exactly.
 */
export interface CostPool {
  readonly qty: Quantity;
  readonly value: Money;
}

export interface IssueResult {
  /** The value the issuing movement carries. */
  readonly carried: Money;
  /** The quantity issued beyond what the pool held: valued at zero, so cost of sales is understated by it. */
  readonly uncovered: Quantity;
  readonly pool: CostPool;
}

export class CostPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostPoolError';
  }
}

export function emptyPool(): CostPool {
  return { qty: Quantity.zero(), value: Money.zero() };
}

/** A receipt adds its quantity and its own value. */
export function receive(pool: CostPool, qty: Quantity, value: Money): CostPool {
  if (qty.compareTo(Quantity.zero()) <= 0) {
    throw new CostPoolError('a receipt moves a positive quantity');
  }
  return { qty: pool.qty.plus(qty), value: pool.value.plus(value) };
}

/** A value-only movement adds cost to stock that exists: feed, veterinary, labour, overhead. */
export function capitalise(pool: CostPool, value: Money): CostPool {
  if (pool.qty.compareTo(Quantity.zero()) <= 0) {
    throw new CostPoolError('cost can be capitalised only onto a pool that holds stock');
  }
  return { qty: pool.qty, value: pool.value.plus(value) };
}

/**
 * An issue of `q` from a pool of `Q` valued `V` carries `V` if `q >= Q`, otherwise `half_up(V x q / Q)`, and the pool
 * is reduced by exactly that. From a pool at or below zero it carries nothing. The part of `q` beyond `Q` is uncovered.
 */
export function issue(pool: CostPool, qty: Quantity): IssueResult {
  if (qty.isNegative()) {
    throw new CostPoolError('an issue moves a non-negative quantity');
  }
  const zero = Quantity.zero();
  let carried: Money;
  let uncovered: Quantity;
  if (pool.qty.compareTo(zero) <= 0) {
    carried = Money.zero();
    uncovered = qty;
  } else if (qty.compareTo(pool.qty) >= 0) {
    carried = pool.value;
    uncovered = qty.minus(pool.qty);
  } else {
    carried = Money.ofPesewas(halfUpDivide(pool.value.pesewas * qty.thousandths, pool.qty.thousandths));
    uncovered = zero;
  }
  return { carried, uncovered, pool: { qty: pool.qty.minus(qty), value: pool.value.minus(carried) } };
}
