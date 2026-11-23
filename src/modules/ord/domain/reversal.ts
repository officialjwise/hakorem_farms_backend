import { err, Money, ok, type Result } from '@hakorem/kernel';
import type { OrderStatus } from './order';

/** The statuses an order may be cancelled from: before it is packed (B11 adds PICKING and AWAITING_CUSTOMER). */
const CANCELLABLE: ReadonlySet<OrderStatus> = new Set(['PLACED', 'CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER']);

/**
 * Whether an order may be cancelled (FR-ORD-014, A-226, B11): placed, confirmed, being picked or waiting for its
 * customer. A pick moves no stock (A-332), so a cancellation while picking withdraws the picks and cancels the pick lists
 * and nothing goes back. A packed order is not cancelled (the machine has no such edge), and a cancel after dispatch is
 * never allowed (a delivery return instead).
 */
export function judgeCancellation(status: OrderStatus): Result<null, 'INVALID_STATE_TRANSITION'> {
  return CANCELLABLE.has(status) ? ok(null) : err('INVALID_STATE_TRANSITION');
}

/** A payment of the order as the cancellation reads it: PAY's `PaymentView` figures. */
export interface OrderPayment {
  readonly id: string;
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly amountPesewas: number;
  readonly allocatedPesewas: number;
  readonly refundedPesewas: number;
}

export interface CancellationMoney {
  /** A refund to ask for from each cleared payment still holding money on deposit, exactly what it holds. */
  readonly refunds: readonly { readonly paymentId: string; readonly amount: Money }[];
  /** The pending charges the order stops waiting for: money that still arrives clears as unmatched (A-210). */
  readonly releases: readonly string[];
  readonly total: Money;
}

/**
 * What a cancellation does with the order's money (FR-ORD-014): every cleared payment's deposit, its amount less what
 * is allocated and already refunded, is asked back to its original method; every pending charge is released. A failed
 * or reversed payment holds nothing.
 */
export function planCancellationMoney(payments: readonly OrderPayment[]): CancellationMoney {
  const refunds: { paymentId: string; amount: Money }[] = [];
  const releases: string[] = [];
  for (const p of payments) {
    if (p.status === 'PENDING') releases.push(p.id);
    if (p.status !== 'CLEARED') continue;
    const held = Money.fromJsonInteger(p.amountPesewas).minus(Money.fromJsonInteger(p.allocatedPesewas)).minus(Money.fromJsonInteger(p.refundedPesewas));
    if (held.compareTo(Money.zero()) > 0) refunds.push({ paymentId: p.id, amount: held });
  }
  return { refunds, releases, total: Money.sum(refunds.map((r) => r.amount)) };
}

/** A tender of the sale as the void reads it. */
export interface VoidPayment {
  readonly id: string;
  readonly methodKind: string;
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly refundedPesewas: number;
}

export interface VoidFacts {
  readonly status: OrderStatus;
  readonly fulfilmentMode: 'COUNTER' | 'COLLECTION' | 'DELIVERY';
  /** The Africa/Accra business date the sale completed, null if it never did. */
  readonly completedOn: string | null;
  readonly today: string;
  readonly payments: readonly VoidPayment[];
  readonly voidPending: boolean;
  /**
   * A reversal of one of the sale's payments is waiting for approval (BL-077): the void reverses every payment itself,
   * so it waits until that reversal is decided. Judged at the void's approval.
   */
  readonly reversalPending: boolean;
}

export type VoidRefusal = 'INVALID_STATE_TRANSITION' | 'VOID_DAY_CLOSED' | 'NOT_A_COUNTER_SALE' | 'VOID_PENDING' | 'TENDER_NOT_VOIDABLE' | 'REVERSAL_PENDING';

/** The tenders a void gives back by reversing the payment itself: cash into the till, store credit into the balance. */
const VOIDABLE_KINDS: ReadonlySet<string> = new Set(['CASH', 'STORE_CREDIT']);

/**
 * Whether a completed sale may be voided (FR-ORD-002 "COMPLETED to VOIDED, same shift, approved", abuse case 1, A-226):
 * a counter or collection sale, on the business day it completed (the shift's day until B9b's shifts exist), with no
 * void already waiting, and every live tender cash or store credit, cleared and never refunded, so the void reverses
 * each payment whole (ADR-0066: a void's refund is a reversal or store credit). Money through the provider or a bank
 * goes back through a return and a refund against its credit note instead. Every refusal is named at once.
 */
export function judgeVoid(f: VoidFacts): Result<null, VoidRefusal[]> {
  if (f.status !== 'COMPLETED') return err(['INVALID_STATE_TRANSITION']);
  const refusals: VoidRefusal[] = [];
  if (f.completedOn === null || f.completedOn !== f.today) refusals.push('VOID_DAY_CLOSED');
  if (f.fulfilmentMode === 'DELIVERY') refusals.push('NOT_A_COUNTER_SALE');
  if (f.voidPending) refusals.push('VOID_PENDING');
  const live = f.payments.filter((p) => p.status !== 'FAILED' && p.status !== 'REVERSED');
  if (live.some((p) => !VOIDABLE_KINDS.has(p.methodKind) || p.status !== 'CLEARED' || p.refundedPesewas > 0)) refusals.push('TENDER_NOT_VOIDABLE');
  if (f.reversalPending) refusals.push('REVERSAL_PENDING');
  return refusals.length === 0 ? ok(null) : err(refusals);
}

/**
 * The supervisor who approves a void is not the cashier (abuse case 1): never the person who posted the sale, nor its
 * salesperson. IAM already refuses the person who asked; the database holds both (`ck_sales_order_void_checker`).
 */
export function judgeVoidApprover(approverId: string, sale: { readonly postedBy: string; readonly salespersonId: string | null }): Result<null, 'CASHIER_CANNOT_APPROVE_VOID'> {
  return approverId === sale.postedBy || approverId === sale.salespersonId ? err('CASHIER_CANNOT_APPROVE_VOID') : ok(null);
}
