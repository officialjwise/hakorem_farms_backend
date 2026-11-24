import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ReceiptTokenRefusal } from '../domain/receipt-link';

export const RECEIPT_LINK_STORE = Symbol('RECEIPT_LINK_STORE');

/** A tender as the till took it, kept with the link so the receipt shows what was handed over (A-284 (d)). */
export interface ReceiptTenderRecord {
  readonly paymentMethodId: string;
  readonly amountPesewas: number;
  readonly tenderedPesewas: number | null;
  readonly unverified: boolean;
}

export interface NewReceiptLink {
  readonly id: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly shiftId: string;
  readonly deviceId: string;
  readonly tokenHash: Buffer;
  /** The sale's time; the link reads for twelve months from it, worked out by the database (ck_receipt_link_expiry). */
  readonly issuedAt: Date;
  readonly tenders: readonly ReceiptTenderRecord[];
  readonly changePesewas: bigint;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** Which sale, shift and device a token is bound to, for a refusal's facts. */
export interface ReceiptBindingRecord {
  readonly saleId: string;
  readonly shiftId: string;
  readonly deviceId: string;
}

export interface ReceiptLinkRecord {
  readonly id: string;
  readonly orderDocumentId: string;
  readonly branchId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly tenders: readonly ReceiptTenderRecord[];
  readonly changePesewas: bigint;
  readonly revoked: boolean;
}

export interface NewReceiptTokenRefusal {
  readonly orderDocumentId: string;
  readonly tokenHash: Buffer;
  readonly reason: ReceiptTokenRefusal;
  readonly boundOrderDocumentId: string | null;
  readonly branchId: string;
  readonly shiftId: string;
  readonly deviceId: string;
  readonly cashierId: string;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** A sale's link as a revocation reads it: its branch for the authorisation, and whether it is already revoked. */
export interface ReceiptLinkOfSale {
  readonly id: string;
  readonly branchId: string;
  readonly revoked: boolean;
}

export interface NewReceiptLinkRevocation {
  readonly receiptLinkId: string;
  readonly reason: string;
  readonly revokedAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

/** POS's receipt links (`pos.receipt_link`, `pos.receipt_link_revocation`, `pos.receipt_token_refusal`). */
export interface ReceiptLinkStore {
  /** The link a token's hash is bound to, whatever its expiry or revocation; null when none. */
  bindingOfToken(tx: Transaction, tokenHash: Buffer): Promise<ReceiptBindingRecord | null>;
  /** The link a token's hash opens at an instant: bound, not expired and not revoked; null otherwise. */
  liveLink(tx: Transaction, tokenHash: Buffer, at: Date): Promise<ReceiptLinkRecord | null>;
  insertLink(tx: Transaction, link: NewReceiptLink): Promise<void>;
  insertRefusal(tx: Transaction, refusal: NewReceiptTokenRefusal): Promise<void>;
  /** The link a sale holds, revoked or not; null when the sale holds none. */
  linkOfSale(tx: Transaction, saleId: string): Promise<ReceiptLinkOfSale | null>;
  /** Once per link (its primary key); `pos.receipt_link_revocation_guard` holds who may. */
  insertRevocation(tx: Transaction, revocation: NewReceiptLinkRevocation): Promise<void>;
  /** The sale's till link live at an instant (not expired, not revoked): what a message link answers; null otherwise. */
  liveTillLinkOfSale(tx: Transaction, saleId: string, at: Date): Promise<{ readonly id: string; readonly expiresAt: Date } | null>;
  /** A link sent by message (B11 continued 12): the hash of a fresh token, of the sale's till link, expiring with it. */
  insertMessageLink(tx: Transaction, link: NewReceiptMessageLink): Promise<void>;
}

/** A receipt link for a message (`pos.receipt_message_link`, B11 continued 12): never the token, only its hash. */
export interface NewReceiptMessageLink {
  readonly id: string;
  readonly receiptLinkId: string;
  readonly orderDocumentId: string;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}
