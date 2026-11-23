import { err, Money, ok, type Result } from '@hakorem/kernel';
import { planTender, type MethodKind } from './tender';

/** What a payment recorded by hand (`recordPayment`) is judged on. */
export interface ReceiptFacts {
  readonly methodKind: MethodKind;
  readonly methodLive: boolean;
  readonly amountPesewas: bigint;
  readonly allocationsPesewas: readonly bigint[];
  /** True when a customer is named and live, false when named and unknown, null when none is named. */
  readonly customerKnown: boolean | null;
  /** The bank account named, if any: its kind and whether it is active. */
  readonly bankAccount: { readonly kind: string; readonly isActive: boolean } | null;
  readonly externalReference: string | null;
  readonly shiftNamed: boolean;
  readonly receivedAt: Date;
  readonly now: Date;
}

export type ReceiptRefusal =
  | 'REQUIRES_VERIFICATION'
  | 'TENDER_NOT_AVAILABLE'
  | 'METHOD_DISABLED'
  | 'AMOUNT_NOT_POSITIVE'
  | 'ALLOCATION_NOT_POSITIVE'
  | 'ALLOCATIONS_EXCEED_AMOUNT'
  | 'CUSTOMER_UNKNOWN'
  | 'CUSTOMER_REQUIRED'
  | 'SHIFT_NOT_AVAILABLE'
  | 'RECEIVED_IN_FUTURE'
  | 'BANK_ACCOUNT_REQUIRED'
  | 'BANK_ACCOUNT_NOT_USABLE'
  | 'BANK_ACCOUNT_NOT_FOR_METHOD'
  | 'CHEQUE_NUMBER_REQUIRED'
  | 'ALLOCATION_WHILE_PENDING';

/** How a receipt is written: its status, and whether ◆ `pay.PaymentCleared` posts it now. */
export interface ReceiptPlan {
  readonly status: 'PENDING' | 'CLEARED';
  readonly postsAtReceipt: boolean;
}

const BANKED: ReadonlySet<MethodKind> = new Set(['CHEQUE', 'BANK_TRANSFER']);

/**
 * A payment recorded by hand (FR-PAY-001, A-212). Mobile money and card are never recorded by hand (FR-PAY-005, abuse
 * case 4); cash is taken through a sale with the till of an open shift (B9b) or by a driver (B11), never with a till a
 * caller names. A cheque is PENDING in 1130 from its receipt, its allocations applied at once, and needs its number and
 * the bank account it is paid into; a bank transfer is PENDING with nothing posted and nothing allocated until a
 * statement line matches it (B09a continued 1c); store credit clears at once against a named customer. Every refusal is
 * named at once; the two that make a method unavailable stand alone.
 */
export function judgeReceipt(f: ReceiptFacts): Result<ReceiptPlan, ReceiptRefusal[]> {
  if (f.methodKind === 'MOBILE_MONEY' || f.methodKind === 'CARD') return err(['REQUIRES_VERIFICATION']);
  if (f.methodKind === 'CASH') return err(['TENDER_NOT_AVAILABLE']);
  const refusals: ReceiptRefusal[] = [];
  if (!f.methodLive) refusals.push('METHOD_DISABLED');
  const plan = planTender(Money.ofPesewas(f.amountPesewas), f.allocationsPesewas.map((a) => Money.ofPesewas(a)));
  if (!plan.ok) refusals.push(plan.error);
  if (f.customerKnown === false) refusals.push('CUSTOMER_UNKNOWN');
  if (f.methodKind === 'STORE_CREDIT' && f.customerKnown === null) refusals.push('CUSTOMER_REQUIRED');
  if (f.shiftNamed) refusals.push('SHIFT_NOT_AVAILABLE');
  if (f.receivedAt.getTime() > f.now.getTime()) refusals.push('RECEIVED_IN_FUTURE');
  if (BANKED.has(f.methodKind)) {
    if (f.bankAccount === null) refusals.push('BANK_ACCOUNT_REQUIRED');
    else if (f.bankAccount.kind !== 'BANK' || !f.bankAccount.isActive) refusals.push('BANK_ACCOUNT_NOT_USABLE');
  } else if (f.bankAccount !== null) refusals.push('BANK_ACCOUNT_NOT_FOR_METHOD');
  if (f.methodKind === 'CHEQUE' && f.externalReference === null) refusals.push('CHEQUE_NUMBER_REQUIRED');
  if (f.methodKind === 'BANK_TRANSFER' && f.allocationsPesewas.length > 0) refusals.push('ALLOCATION_WHILE_PENDING');
  if (refusals.length > 0) return err(refusals);
  return ok({ status: f.methodKind === 'STORE_CREDIT' ? 'CLEARED' : 'PENDING', postsAtReceipt: f.methodKind !== 'BANK_TRANSFER' });
}

/** A store credit redemption (FR-PAY-015): never beyond the balance; answers what is left. The database holds it too. */
export function judgeRedemption(balance: Money, amount: Money): Result<Money, 'STORE_CREDIT_INSUFFICIENT'> {
  if (amount.compareTo(balance) > 0) return err('STORE_CREDIT_INSUFFICIENT');
  return ok(balance.minus(amount));
}

/** A cheque's clearing (FR-PAY-011): a pending cheque, on a business date from its receipt to today. */
export function judgeChequeClearance(
  payment: { readonly methodKind: MethodKind; readonly status: string; readonly receivedOn: string },
  clearedOn: string,
  today: string,
): Result<void, ('NOT_A_CHEQUE' | 'CHEQUE_NOT_PENDING' | 'CLEARED_ON_OUT_OF_RANGE')[]> {
  if (payment.methodKind !== 'CHEQUE') return err(['NOT_A_CHEQUE']);
  if (payment.status !== 'PENDING') return err(['CHEQUE_NOT_PENDING']);
  if (clearedOn < payment.receivedOn || clearedOn > today) return err(['CLEARED_ON_OUT_OF_RANGE']);
  return ok(undefined);
}

export interface ReversiblePayment {
  readonly methodKind: MethodKind;
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly reversesPaymentId: string | null;
  readonly refundedPesewas: bigint;
  /** `UNVERIFIED` for an offline mobile money tender awaiting verification (A-282); absent or anything else otherwise. */
  readonly verification?: string;
  /** Whether that tender was verified and moved to the wallet (`pay.unverified_verification`). */
  readonly verified?: boolean;
}

export type ReversalRefusal = 'NOT_REVERSIBLE' | 'PAYMENT_HAS_REFUNDS' | 'REASON_UNKNOWN' | 'REASON_NOT_FOR_METHOD';

/**
 * A reversal (FR-PAY-011, FR-PAY-014): a cleared payment becomes REVERSED; a cheque still awaiting clearance bounces and
 * becomes FAILED. Either way its journal is mirrored and its allocations reopened. A payment that posted nothing (a
 * pending provider payment or bank transfer) is not reversed, nor one already reversed, a reversing payment, or one with
 * a refund that is not rejected. The reason is a PAYMENT_REVERSAL code; CHEQUE_DISHONOURED only for a cheque. An
 * unverified offline mobile money tender still awaiting verification bounces too (MOBILE_MONEY_NOT_RECEIVED, its own).
 */
export function judgeReversal(payment: ReversiblePayment, reason: { readonly domain: string; readonly code: string } | null): Result<{ readonly becomes: 'REVERSED' | 'FAILED' }, ReversalRefusal[]> {
  const refusals: ReversalRefusal[] = [];
  // An unverified offline mobile money tender still awaiting verification bounces as a cheque does (A-282 (d)): FAILED,
  // its receipt mirrored out of 1115; once verified it is in the wallet and is no longer bounced.
  const waitingTender = payment.methodKind === 'MOBILE_MONEY' && payment.verification === 'UNVERIFIED' && payment.verified !== true;
  const bounce = payment.status === 'PENDING' && (payment.methodKind === 'CHEQUE' || waitingTender);
  if (payment.reversesPaymentId !== null || !(payment.status === 'CLEARED' || bounce)) refusals.push('NOT_REVERSIBLE');
  else if (payment.refundedPesewas > 0n) refusals.push('PAYMENT_HAS_REFUNDS');
  if (reason === null || reason.domain !== 'PAYMENT_REVERSAL') refusals.push('REASON_UNKNOWN');
  else if (reason.code === 'CHEQUE_DISHONOURED' && payment.methodKind !== 'CHEQUE') refusals.push('REASON_NOT_FOR_METHOD');
  else if (reason.code === 'MOBILE_MONEY_NOT_RECEIVED' && !(waitingTender && payment.status === 'PENDING')) refusals.push('REASON_NOT_FOR_METHOD');
  if (refusals.length > 0) return err(refusals);
  return ok({ becomes: bounce ? 'FAILED' : 'REVERSED' });
}
