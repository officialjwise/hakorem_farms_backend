/*
 * BIL's published events (docs/DOMAIN_MODEL.md section 5.8). Other modules import these as types only. The three ◆
 * events post to the ledger in the issuing transaction (ADR-0003, ADR-0056); FIN reads them by the fields below.
 * Amounts are JSON integers of pesewas; a line's price variance is signed (above zero, agreed below resolved).
 */

export interface BillingLinePayload {
  readonly lineNo: number;
  readonly lineKind: 'PRODUCT' | 'DELIVERY_FEE' | 'ADJUSTMENT';
  readonly productId: string | null;
  readonly glGroup: string;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly discountPesewas: number;
  readonly priceVariancePesewas: number;
  readonly stockUnitId: string | null;
}

export interface BillingLevyPayload {
  readonly lineNo: number;
  readonly levyId: string;
  readonly levyCode: string;
  readonly amountPesewas: number;
}

/** The fields every billing document event carries. */
export interface BillingDocumentPayload {
  readonly billingDocumentId: string;
  readonly kind: 'PROFORMA' | 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  readonly documentNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly originalDocumentId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly taxInclusive: boolean;
  readonly taxSchemeVersionId: string;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly lines: readonly BillingLinePayload[];
  readonly levies: readonly BillingLevyPayload[];
}

/** ◆ An invoice or a receipt was issued (a RECEIPT posts as an invoice). NTF sends it; FIN posts it. */
export interface InvoiceIssued extends BillingDocumentPayload {
  readonly kind: 'INVOICE' | 'RECEIPT';
}

/** ◆ A credit note was issued against an invoice or receipt, after its approval. */
export interface CreditNoteIssued extends BillingDocumentPayload {
  readonly kind: 'CREDIT_NOTE';
  readonly reasonCode: string;
  readonly approvalRequestId: string | null;
  /** The abuse cases the daily exception report reads this for (THREAT_MODEL case 31). */
  readonly abuseCases: readonly number[];
}

/** ◆ A debit note added a charge to an invoice or receipt. */
export interface DebitNoteIssued extends BillingDocumentPayload {
  readonly kind: 'DEBIT_NOTE';
  readonly reasonCode: string;
}

/** A proforma was issued: no stock, no ledger (FR-BIL-006). */
export interface ProformaIssued extends BillingDocumentPayload {
  readonly kind: 'PROFORMA';
}

/**
 * `bil.DocumentSendRequested` v1 (B11 continued 13, ADR-0062, ADR-0099): an issued, archived billing document was asked
 * to be sent to its own customer, logged as a copy (`bil.reprint_log`, `sendId`, `copyNo`). NTF queues one message from
 * it, to the customer's own address read through MDM when it is sent, never from this event, which carries no address.
 */
export interface DocumentSendRequested {
  readonly sendId: string;
  readonly billingDocumentId: string;
  readonly copyNo: number;
  readonly channels: readonly ('SMS' | 'WHATSAPP' | 'EMAIL')[];
}
