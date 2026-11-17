import type { Transaction } from '../../../platform/database/unit-of-work';

export const SUPPLIER_CLAIM_STORE = Symbol('SUPPLIER_CLAIM_STORE');

export type ClaimStatus = 'OPEN' | 'SETTLED';
export type ClaimSettlement = 'INVOICE' | 'CREDIT_NOTE';

/** One rejected receipt line on a claim (migration 0223): base quantities and exact pesewas. */
export interface ClaimLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly goodsReceiptLineId: string;
  readonly purchaseOrderLineId: string;
  readonly productId: string;
  readonly rejectionReasonCode: string;
  readonly qtyAcceptedBase: string;
  readonly qtyRejectedBase: string;
  readonly lineValuePesewas: bigint;
  readonly acceptedValuePesewas: bigint;
  readonly claimedValuePesewas: bigint;
}

export interface ClaimRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly purchaseOrderId: string;
  readonly goodsReceiptId: string;
  readonly receivedBy: string;
  readonly note: string | null;
  readonly claimedPesewas: bigint;
  readonly status: ClaimStatus;
  readonly settlement: ClaimSettlement | null;
  readonly settledByInvoiceId: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly postedAt: Date | null;
  readonly postedBy: string | null;
  readonly lines: readonly ClaimLineRecord[];
}

export interface ClaimFilter {
  readonly status?: ClaimStatus | undefined;
  readonly supplierId?: string | undefined;
  readonly purchaseOrderId?: string | undefined;
  readonly goodsReceiptId?: string | undefined;
}

/** PUR's claim tables (migration 0223), always in the caller's transaction. */
export interface SupplierClaimStore {
  insertClaim(tx: Transaction, claim: Omit<ClaimRecord, 'status' | 'settlement' | 'settledByInvoiceId' | 'version' | 'postedAt' | 'postedBy'>): Promise<void>;
  claim(tx: Transaction, id: string): Promise<ClaimRecord | null>;
  lockClaim(tx: Transaction, id: string): Promise<ClaimRecord | null>;
  claimOfReceipt(tx: Transaction, goodsReceiptId: string): Promise<ClaimRecord | null>;
  listClaims(tx: Transaction, filter: ClaimFilter, branches: readonly string[], beforeId: string | null, limit: number): Promise<ClaimRecord[]>;
  /** By order line: the rejected base quantity of claims not settled by an invoice, which the match allows (ADR-0076). */
  claimedQty(tx: Transaction, orderLineIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** By order line: the rejected base quantity of claims other than `exceptClaimId` settled or being settled by a credit note. */
  creditedQty(tx: Transaction, orderLineIds: readonly string[], exceptClaimId: string): Promise<ReadonlyMap<string, string>>;
  /** Each claim's credit note that is not cancelled, if any. */
  liveCreditNotes(tx: Transaction, claimIds: readonly string[]): Promise<ReadonlyMap<string, { readonly id: string; readonly status: string; readonly supplierInvoiceNo: string }>>;
  settle(tx: Transaction, id: string, settlement: ClaimSettlement, invoiceId: string, actorId: string, at: Date): Promise<void>;
}
