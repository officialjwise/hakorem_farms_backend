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

/**
 * `pur.SupplierClaimRaised` v1 (ADR-0076, CR-036): a claim was raised from a posted goods receipt's rejected lines, at
 * the order price, never keyed. It moves no stock and posts nothing. The daily exception report (B12) reads it under
 * `RECEIPT_CLAIM` (THREAT_MODEL abuse case 34: rejections inflated at the door), with who received the goods, who
 * raised the claim, the reasons and each line's rejected share.
 */
export interface SupplierClaimRaised {
  readonly supplierClaimId: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string;
  readonly goodsReceiptId: string;
  readonly receivedBy: string;
  readonly raisedBy: string;
  readonly claimedPesewas: number;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly productId: string;
    readonly rejectionReasonCode: string;
    readonly qtyAcceptedBase: string;
    readonly qtyRejectedBase: string;
    readonly claimedValuePesewas: number;
  }[];
  readonly abuseCases: readonly number[];
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
  /**
   * The approved variance it was approved on (FR-PUR-010, A-172), or null for an invoice that matched. B8 posts the
   * price above the order to purchase price variance (5140) the same way; the exception report reads it (B12).
   */
  readonly varianceApprovalRequestId: string | null;
}

/**
 * ◆ `pur.SupplierCreditNoteApproved` v1 (FR-PUR-011, A-172): a second person approved a supplier credit note, which
 * reduced what its invoice is owed. B8 debits trade payables (2000) with the supplier as subledger, reverses the
 * reclaimable levies from 1400 and credits the purchase side; goods sent back are INV's `inv.SupplierReturnIssued`
 * movements, at their cost, named here so B8 can post the difference between credit and cost.
 */
export interface SupplierCreditNoteApproved {
  readonly creditNoteId: string;
  readonly originalInvoiceId: string;
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  readonly invoiceDate: string;
  readonly purchaseOrderId: string | null;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly approvalRequestId: string;
  readonly lines: readonly PurchasePostingLine[];
  readonly levies: readonly PurchasePostingLevy[];
  readonly returns: readonly { readonly lineNo: number; readonly movementId: string; readonly productId: string; readonly qty: string; readonly costPesewas: number }[];
}

/**
 * `pur.SupplierRemittanceReady` v1 (FR-PUR-013, A-174): a payment was marked paid and its remittance advice data is
 * fixed, once. DOC renders and archives it (B8) and NTF sends it to the supplier (B11), each once per payment.
 */
export interface SupplierRemittanceReady {
  readonly remittanceId: string;
  readonly supplierPaymentId: string;
  readonly supplierId: string;
  readonly amountPesewas: number;
  readonly paidAt: string;
  readonly externalReference: string;
}

/**
 * ◆ `pur.SupplierPaymentMade` v1: an approved payment left the farm; FIN debits 2000 and credits the bank or cash
 * account. `bankAccountId` (added in B08 continued 1b2, optional, so v1 is unchanged for readers) names the farm's own
 * account it left from, whose subledger party FIN posts to; null or absent posts as A-185 says.
 */
export interface SupplierPaymentMade {
  readonly supplierPaymentId: string;
  readonly supplierId: string;
  readonly method: 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';
  readonly bankAccountId?: string | null;
  readonly amountPesewas: number;
  readonly paidAt: string;
  readonly approvalRequestId: string;
  readonly allocations: readonly { readonly supplierInvoiceId: string; readonly amountPesewas: number }[];
}

/**
 * `pur.SupplierPayoutChangeRequested` v1: someone asked to change where a supplier is paid (FR-PUR-002). Nothing is in
 * force yet. The payout change report and the daily exception report (`PAYOUT_DETAIL_CHANGE`, THREAT_MODEL case 13)
 * read it (B12). Only masked details travel.
 */
export interface SupplierPayoutChangeRequested {
  readonly payoutChangeId: string;
  readonly supplierId: string;
  readonly approvalRequestId: string;
  readonly method: 'BANK' | 'MOBILE_MONEY' | 'CASH' | 'CHEQUE';
  /** The details in force when the change was asked for, masked; null when none were. */
  readonly previousPayoutMasked: string | null;
  readonly payoutMasked: string;
  readonly requestedBy: string;
  readonly abuseCase: number;
}

/** `pur.SupplierPayoutChanged` v1: a different person approved the change and the new details are in force. */
export interface SupplierPayoutChanged extends SupplierPayoutChangeRequested {
  readonly approvedBy: string;
}

/** `pur.RequisitionSubmitted` v1: a requisition waits for a manager to reject or convert it (FR-PUR-004). */
export interface RequisitionSubmitted {
  readonly requisitionId: string;
  readonly requestedBy: string;
  readonly locationId: string | null;
  readonly neededBy: string | null;
  readonly lines: readonly { readonly productId: string; readonly qty: string }[];
}
