import { Money, type Quantity } from '@hakorem/kernel';

/** One reservation a line takes from the balance at `index` of the balances it was offered. */
export interface ReservationPiece {
  readonly index: number;
  readonly qty: Quantity;
}

export type LineReservationPlan = { readonly kind: 'HELD'; readonly pieces: readonly ReservationPiece[] } | { readonly kind: 'SHORT'; readonly available: Quantity; readonly short: Quantity };

/**
 * How a confirmed line is held (FR-ORD-005): from the balances it may be promised, in the order given (oldest stock
 * first), each taking what it can until the line is covered. If all of them together cannot cover it, nothing is held
 * and the plan names what is available and how much is short, so the order stays PLACED and says why.
 */
export function planLineReservation(needed: Quantity, balances: readonly { readonly availableQty: Quantity }[]): LineReservationPlan {
  const pieces: ReservationPiece[] = [];
  let left = needed;
  for (const [index, balance] of balances.entries()) {
    if (left.isZero()) break;
    const take = balance.availableQty.compareTo(left) < 0 ? balance.availableQty : left;
    if (take.isZero() || take.isNegative()) continue;
    pieces.push({ index, qty: take });
    left = left.minus(take);
  }
  if (!left.isZero()) return { kind: 'SHORT', available: needed.minus(left), short: left };
  return { kind: 'HELD', pieces };
}

/** A payment as the confirmation reads it: PAY's `PaymentView` figures. */
export interface ReceivedPayment {
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly amountPesewas: number;
  readonly refundedPesewas: number;
}

/** What the customer has paid towards an order and still holds there: cleared payments less what was refunded. */
export function receivedForOrder(payments: readonly ReceivedPayment[]): Money {
  return Money.sum(payments.filter((p) => p.status === 'CLEARED').map((p) => Money.fromJsonInteger(p.amountPesewas).minus(Money.fromJsonInteger(p.refundedPesewas))));
}

/** A registered `OrderConfirmationPolicy`'s answer for a credit order; null when no policy answers (WHL arrives in B10). */
export type CreditAnswer = 'PASSED' | 'REFUSED' | null;

export type ConfirmationRefusal = 'PREPAYMENT_SHORT' | 'CREDIT_CHECK_UNAVAILABLE' | 'CREDIT_REFUSED' | 'TERMS_NOT_CONFIRMED';

export type ConfirmationVerdict = { readonly ok: true; readonly creditCheck: 'PASSED' | 'NOT_REQUIRED' } | { readonly ok: false; readonly rule: ConfirmationRefusal };

/**
 * The payment or credit check of a confirmation (FR-ORD-005, A-224): cash on delivery needs neither; a prepaid order
 * needs its estimate received in full; a credit order needs a policy to pass it, and with none registered it is
 * refused rather than waved through. An order on immediate terms is never confirmed: the sale posting completes it.
 */
export function judgeConfirmation(input: {
  readonly paymentTerms: 'IMMEDIATE' | 'PREPAID' | 'COD' | 'CREDIT';
  readonly estimated: Money;
  readonly received: Money;
  readonly credit: CreditAnswer;
}): ConfirmationVerdict {
  switch (input.paymentTerms) {
    case 'COD':
      return { ok: true, creditCheck: 'NOT_REQUIRED' };
    case 'PREPAID':
      return input.received.compareTo(input.estimated) >= 0 ? { ok: true, creditCheck: 'NOT_REQUIRED' } : { ok: false, rule: 'PREPAYMENT_SHORT' };
    case 'CREDIT':
      if (input.credit === null) return { ok: false, rule: 'CREDIT_CHECK_UNAVAILABLE' };
      return input.credit === 'PASSED' ? { ok: true, creditCheck: 'PASSED' } : { ok: false, rule: 'CREDIT_REFUSED' };
    case 'IMMEDIATE':
      return { ok: false, rule: 'TERMS_NOT_CONFIRMED' };
  }
}
