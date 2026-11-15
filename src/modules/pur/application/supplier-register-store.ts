import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PayoutMethod } from '../domain/payout-details';
import type { RequisitionStatus } from '../domain/requisition';
import type { ReadScope } from './purchasing-store';

export interface ProfileRecord {
  readonly supplierId: string;
  readonly paymentTermsDays: number;
  readonly leadTimeDays: number | null;
  readonly notes: string | null;
  /** The approved payout change in force, or null when none was ever approved. */
  readonly payoutChangeId: string | null;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface ProfileTerms {
  readonly paymentTermsDays?: number | undefined;
  readonly leadTimeDays?: number | undefined;
  readonly notes?: string | undefined;
}

export type PayoutChangeStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface PayoutChangeRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly method: PayoutMethod;
  /** Ciphertext under the supplier's subject key, bound to this row; null for cash and cheques. */
  readonly detailsEnc: Buffer | null;
  readonly masked: string;
  readonly terms: ProfileTerms;
  readonly approvalRequestId: string;
  readonly status: PayoutChangeStatus;
  readonly branchId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export type NewPayoutChange = Omit<PayoutChangeRecord, 'status' | 'createdAt'>;

export type SupplierDocumentKind = 'REGISTRATION' | 'CONTRACT' | 'HEALTH_CERTIFICATE' | 'TAX_CLEARANCE' | 'OTHER';

export interface SupplierDocumentRecord {
  readonly id: string;
  readonly supplierId: string;
  readonly kind: SupplierDocumentKind;
  readonly fileId: string;
  readonly expiresOn: string | null;
  readonly createdAt: Date;
}

export interface RequisitionLineRecord {
  readonly id: string;
  readonly lineNo: number;
  readonly productId: string;
  readonly qty: string;
  readonly note: string | null;
}

export interface RequisitionHeader {
  readonly locationId: string | null;
  readonly neededBy: string | null;
  readonly justification: string | null;
  readonly branchId: string;
}

export interface RequisitionRecord extends RequisitionHeader {
  readonly id: string;
  readonly requisitionNo: string | null;
  readonly status: RequisitionStatus;
  readonly requestedBy: string;
  readonly purchaseOrderId: string | null;
  readonly rejectReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly lines: readonly RequisitionLineRecord[];
}

export interface RequisitionFilter {
  readonly status?: RequisitionStatus | undefined;
  readonly requestedBy?: string | undefined;
}

/** PUR's supplier register and requisition tables (migrations 0098 and 0099). */
export interface SupplierRegisterStore {
  profile(tx: Transaction, supplierId: string, lock: boolean): Promise<ProfileRecord | null>;
  /** Opens a supplier's profile with no terms; does nothing if it is open. */
  openProfile(tx: Transaction, supplierId: string, actorId: string): Promise<void>;
  updateTerms(tx: Transaction, supplierId: string, terms: ProfileTerms, actorId: string): Promise<void>;
  putPayoutInForce(tx: Transaction, supplierId: string, payoutChangeId: string, actorId: string): Promise<void>;
  payoutChange(tx: Transaction, id: string, lock: boolean): Promise<PayoutChangeRecord | null>;
  pendingPayoutChange(tx: Transaction, supplierId: string): Promise<PayoutChangeRecord | null>;
  insertPayoutChange(tx: Transaction, change: NewPayoutChange): Promise<void>;
  decidePayoutChange(tx: Transaction, id: string, status: Exclude<PayoutChangeStatus, 'PENDING_APPROVAL'>, reason: string | null, decidedBy: string): Promise<void>;

  documents(tx: Transaction, supplierId: string, beforeId: string | null, limit: number): Promise<SupplierDocumentRecord[]>;
  documentOfFile(tx: Transaction, fileId: string): Promise<SupplierDocumentRecord | null>;
  insertDocument(tx: Transaction, document: Omit<SupplierDocumentRecord, 'createdAt'>, actorId: string): Promise<void>;

  requisition(tx: Transaction, id: string, lock: boolean): Promise<RequisitionRecord | null>;
  listRequisitions(tx: Transaction, filter: RequisitionFilter, scopes: readonly ReadScope[], beforeId: string | null, limit: number): Promise<RequisitionRecord[]>;
  insertRequisition(tx: Transaction, id: string, header: RequisitionHeader, lines: readonly Omit<RequisitionLineRecord, 'lineNo'>[], actorId: string): Promise<void>;
  updateRequisition(tx: Transaction, id: string, header: Omit<RequisitionHeader, 'branchId' | 'locationId'>, lines: readonly Omit<RequisitionLineRecord, 'lineNo'>[] | null, actorId: string): Promise<void>;
  markRequisition(tx: Transaction, id: string, status: RequisitionStatus, change: { readonly purchaseOrderId?: string; readonly rejectReason?: string }, actorId: string): Promise<void>;
}

export const SUPPLIER_REGISTER_STORE = Symbol('SUPPLIER_REGISTER_STORE');
