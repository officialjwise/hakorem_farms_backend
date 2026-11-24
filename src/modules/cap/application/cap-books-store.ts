import type { Transaction } from '../../../platform/database/unit-of-work';
import type { InvestorRecord } from './cap-store';

export const CAP_BOOKS_STORE = Symbol('CAP_BOOKS_STORE');

/** A `cap.investor_payout_change` row (DOCUMENT): the sealed details and their masked form. */
export interface PayoutChangeRecord {
  readonly id: string;
  readonly investorId: string;
  readonly method: 'BANK' | 'MOBILE_MONEY';
  readonly detailsEnc: Buffer;
  readonly masked: string;
  readonly last4: string;
  readonly approvalRequestId: string;
  readonly status: 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'CANCELLED';
  readonly branchId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A `cap.investor_document` row (MASTER). */
export interface InvestorDocumentRecord {
  readonly id: string;
  readonly investorId: string;
  readonly kind: 'AGREEMENT' | 'IDENTIFICATION' | 'STATEMENT' | 'DISTRIBUTION_SCHEDULE' | 'OTHER';
  readonly name: string;
  readonly fileId: string;
  readonly createdAt: Date;
}

/** One investor's line of a posted distribution run (the run's current computation). */
export interface InvestorLineRecord {
  readonly runId: string;
  readonly runNo: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly unitDaysE4: bigint;
  readonly allocatedPesewas: bigint;
  readonly withheldPesewas: bigint;
  readonly netPayablePesewas: bigint;
  readonly paidPesewas: bigint;
  readonly runStatus: string;
  readonly postedAt: Date;
}

/** A payment to one investor against a distribution line. */
export interface InvestorPaymentRecord {
  readonly id: string;
  readonly runNo: string;
  readonly amountPesewas: bigint;
  readonly paidAt: Date;
}

/** A `cap.financing` row (DOCUMENT). */
export interface FinancingRecord {
  readonly id: string;
  readonly financingNo: string;
  readonly kind: 'LOAN' | 'GRANT';
  readonly lenderInvestorId: string | null;
  readonly lenderName: string;
  readonly principalPesewas: bigint;
  readonly annualRatePercent: string;
  readonly startDate: string;
  readonly termMonths: number | null;
  readonly bankAccountId: string;
  readonly agreementFileId: string | null;
  readonly approvalRequestId: string;
  readonly journalEntryId: string | null;
  readonly status: 'DRAFT' | 'ACTIVE' | 'SETTLED' | 'CANCELLED';
  readonly branchId: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface ScheduleLineRecord {
  readonly financingId: string;
  readonly instalmentNo: number;
  readonly dueDate: string;
  readonly principalDuePesewas: bigint;
  readonly interestDuePesewas: bigint;
}

/** A `cap.financing_accrual` row (LEDGER): a month's interest, or a month's part of a grant. */
export interface AccrualRecord {
  readonly id: string;
  readonly financingId: string;
  readonly kind: 'INTEREST' | 'RECOGNITION';
  readonly monthStart: string;
  readonly monthEnd: string;
  readonly amountPesewas: bigint;
  readonly journalEntryId: string | null;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** A `cap.financing_repayment` row (LEDGER). */
export interface RepaymentRecord {
  readonly id: string;
  readonly financingId: string;
  readonly principalPesewas: bigint;
  readonly interestPesewas: bigint;
  readonly bankAccountId: string;
  readonly externalReference: string | null;
  readonly paidAt: Date;
  readonly valueDate: string;
  readonly journalEntryId: string;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** CAP's tables built in B12 continued (migration 0359), and the investor's own reads. Parameterised SQL only. */
export interface CapBooksStore {
  investorByPrincipal(tx: Transaction, principalId: string): Promise<InvestorRecord | null>;
  sealIdNumber(tx: Transaction, investorId: string, sealed: Buffer, masked: string, by: string, at: Date): Promise<void>;
  setPortalLogin(tx: Transaction, investorId: string, principalId: string, by: string, at: Date): Promise<void>;
  setAgreement(tx: Transaction, investorId: string, fileId: string, by: string, at: Date): Promise<void>;
  /** The sealed columns, read only to reveal them to a holder of the payout permission. */
  sealedOf(tx: Transaction, investorId: string): Promise<{ readonly payoutEnc: Buffer | null; readonly payoutChangeId: string | null; readonly idNumberEnc: Buffer | null } | null>;

  insertPayoutChange(tx: Transaction, change: PayoutChangeRecord): Promise<void>;
  payoutChange(tx: Transaction, id: string): Promise<PayoutChangeRecord | null>;
  payoutChangeByApproval(tx: Transaction, approvalRequestId: string): Promise<PayoutChangeRecord | null>;
  pendingPayoutChange(tx: Transaction, investorId: string): Promise<PayoutChangeRecord | null>;
  decidePayoutChange(tx: Transaction, id: string, status: 'APPLIED' | 'REJECTED' | 'CANCELLED', by: string, at: Date): Promise<void>;
  applyPayout(tx: Transaction, change: PayoutChangeRecord, by: string, at: Date): Promise<void>;

  insertDocument(tx: Transaction, document: InvestorDocumentRecord, by: string): Promise<void>;
  documents(tx: Transaction, investorId: string, beforeId: string | null, limit: number): Promise<InvestorDocumentRecord[]>;
  document(tx: Transaction, investorId: string, id: string): Promise<InvestorDocumentRecord | null>;

  linesOfInvestor(tx: Transaction, investorId: string | null): Promise<InvestorLineRecord[]>;
  paymentsOfInvestor(tx: Transaction, investorId: string | null): Promise<InvestorPaymentRecord[]>;

  insertFinancing(tx: Transaction, financing: FinancingRecord, schedule: readonly ScheduleLineRecord[]): Promise<void>;
  financing(tx: Transaction, id: string, forUpdate: boolean): Promise<FinancingRecord | null>;
  financingByApproval(tx: Transaction, approvalRequestId: string): Promise<FinancingRecord | null>;
  financings(tx: Transaction, filter: { readonly kind: FinancingRecord['kind'] | null; readonly status: FinancingRecord['status'] | null }, beforeId: string | null, limit: number): Promise<FinancingRecord[]>;
  activeFinancingIds(tx: Transaction): Promise<string[]>;
  decideFinancing(tx: Transaction, id: string, decision: { readonly status: 'ACTIVE' | 'CANCELLED'; readonly journalEntryId: string | null; readonly by: string; readonly at: Date }): Promise<void>;
  settleFinancing(tx: Transaction, id: string, by: string, at: Date): Promise<void>;
  scheduleOf(tx: Transaction, financingId: string): Promise<ScheduleLineRecord[]>;
  accrualsOf(tx: Transaction, financingId: string): Promise<AccrualRecord[]>;
  insertAccrual(tx: Transaction, accrual: AccrualRecord): Promise<void>;
  repaymentsOf(tx: Transaction, financingId: string): Promise<RepaymentRecord[]>;
  insertRepayment(tx: Transaction, repayment: RepaymentRecord): Promise<void>;
  repaymentByReference(tx: Transaction, externalReference: string): Promise<RepaymentRecord | null>;
}
