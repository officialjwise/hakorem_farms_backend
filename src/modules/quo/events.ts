/**
 * QUO's published events (DOMAIN_MODEL section 5.12), written to the outbox in the transaction of the change. None of
 * them carries a link token (ADR-0074): the worker that sends a quote asks QUO for a fresh one just before it sends
 * (B11). None carries the buyer's phone or name: the sender reads them from the quote.
 */
export interface RfqReceived {
  readonly rfqId: string;
  readonly rfqNo: string;
  readonly source: string;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly productId: string | null;
  readonly receivedAt: string;
}

export interface QuoteIssued {
  readonly quoteId: string;
  readonly quoteNo: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly salespersonId: string;
  readonly grossPesewas: number;
  readonly validUntil: string;
  /** The channels the salesperson asked the link to be sent by (FR-QUO-007); sent by NTF from the outbox (B11). */
  readonly channels: readonly string[];
  readonly supersededVersionId: string | null;
  readonly approvalRequestId: string | null;
  readonly issuedAt: string;
}

export interface QuoteDecided {
  readonly quoteId: string;
  readonly quoteNo: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly branchId: string;
  readonly salespersonId: string;
  readonly grossPesewas: number;
  readonly method: 'SIGNED_LINK' | 'IN_PERSON' | 'PHONE_CONFIRMED' | 'STAFF' | 'EXPIRY';
  readonly at: string;
}

export interface QuoteConverted {
  readonly quoteId: string;
  readonly quoteNo: string;
  readonly versionId: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly branchId: string;
  readonly salespersonId: string;
  readonly convertedAt: string;
}
