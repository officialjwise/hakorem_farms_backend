/**
 * Events ORD publishes (docs/DOMAIN_MODEL.md section 5.10). Types only: subscribers import them with `import type`.
 * None of them posts to the ledger: a sale's journals post from the stock, billing and payment events its posting
 * publishes in the same transaction (ADR-0010). Amounts are JSON integers of pesewas.
 */

/**
 * `ord.OrderCompleted` v1: an order completed, its stock issued, its document issued and its tenders recorded in one
 * transaction. RPT's sales figures, POS's shift totals (B9b) and NTF's receipt message (B11) read it.
 */
export interface OrderCompleted {
  readonly orderId: string;
  readonly orderNo: string;
  readonly channel: 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';
  readonly branchId: string;
  readonly customerId: string | null;
  readonly billingDocumentId: string;
  readonly billingDocumentNo: string;
  readonly finalTotalPesewas: number;
  readonly paymentIds: readonly string[];
  readonly lines: readonly { readonly lineNo: number; readonly productId: string; readonly qty: string; readonly finalLineTotalPesewas: number }[];
  readonly placedAt: string;
  readonly completedAt: string;
}

/**
 * `ord.OrderPlaced` v1: an order entered by staff (B09a continued 2b), PLACED with its lines priced and nothing
 * reserved. NTF's order message (B11) reads it.
 */
export interface OrderPlaced {
  readonly orderId: string;
  readonly orderNo: string;
  readonly channel: 'POS' | 'ONLINE' | 'WHOLESALE' | 'QUOTE';
  readonly branchId: string;
  readonly customerId: string | null;
  readonly paymentTerms: 'IMMEDIATE' | 'PREPAID' | 'COD' | 'CREDIT';
  readonly estimatedTotalPesewas: number;
  readonly placedAt: string;
}

/**
 * `ord.OrderConfirmed` v1: an order's payment or credit check passed and every line is reserved; it holds its stock
 * until fulfilment (B11), cancellation or void. Fulfilment's pick list and NTF's message (B11) read it.
 */
export interface OrderConfirmed {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly creditCheck: 'PASSED' | 'NOT_REQUIRED';
  readonly reservationIds: readonly string[];
  readonly confirmedAt: string;
}

/**
 * `ord.OrderCancelled` v1 (B09a continued 2c, FR-ORD-014): an order cancelled before fulfilment, its reservations
 * released, its pending charges released and the refund of what it was paid asked for, in one transaction. NTF's
 * message (B11) and RPT's figures read it.
 */
export interface OrderCancelled {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly fromStatus: 'PLACED' | 'CONFIRMED';
  readonly reasonCode: string;
  readonly releasedReservationIds: readonly string[];
  readonly releasedChargePaymentIds: readonly string[];
  readonly refundIds: readonly string[];
  readonly refundRequestedPesewas: number;
  readonly cancelledAt: string;
}

/**
 * `ord.SaleVoidRequested` v1 (abuse case 1): a void of a completed sale asked for, waiting for a supervisor who is
 * neither the person asking nor the cashier. Every request reaches the daily exception report (B12, `SALE_VOID`).
 */
export interface SaleVoidRequested {
  readonly voidId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly reasonCode: string;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly cashierId: string;
  readonly abuseCases: readonly number[];
}

/**
 * `ord.OrderVoided` v1 (abuse case 1): a completed sale voided on a supervisor's approval; its stock, receipt and
 * payments reversed by new records (the reversing movements, a credit note, the reversing payments), the original kept.
 * The journals post from those modules' own events in the same transaction. On the daily exception report (`SALE_VOID`).
 */
export interface OrderVoided {
  readonly voidId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly amountPesewas: number;
  readonly reasonCode: string;
  readonly creditNoteId: string;
  readonly creditNoteNo: string;
  readonly reversingPaymentIds: readonly string[];
  readonly reversingMovementIds: readonly string[];
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly voidedBy: string;
  readonly cashierId: string;
  readonly voidedAt: string;
  readonly abuseCases: readonly number[];
}

/**
 * `ord.ReturnSubmitted` v1 (abuse case 12): a return against a sale submitted by its maker; it waits for a supervisor
 * who did not make it (`RETURN`). Nothing has moved yet. On the daily exception report with the refunds (`REFUND`).
 */
export interface ReturnSubmitted {
  readonly returnId: string;
  readonly returnNo: string;
  readonly orderId: string;
  readonly branchId: string;
  readonly totalRefundPesewas: number;
  readonly reasonCode: string;
  readonly approvalRequestId: string;
  readonly makerId: string;
  readonly abuseCases: readonly number[];
}

/**
 * `ord.ReturnCompleted` v1 (abuse case 12): an approved return. Its credit note, its stock movements and its refund
 * request were written in the same transaction by BIL, INV and PAY, whose own events post the journals; the refund
 * waits for a different approver (ADR-0066).
 */
export interface ReturnCompleted {
  readonly returnId: string;
  readonly returnNo: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly reasonCode: string;
  readonly creditNoteId: string;
  readonly creditNoteNo: string;
  readonly refundId: string | null;
  readonly totalRefundPesewas: number;
  readonly refundRequestedPesewas: number;
  readonly movementIds: readonly string[];
  readonly approvalRequestId: string;
  readonly makerId: string;
  readonly approvedBy: string;
  readonly completedAt: string;
  readonly abuseCases: readonly number[];
}
