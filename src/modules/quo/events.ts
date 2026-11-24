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
  /**
   * What the version holds for its validity, line by line, in the base unit (B11u, abuse case 64): how much each product
   * line asked for and how much stock it holds, so the exception report can see a quote holding stock away from buyers.
   */
  readonly holds: readonly { readonly quoteLineId: string; readonly productId: string; readonly askedQty: string; readonly heldQty: string }[];
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

/**
 * `quo.QuoteLinkDecidedFromStaffAddress` v1 (B10 continued 6, the owner, 2026-11-23, A-343, abuse case 40): a possible
 * staff acceptance. A quote was accepted or declined through its link from the address of staff sessions active in the
 * 24 hours before, by the application clock; each staff member is named with whether one of their sessions had the
 * decision's browser. Found by address and browser, never by a staff cookie; raised for review, never blocking the
 * decision. For the exception report's source (`QUOTE_ACCEPTED_BY_STAFF`, B12). No address, user agent, session id or
 * token: those stay in `quo.quote_link_decision` and `quo.quote_link_staff_match`. It replaces
 * `quo.QuoteLinkDecidedInStaffBrowser` (B10 continued 4, read from the staff cookie), which is no longer published.
 */
export interface QuoteLinkDecidedFromStaffAddress {
  readonly quoteId: string;
  readonly quoteNo: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly branchId: string;
  readonly salespersonId: string;
  readonly linkId: string;
  readonly linkDecisionId: string;
  readonly decision: 'ACCEPTED' | 'DECLINED';
  readonly staff: readonly { readonly principalId: string; readonly sameBrowser: boolean }[];
  /** Any matched session had the decision's browser: the stronger sign (A-343 (c)). */
  readonly sameBrowser: boolean;
  readonly windowHours: 24;
  readonly grossPesewas: number;
  readonly abuseCase: 40;
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

/**
 * `quo.QuoteWithdrawn` v1 (B11u, the owner, 2026-11-23, A-329 (b), abuse case 65): the farm withdrew a quote
 * (`cancelQuote`), with its reason and who withdrew it. A quote withdrawn after issue is its own outcome in the pipeline,
 * outside the win and loss rate, so each withdrawal is published for the exception report (a loss hidden by
 * withdrawing a quote about to be declined or to expire). `wasIssued` is false for a draft never sent.
 */
export interface QuoteWithdrawn {
  readonly quoteId: string;
  readonly quoteNo: string;
  readonly branchId: string;
  readonly salespersonId: string;
  readonly withdrawnBy: string;
  readonly reason: string;
  readonly fromStatus: string;
  readonly wasIssued: boolean;
  /** The gross of the version the buyer last saw (the accepted one, else the last issued); null for a draft never sent. */
  readonly grossPesewas: number | null;
  readonly heldReleasedQty: string;
  readonly abuseCase: 65;
  readonly at: string;
}
