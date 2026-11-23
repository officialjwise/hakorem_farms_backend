import type { Money } from '@hakorem/kernel';

/** What a payment taken for the order still holds unallocated, as a deposit (ADR-0003, 2200). */
export interface DepositHeld {
  readonly paymentId: string;
  readonly unallocated: Money;
}

export interface Settlement {
  /** Each deposit's part applied to the invoice, oldest first. */
  readonly allocations: readonly { readonly paymentId: string; readonly amount: Money }[];
  /** What each deposit holds beyond the invoice, asked back to the original method. */
  readonly refunds: readonly { readonly paymentId: string; readonly amount: Money }[];
  /** What is left on the invoice: the cash due on delivery. */
  readonly due: Money;
}

/**
 * The settlement at dispatch (FR-ORD-011, ADR-0021): the deposits applied to the billing document on the weighed
 * quantity, oldest first, each never beyond what is still outstanding; what a deposit holds beyond the document is
 * refunded; what the deposits do not cover is due on delivery. Exact integers: allocated plus due is the document, and
 * allocated plus refunded is what the deposits held.
 */
export function planSettlement(gross: Money, deposits: readonly DepositHeld[]): Settlement {
  let left = gross;
  const allocations: { paymentId: string; amount: Money }[] = [];
  const refunds: { paymentId: string; amount: Money }[] = [];
  for (const deposit of deposits) {
    if (deposit.unallocated.isZero()) continue;
    const applied = deposit.unallocated.compareTo(left) <= 0 ? deposit.unallocated : left;
    if (!applied.isZero()) allocations.push({ paymentId: deposit.paymentId, amount: applied });
    left = left.minus(applied);
    const beyond = deposit.unallocated.minus(applied);
    if (!beyond.isZero()) refunds.push({ paymentId: deposit.paymentId, amount: beyond });
  }
  return { allocations, refunds, due: left };
}
