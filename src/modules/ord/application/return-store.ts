import type { Transaction } from '../../../platform/database/unit-of-work';

export type ReturnStatus = 'REQUESTED' | 'PENDING_APPROVAL' | 'COMPLETED' | 'REJECTED';
export type Disposition = 'RESTOCK' | 'RETURNS_HOLD' | 'WRITE_OFF';
export type RefundDestination = 'ORIGINAL_METHOD' | 'STORE_CREDIT' | 'CASH';

export interface ReturnLineRecord {
  readonly id: string;
  readonly salesOrderLineId: string;
  readonly lineNo: number;
  readonly qty: string;
  readonly weightKg: string | null;
  readonly disposition: Disposition;
  readonly refundPesewas: bigint;
  readonly stockMovementId: string | null;
}

export interface ReturnRecord {
  readonly id: string;
  readonly returnNo: string;
  readonly salesOrderId: string;
  readonly originalBillingDocumentId: string;
  readonly kind: 'RETURN' | 'EXCHANGE';
  readonly reasonCode: string;
  readonly refundDestination: RefundDestination;
  readonly note: string | null;
  readonly status: ReturnStatus;
  readonly approvalRequestId: string | null;
  readonly creditNoteId: string | null;
  readonly refundId: string | null;
  readonly submittedBy: string | null;
  readonly decidedBy: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly lines: readonly ReturnLineRecord[];
}

export type NewReturn = Omit<ReturnRecord, 'status' | 'approvalRequestId' | 'creditNoteId' | 'refundId' | 'submittedBy' | 'decidedBy' | 'version' | 'createdAt' | 'lines'> & {
  readonly lines: readonly Omit<ReturnLineRecord, 'stockMovementId'>[];
};

/** ORD's returns (migration 0200). Point reads by key; the database holds what may be returned. */
export interface ReturnStore {
  insert(tx: Transaction, r: NewReturn): Promise<void>;
  /** Returns with their lines, by id; `forUpdate` locks the headers. Unknown ids are absent. */
  returns(tx: Transaction, ids: readonly string[], forUpdate?: boolean): Promise<ReturnRecord[]>;
  idByApproval(tx: Transaction, approvalRequestId: string): Promise<string | null>;
  /** What returns not REJECTED hold of each sold line, as decimal strings; a line with none is absent. */
  returnedOf(tx: Transaction, salesOrderLineIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  submit(tx: Transaction, id: string, s: { readonly approvalRequestId: string; readonly actorId: string; readonly at: Date }): Promise<void>;
  setLine(tx: Transaction, lineId: string, l: { readonly refundPesewas: bigint; readonly stockMovementId: string | null }): Promise<void>;
  decide(tx: Transaction, id: string, d: { readonly status: 'COMPLETED' | 'REJECTED'; readonly creditNoteId: string | null; readonly refundId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void>;
}

export const RETURN_STORE = Symbol('ReturnStore');
