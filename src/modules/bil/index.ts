/**
 * BIL's public door (MODULE_BOUNDARIES, BIL card). `Billing` is the `Billing` interface: `issueIn` (an invoice, receipt
 * or proforma in the caller's serializable transaction, with `seriesLocksFor` to name its locks), credit and debit
 * notes, and the reads. Published view: `bil.pub_document`. Events are in `events.ts`.
 */
export { BilModule } from './bil.module';
export { BillingNumberingAudit, type NumberingAuditReport } from './application/numbering-audit';
export { Billing, type BillingDocumentView, type CreditPreview, type IssueLineRequest, type IssueRequest, type SettleableDocument } from './application/billing';
export type { OpenItemRecord, ReceivableAsAtRecord } from './application/billing-store';
export { AllocationExceedsOutstandingError } from './application/errors';
export type { BillingLinePayload, BillingDocumentPayload, CreditNoteIssued, DebitNoteIssued, InvoiceIssued, ProformaIssued } from './events';
export { buyerVerdict, isGhanaTin, maskTin, type BuyerDetails, type BuyerRule, type BuyerVerdict } from './domain/buyer';
