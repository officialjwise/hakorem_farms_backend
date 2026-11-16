import { err, Money, ok, type Result } from '@hakorem/kernel';

/** A payment method's kind, as `mdm.payment_method.kind` stores it and the ledger determines the tender account by. */
export type MethodKind = 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'STORE_CREDIT';

/**
 * How a method's payment clears (FR-PAY-001): cash and store credit at once; mobile money and card only from a verified
 * provider callback or lookup (FR-PAY-005, abuse case 4); a bank transfer from a matched statement line; a cheque from
 * the bank's confirmation.
 */
export type Clearing = 'AT_ONCE' | 'PROVIDER' | 'STATEMENT' | 'BANK_CONFIRMATION';

const CLEARING: Readonly<Record<MethodKind, Clearing>> = {
  CASH: 'AT_ONCE',
  STORE_CREDIT: 'AT_ONCE',
  MOBILE_MONEY: 'PROVIDER',
  CARD: 'PROVIDER',
  BANK_TRANSFER: 'STATEMENT',
  CHEQUE: 'BANK_CONFIRMATION',
};

export function clearingOf(kind: MethodKind): Clearing {
  return CLEARING[kind];
}

export interface TenderPlan {
  /** The part applied to billing documents now. */
  readonly allocated: Money;
  /** The rest, held as the customer's deposit (2200) until allocated or refunded (FR-PAY-010). */
  readonly unallocated: Money;
}

export type TenderRefusal = 'AMOUNT_NOT_POSITIVE' | 'ALLOCATION_NOT_POSITIVE' | 'ALLOCATIONS_EXCEED_AMOUNT';

/** A tender and its allocations: every amount above zero, the allocations never more than the tender (FR-PAY-009). */
export function planTender(amount: Money, allocations: readonly Money[]): Result<TenderPlan, TenderRefusal> {
  if (amount.isZero()) return err('AMOUNT_NOT_POSITIVE');
  if (allocations.some((a) => a.isZero())) return err('ALLOCATION_NOT_POSITIVE');
  const allocated = Money.sum(allocations);
  if (allocated.compareTo(amount) > 0) return err('ALLOCATIONS_EXCEED_AMOUNT');
  return ok({ allocated, unallocated: amount.minus(allocated) });
}
