import type { Transaction } from '../../../platform/database/unit-of-work';
import type { DunningChannel, DunningLevelRule } from '../domain/dunning';

export const DUNNING_STORE = Symbol('DUNNING_STORE');

/** What the ageing report and the dunning job need of a business account. */
export interface AccountFacts {
  readonly customerId: string;
  readonly branchId: string;
  readonly creditLimitPesewas: bigint;
  readonly status: 'ACTIVE' | 'ON_HOLD' | 'CLOSED';
  readonly accountManagerId: string | null;
}

/** A `whl.dunning_notice` row. */
export interface DunningNoticeRecord {
  readonly id: string;
  readonly customerId: string;
  readonly billingDocumentId: string;
  readonly branchId: string;
  readonly level: number;
  readonly daysPastDue: number;
  readonly outstandingPesewas: bigint;
  readonly channels: readonly DunningChannel[];
  readonly templateCode: string;
  readonly noticeDate: string;
  readonly queuedAt: Date;
}

/** A `whl.dunning_notice_delivery` row (B11 continued 13): what NTF reported of a notice's reminder on a channel. */
export interface NoticeDeliveryRecord {
  readonly id: string;
  readonly noticeId: string;
  readonly channel: DunningChannel;
  readonly status: 'SENT' | 'DELIVERED' | 'FAILED';
  readonly messageRef: string;
  readonly occurredAt: Date;
}

export interface DunningNoticeFilter {
  readonly branchIds: readonly string[];
  readonly customerId: string | null;
  readonly from: Date | null;
}

/** WHL's ageing and dunning reads and writes (migration 0265); the guard of `whl.dunning_notice` decides too. */
export interface DunningStore {
  accountsOf(tx: Transaction, customerIds: readonly string[]): Promise<ReadonlyMap<string, AccountFacts>>;
  /** Customers whose account names this account manager. */
  customersManagedBy(tx: Transaction, accountManagerId: string): Promise<string[]>;
  /** Accounts not closed, by customer id after `afterId`, for the dunning job. */
  openAccounts(tx: Transaction, afterId: string | null, limit: number): Promise<AccountFacts[]>;
  /** The live levels, lowest first. */
  levels(tx: Transaction): Promise<DunningLevelRule[]>;
  /** Soft-deletes every live level and writes the new ones, in the caller's transaction. */
  replaceLevels(tx: Transaction, levels: readonly (DunningLevelRule & { readonly id: string })[], actorId: string, at: Date): Promise<void>;
  /** The levels that have reached each document. */
  sentLevels(tx: Transaction, billingDocumentIds: readonly string[]): Promise<ReadonlyMap<string, number[]>>;
  /** Writes a notice; false if this level has already reached the document (`uq_dunning_notice_level`), which changes nothing. */
  insertNotice(tx: Transaction, notice: DunningNoticeRecord, actorId: string): Promise<boolean>;
  /** Newest first, before `beforeId`. */
  /** Notices by id (B11 continued 11: NTF's reminder reads the notice it sends, never the event's copy). */
  noticesById(tx: Transaction, ids: readonly string[]): Promise<DunningNoticeRecord[]>;
  notices(tx: Transaction, filter: DunningNoticeFilter, beforeId: string | null, limit: number): Promise<DunningNoticeRecord[]>;
  /** Writes what NTF reported; false when this message's status is already recorded (`uq_dunning_notice_delivery`). */
  insertDelivery(tx: Transaction, delivery: NoticeDeliveryRecord, at: Date, actorId: string): Promise<boolean>;
  /** Every delivery recorded for the notices, oldest first. */
  deliveriesOf(tx: Transaction, noticeIds: readonly string[]): Promise<NoticeDeliveryRecord[]>;
}
