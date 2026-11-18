import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BillingKind, LineKind } from '../domain/billing';

export const BILLING_STORE = Symbol('BILLING_STORE');

/** One levy row of a line, a snapshot of the scheme version used (ADR-0020). */
export interface LevyRecord {
  readonly levyId: string;
  readonly levyCode: string;
  readonly levyName: string;
  readonly treatment: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT' | 'OUT_OF_SCOPE';
  readonly ratePercent: string;
  readonly basePesewas: bigint;
  readonly amountPesewas: bigint;
  readonly calcOrder: number;
}

export interface LineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly lineKind: LineKind;
  readonly productId: string | null;
  readonly description: string;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly orderLineRef: string | null;
  readonly creditsLineId: string | null;
  /** Decimal string, three places. */
  readonly qty: string;
  readonly uom: string;
  readonly weightKg: string | null;
  readonly unitPricePesewas: bigint;
  readonly resolvedUnitPricePesewas: bigint;
  readonly discountPesewas: bigint;
  readonly taxCategoryId: string;
  readonly lineNetPesewas: bigint;
  readonly lineTaxPesewas: bigint;
  readonly lineGrossPesewas: bigint;
  readonly glGroup: string;
  readonly levies: readonly LevyRecord[];
}

/** What a new document is written with, as a draft. */
export interface DraftHeader {
  readonly id: string;
  readonly kind: BillingKind;
  readonly branchId: string;
  readonly provisionalRef: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly customerTin: string | null;
  readonly billingAddress: string | null;
  readonly orderDocumentId: string | null;
  readonly originalDocumentId: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly taxInclusive: boolean;
  readonly taxSchemeVersionId: string;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly occurredAt: Date | null;
  /** A receipt for a sale an offline till synced later, issued at the till's time (A-278 (d)); false when absent. */
  readonly syncedFromOffline?: boolean;
  readonly actorId: string;
}

export interface DocumentRecord extends Omit<DraftHeader, 'actorId'> {
  readonly status: 'DRAFT' | 'ISSUED';
  readonly documentNo: string | null;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly certification: { readonly taxPesewas: bigint; readonly grossPesewas: bigint; readonly reference: string } | null;
  readonly approvalRequestId: string | null;
  readonly contentHash: Buffer | null;
  readonly archivedDocumentId: string | null;
  readonly issuedAt: Date | null;
  readonly createdBy: string;
  readonly version: number;
  readonly lines: readonly LineRecord[];
}

export interface SettlementRecord {
  readonly allocatedPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly outstandingPesewas: bigint;
  /** Refunds asked for against its credit notes (or, on a credit note, against it) and not rejected (ADR-0066). */
  readonly refundedPesewas: bigint;
  /** What an invoice or receipt owes back to the customer once credited beyond what it had outstanding; 0 on a credit note. */
  readonly refundablePesewas: bigint;
  readonly paymentStatus: 'UNPAID' | 'PART_PAID' | 'PAID' | 'CREDITED' | 'NOT_APPLICABLE';
  readonly settledAt: Date | null;
  readonly asOf: Date;
}

export interface DocumentFilter {
  readonly branchIds: readonly string[];
  readonly kind: BillingKind | null;
  readonly customerId: string | null;
  readonly orderId: string | null;
  readonly documentNo: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly paymentStatus: SettlementRecord['paymentStatus'] | null;
}

export interface BillingStore {
  insertDraft(tx: Transaction, header: DraftHeader, lines: readonly LineRecord[]): Promise<void>;
  /** Issues a draft with its number and totals; the database checks them at commit. */
  issue(tx: Transaction, id: string, issue: { readonly documentNo: string; readonly netPesewas: bigint; readonly taxPesewas: bigint; readonly grossPesewas: bigint; readonly issueDate: string; readonly dueDate: string | null; readonly issuedAt: Date; readonly actorId: string }): Promise<void>;
  markPending(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void>;
  documents(tx: Transaction, ids: readonly string[], forUpdate?: boolean): Promise<DocumentRecord[]>;
  /** What issued credit notes already took off each original line, in the original's anchor terms (net or gross). */
  creditedAnchors(tx: Transaction, originalLineIds: readonly string[], taxInclusive: boolean): Promise<ReadonlyMap<string, bigint>>;
  settlements(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, SettlementRecord>>;
  /** Issued invoices, receipts and debit notes with something outstanding, newest first below `beforeId`, and their total. */
  openItems(tx: Transaction, filter: OpenItemFilter, beforeId: string | null, limit: number): Promise<{ readonly rows: OpenItemRecord[]; readonly totalOutstandingPesewas: bigint }>;
  /** Ids of matching documents, newest first, after the given id. */
  list(tx: Transaction, filter: DocumentFilter, afterId: string | null, limit: number): Promise<string[]>;
  /** Sets the archived rendering and its content hash once, after DOC has archived it (B08 continued 2b). */
  linkArchive(tx: Transaction, id: string, archivedDocumentId: string, contentHash: Buffer): Promise<boolean>;
  reprintCounts(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Writes the next copy number of a document's reprint log and returns it (`ck_reprint_log_copy_no`). */
  appendReprint(tx: Transaction, reprint: { readonly id: string; readonly billingDocumentId: string; readonly channel: ReprintRecord['channel']; readonly actorId: string; readonly at: Date }): Promise<number>;
  reprints(tx: Transaction, billingDocumentId: string, afterCopyNo: number | null, limit: number): Promise<ReprintRecord[]>;
  /** Every issued document's number, hash and archive, for the nightly numbering audit (FR-BIL-003). */
  issuedForAudit(tx: Transaction): Promise<{ readonly id: string; readonly documentNo: string; readonly contentHash: Buffer | null; readonly archivedDocumentId: string | null; readonly issuedAt: Date }[]>;
}

export interface ReprintRecord {
  readonly copyNo: number;
  readonly channel: 'THERMAL' | 'PDF' | 'SMS' | 'WHATSAPP' | 'EMAIL';
  readonly actorId: string;
  readonly recordedAt: Date;
}

export interface OpenItemFilter {
  readonly branchIds: readonly string[];
  readonly customerId: string | null;
  /** Only documents due before this business date. */
  readonly overdueBefore: string | null;
}

export interface OpenItemRecord {
  readonly id: string;
  readonly kind: string;
  readonly documentNo: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly grossPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly allocatedPesewas: bigint;
  readonly outstandingPesewas: bigint;
}
