import type { Transaction } from '../../../platform/database/unit-of-work';
import type { BreakRow, ExceptionDraft } from '../domain/classify';
import type { ExceptionKind, Severity } from '../domain/exception-kinds';
import type { StockExceptionRow } from '../domain/sweep';

export const EXCEPTION_STORE = Symbol('EXCEPTION_STORE');

/** An item as stored: the draft with its Africa/Accra date and the outbox message that raised it, if any. */
export interface StoredDraft extends ExceptionDraft {
  readonly exceptionDate: string;
  readonly eventRef: string | null;
}

export interface ReviewRecord {
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
  readonly note: string;
}

export interface ExceptionItemRecord {
  readonly id: string;
  readonly exceptionDate: string;
  readonly branchId: string | null;
  readonly kind: ExceptionKind;
  readonly sourceKind: string | null;
  readonly severity: Severity;
  readonly abuseCases: readonly number[];
  readonly actorId: string | null;
  readonly subjectId: string | null;
  readonly subjectDocType: string | null;
  readonly amountPesewas: bigint | null;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly raisedAt: Date;
  readonly restrictedTo: string | null;
  readonly review: ReviewRecord | null;
}

/** What a reader may see: whole branches they hold the read at, and where they also read the investor books. */
export interface ItemScope {
  readonly branchIds: readonly string[];
  readonly investorBranchIds: readonly string[];
}

export interface ItemFilter {
  readonly from: string;
  readonly to: string;
  readonly branchId?: string | undefined;
  readonly kind?: string | undefined;
  readonly severity?: string | undefined;
  readonly actorId?: string | undefined;
  readonly reviewed?: boolean | undefined;
}

export interface ApprovalFactRecord {
  readonly makerId: string;
  readonly checkerId: string;
  readonly amountPesewas: bigint | null;
}

export interface PayoutChangeRecord {
  readonly changeId: string;
  readonly changedAt: Date;
  readonly requestedBy: string | null;
  readonly approvedBy: string | null;
}

export interface BreakState {
  readonly id: string;
  readonly status: string;
  readonly raisedAt: Date;
  readonly resolvedAt: Date | null;
}

/** RPT's own tables for the daily exception report, and the published views and outbox it reads (ADR-0023, ADR-0103). */
export interface ExceptionStore {
  putItems(tx: Transaction, items: readonly StoredDraft[], replace: boolean): Promise<number>;
  checkpoint(tx: Transaction, projector: string, message: { readonly id: string; readonly recordedAt: Date } | null, at: Date, rebuilt: boolean): Promise<void>;
  checkpointOf(tx: Transaction, projector: string): Promise<{ readonly lastProcessedAt: Date | null; readonly lastRecordedAt: Date | null; readonly rebuiltAt: Date | null } | null>;
  clearProjections(tx: Transaction): Promise<void>;
  countItems(tx: Transaction): Promise<number>;

  putApproval(tx: Transaction, fact: { readonly eventId: string; readonly at: Date; readonly date: string; readonly branchId: string | null; readonly kind: string; readonly decision: string; readonly makerId: string; readonly checkerId: string; readonly amountPesewas: bigint | null }): Promise<void>;
  approvalsOn(tx: Transaction, date: string, branchIds: readonly string[]): Promise<ApprovalFactRecord[]>;

  putCheckout(tx: Transaction, checkoutId: string, addressHash: string | null, at: Date, date: string, outcome: 'STARTED' | 'EXPIRED' | 'CANCELLED' | 'COMPLETED'): Promise<void>;
  /** For one address and day: checkouts started, ended unpaid (expired or cancelled) and completed. */
  checkoutsOf(tx: Transaction, checkoutId: string): Promise<{ readonly addressHash: string | null; readonly date: string } | null>;
  checkoutCounts(tx: Transaction, addressHash: string, date: string): Promise<{ readonly started: number; readonly unpaid: number; readonly completed: number }>;

  putPayoutChange(tx: Transaction, change: { readonly eventId: string; readonly partyKind: 'SUPPLIER' | 'INVESTOR'; readonly partyId: string; readonly changeId: string; readonly at: Date; readonly requestedBy: string | null; readonly approvedBy: string | null }): Promise<void>;
  payoutChangesWithin(tx: Transaction, partyKind: 'SUPPLIER' | 'INVESTOR', partyId: string, from: Date, to: Date): Promise<PayoutChangeRecord[]>;

  stockExceptionsBetween(tx: Transaction, from: Date, to: Date): Promise<StockExceptionRow[]>;
  breaksBetween(tx: Transaction, from: Date, to: Date): Promise<BreakRow[]>;
  breakStates(tx: Transaction, ids: readonly string[]): Promise<Map<string, BreakState>>;
  /** Completed counter sales per salesperson on a day: the void rate's base. */
  completedSalesBySalesperson(tx: Transaction, date: string, branchIds: readonly string[]): Promise<Map<string, number>>;

  itemsOn(tx: Transaction, filter: ItemFilter, scope: ItemScope): Promise<ExceptionItemRecord[]>;
  listItems(tx: Transaction, filter: ItemFilter, scope: ItemScope, after: { readonly raisedAt: string; readonly id: string } | null, limit: number): Promise<ExceptionItemRecord[]>;
  item(tx: Transaction, id: string): Promise<ExceptionItemRecord | null>;
  insertReview(tx: Transaction, review: { readonly id: string; readonly itemId: string; readonly branchId: string | null; readonly itemActorId: string | null; readonly note: string; readonly at: Date; readonly actorId: string }): Promise<boolean>;
}
