import type { Transaction } from '../../../platform/database/unit-of-work';
import type { Direction, ResolutionPosting } from '../domain/reconciliation';

export const RECONCILIATION_STORE = Symbol('RECONCILIATION_STORE');

export type SettlementStatus = 'IMPORTED' | 'MATCHED' | 'POSTED' | 'HAS_BREAKS';
export type SettlementLineStatus = 'UNMATCHED' | 'MATCHED' | 'AMOUNT_DIFFERS' | 'NOT_FOUND';
export type StatementStatus = 'IMPORTED' | 'RECONCILED' | 'HAS_BREAKS';

export interface SettlementReportRecord {
  readonly id: string;
  readonly provider: string;
  readonly settlementRef: string;
  readonly settledOn: string;
  readonly bankAccountId: string;
  readonly grossPesewas: bigint;
  readonly feePesewas: bigint;
  readonly netPesewas: bigint;
  readonly status: SettlementStatus;
  readonly branchId: string;
}

export interface SettlementLineRecord {
  readonly id: string;
  readonly settlementReportId: string;
  readonly lineNo: number;
  readonly provider: string;
  readonly providerReference: string;
  readonly amountPesewas: bigint;
  readonly feePesewas: bigint;
  readonly matchedPaymentId: string | null;
  readonly matchedPaymentNo: string | null;
  readonly matchStatus: SettlementLineStatus;
  readonly matchReason: string | null;
}

export interface StatementRecord {
  readonly id: string;
  readonly bankAccountId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingPesewas: bigint;
  readonly closingPesewas: bigint;
  readonly status: StatementStatus;
  readonly branchId: string;
}

export interface StatementLineRecord {
  readonly id: string;
  readonly bankStatementId: string;
  readonly lineNo: number;
  readonly bankAccountId: string;
  readonly valueDate: string;
  readonly direction: Direction;
  readonly amountPesewas: bigint;
  readonly balancePesewas: bigint;
  readonly narration: string | null;
  readonly bankReference: string | null;
  readonly matchedPaymentId: string | null;
  readonly matchedJournalEntryRef: string | null;
  readonly matchStatus: 'MATCHED' | 'UNMATCHED';
  readonly branchId: string;
}

/** A provider payment by its reference, as settlement matching reads it. */
export interface ProviderPaymentRecord {
  readonly id: string;
  readonly status: string;
  readonly provider: string | null;
  readonly amountPesewas: bigint;
  readonly alreadySettled: boolean;
}

/** A bank transfer still pending into a bank account: a statement line's automatic candidate. */
export interface PendingTransferRecord {
  readonly id: string;
  readonly externalReference: string | null;
  readonly amountPesewas: bigint;
}

/** A settlement report already posted whose payout no statement line has matched yet. */
export interface PayoutRecord {
  readonly settlementReportId: string;
  readonly settlementRef: string;
  readonly netPesewas: bigint;
}

export interface BreakRecord {
  readonly id: string;
  readonly kind: string;
  readonly branchId: string | null;
  readonly paymentId: string | null;
  readonly paymentNo: string | null;
  readonly refundId: string | null;
  readonly provider: string | null;
  readonly reference: string | null;
  readonly sourceDocumentId: string | null;
  readonly settlementLineId: string | null;
  readonly bankStatementLineId: string | null;
  readonly amountPesewas: bigint | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: Date;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolutionNote: string | null;
}

export interface ResolutionRecord {
  readonly id: string;
  readonly breakId: string;
  readonly posting: ResolutionPosting;
  readonly note: string;
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly approvalRequestId: string | null;
  readonly branchId: string;
  readonly createdBy: string;
}

export interface BreakFilter {
  readonly status: 'OPEN' | 'RESOLVED' | null;
  readonly kind: string | null;
  /** The branches the reader may see; a break no branch is known for is held by the head office. */
  readonly branchIds: readonly string[];
  readonly headOfficeBranchId: string | null;
}

/** PAY's reconciliation tables (ADR-0065). Statements run in the caller's transaction; nothing here authorises. */
export interface ReconciliationStore {
  settlementByFileOrRef(tx: Transaction, provider: string, sha256: Buffer, settlementRef: string): Promise<string | null>;
  insertSettlement(
    tx: Transaction,
    r: SettlementReportRecord & { readonly fileId: string; readonly sha256: Buffer },
    lines: readonly Omit<SettlementLineRecord, 'matchedPaymentId' | 'matchedPaymentNo' | 'matchStatus' | 'matchReason'>[],
    actorId: string,
  ): Promise<void>;
  settlement(tx: Transaction, id: string, forUpdate: boolean): Promise<SettlementReportRecord | null>;
  settlements(tx: Transaction, filter: { readonly status: string | null; readonly from: string | null; readonly to: string | null; readonly branchIds: readonly string[] }, after: { readonly settledOn: string; readonly id: string } | null, limit: number): Promise<SettlementReportRecord[]>;
  settlementLines(tx: Transaction, reportIds: readonly string[]): Promise<SettlementLineRecord[]>;
  settlementLine(tx: Transaction, id: string): Promise<SettlementLineRecord | null>;
  /** The provider references any imported settlement line already carries. */
  settledReferences(tx: Transaction, provider: string, references: readonly string[]): Promise<ReadonlySet<string>>;
  providerPayments(tx: Transaction, provider: string, references: readonly string[]): Promise<ReadonlyMap<string, ProviderPaymentRecord>>;
  markSettlementLine(tx: Transaction, id: string, change: { readonly status: SettlementLineStatus; readonly reason: string | null; readonly paymentId: string | null }, actorId: string): Promise<void>;
  markSettlement(tx: Transaction, id: string, status: SettlementStatus, at: Date, actorId: string): Promise<void>;

  statementByFileOrPeriod(tx: Transaction, bankAccountId: string, sha256: Buffer, period: { readonly start: string; readonly end: string }): Promise<string | null>;
  insertStatement(
    tx: Transaction,
    r: StatementRecord & { readonly fileId: string; readonly sha256: Buffer },
    lines: readonly Omit<StatementLineRecord, 'matchedPaymentId' | 'matchedJournalEntryRef' | 'matchStatus'>[],
    actorId: string,
  ): Promise<void>;
  statement(tx: Transaction, id: string, forUpdate: boolean): Promise<StatementRecord | null>;
  statements(tx: Transaction, filter: { readonly bankAccountId: string | null; readonly status: string | null; readonly branchIds: readonly string[] }, after: { readonly periodEnd: string; readonly id: string } | null, limit: number): Promise<StatementRecord[]>;
  statementLines(tx: Transaction, statementIds: readonly string[]): Promise<StatementLineRecord[]>;
  statementLine(tx: Transaction, id: string, forUpdate: boolean): Promise<StatementLineRecord | null>;
  pendingTransfers(tx: Transaction, bankAccountId: string): Promise<PendingTransferRecord[]>;
  pendingTransfer(tx: Transaction, paymentId: string): Promise<(PendingTransferRecord & { readonly methodKind: string; readonly status: string; readonly bankAccountId: string | null; readonly branchId: string; readonly customerId: string | null; readonly orderDocumentId: string | null; readonly receivedAt: Date }) | null>;
  payouts(tx: Transaction, bankAccountId: string): Promise<PayoutRecord[]>;
  lineMatching(tx: Transaction, target: { readonly paymentId: string } | { readonly journalEntryId: string }): Promise<boolean>;
  markLineMatched(tx: Transaction, id: string, match: { readonly paymentId: string } | { readonly journalEntryId: string }, at: Date, actorId: string): Promise<void>;
  markStatement(tx: Transaction, id: string, status: StatementStatus, actorId: string): Promise<void>;
  clearTransfer(tx: Transaction, paymentId: string, at: Date, actorId: string): Promise<void>;

  breaks(tx: Transaction, filter: BreakFilter, after: { readonly raisedAt: Date; readonly id: string } | null, limit: number): Promise<BreakRecord[]>;
  break(tx: Transaction, id: string, forUpdate: boolean): Promise<BreakRecord | null>;
  openResolutionOf(tx: Transaction, breakId: string): Promise<ResolutionRecord | null>;
  resolution(tx: Transaction, id: string): Promise<ResolutionRecord | null>;
  resolutionByApproval(tx: Transaction, approvalRequestId: string): Promise<ResolutionRecord | null>;
  insertResolution(tx: Transaction, r: { readonly id: string; readonly breakId: string; readonly posting: ResolutionPosting; readonly note: string; readonly branchId: string; readonly createdBy: string }): Promise<void>;
  updateResolution(tx: Transaction, id: string, change: { readonly approvalRequestId?: string; readonly status?: 'APPROVED' | 'REJECTED' }, actorId: string): Promise<void>;
  resolveBreak(tx: Transaction, id: string, note: string, at: Date, actorId: string): Promise<void>;

  /** An unverified offline mobile money tender, as its break's resolution reads it (A-282); null for any other payment. */
  unverifiedTender(tx: Transaction, paymentId: string, forUpdate: boolean): Promise<UnverifiedTenderRecord | null>;
  /** The tender's move to the wallet: one row per payment, break and resolution (`pay.unverified_verification`). */
  insertVerification(tx: Transaction, r: { readonly id: string; readonly paymentId: string; readonly breakId: string; readonly resolutionId: string; readonly branchId: string; readonly amountPesewas: bigint; readonly verifiedOn: string; readonly recordedAt: Date; readonly actorId: string }): Promise<void>;
  /** Open `UNVERIFIED_PAYMENT` breaks whose tender still waits and whose window ended at or before `at`, not yet raised URGENT. */
  overdueUnverified(tx: Transaction, at: Date, limit: number): Promise<OverdueUnverifiedRecord[]>;
  /** Raises one overdue break once (`pay.unverified_overdue`); false when it was already raised. */
  insertOverdue(tx: Transaction, r: { readonly id: string; readonly breakId: string; readonly paymentId: string; readonly branchId: string; readonly amountPesewas: bigint; readonly urgentFrom: Date; readonly recordedAt: Date; readonly actorId: string }): Promise<boolean>;
}

export interface UnverifiedTenderRecord {
  readonly paymentId: string;
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly amountPesewas: bigint;
  readonly bankAccountId: string | null;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly verified: boolean;
}

export interface OverdueUnverifiedRecord {
  readonly breakId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly amountPesewas: bigint;
  readonly urgentFrom: Date;
  readonly reference: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}
