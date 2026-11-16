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
export type RefundRefusal =
  | 'AMOUNT_NOT_POSITIVE'
  | 'PAYMENT_NOT_CLEARED'
  | 'REFUND_EXCEEDS_PAYMENT'
  | 'REFUND_EXCEEDS_CREDIT_NOTE'
  | 'CREDIT_NOTE_NOT_AVAILABLE'
  | 'DESTINATION_NOT_AVAILABLE'
  | 'STORE_CREDIT_NEEDS_PHONE';

/**
 * How the money goes back: through the provider; paid by hand and recorded with its reference (`markRefundPaid`); into
 * the customer's store credit; or, for a cheque, a bank payout out of the account it was paid into, also recorded by
 * hand with its reference (ADR-0066).
 */
export interface RefundRoute {
  readonly route: 'PROVIDER' | 'MANUAL' | 'STORE_CREDIT' | 'BANK_PAYOUT';
}

/**
 * What a refund against a credit note draws on (ADR-0066): the credit note's amount less the refunds already held
 * against it, never more than its document owes back to the customer (`left`); and what the refunded payment applied
 * to the credited document, less the credit note refunds it already carries (`paidByPayment`).
 */
export interface CreditNoteFacts {
  /** An issued credit note. */
  readonly issued: boolean;
  /** Of the payment's customer (or both walk-in) and branch. */
  readonly matchesPayment: boolean;
  readonly left: Money;
  readonly paidByPayment: Money;
}

const PROVIDER_KINDS: ReadonlySet<MethodKind> = new Set(['MOBILE_MONEY', 'CARD']);

/** What is left to refund: the unallocated money of the payment, less refunds that are not rejected (FR-PAY-012). */
export function refundableOf(payment: RefundablePayment): Money {
  return payment.amount.minus(payment.allocated).minus(payment.refunded);
}

/**
 * A refund request (FR-PAY-012, abuse case 12): only a cleared payment. Without a credit note, never more than the
 * payment's unallocated, unrefunded money; against a credit note (ADR-0066), never more than the credit note has left
 * and never more than the payment paid on the credited document. To the original method (through the provider for
 * mobile money and card, a bank payout for a cheque, by hand otherwise), in cash only for a cash original, or to the
 * customer's store credit (paid at once on approval, FR-PAY-015), never the walk-in and only for a customer with a phone
 * number (the owner, 2026-11-16); a store credit tender goes back to store credit. Every refusal is named at once.
 */
export function judgeRefund(payment: RefundablePayment, amount: Money, destination: RefundDestination, creditNote: CreditNoteFacts | null = null): Result<RefundRoute, RefundRefusal[]> {
  const refusals: RefundRefusal[] = [];
  if (amount.isZero()) refusals.push('AMOUNT_NOT_POSITIVE');
  if (payment.status !== 'CLEARED') refusals.push('PAYMENT_NOT_CLEARED');
  if (creditNote === null) {
    if (amount.compareTo(refundableOf(payment)) > 0) refusals.push('REFUND_EXCEEDS_PAYMENT');
  } else if (!creditNote.issued || !creditNote.matchesPayment) {
    refusals.push('CREDIT_NOTE_NOT_AVAILABLE');
  } else {
    if (amount.compareTo(creditNote.left) > 0) refusals.push('REFUND_EXCEEDS_CREDIT_NOTE');
    if (amount.compareTo(creditNote.paidByPayment) > 0) refusals.push('REFUND_EXCEEDS_PAYMENT');
  }
  const toCredit = destination === 'STORE_CREDIT' || (destination === 'ORIGINAL_METHOD' && payment.methodKind === 'STORE_CREDIT');
  if ((toCredit && !payment.hasCustomer) || (destination === 'CASH' && payment.methodKind !== 'CASH')) {
    refusals.push('DESTINATION_NOT_AVAILABLE');
  } else if (toCredit && !payment.customerHasPhone) {
    refusals.push('STORE_CREDIT_NEEDS_PHONE');
  }
  if (refusals.length > 0) return err(refusals);
  if (toCredit) return ok({ route: 'STORE_CREDIT' });
  if (destination === 'ORIGINAL_METHOD' && payment.methodKind === 'CHEQUE') return ok({ route: 'BANK_PAYOUT' });
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

/** A credit note's facts as PAY reads them, in integer pesewas. */
export interface StoredCreditNoteFacts {
  readonly issued: boolean;
  readonly matchesPayment: boolean;
  readonly leftPesewas: bigint;
  readonly paidByPaymentPesewas: bigint;
}

/** `judgeRefund` over a stored payment (and the credit note it draws on), in integer pesewas. */
export function judgeStoredRefund(payment: StoredPaymentAmounts, amountPesewas: bigint, destination: RefundDestination, creditNote: StoredCreditNoteFacts | null = null): Result<RefundRoute, RefundRefusal[]> {
  const facts =
    creditNote === null
      ? null
      : { issued: creditNote.issued, matchesPayment: creditNote.matchesPayment, left: Money.ofPesewas(creditNote.leftPesewas), paidByPayment: Money.ofPesewas(creditNote.paidByPaymentPesewas) };
  return judgeRefund(refundableFromStore(payment), Money.ofPesewas(amountPesewas), destination, facts);
}

/** What a stored payment has left to refund, in integer pesewas. */
export function refundLeftOf(payment: StoredPaymentAmounts): bigint {
  return refundableOf(refundableFromStore(payment)).pesewas;
}
