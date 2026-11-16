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
  readonly abuseCases: readonly number[];
}

/** ◆ `pay.RefundPaid` v1: a refund paid out of the customer's deposit to the original payment's method. */
export interface RefundPaid {
  readonly refundId: string;
  readonly paymentId: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly amountPesewas: number;
  readonly methodKind: string;
  readonly register: RegisterRefPayload | null;
  readonly provider: string | null;
  readonly paidBy: 'PROVIDER' | 'MANUAL';
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
}
