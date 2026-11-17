import { err, formatCedis, ok, toBusinessDate, type Result } from '@hakorem/kernel';

/**
 * The remittance advice of a paid supplier payment (FR-PUR-013, A-174): each invoice it pays, with the invoice's
 * gross, the credits approved against it, the amount this payment puts on it and what is left after. Pure. The data is
 * fixed once, when the payment is marked paid; DOC renders and archives it after commit (B08 continued 2c), NTF sends
 * it (B11).
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

/** What the advice prints: the stored remittance, the payment's number and the names as they stand when it is paid. */
export interface PrintableRemittance {
  readonly supplierPaymentId: string;
  /** The payment's SPY number (A-205, B09x); null only on a payment marked paid before 0207, whose advice quotes its id. */
  readonly paymentNo: string | null;
  readonly paidAt: Date;
  readonly method: 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';
  readonly payeeMasked: string | null;
  readonly externalReference: string;
  readonly supplierName: string;
  readonly branch: { readonly code: string; readonly name: string };
  readonly amountPesewas: bigint;
  readonly lines: readonly RemittanceLine[];
}

/**
 * The advice's render data (ADR-0062): every amount formatted from its integer pesewas, the paid date as the business
 * date in Africa/Accra. The template never computes; the total printed is the payment's own amount.
 */
export function remittanceRenderData(r: PrintableRemittance): Record<string, unknown> {
  return {
    title: 'Remittance advice',
    paymentNo: r.paymentNo ?? r.supplierPaymentId,
    paidDate: toBusinessDate(r.paidAt),
    method: r.method,
    payee: r.payeeMasked,
    externalReference: r.externalReference,
    supplier: { name: r.supplierName },
    branch: { code: r.branch.code, name: r.branch.name },
    amount: formatCedis(r.amountPesewas),
    lines: r.lines.map((l) => ({
      supplierInvoiceNo: l.supplierInvoiceNo,
      invoiceDate: l.invoiceDate,
      gross: formatCedis(l.grossPesewas),
      credited: formatCedis(l.creditedPesewas),
      amount: formatCedis(l.amountPesewas),
      outstandingAfter: formatCedis(l.outstandingAfterPesewas),
    })),
  };
}
