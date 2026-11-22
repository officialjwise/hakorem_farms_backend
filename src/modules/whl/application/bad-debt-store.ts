import type { Transaction } from '../../../platform/database/unit-of-work';

export const BAD_DEBT_STORE = Symbol('BAD_DEBT_STORE');

/** A `whl.bad_debt_write_off_request` row. */
export interface WriteOffRequestRecord {
  readonly id: string;
  readonly customerId: string;
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly amountPesewas: bigint;
  readonly reason: string;
  readonly approvalRequestId: string;
  readonly status: 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'CANCELLED';
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** A `whl.bad_debt_write_off` row: the write-off applied. */
export interface WriteOffRecord {
  readonly id: string;
  readonly customerId: string;
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly amountPesewas: bigint;
  readonly writtenOffOn: string;
  readonly journalEntryId: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly recordedAt: Date;
}

/** WHL's bad-debt write-offs (FR-WHL-012, migration 0274). */
export interface BadDebtStore {
  insertRequest(tx: Transaction, request: WriteOffRequestRecord): Promise<void>;
  request(tx: Transaction, id: string): Promise<WriteOffRequestRecord | null>;
  requestByApproval(tx: Transaction, approvalRequestId: string): Promise<WriteOffRequestRecord | null>;
  /** The request waiting for a decision against a document, if any. */
  pendingFor(tx: Transaction, billingDocumentId: string): Promise<WriteOffRequestRecord | null>;
  decide(tx: Transaction, id: string, decision: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly at: Date }): Promise<void>;
  insertWriteOff(tx: Transaction, writeOff: WriteOffRecord, actorId: string): Promise<void>;
  /** What was written off each document by the end of a business day. */
  writtenOffAsAt(tx: Transaction, billingDocumentIds: readonly string[], asOf: string): Promise<ReadonlyMap<string, bigint>>;
  /** All that has ever been written off what the customer owes. */
  writtenOffFor(tx: Transaction, customerId: string): Promise<bigint>;
}
