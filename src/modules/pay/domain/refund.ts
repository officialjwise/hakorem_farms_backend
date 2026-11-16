import { err, Money, ok, type Result } from '@hakorem/kernel';
import { backoffAt } from './time';
import type { MethodKind } from './tender';

/** A provider refund is tried this many times before it waits for a person (FR-PAY-013). */
export const REFUND_MAX_ATTEMPTS = 3;
const REFUND_BACKOFF_BASE_MS = 300_000;

export interface RefundablePayment {
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly methodKind: MethodKind;
  readonly amount: Money;
  readonly allocated: Money;
  readonly refunded: Money;
  /** Store credit is held against a customer: a walk-in payment has none to credit. */
  readonly hasCustomer: boolean;
  /** Store credit is held only for a customer with a phone number (the owner, 2026-11-16): never a pot anyone could spend. */
  readonly customerHasPhone: boolean;
}

export type RefundDestination = 'ORIGINAL_METHOD' | 'STORE_CREDIT' | 'CASH';
export type RefundRefusal = 'AMOUNT_NOT_POSITIVE' | 'PAYMENT_NOT_CLEARED' | 'REFUND_EXCEEDS_PAYMENT' | 'DESTINATION_NOT_AVAILABLE' | 'STORE_CREDIT_NEEDS_PHONE';

/** How the money goes back: through the provider, or paid by hand and recorded with its reference (`markRefundPaid`). */
export interface RefundRoute {
  readonly route: 'PROVIDER' | 'MANUAL' | 'STORE_CREDIT';
}

const PROVIDER_KINDS: ReadonlySet<MethodKind> = new Set(['MOBILE_MONEY', 'CARD']);

/** What is left to refund: the unallocated money of the payment, less refunds that are not rejected (FR-PAY-012). */
export function refundableOf(payment: RefundablePayment): Money {
  return payment.amount.minus(payment.allocated).minus(payment.refunded);
}

/**
 * A refund request (FR-PAY-012, abuse case 12): only a cleared payment, never more than its unallocated, unrefunded
 * money (money settling a document is credited by a credit note first), to the original method (through the provider
 * for mobile money and card, by hand otherwise), in cash only for a cash original, or to the customer's store credit
 * (paid at once on approval, FR-PAY-015), never the walk-in and only for a customer with a phone number (the owner,
 * 2026-11-16); a store credit tender goes back to store credit. A cheque is not paid back to
 * its original method until the bank payout is built with reconciliation (A-213). Every refusal is named at once.
 */
export function judgeRefund(payment: RefundablePayment, amount: Money, destination: RefundDestination): Result<RefundRoute, RefundRefusal[]> {
  const refusals: RefundRefusal[] = [];
  if (amount.isZero()) refusals.push('AMOUNT_NOT_POSITIVE');
  if (payment.status !== 'CLEARED') refusals.push('PAYMENT_NOT_CLEARED');
  if (amount.compareTo(refundableOf(payment)) > 0) refusals.push('REFUND_EXCEEDS_PAYMENT');
  const toCredit = destination === 'STORE_CREDIT' || (destination === 'ORIGINAL_METHOD' && payment.methodKind === 'STORE_CREDIT');
  if ((toCredit && !payment.hasCustomer) || (destination === 'CASH' && payment.methodKind !== 'CASH') || (destination === 'ORIGINAL_METHOD' && payment.methodKind === 'CHEQUE')) {
    refusals.push('DESTINATION_NOT_AVAILABLE');
  } else if (toCredit && !payment.customerHasPhone) {
    refusals.push('STORE_CREDIT_NEEDS_PHONE');
  }
  if (refusals.length > 0) return err(refusals);
  if (toCredit) return ok({ route: 'STORE_CREDIT' });
  return ok({ route: destination === 'ORIGINAL_METHOD' && PROVIDER_KINDS.has(payment.methodKind) ? 'PROVIDER' : 'MANUAL' });
}

/** After a provider refund's nth failure: retry after 5 minutes doubled each time, or stop at the limit. */
export function nextRefundAttempt(failures: number, now: Date): { readonly kind: 'RETRY'; readonly at: Date } | { readonly kind: 'EXHAUSTED' } {
  if (failures >= REFUND_MAX_ATTEMPTS) return { kind: 'EXHAUSTED' };
  return { kind: 'RETRY', at: backoffAt(now, REFUND_BACKOFF_BASE_MS, failures) };
}

/** A payment's amounts as PAY stores them, integer pesewas. */
export interface StoredPaymentAmounts {
  readonly status: RefundablePayment['status'];
  readonly methodKind: MethodKind;
  readonly amountPesewas: bigint;
  readonly allocatedPesewas: bigint;
  readonly refundedPesewas: bigint;
  readonly customerId?: string | null;
  /** Whether the payment's customer has a phone number; unknown is no. */
  readonly customerHasPhone?: boolean;
}

function refundableFromStore(p: StoredPaymentAmounts): RefundablePayment {
  return {
    status: p.status,
    methodKind: p.methodKind,
    amount: Money.ofPesewas(p.amountPesewas),
    allocated: Money.ofPesewas(p.allocatedPesewas),
    refunded: Money.ofPesewas(p.refundedPesewas),
    hasCustomer: p.customerId !== null && p.customerId !== undefined,
    customerHasPhone: p.customerHasPhone === true,
  };
}

/** `judgeRefund` over a stored payment, in integer pesewas. */
export function judgeStoredRefund(payment: StoredPaymentAmounts, amountPesewas: bigint, destination: RefundDestination): Result<RefundRoute, RefundRefusal[]> {
  return judgeRefund(refundableFromStore(payment), Money.ofPesewas(amountPesewas), destination);
}

/** What a stored payment has left to refund, in integer pesewas. */
export function refundLeftOf(payment: StoredPaymentAmounts): bigint {
  return refundableOf(refundableFromStore(payment)).pesewas;
}
