import type { Transaction } from '../../../platform/database/unit-of-work';
import type { RunStatus } from '../domain/distribution';

export const CAP_STORE = Symbol('CAP_STORE');

/** A `cap.investor` row (MASTER). The sealed columns are never selected. */
export interface InvestorRecord {
  readonly id: string;
  readonly investorNo: string;
  readonly kind: 'INDIVIDUAL' | 'ENTITY';
  readonly legalName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly principalId: string | null;
  readonly payoutMethod: 'BANK' | 'MOBILE_MONEY' | null;
  readonly payoutLast4: string | null;
  /** The payout details in force, masked (B12 continued): the bank or network, the account name, the last four. */
  readonly payoutMasked: string | null;
  readonly idNumberMasked: string | null;
  readonly hasIdNumber: boolean;
  readonly joinedOn: string;
  readonly status: 'ACTIVE' | 'EXITED';
  readonly version: number;
}

/** A `cap.unit_holding` row: what the investor holds now, in ten-thousandths of a unit. */
export interface HoldingRecord {
  readonly investorId: string;
  readonly unitsE4: bigint;
  readonly contributedPesewas: bigint;
  readonly withdrawnPesewas: bigint;
}

/** A `cap.capital_transaction` row (LEDGER). */
export interface CapitalTransactionRecord {
  readonly id: string;
  readonly transactionNo: string;
  readonly investorId: string;
  readonly branchId: string;
  readonly kind: 'CONTRIBUTION' | 'WITHDRAWAL';
  readonly amountPesewas: bigint;
  readonly valueDate: string;
  readonly postingDate: string;
  readonly unitPricePesewas: bigint;
  readonly unitsE4: bigint;
  readonly bankAccountId: string;
  readonly externalReference: string | null;
  readonly approvalRequestId: string | null;
  readonly withdrawalRequestId: string | null;
  readonly journalEntryId: string;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** A `cap.capital_withdrawal_request` row (DOCUMENT). */
export interface WithdrawalRequestRecord {
  readonly id: string;
  readonly investorId: string;
  readonly branchId: string;
  readonly amountPesewas: bigint;
  readonly valueDate: string;
  readonly unitPricePesewas: bigint;
  readonly unitsE4: bigint;
  readonly bankAccountId: string;
  readonly externalReference: string | null;
  readonly approvalRequestId: string;
  readonly status: 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'CANCELLED';
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** The figures of one computation of a run. */
export interface RunFigures {
  readonly netProfitPesewas: bigint;
  readonly isLoss: boolean;
  readonly retentionRatePercent: string;
  readonly retainedPesewas: bigint;
  readonly distributablePesewas: bigint;
  readonly totalUnitDaysE4: bigint;
  readonly withholdingRatePercent: string;
  readonly computationNo: number;
  readonly computedAt: Date;
}

/** A `cap.distribution_run` row (DOCUMENT). */
export interface RunRecord extends RunFigures {
  readonly id: string;
  readonly runNo: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly daysInPeriod: number;
  readonly dayCountConvention: string;
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly scheduleDocumentId: string | null;
  readonly journalEntryId: string | null;
  readonly paidPesewas: bigint;
  readonly status: RunStatus;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedBy: string | null;
}

/** A `cap.distribution_line` row of a run's current computation. */
export interface LineRecord {
  readonly id: string;
  readonly runId: string;
  readonly computationNo: number;
  readonly investorId: string;
  readonly unitDaysE4: bigint;
  readonly allocatedPesewas: bigint;
  readonly receivedExtraPesewa: boolean;
  readonly withheldPesewas: bigint;
  readonly netPayablePesewas: bigint;
  readonly paidPesewas: bigint;
}

/** A `cap.distribution_payment` row (LEDGER). */
export interface PaymentRecord {
  readonly id: string;
  readonly lineId: string;
  readonly amountPesewas: bigint;
  readonly bankAccountId: string;
  readonly externalReference: string | null;
  readonly paidAt: Date;
  readonly journalEntryId: string;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** A page position for keyset lists: the sort value and the id. */
export interface Position {
  readonly key: string;
  readonly id: string;
}

/** CAP's own tables (migration 0353). Parameterised SQL only; nothing outside schema `cap` is read. */
export interface CapStore {
  nextInvestorNo(tx: Transaction): Promise<string>;
  insertInvestor(tx: Transaction, investor: InvestorRecord, by: string, at: Date): Promise<void>;
  updateInvestor(tx: Transaction, id: string, change: { readonly phone: string | null; readonly email: string | null; readonly status: InvestorRecord['status'] }, by: string, at: Date): Promise<void>;
  investor(tx: Transaction, id: string, forUpdate: boolean): Promise<InvestorRecord | null>;
  investorsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, InvestorRecord>>;
  investors(tx: Transaction, filter: { readonly status: InvestorRecord['status'] | null }, after: string | null, limit: number): Promise<InvestorRecord[]>;
  holdingsIn(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, HoldingRecord>>;
  unitsInIssue(tx: Transaction): Promise<bigint>;

  insertTransaction(tx: Transaction, record: CapitalTransactionRecord): Promise<void>;
  transaction(tx: Transaction, id: string): Promise<CapitalTransactionRecord | null>;
  transactions(
    tx: Transaction,
    filter: { readonly investorId: string | null; readonly kind: CapitalTransactionRecord['kind'] | null; readonly from: string | null; readonly to: string | null },
    after: Position | null,
    limit: number,
  ): Promise<CapitalTransactionRecord[]>;
  /** Every capital transaction with a value date on or before the date, every investor's (the register and unit-days read them). */
  transactionsUpTo(tx: Transaction, date: string): Promise<CapitalTransactionRecord[]>;
  /** One investor's capital transactions, all of them, locking the investor first so two withdrawals of theirs queue. */
  transactionsOfLocked(tx: Transaction, investorId: string): Promise<CapitalTransactionRecord[]>;

  insertWithdrawalRequest(tx: Transaction, request: WithdrawalRequestRecord): Promise<void>;
  withdrawalRequest(tx: Transaction, id: string): Promise<WithdrawalRequestRecord | null>;
  withdrawalByApproval(tx: Transaction, approvalRequestId: string): Promise<WithdrawalRequestRecord | null>;
  decideWithdrawal(tx: Transaction, id: string, decision: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly at: Date }): Promise<void>;

  insertRun(tx: Transaction, run: RunRecord): Promise<void>;
  recomputeRun(tx: Transaction, id: string, figures: RunFigures, by: string): Promise<void>;
  submitRun(tx: Transaction, id: string, approvalRequestId: string, by: string): Promise<void>;
  decideRun(tx: Transaction, id: string, decision: { readonly status: 'APPROVED' | 'REJECTED'; readonly by: string; readonly at: Date }): Promise<void>;
  postRun(tx: Transaction, id: string, journalEntryId: string, by: string, at: Date): Promise<void>;
  markRunPaid(tx: Transaction, id: string, by: string): Promise<void>;
  linkSchedule(tx: Transaction, id: string, archivedDocumentId: string, by: string): Promise<boolean>;
  run(tx: Transaction, id: string, forUpdate: boolean): Promise<RunRecord | null>;
  runByApproval(tx: Transaction, approvalRequestId: string): Promise<RunRecord | null>;
  runs(tx: Transaction, filter: { readonly status: RunStatus | null; readonly branchIds: readonly string[] }, after: Position | null, limit: number): Promise<RunRecord[]>;
  /** The lines of each run's current computation, by investor number. */
  linesOf(tx: Transaction, runIds: readonly string[]): Promise<ReadonlyMap<string, LineRecord[]>>;
  insertLines(tx: Transaction, lines: readonly LineRecord[], at: Date): Promise<void>;
  line(tx: Transaction, id: string, forUpdate: boolean): Promise<LineRecord | null>;
  insertPayment(tx: Transaction, payment: PaymentRecord): Promise<void>;
  paymentByReference(tx: Transaction, externalReference: string): Promise<PaymentRecord | null>;
}
