import { err, ok, type Result } from '@hakorem/kernel';

/**
 * The remittance advice of a paid supplier payment (FR-PUR-013, A-174): each invoice it pays, with the invoice's
 * gross, the credits approved against it, the amount this payment puts on it and what is left after. Pure. The data is
 * fixed once, when the payment is marked paid; rendering, archiving and sending it wait for B8 and B11.
 */
export interface RemittanceInput {
  readonly supplierInvoiceId: string;
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly grossPesewas: bigint;
  readonly creditedPesewas: bigint;
  /** What the invoice has been paid in all, this payment included. */
  readonly paidAfterPesewas: bigint;
  /** What this payment puts on the invoice. */
  readonly amountPesewas: bigint;
}

export interface RemittanceLine {
  readonly supplierInvoiceId: string;
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly grossPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly amountPesewas: bigint;
  readonly outstandingAfterPesewas: bigint;
}

/** The advice's lines, which add up to the payment exactly, or the refusal. */
export function remittanceLines(paymentPesewas: bigint, allocations: readonly RemittanceInput[]): Result<RemittanceLine[], 'NO_INVOICES' | 'LINES_DIFFER_FROM_PAYMENT'> {
  if (allocations.length === 0) return err('NO_INVOICES');
  if (allocations.reduce((sum, a) => sum + a.amountPesewas, 0n) !== paymentPesewas) return err('LINES_DIFFER_FROM_PAYMENT');
  return ok(
    allocations.map((a) => ({
      supplierInvoiceId: a.supplierInvoiceId,
      supplierInvoiceNo: a.supplierInvoiceNo,
      invoiceDate: a.invoiceDate,
      grossPesewas: a.grossPesewas,
      creditedPesewas: a.creditedPesewas,
      amountPesewas: a.amountPesewas,
      outstandingAfterPesewas: a.grossPesewas - a.creditedPesewas - a.paidAfterPesewas,
    })),
  );
}
