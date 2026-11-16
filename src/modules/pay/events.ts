/**
 * Events PAY publishes (docs/DOMAIN_MODEL.md section 5.9). Types only: subscribers import them with `import type`.
 * Those marked ◆ post to the ledger in the publishing transaction (ADR-0003, ADR-0056). Amounts are JSON integers of
 * pesewas.
 */

/** The till a cash tender went into: the subledger party of account 1000 (B9b registers tills; B9a names them). */
export interface RegisterRefPayload {
  readonly id: string;
  readonly code: string;
}

/**
 * ◆ `pay.PaymentCleared` v1: a payment cleared. `amountPesewas` is the tender received (`tender`, by the method's kind),
 * `allocatedPesewas` the part applied to billing documents at clearing (off receivables, against the customer, the
 * walk-in party if none) and `unallocatedPesewas` the rest, held as the customer's deposit; the two sum to the amount.
 */
export interface PaymentCleared {
  readonly paymentId: string;
  readonly branchId: string;
  readonly methodKind: string;
  readonly amountPesewas: number;
  readonly allocatedPesewas: number;
  readonly unallocatedPesewas: number;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly register: RegisterRefPayload | null;
  readonly allocations: readonly { readonly billingDocumentId: string; readonly amountPesewas: number }[];
  readonly receivedAt: string;
  /** The provider that took a mobile money or card payment (B09a continued), null otherwise. */
  readonly provider?: string | null;
  /**
   * True when the money arrived after its order stopped waiting (expired or released): it is held as an unmatched
   * deposit with a reconciliation break, and the order must not confirm on it (A-210).
   */
  readonly heldAsUnmatched?: boolean;
  /**
   * True for a cheque: it is received into 1130 Cheques awaiting clearance and stays PENDING until `pay.ChequeCleared`;
   * an order must not treat it as cleared money (ADR-0064).
   */
  readonly awaitingClearance?: boolean;
  /** The bank account a bank transfer landed in, from its matched statement line (ADR-0065); null for any other tender. */
  readonly bankAccountId?: string | null;
  /** A bank transfer's statement value date, the business date it is posted on (ADR-0065). */
  readonly clearedOn?: string | null;
}

/** ◆ `pay.ChequeCleared` v1: a cheque awaiting clearance cleared at the bank, into the bank account it was paid into. */
export interface ChequeCleared {
  readonly paymentId: string;
  /** The subject of the clearing entry, so a later reversal mirrors it. */
  readonly clearanceRef: string;
  readonly branchId: string;
  readonly bankAccountId: string;
  readonly customerId: string | null;
  readonly amountPesewas: number;
  /** The business date the bank confirmed, the entry's posting date. */
  readonly clearedOn: string;
}

/** `pay.PaymentReversalRequested` v1: a reversal waits for a different person's approval (the daily report's `PAYMENT_REVERSAL`). */
export interface PaymentReversalRequested {
  readonly reversalId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly methodKind: string;
  readonly reasonCode: string;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly abuseCases: readonly number[];
}

/**
 * ◆ `pay.PaymentReversed` v1: the mirror of one entry of a reversed payment (ADR-0003 "Reverse of the original",
 * ADR-0064). `part` names which: `RECEIPT` mirrors its `pay.PaymentCleared` entry (subject the payment), `CLEARING` a
 * cleared cheque's `pay.ChequeCleared` entry (subject its clearance). `bounced` is a cheque the bank returned unpaid
 * (the original is FAILED); otherwise the original is REVERSED. Its allocations are reopened in the same transaction.
 */
export interface PaymentReversed {
  readonly reversingPaymentId: string;
  readonly paymentId: string;
  readonly reversesSubjectId: string;
  readonly part: 'RECEIPT' | 'CLEARING';
  readonly branchId: string;
  readonly customerId: string | null;
  readonly orderDocumentId: string | null;
  readonly methodKind: string;
  readonly amountPesewas: number;
  readonly reasonCode: string;
  readonly bounced: boolean;
  readonly approvalRequestId: string;
}

/** `pay.PaymentInitiated` v1: a provider charge was created PENDING and sent, or is about to be. */
export interface PaymentInitiated {
  readonly paymentId: string;
  readonly branchId: string;
  readonly methodKind: string;
  readonly amountPesewas: number;
  readonly orderDocumentId: string | null;
  readonly provider: string;
}

/** `pay.PaymentFailed` v1: a pending payment failed (the provider failed, abandoned or reversed it, or has no record). */
export interface PaymentFailed {
  readonly paymentId: string;
  readonly branchId: string;
  readonly orderDocumentId: string | null;
  readonly reason: string;
}

/**
 * ◆ `pay.DepositAllocated` v1: a cleared payment's deposit applied to a billing document (`appliedPesewas`), or an
 * allocation taken off back to deposit (`unappliedPesewas`); one of the two is zero (A-210).
 */
export interface DepositAllocated {
  readonly allocationId: string;
  readonly paymentId: string;
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly appliedPesewas: number;
  readonly unappliedPesewas: number;
  readonly reversesAllocationId: string | null;
}

/** `pay.RefundRequested` v1: a refund waits for a different person's approval (the daily report's `REFUND`). */
export interface RefundRequested {
  readonly refundId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  /** The credit note it draws on, and who raised it, for the refund report (abuse case 12, ADR-0066). */
  readonly creditNoteId: string | null;
  readonly creditNoteMakerId: string | null;
  readonly abuseCases: readonly number[];
}

/**
 * ◆ `pay.RefundPaid` v1: a refund paid out of the customer's deposit to the original payment's method, or to the
 * customer's store credit. `methodKind` is the tender it is paid to: the original's, or `STORE_CREDIT` (2210).
 */
export interface RefundPaid {
  readonly refundId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly amountPesewas: number;
  readonly methodKind: string;
  readonly destination?: 'ORIGINAL_METHOD' | 'STORE_CREDIT' | 'CASH';
  readonly register: RegisterRefPayload | null;
  readonly provider: string | null;
  readonly paidBy: 'PROVIDER' | 'MANUAL' | 'STORE_CREDIT';
  /** The credit note the refund draws on: FIN posts it out of receivables (Dr 1200) rather than deposit (ADR-0066). */
  readonly creditNoteId: string | null;
  /** A cheque's bank payout (tender `BANK_TRANSFER`): the bank account it leaves from, the cheque's own. */
  readonly bankAccountId: string | null;
}

/** `pay.RefundFailed` v1: a provider refund attempt failed; `exhausted` when it now waits for a person. */
export interface RefundFailed {
  readonly refundId: string;
  readonly branchId: string;
  readonly attempts: number;
  readonly exhausted: boolean;
}

/** `pay.WebhookRejected` v1: a webhook that took no effect (the daily report's `WEBHOOK_REJECTED`). No payload body. */
export interface WebhookRejected {
  readonly webhookEventId: string;
  readonly provider: string;
  readonly outcome: string;
  readonly abuseCases: readonly number[];
}

/** `pay.ReconciliationBreakRaised` v1: an exception for a person (the daily report's `RECONCILIATION_BREAK`). */
export interface ReconciliationBreakRaised {
  readonly breakId: string;
  readonly kind: string;
  readonly branchId: string | null;
  readonly paymentId: string | null;
  readonly refundId: string | null;
  readonly reference: string | null;
  readonly amountPesewas: number | null;
  /** The settlement report or bank statement, and the line in it, a reconciliation break was raised for (B09a continued 1c). */
  readonly sourceDocumentId?: string | null;
  readonly settlementLineId?: string | null;
  readonly bankStatementLineId?: string | null;
}

/**
 * ◆ `pay.ProviderSettled` v1: a payment provider paid out the payments a settlement report matched (ADR-0003,
 * ADR-0065): `grossPesewas` off provider clearing, `feePesewas` to fees, `netPesewas` into the bank account; net and fee
 * sum to the gross. Lines that did not match post nothing and are breaks.
 */
export interface ProviderSettled {
  readonly settlementReportId: string;
  readonly branchId: string;
  readonly provider: string;
  readonly settlementRef: string;
  readonly bankAccountId: string;
  readonly grossPesewas: number;
  readonly feePesewas: number;
  readonly netPesewas: number;
  readonly settledOn: string;
  readonly paymentIds: readonly string[];
}

/**
 * ◆ `pay.UnidentifiedReceiptHeld` v1: money from a payer nobody can name, held in suspense (2290) on a second person's
 * approval of a break's resolution (FR-PAY-010, FR-PAY-017, ADR-0065). `amountPesewas` is what the line says was paid,
 * `feePesewas` what the provider kept of it (0 for a bank line); the bank received the difference.
 */
export interface UnidentifiedReceiptHeld {
  readonly breakId: string;
  readonly lineId: string;
  readonly sourceDocumentId: string;
  readonly branchId: string;
  readonly bankAccountId: string;
  readonly amountPesewas: number;
  readonly feePesewas: number;
  readonly approvalRequestId: string;
}

/** `pay.BreakResolutionRequested` v1: a break's resolution waits for a different person's approval (the daily report's `RECONCILIATION_BREAK`). */
export interface BreakResolutionRequested {
  readonly resolutionId: string;
  readonly breakId: string;
  readonly kind: string;
  readonly branchId: string;
  readonly posting: 'NONE' | 'UNIDENTIFIED_RECEIPT';
  readonly amountPesewas: number | null;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
}
