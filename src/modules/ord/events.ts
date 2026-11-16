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
