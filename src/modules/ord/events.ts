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
  readonly creditCheck: 'PASSED' | 'OVERRIDDEN' | 'NOT_REQUIRED';
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
  /** PICKING and AWAITING_CUSTOMER from B11, when a cancellation also ends the order's pick lists. */
  readonly fromStatus: 'PLACED' | 'CONFIRMED' | 'PICKING' | 'AWAITING_CUSTOMER';
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

/**
 * `ord.PriceOverrideRequested` v1 (abuse case 3): a price outside the band, or below list beyond the seller's per-line
 * limit, waits for a different user's approval (A-230). `orderId` is the order entered, or the sale the sale posting is
 * asked to post (not yet written). B12's daily exception report lists it under `PRICE_OVERRIDE`, with the override
 * value by user.
 */
export interface PriceOverrideRequested {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly branchId: string;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly salespersonId: string;
  /** What the flagged lines take off list, or add above the ceiling, extended over each line. */
  readonly variancePesewas: number;
  readonly lines: readonly { readonly lineNo: number; readonly productId: string; readonly agreedUnitPricePesewas: number; readonly resolvedUnitPricePesewas: number; readonly reason: string }[];
  readonly requestedAt: string;
  readonly abuseCases: readonly number[];
}

/** `ord.PriceOverrideApproved` v1 (abuse case 3): the override approved by someone who neither asked nor sold. */
export interface PriceOverrideApproved {
  readonly orderId: string;
  readonly branchId: string;
  readonly approvalRequestId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly variancePesewas: number;
  readonly approvedAt: string;
  readonly abuseCases: readonly number[];
}

/**
 * `ord.CustomerConsentRequested` v1 (B11, FR-ORD-010, FR-ORD-013, CR-054): an order asks its customer for a higher total
 * (the weighed total past the tolerance), a substitute or a smaller quantity, and waits AWAITING_CUSTOMER. NTF's message
 * to the customer reads it; it carries no price record beyond what the customer is asked to pay.
 */
export interface CustomerConsentRequested {
  readonly consentId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly kind: 'HIGHER_TOTAL' | 'SUBSTITUTION' | 'SHORT_PICK';
  readonly lineNo: number;
  readonly proposedProductId: string | null;
  readonly proposedQty: string | null;
  readonly proposedUom: string | null;
  readonly proposedTotalPesewas: number | null;
  readonly askedAt: string;
}

/** `ord.CustomerConsentAnswered` v1 (B11): the customer's answer, as they gave it or as staff who did not ask recorded it. */
export interface CustomerConsentAnswered {
  readonly consentId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly kind: 'HIGHER_TOTAL' | 'SUBSTITUTION' | 'SHORT_PICK';
  readonly accepted: boolean;
  readonly method: 'PHONE' | 'IN_PERSON' | 'WHATSAPP' | 'SIGNED_LINK' | 'CUSTOMER_ACCOUNT';
  readonly answeredBy: string;
  readonly answeredAt: string;
}

/** `ord.FulfilmentPacked` v1 (B11, FR-ORD-011): a pick list packed, its picks sealed; dispatch follows (B11 continued). */
export interface FulfilmentPacked {
  readonly fulfilmentId: string;
  readonly fulfilmentNo: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly packageCount: number;
  readonly weighedTotalPesewas: number;
  readonly packedAt: string;
}

/**
 * `ord.OrderDispatched` v1 (B11 continued, FR-ORD-011, FR-DEL-012): a delivery order dispatched onto a vehicle, its
 * billing document issued on the weighed quantity, its deposits allocated and the cash due on delivery fixed. Written to
 * the outbox in the dispatch's own transaction, so the customer's one message with the weights and the final total exists
 * exactly when the dispatch committed (NTF sends it, B11 continued 3). No identifier in it is a link's key (ADR-0074).
 */
export interface OrderDispatched {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  /** The number the message goes to: the order's contact, else the delivery's recipient. */
  readonly contactPhone: string;
  readonly billingDocumentId: string;
  readonly billingDocumentNo: string;
  readonly finalTotalPesewas: number;
  readonly allocatedPesewas: number;
  readonly refundRequestedPesewas: number;
  /** Nil on an order on account (B11 continued 8): nothing is due to the driver; the invoice is due on `dueDate`. */
  readonly codDuePesewas: number;
  /** An order on account's invoice due date from the customer's terms (B11 continued 8), else null. */
  readonly dueDate: string | null;
  readonly deliveryId: string;
  readonly deliveryNo: string;
  /** The slot chosen at the checkout (B11 continued 8), else null; `bookedSlotId` is it when dispatch could book it, else null. */
  readonly chosenSlotId: string | null;
  readonly bookedSlotId: string | null;
  readonly lines: readonly { readonly orderLineId: string; readonly name: string; readonly quantity: string; readonly uom: string; readonly weightKg: string | null }[];
  /** The backorder this dispatch left for what was not sent (FR-ORD-012, B11 continued 7), else null. */
  readonly backorderId: string | null;
  readonly backorderNo: string | null;
  readonly dispatchedAt: string;
}

/**
 * `ord.OrderCollected` v1 (B11 continued 7, FR-ORD-011): a collection order handed to the customer, its document issued
 * on the weighed quantity and its deposits allocated; `dueAtTillPesewas` is what is left to pay at the till, `completed`
 * when nothing was. For the customer's message (NTF) and the daily exception report.
 */
export interface OrderCollected {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly contactPhone: string | null;
  readonly billingDocumentId: string;
  readonly billingDocumentNo: string;
  readonly finalTotalPesewas: number;
  readonly allocatedPesewas: number;
  readonly refundRequestedPesewas: number;
  /** Nil on an order on account (B11 continued 8): the invoice is due on `dueDate`, never at the till. */
  readonly dueAtTillPesewas: number;
  /** An order on account's invoice due date from the customer's terms (B11 continued 8), else null. */
  readonly dueDate: string | null;
  readonly completed: boolean;
  readonly backorderId: string | null;
  readonly collectedAt: string;
}

/**
 * `ord.OrderDelivered` v1 (B11 continued, FR-DEL-008, FR-DEL-012): a dispatched order delivered, its goods issued from
 * the vehicle; `completed` when nothing was left to pay. The customer's delivered message (NTF, B11 continued 3).
 */
export interface OrderDelivered {
  readonly orderId: string;
  readonly orderNo: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly contactPhone: string | null;
  readonly deliveryId: string;
  readonly deliveryNo: string;
  readonly billingDocumentId: string;
  readonly codCollectedPesewas: number;
  readonly outstandingPesewas: number;
  readonly completed: boolean;
  readonly deliveredAt: string;
}
