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
}
