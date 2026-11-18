import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CreditReason } from '../domain/credit';

/** A business account as stored (`whl.business_account`). */
export interface AccountRecord {
  readonly customerId: string;
  readonly branchId: string;
  readonly creditLimitPesewas: bigint;
  readonly paymentTermsDays: number;
  readonly accountManagerId: string | null;
  readonly overdueHoldDays: number;
  readonly status: 'ACTIVE' | 'ON_HOLD' | 'CLOSED';
  readonly holdReason: string | null;
  readonly heldAt: Date | null;
  readonly heldBy: string | null;
  readonly holdDocumentId: string | null;
  /** The overdue job placed the hold (0269): paying off what is overdue releases it (decision 4 on A-314). */
  readonly holdAutomatic: boolean;
  readonly version: number;
}

export interface NewAccount {
  readonly customerId: string;
  readonly branchId: string;
  readonly paymentTermsDays: number;
  readonly accountManagerId: string | null;
  readonly overdueHoldDays: number;
}

/** A change that needs a second person (`whl.account_change`). */
export interface AccountChangeRecord {
  readonly id: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly kind: 'CREDIT_LIMIT' | 'RELEASE';
  readonly creditLimitPesewas: bigint | null;
  readonly previousLimitPesewas: bigint | null;
  readonly reason: string;
  readonly approvalRequestId: string;
  readonly status: 'PENDING_APPROVAL' | 'APPLIED' | 'REJECTED' | 'CANCELLED';
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** The figures an override was asked or approved on (`whl.credit_override_request`, `whl.credit_override`). */
export interface OverrideFigures {
  readonly orderId: string;
  readonly customerId: string;
  readonly branchId: string;
  readonly approvalRequestId: string;
  readonly reason: string;
  readonly reasons: readonly CreditReason[];
  readonly limitPesewas: bigint;
  readonly orderPesewas: bigint;
  readonly overLimitPesewas: bigint;
  readonly requestedBy: string;
}

export interface OverrideRequestRecord extends OverrideFigures {
  readonly id: string;
  /** Exposure before the order. */
  readonly exposurePesewas: bigint;
  readonly recordedAt: Date;
}

export interface OverrideRecord extends OverrideFigures {
  readonly id: string;
  readonly requestId: string;
  /** Exposure with the order. */
  readonly exposurePesewas: bigint;
  readonly approvedBy: string;
  readonly recordedAt: Date;
}

export interface AccountFilter {
  readonly branchIds: readonly string[];
  readonly status: string | null;
  readonly accountManagerId: string | null;
}

export interface OverrideFilter {
  readonly branchIds: readonly string[];
  readonly customerId: string | null;
  /** Inclusive instants. */
  readonly from: Date | null;
  readonly to: Date | null;
}

/** WHL's business account and credit control tables. */
export interface AccountStore {
  insertAccount(tx: Transaction, account: NewAccount, actorId: string, at: Date): Promise<void>;
  account(tx: Transaction, customerId: string, lock: boolean): Promise<AccountRecord | null>;
  /** Accounts after `afterId` (by customer id), at most `limit`. */
  accounts(tx: Transaction, filter: AccountFilter, afterId: string | null, limit: number): Promise<AccountRecord[]>;
  /** Active accounts after `afterId`, for the overdue hold. */
  activeAccounts(tx: Transaction, afterId: string | null, limit: number): Promise<AccountRecord[]>;
  updateTerms(tx: Transaction, customerId: string, terms: { readonly paymentTermsDays: number; readonly accountManagerId: string | null; readonly overdueHoldDays: number; readonly status: AccountRecord['status'] }, actorId: string, at: Date): Promise<void>;
  setLimit(tx: Transaction, customerId: string, limitPesewas: bigint, changeId: string, actorId: string, at: Date): Promise<void>;
  hold(tx: Transaction, customerId: string, hold: { readonly reason: string; readonly documentId: string | null; readonly by: string; readonly at: Date; readonly automatic: boolean }): Promise<void>;
  /** Releases a hold the system placed, without a release change (0269's guard allows only that). */
  releaseAutomatic(tx: Transaction, customerId: string, actorId: string, at: Date): Promise<void>;
  /** Accounts on a hold the system placed, after `afterId`. */
  heldAutomatically(tx: Transaction, afterId: string | null, limit: number): Promise<AccountRecord[]>;
  release(tx: Transaction, customerId: string, changeId: string, actorId: string, at: Date): Promise<void>;
  insertChange(tx: Transaction, change: AccountChangeRecord): Promise<void>;
  change(tx: Transaction, id: string): Promise<AccountChangeRecord | null>;
  changeByApproval(tx: Transaction, approvalRequestId: string): Promise<AccountChangeRecord | null>;
  pendingChange(tx: Transaction, customerId: string, kind: 'CREDIT_LIMIT' | 'RELEASE'): Promise<AccountChangeRecord | null>;
  decideChange(tx: Transaction, id: string, decision: { readonly status: 'APPLIED' | 'REJECTED' | 'CANCELLED'; readonly by: string; readonly reason: string | null; readonly at: Date }): Promise<void>;
  insertOverrideRequest(tx: Transaction, request: OverrideRequestRecord, actorId: string): Promise<void>;
  overrideRequestByApproval(tx: Transaction, approvalRequestId: string): Promise<OverrideRequestRecord | null>;
  insertOverride(tx: Transaction, override: OverrideRecord, actorId: string): Promise<void>;
  overridesOfOrder(tx: Transaction, orderId: string): Promise<OverrideRecord[]>;
  /** Newest first, before `beforeId`. */
  overrides(tx: Transaction, filter: OverrideFilter, beforeId: string | null, limit: number): Promise<OverrideRecord[]>;
}

export const ACCOUNT_STORE = Symbol('ACCOUNT_STORE');
