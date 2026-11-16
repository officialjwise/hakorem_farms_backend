import type { Transaction } from '../../../platform/database/unit-of-work';
import type { RefundDestination } from '../domain/refund';
import type { MethodKind } from '../domain/tender';

export const PAYMENT_STORE = Symbol('PAYMENT_STORE');

export type PaymentStatus = 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
export type Verification = 'NOT_REQUIRED' | 'PROVIDER_CALLBACK' | 'PROVIDER_LOOKUP' | 'UNVERIFIED';

export interface PaymentRecord {
  readonly id: string;
  readonly paymentMethodId: string;
  readonly methodKind: MethodKind;
  readonly amountPesewas: bigint;
  readonly allocatedPesewas: bigint;
  readonly refundedPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly shiftDocumentId: string | null;
  readonly registerRef: string | null;
  readonly registerCode: string | null;
  readonly provider: string | null;
  readonly providerReference: string | null;
  readonly externalReference: string | null;
  readonly payerPhoneMasked: string | null;
  readonly verification: Verification;
  readonly status: PaymentStatus;
  readonly receivedAt: Date;
  readonly clearedAt: Date | null;
  readonly failureReason: string | null;
  readonly reversesPaymentId: string | null;
  readonly bankAccountId: string | null;
  readonly chequeDueOn: string | null;
  /** The subject of a cleared cheque's clearing entry (`pay.ChequeCleared`), so a reversal mirrors it too. */
  readonly clearanceRef: string | null;
  readonly branchId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export interface AllocationRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly billingDocumentId: string;
  readonly amountPesewas: bigint;
  readonly direction: 'APPLY' | 'UNAPPLY';
  readonly reversesAllocationId?: string | null;
  readonly recordedAt?: Date;
  /** Written in the payment's own transaction, so its clearing entry credited it; otherwise applied from deposit later. */
  readonly atReceipt?: boolean;
}

export interface NewPayment {
  readonly id: string;
  readonly paymentMethodId: string;
  readonly methodKind: MethodKind;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly shiftDocumentId: string | null;
  readonly register: { readonly id: string; readonly code: string } | null;
  readonly provider?: string | null;
  readonly providerReference?: string | null;
  readonly externalReference?: string | null;
  readonly payerPhoneMasked?: string | null;
  readonly verification: Verification;
  readonly status: 'PENDING' | 'CLEARED' | 'REVERSED';
  readonly receivedAt: Date;
  readonly clearedAt: Date | null;
  readonly branchId: string;
  readonly actorId: string;
  readonly bankAccountId?: string | null;
  readonly chequeDueOn?: string | null;
  /** Set only on a reversing payment, written REVERSED. */
  readonly reversesPaymentId?: string | null;
}

/** A reversal asked for (`pay.payment_reversal`), waiting for a different person's approval. */
export interface ReversalRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly approvalRequestId: string | null;
  readonly reversingPaymentId: string | null;
  readonly status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  readonly branchId: string;
  readonly createdBy: string;
}

/** One store credit entry (`pay.store_credit_entry`). */
export interface StoreCreditEntryRecord {
  readonly id: string;
  readonly customerId: string;
  readonly direction: 'ISSUE' | 'REDEEM' | 'EXPIRE';
  readonly amountPesewas: bigint;
  readonly sourceDocumentId: string;
  readonly branchId: string;
  readonly recordedAt: Date;
}

/** One attempt to collect through the provider port (`pay.provider_transaction`). */
export interface ChargeRecord {
  readonly id: string;
  readonly paymentId: string;
  readonly provider: string;
  readonly reference: string;
  readonly channel: 'MOBILE_MONEY' | 'CARD';
  readonly network: 'MTN' | 'TELECEL' | 'AIRTELTIGO' | null;
  readonly requestedPesewas: bigint;
  readonly confirmedPesewas: bigint | null;
  readonly status: 'INITIATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED';
  readonly awaitedUntil: Date;
  readonly releasedAt: Date | null;
  readonly createdAt: Date;
  readonly branchId: string;
}

export interface ChargeChange {
  readonly status?: ChargeRecord['status'];
  readonly providerStatus?: string;
  readonly confirmedPesewas?: bigint;
  readonly verifiedAt?: Date;
  readonly lastCheckedAt?: Date;
  readonly releasedAt?: Date;
}

export type WebhookOutcome =
  | 'ACCEPTED'
  | 'REJECTED_SIGNATURE'
  | 'REJECTED_STALE'
  | 'REJECTED_AMOUNT'
  | 'REJECTED_MALFORMED'
  | 'IGNORED_UNKNOWN_REFERENCE'
  | 'IGNORED_EVENT_TYPE'
  | 'REPLAYED'
  | 'DEFERRED_LOOKUP';

export interface WebhookRow {
  readonly id: string;
  readonly provider: string;
  readonly eventId: string | null;
  readonly eventType: string | null;
  readonly signatureValid: boolean;
  readonly withinTimeWindow: boolean | null;
  readonly payloadHash: Buffer;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reference: string | null;
  readonly paymentId: string | null;
  readonly outcome: WebhookOutcome;
  readonly sourceIp: string | null;
  readonly correlationId: string | null;
  readonly receivedAt: Date;
  readonly actorId: string;
}

export type RefundStatus = 'REQUESTED' | 'PENDING_APPROVAL' | 'APPROVED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REJECTED';

export interface RefundRecord {
  readonly id: string;
  readonly originalPaymentId: string;
  readonly amountPesewas: bigint;
  readonly destination: RefundDestination;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly creditNoteId: string | null;
  readonly isAutomatic: boolean;
  readonly approvalRequestId: string | null;
  readonly providerReference: string | null;
  readonly externalReference: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly paidAt: Date | null;
  readonly paidBy: string | null;
  readonly failureReason: string | null;
  readonly status: RefundStatus;
  readonly branchId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface RefundChange {
  readonly status?: RefundStatus;
  readonly approvalRequestId?: string;
  readonly providerReference?: string;
  readonly providerStatus?: string;
  readonly externalReference?: string;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date | null;
  readonly paid?: { readonly at: Date; readonly by: string };
  readonly failureReason?: string;
}

export type BreakKind = 'UNMATCHED_PAYMENT' | 'PROVIDER_AMOUNT_DIFFERS' | 'PROVIDER_REFERENCE_UNKNOWN' | 'PROVIDER_PAYMENT_MISSING' | 'REFUND_FAILED';

export interface NewBreak {
  readonly id: string;
  readonly kind: BreakKind;
  readonly branchId: string | null;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly provider: string | null;
  readonly reference: string | null;
  readonly amountPesewas: bigint | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: Date;
  readonly actorId: string;
}

export interface PaymentFilter {
  readonly branchIds: readonly string[];
  readonly status: PaymentStatus | null;
  readonly methodKind: MethodKind | null;
  readonly customerId: string | null;
  readonly orderId: string | null;
  readonly shiftId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly unallocatedOnly: boolean;
}

export interface RefundFilter {
  readonly branchIds: readonly string[];
  readonly status: RefundStatus | null;
  readonly createdBy: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** PAY's own tables (schema `pay`). Ledger rows are inserted only; the database's triggers keep the derived amounts. */
export interface PaymentStore {
  insert(tx: Transaction, payment: NewPayment): Promise<void>;
  allocate(tx: Transaction, allocation: AllocationRecord & { readonly actorId: string; readonly reason?: string | null }): Promise<void>;
  payments(tx: Transaction, ids: readonly string[], forUpdate?: boolean): Promise<PaymentRecord[]>;
  paymentsOfOrder(tx: Transaction, orderDocumentId: string): Promise<PaymentRecord[]>;
  allocationsOf(tx: Transaction, paymentIds: readonly string[]): Promise<AllocationRecord[]>;
  /** An allocation by id, and whether an unallocation has reversed it. */
  allocation(tx: Transaction, id: string): Promise<(AllocationRecord & { readonly reversed: boolean }) | null>;
  /** Payment ids matching the filter, newest first, below `beforeId`. */
  list(tx: Transaction, filter: PaymentFilter, beforeId: string | null, limit: number): Promise<string[]>;
  /** The unmatched queue: provider payments still pending, and payments with an open unmatched or amount break. */
  unmatched(tx: Transaction, branchIds: readonly string[], beforeId: string | null, limit: number): Promise<string[]>;
  markCleared(tx: Transaction, id: string, verification: Verification, at: Date, actorId: string): Promise<void>;
  markFailed(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;
  /** A pending cheque cleared at the bank, naming its clearing entry's subject. */
  markChequeCleared(tx: Transaction, id: string, clearanceRef: string, at: Date, actorId: string): Promise<void>;
  markReversed(tx: Transaction, id: string, actorId: string): Promise<void>;
  /** The allocations of a payment that no unallocation has reversed, oldest first. */
  activeAllocations(tx: Transaction, paymentId: string): Promise<AllocationRecord[]>;

  insertReversal(tx: Transaction, reversal: Omit<ReversalRecord, 'approvalRequestId' | 'reversingPaymentId' | 'status'>): Promise<void>;
  reversalByApproval(tx: Transaction, approvalRequestId: string): Promise<ReversalRecord | null>;
  /** The reversal of a payment that is not rejected (one at most), locked. */
  openReversalOf(tx: Transaction, paymentId: string): Promise<ReversalRecord | null>;
  updateReversal(tx: Transaction, id: string, change: { readonly status?: ReversalRecord['status']; readonly approvalRequestId?: string; readonly reversingPaymentId?: string }, actorId: string): Promise<void>;

  insertStoreCredit(tx: Transaction, entry: Omit<StoreCreditEntryRecord, 'recordedAt'> & { readonly actorId: string }): Promise<void>;
  storeCreditBalance(tx: Transaction, customerId: string): Promise<bigint>;
  storeCreditEntries(tx: Transaction, customerId: string, limit: number): Promise<StoreCreditEntryRecord[]>;

  insertCharge(tx: Transaction, charge: Omit<ChargeRecord, 'confirmedPesewas' | 'status' | 'releasedAt' | 'createdAt'> & { readonly actorId: string }): Promise<void>;
  chargeOfPayment(tx: Transaction, paymentId: string, forUpdate?: boolean): Promise<ChargeRecord | null>;
  chargeByReference(tx: Transaction, provider: string, reference: string, forUpdate?: boolean): Promise<ChargeRecord | null>;
  updateCharge(tx: Transaction, id: string, change: ChargeChange, actorId: string): Promise<void>;
  /** Charges still open (INITIATED or PENDING) created before `before`, oldest first. */
  openCharges(tx: Transaction, provider: string, before: Date, limit: number): Promise<ChargeRecord[]>;

  webhookSeen(tx: Transaction, provider: string, eventId: string): Promise<boolean>;
  insertWebhook(tx: Transaction, row: WebhookRow): Promise<void>;

  insertRefund(tx: Transaction, refund: Omit<RefundRecord, 'approvalRequestId' | 'providerReference' | 'externalReference' | 'attempts' | 'nextAttemptAt' | 'paidAt' | 'paidBy' | 'failureReason' | 'createdAt'>): Promise<void>;
  refunds(tx: Transaction, ids: readonly string[], forUpdate?: boolean): Promise<RefundRecord[]>;
  refundsOfPayment(tx: Transaction, paymentId: string): Promise<RefundRecord[]>;
  listRefunds(tx: Transaction, filter: RefundFilter, beforeId: string | null, limit: number): Promise<string[]>;
  updateRefund(tx: Transaction, id: string, change: RefundChange, actorId: string): Promise<void>;
  /** Provider refunds due an attempt or a status check now. */
  dueRefunds(tx: Transaction, now: Date, limit: number): Promise<RefundRecord[]>;

  /** Raises a break unless the same one is already open; answers whether it was raised. */
  raiseBreak(tx: Transaction, row: NewBreak): Promise<boolean>;
  resolveRefundBreaks(tx: Transaction, refundId: string, note: string, at: Date, actorId: string): Promise<void>;
  lastSweepEnd(tx: Transaction, provider: string): Promise<Date | null>;
  insertSweep(tx: Transaction, row: { readonly id: string; readonly provider: string; readonly from: Date; readonly to: Date; readonly transactions: number; readonly cleared: number; readonly breaksRaised: number; readonly actorId: string }): Promise<void>;
}
