import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PriceBasis, QuoteStatus, VersionStatus } from '../domain/quote';

export const QUOTE_STORE = Symbol('QUOTE_STORE');

export type RfqSource = 'PUBLIC_FORM' | 'REQUEST_TO_BUY' | 'PHONE' | 'WHATSAPP' | 'COUNTER' | 'WHOLESALE_ORDER';
export type RfqStatus = 'NEW' | 'IN_PROGRESS' | 'QUOTED' | 'CLOSED' | 'SPAM';

export interface RfqRecord {
  readonly id: string;
  readonly rfqNo: string;
  readonly source: RfqSource;
  readonly customerId: string | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly requirements: string;
  readonly productId: string | null;
  readonly stockUnitId: string | null;
  readonly qty: string | null;
  readonly uom: string | null;
  readonly neededBy: string | null;
  readonly deliveryArea: string | null;
  readonly assignedTo: string | null;
  readonly submittedIp: string | null;
  readonly consentToContact: boolean;
  readonly status: RfqStatus;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
}

export interface QuoteRecord {
  readonly id: string;
  readonly quoteNo: string;
  readonly rfqId: string | null;
  readonly customerId: string | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly salespersonId: string;
  readonly productLine: string | null;
  readonly currentVersionNo: number;
  readonly acceptedVersionId: string | null;
  readonly convertedOrderId: string | null;
  readonly declineReason: string | null;
  readonly cancelReason: string | null;
  readonly status: QuoteStatus;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface VersionRecord {
  readonly id: string;
  readonly quoteId: string;
  readonly versionNo: number;
  readonly status: VersionStatus;
  readonly validUntil: Date;
  readonly terms: string | null;
  readonly deliveryEstimate: string | null;
  readonly deliveryFeePesewas: bigint;
  readonly taxInclusive: boolean;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly estimatedCostPesewas: bigint | null;
  /** Markup over cost, stored in `margin_percent` (a name kept for one release, A-342). */
  readonly markupPercent: string | null;
  readonly belowMarginFloor: boolean;
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
  readonly changeNote: string | null;
  readonly issuedAt: Date | null;
  readonly issuedBy: string | null;
  readonly archivedDocumentId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface LineRecord {
  readonly id: string;
  readonly quoteVersionId: string;
  readonly lineNo: number;
  readonly productId: string | null;
  readonly description: string;
  readonly gradeId: string | null;
  readonly weightBandId: string | null;
  readonly stockUnitId: string | null;
  readonly reservationId: string | null;
  readonly qty: string;
  readonly uom: string;
  readonly baseQty: string | null;
  readonly priceBasis: PriceBasis;
  readonly resolvedUnitPricePesewas: bigint | null;
  readonly resolvedFloorUnitPricePesewas: bigint | null;
  readonly unitPricePesewas: bigint;
  readonly lineNetPesewas: bigint;
  readonly estimatedUnitCostPesewas: bigint | null;
}

export interface AcceptanceRecord {
  readonly id: string;
  readonly quoteVersionId: string;
  readonly method: 'SIGNED_LINK' | 'IN_PERSON' | 'PHONE_CONFIRMED';
  readonly acceptedName: string;
  readonly note: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly acceptedAt: Date;
}

export interface VersionFiguresPatch {
  readonly validUntil: Date;
  readonly terms: string | null;
  readonly deliveryEstimate: string | null;
  readonly deliveryFeePesewas: bigint;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly estimatedCostPesewas: bigint | null;
  /** Markup over cost, stored in `margin_percent` (a name kept for one release, A-342). */
  readonly markupPercent: string | null;
  readonly belowMarginFloor: boolean;
}

export interface RfqFilter {
  readonly branchIds: readonly string[];
  readonly status: RfqStatus | null;
  readonly source: RfqSource | null;
  readonly assignedToId: string | null;
}

export interface QuoteFilter {
  readonly branchIds: readonly string[];
  readonly status: QuoteStatus | null;
  readonly customerId: string | null;
  readonly salespersonId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** QUO's tables (migration 0251). Every write is in the caller's transaction; the database holds the rules. */
export interface QuoteStore {
  insertRfq(tx: Transaction, rfq: Omit<RfqRecord, 'version' | 'status'>, actorId: string): Promise<void>;
  rfqs(tx: Transaction, ids: readonly string[]): Promise<RfqRecord[]>;
  lockRfq(tx: Transaction, id: string): Promise<RfqRecord | null>;
  listRfqs(tx: Transaction, filter: RfqFilter, beforeId: string | null, limit: number): Promise<RfqRecord[]>;
  updateRfq(tx: Transaction, id: string, patch: { readonly status: RfqStatus; readonly customerId: string | null; readonly assignedTo: string | null }, actorId: string, at: Date): Promise<void>;
  quoteIdsOfRfqs(tx: Transaction, rfqIds: readonly string[]): Promise<ReadonlyMap<string, string[]>>;

  insertQuote(tx: Transaction, quote: Omit<QuoteRecord, 'version' | 'status' | 'currentVersionNo' | 'acceptedVersionId' | 'convertedOrderId' | 'declineReason' | 'cancelReason'>): Promise<void>;
  /** Ids of one customer's quotes that were ever issued, at every branch, newest first, before `beforeId` (listMyQuotes). */
  quoteIdsOfCustomer(tx: Transaction, customerId: string, beforeId: string | null, limit: number): Promise<string[]>;
  quotes(tx: Transaction, ids: readonly string[]): Promise<QuoteRecord[]>;
  lockQuote(tx: Transaction, id: string): Promise<QuoteRecord | null>;
  listQuotes(tx: Transaction, filter: QuoteFilter, beforeId: string | null, limit: number): Promise<QuoteRecord[]>;
  updateQuote(
    tx: Transaction,
    id: string,
    patch: Partial<Pick<QuoteRecord, 'status' | 'currentVersionNo' | 'acceptedVersionId' | 'convertedOrderId' | 'declineReason' | 'cancelReason'>>,
    actorId: string,
    at: Date,
  ): Promise<void>;
  /**
   * Issued quotes whose live version's validity ended before `now`, and accepted quotes accepted at or before
   * `acceptedBy` (their hold ends 7 days after acceptance, the owner, 2026-11-24), locked, skipping any a conversion
   * holds, by id.
   */
  lockLapsed(tx: Transaction, now: Date, limit: number, acceptedBy: Date): Promise<QuoteRecord[]>;

  insertVersion(tx: Transaction, version: Omit<VersionRecord, 'version' | 'status' | 'approvalRequestId' | 'approvedBy' | 'issuedAt' | 'issuedBy' | 'archivedDocumentId'>): Promise<void>;
  versionsOf(tx: Transaction, quoteIds: readonly string[]): Promise<VersionRecord[]>;
  version(tx: Transaction, id: string): Promise<VersionRecord | null>;
  setFigures(tx: Transaction, id: string, figures: VersionFiguresPatch, actorId: string, at: Date): Promise<void>;
  setVersionStatus(
    tx: Transaction,
    id: string,
    patch: {
      readonly status: VersionStatus;
      readonly approvalRequestId?: string | null;
      readonly approvedBy?: string | null;
      readonly approvedAt?: Date | null;
      readonly issuedAt?: Date | null;
      readonly issuedBy?: string | null;
    },
    actorId: string,
    at: Date,
  ): Promise<void>;
  replaceLines(tx: Transaction, versionId: string, lines: readonly LineRecord[]): Promise<void>;
  linesOf(tx: Transaction, versionIds: readonly string[]): Promise<LineRecord[]>;
  holdLine(tx: Transaction, lineId: string, reservationId: string): Promise<void>;

  insertAcceptance(tx: Transaction, acceptance: AcceptanceRecord, actorId: string, at: Date): Promise<void>;
  acceptancesOf(tx: Transaction, versionIds: readonly string[]): Promise<AcceptanceRecord[]>;

  insertLinkToken(tx: Transaction, token: { readonly id: string; readonly quoteVersionId: string; readonly tokenHash: Buffer; readonly expiresAt: Date }, actorId: string, at: Date): Promise<void>;
  linkToken(tx: Transaction, tokenHash: Buffer): Promise<{ readonly id: string; readonly quoteVersionId: string; readonly tokenHash: Buffer; readonly expiresAt: Date; readonly revoked: boolean } | null>;
  /** A version's links, oldest first, never their tokens (only the hash is kept, ADR-0074). */
  linksOf(tx: Transaction, versionIds: readonly string[]): Promise<LinkRecord[]>;
  link(tx: Transaction, id: string): Promise<LinkRecord | null>;
  insertLinkRevocation(tx: Transaction, revocation: { readonly id: string; readonly linkTokenId: string; readonly reason: string }, actorId: string, at: Date): Promise<void>;
  insertLinkDecision(tx: Transaction, decision: LinkDecisionRecord, actorId: string, at: Date): Promise<void>;
  /** The staff sessions matched to a link decision by its address (abuse case 40, A-343), one row each. */
  insertStaffMatches(tx: Transaction, rows: readonly StaffMatchRecord[], actorId: string, at: Date): Promise<void>;
  linkDecisionsOf(tx: Transaction, versionIds: readonly string[]): Promise<LinkDecisionRecord[]>;
  /** What a product line found on hand and held at issue (quo.quote_line_stock, migration 0288), once per line. */
  insertLineStock(tx: Transaction, row: LineStockRecord, actorId: string, at: Date): Promise<void>;
  lineStockOf(tx: Transaction, versionIds: readonly string[]): Promise<LineStockRecord[]>;
  /** The version's archived rendering, set once (ck_quote_version_frozen allows it once on an issued version). */
  setArchivedDocument(tx: Transaction, versionId: string, archivedDocumentId: string, actorId: string, at: Date): Promise<boolean>;
  /** The version of a quote archived as this revision (the version number), for DOC's archive event. */
  versionByNo(tx: Transaction, quoteId: string, versionNo: number): Promise<VersionRecord | null>;
  /** The pipeline's cells: issued quotes created in the period at these branches, by group and status (FR-QUO-013). */
  pipelineCells(tx: Transaction, filter: PipelineFilter): Promise<PipelineCell[]>;
}

/** quo.quote_line_stock: both quantities in the product's base unit (A-328). */
export interface LineStockRecord {
  readonly id: string;
  readonly quoteLineId: string;
  readonly quoteVersionId: string;
  readonly availableQty: string;
  readonly heldQty: string;
}

export interface PipelineFilter {
  readonly branchIds: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly groupBy: 'SALESPERSON' | 'PRODUCT_LINE';
}

/** One group and status: how many quotes and the gross of the version each shows (the accepted one, else the last issued). */
export interface PipelineCell {
  readonly groupKey: string | null;
  /** CANCELLED is a quote withdrawn after it was issued (A-329 (b)). */
  readonly status: 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CONVERTED' | 'CANCELLED';
  readonly count: number;
  readonly grossPesewas: bigint;
}

/** An acceptance link of a version (quo.quote_link_token with its revocation, if any). */
export interface LinkRecord {
  readonly id: string;
  readonly quoteVersionId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

/** The device and session behind a decision made through a link (quo.quote_link_decision, abuse case 40). */
export interface StaffMatchRecord {
  readonly id: string;
  readonly linkDecisionId: string;
  readonly staffPrincipalId: string;
  readonly staffSessionId: string;
  readonly sameBrowser: boolean;
  readonly sessionLastSeenAt: Date;
  readonly windowHours: number;
}

export interface LinkDecisionRecord {
  readonly id: string;
  readonly linkTokenId: string;
  readonly quoteVersionId: string;
  readonly decision: 'ACCEPTED' | 'DECLINED';
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Only on a decision B10 continued 4 recorded from the staff cookie (A-325 (c), withdrawn); null on every later one. */
  readonly staffPrincipalId: string | null;
  readonly staffSessionId: string | null;
  readonly decidedAt: Date;
}
