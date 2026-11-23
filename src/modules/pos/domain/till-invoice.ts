import { err, Money, ok, type Result } from '@hakorem/kernel';

/**
 * A customer paying an invoice in cash at the till (the owner on A-212 (a): cash enters only through a till shift; A-285
 * (g)): an issued invoice of the till's branch with something outstanding, paid in part or whole, never beyond what is
 * outstanding; what was handed over beyond it is change. The shift and the cashier are judged by the till's own rules
 * (`tillTakesCash`, ADR-0077) and by PAY under the shift's lock.
 */
export type TillInvoiceRefusal = 'AMOUNT_NOT_POSITIVE' | 'NOT_AN_INVOICE' | 'INVOICE_NOT_ISSUED' | 'INVOICE_OTHER_BRANCH' | 'INVOICE_SETTLED' | 'AMOUNT_EXCEEDS_OUTSTANDING' | 'TENDERED_BELOW_AMOUNT';

export interface TillInvoiceFacts {
  readonly document: { readonly kind: string; readonly status: 'DRAFT' | 'ISSUED'; readonly branchId: string; readonly outstandingPesewas: bigint };
  /** The till's branch. */
  readonly branchId: string;
  readonly amount: Money;
  /** What the customer handed over; null when exactly the amount. */
  readonly tendered: Money | null;
}

export interface TillInvoicePlan {
  readonly change: Money;
  readonly outstandingAfter: Money;
}

export function judgeTillInvoicePayment(f: TillInvoiceFacts): Result<TillInvoicePlan, TillInvoiceRefusal[]> {
  if (f.amount.compareTo(Money.zero()) <= 0) return err(['AMOUNT_NOT_POSITIVE']);
  if (f.document.kind !== 'INVOICE') return err(['NOT_AN_INVOICE']);
  if (f.document.status !== 'ISSUED') return err(['INVOICE_NOT_ISSUED']);
  if (f.document.branchId !== f.branchId) return err(['INVOICE_OTHER_BRANCH']);
  const outstanding = Money.ofPesewas(f.document.outstandingPesewas);
  if (outstanding.compareTo(Money.zero()) <= 0) return err(['INVOICE_SETTLED']);
  if (f.amount.compareTo(outstanding) > 0) return err(['AMOUNT_EXCEEDS_OUTSTANDING']);
  const tendered = f.tendered ?? f.amount;
  if (tendered.compareTo(f.amount) < 0) return err(['TENDERED_BELOW_AMOUNT']);
  return ok({ change: tendered.minus(f.amount), outstandingAfter: outstanding.minus(f.amount) });
}
