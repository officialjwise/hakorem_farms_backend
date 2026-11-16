import { err, ok, type Result } from '@hakorem/kernel';

/**
 * Supplier credit notes (FR-PUR-011, A-172). Pure: amounts are integer pesewas. A credit note names the approved
 * invoice it reduces and never takes more than that invoice has left: its gross less the credit notes still alive
 * against it (any not cancelled, so one waiting for approval already counts) and less what live payments promise it.
 * The database holds the same cap on its own rows (`ck_supplier_credit_note_cap`, migration 0107).
 */
export type CreditRefusal = 'CREDIT_EMPTY' | 'CREDIT_EXCEEDS_UNCREDITED';

export interface CreditHeadroom {
  readonly grossPesewas: bigint;
  /** The gross of every credit note against the invoice that is not cancelled, approved or waiting. */
  readonly liveCreditsPesewas: bigint;
  /** What live payments (not rejected or cancelled) allocate to the invoice. */
  readonly promisedPesewas: bigint;
}

/** A credit of `creditPesewas` against the invoice: what is left payable after it, or the refusal. */
export function judgeCreditNote(invoice: CreditHeadroom, creditPesewas: bigint): Result<bigint, CreditRefusal> {
  if (creditPesewas <= 0n) return err('CREDIT_EMPTY');
  const left = invoice.grossPesewas - invoice.liveCreditsPesewas - invoice.promisedPesewas;
  return creditPesewas <= left ? ok(left - creditPesewas) : err('CREDIT_EXCEEDS_UNCREDITED');
}

export interface Settlement {
  readonly grossPesewas: bigint;
  /** The gross of the approved credit notes against it. */
  readonly creditedPesewas: bigint;
  readonly paidPesewas: bigint;
}

/** What an invoice still has to be paid: its gross less approved credits and payments made. */
export function invoicePayable(invoice: Settlement): bigint {
  return invoice.grossPesewas - invoice.creditedPesewas - invoice.paidPesewas;
}

/** An approved invoice is PAID once a payment was made and payments and credits together reach its gross. */
export function settledStatus(invoice: Settlement): 'APPROVED' | 'PAID' {
  return invoice.paidPesewas > 0n && invoicePayable(invoice) === 0n ? 'PAID' : 'APPROVED';
}

export type CreditTargetRefusal = 'ORIGINAL_NOT_AN_INVOICE' | 'ORIGINAL_NOT_APPROVED' | 'ORIGINAL_SETTLED' | 'ORIGINAL_OF_ANOTHER_SUPPLIER' | 'ORDER_DIFFERS' | 'BRANCH_DIFFERS';

export interface CreditTarget {
  readonly kind: 'INVOICE' | 'CREDIT_NOTE';
  readonly status: 'DRAFT' | 'MATCHED' | 'MISMATCH' | 'APPROVED' | 'PAID' | 'CANCELLED';
  readonly supplierId: string;
  readonly purchaseOrderId: string | null;
  readonly branchId: string;
}

/**
 * Whether a credit note may reduce this invoice: an approved invoice (one not yet approved is corrected instead, and a
 * paid one has nothing left to reduce: a refund from the supplier waits for the ledger, B8) of the credit's supplier,
 * on the same order and branch when the credit names them.
 */
export function judgeCreditTarget(
  original: CreditTarget,
  credit: { readonly supplierId: string; readonly purchaseOrderId: string | null; readonly branchId: string | null },
): Result<void, CreditTargetRefusal> {
  if (original.kind !== 'INVOICE') return err('ORIGINAL_NOT_AN_INVOICE');
  if (original.status === 'PAID') return err('ORIGINAL_SETTLED');
  if (original.status !== 'APPROVED') return err('ORIGINAL_NOT_APPROVED');
  if (original.supplierId !== credit.supplierId) return err('ORIGINAL_OF_ANOTHER_SUPPLIER');
  if (credit.purchaseOrderId !== null && credit.purchaseOrderId !== original.purchaseOrderId) return err('ORDER_DIFFERS');
  if (credit.branchId !== null && credit.branchId !== original.branchId) return err('BRANCH_DIFFERS');
  return ok(undefined);
}
