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
