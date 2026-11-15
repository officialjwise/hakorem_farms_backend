/**
 * Events PUR publishes (docs/DOMAIN_MODEL.md section 5.7). Types only: subscribers import them with `import type`.
 * Those marked ◆ post to the ledger: B8 subscribes and posts them (FR-PUR-015); until then they wait in the outbox.
 * Amounts are integer pesewas.
 */

/** `pur.PurchaseOrderApproved` v1: an order was approved, on submit within the limit or by a second person above it. */
export interface PurchaseOrderApproved {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly grossPesewas: number;
  /** Null when the order was within the limit and approved on submit. */
  readonly approvalRequestId: string | null;
  readonly expectedOn: string | null;
}

/** `pur.PurchaseOrderSent` v1: an approved order went to its supplier; NTF delivers it on the channels asked (B11). */
export interface PurchaseOrderSent {
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly channels: readonly ('EMAIL' | 'WHATSAPP')[];
  readonly recipient: string | null;
  readonly grossPesewas: number;
}

/** `pur.SupplierInvoiceMismatched` v1: the three-way match failed; the daily exception report reads it (B12). */
export interface SupplierInvoiceMismatched {
  readonly supplierInvoiceId: string;
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  readonly purchaseOrderId: string | null;
  readonly grossPesewas: number;
  readonly lines: readonly { readonly lineNo: number; readonly reasons: readonly string[] }[];
}

/** One invoice line as the ledger posts it: what it costs at the order price, and what the supplier charged. */
export interface PurchasePostingLine {
  readonly lineNo: number;
  readonly productId: string | null;
  readonly purchaseOrderLineId: string | null;
  readonly expenseCategory: string | null;
  readonly taxCategoryId: string;
  readonly netPesewas: number;
  /** The invoiced quantity at the order line's price, rounded half-up once: what the receipt booked to 2010. Null without an order line. */
  readonly orderValuePesewas: number | null;
}

/** A levy row as the ledger posts it (ADR-0020): reclaimable to 1400, otherwise into the cost. */
export interface PurchasePostingLevy {
  readonly lineNo: number;
  readonly levyId: string;
  readonly levyCode: string;
  readonly amountPesewas: number;
  readonly isReclaimable: boolean;
}

/**
 * ◆ `pur.SupplierInvoiceMatched` v1 (an invoice against an order) and ◆ `pur.ExpenseInvoiceApproved` v1 (an invoice with
 * no order), published when the invoice is approved for payment. B8 clears 2010 at each line's order value, posts the
 * difference to purchase price variance (5140), credits 2000 with the supplier as subledger and debits 1400 for
 * reclaimable levies (FR-PUR-015).
 */
export interface SupplierInvoiceApproved {
  readonly supplierInvoiceId: string;
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  readonly purchaseOrderId: string | null;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly lines: readonly PurchasePostingLine[];
  readonly levies: readonly PurchasePostingLevy[];
}

/** ◆ `pur.SupplierPaymentMade` v1: an approved payment left the farm; B8 debits 2000 and credits the bank or cash account. */
export interface SupplierPaymentMade {
  readonly supplierPaymentId: string;
  readonly supplierId: string;
  readonly method: 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';
  readonly amountPesewas: number;
  readonly paidAt: string;
  readonly approvalRequestId: string;
  readonly allocations: readonly { readonly supplierInvoiceId: string; readonly amountPesewas: number }[];
}
