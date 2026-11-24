import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SortOrder } from '../../../platform/http/keyset-sort';
import type { AttemptOutcome, MessageStatus, SuppressedReason } from '../domain/messages';
import type { Category, Channel, TemplateStatus } from '../domain/templates';

export const NTF_STORE = Symbol('NTF_STORE');

export interface TemplateRecord {
  readonly id: string;
  readonly code: string;
  readonly channel: Channel;
  readonly locale: string;
  readonly category: Category;
  readonly subject: string | null;
  readonly body: string;
  readonly providerTemplateRef: string | null;
  readonly versionNo: number;
  readonly status: TemplateStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly position: readonly string[];
}

export interface TemplateFilters {
  readonly code: string | null;
  readonly channel: string | null;
  readonly status: string | null;
}

export interface NewMessage {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly sourceEventRef: string;
  readonly sourceEventType: string;
  readonly branchId: string | null;
  readonly salesOrderId: string | null;
  readonly templateId: string;
  readonly channel: Channel;
  readonly category: Category;
  readonly recipientKind: 'CUSTOMER' | 'CONTACT';
  readonly customerId: string | null;
  readonly addressMasked: string;
  readonly addressHash: Buffer | null;
  readonly renderedBody: string;
  readonly status: 'QUEUED' | 'SUPPRESSED';
  readonly suppressedReason: SuppressedReason | null;
  readonly at: Date;
  readonly actorId: string;
}

export interface MessageRecord {
  readonly id: string;
  readonly sourceEventRef: string;
  readonly sourceEventType: string;
  readonly branchId: string | null;
  readonly salesOrderId: string | null;
  readonly templateId: string;
  readonly templateCode: string;
  readonly channel: Channel;
  readonly category: Category;
  readonly recipientKind: 'CUSTOMER' | 'STAFF' | 'INVESTOR' | 'CONTACT';
  readonly customerId: string | null;
  readonly principalId: string | null;
  readonly addressMasked: string;
  readonly renderedBody: string | null;
  readonly status: MessageStatus;
  readonly suppressedReason: SuppressedReason | null;
  readonly failureReason: string | null;
  readonly attempts: number;
  readonly sendAfter: Date | null;
  readonly providerMessageRef: string | null;
  readonly sentAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly createdAt: Date;
  readonly position: readonly string[];
}

export interface AttemptRecord {
  readonly messageId: string;
  readonly attemptNo: number;
  readonly outcome: AttemptOutcome;
  readonly providerResponse: string | null;
  readonly attemptedAt: Date;
}

export interface MessageFilters {
  readonly branchIds: readonly string[];
  readonly status: string | null;
  readonly channel: string | null;
  readonly customerId: string | null;
  readonly templateCode: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

/** A message a sender holds while it sends, by the claim token only that sender knows. */
export interface ClaimedMessage {
  readonly id: string;
  readonly salesOrderId: string | null;
  readonly channel: Channel;
  readonly renderedBody: string;
  /** The attempt this send is: attempts already made plus one. */
  readonly attemptNo: number;
  readonly claimToken: string;
}

export type SendResult =
  | { readonly kind: 'SENT'; readonly providerRef: string; readonly addressMasked: string; readonly addressHash: Buffer }
  | { readonly kind: 'QUEUED'; readonly sendAfter: Date; readonly reason: string }
  | { readonly kind: 'FAILED'; readonly reason: string }
  | { readonly kind: 'SUPPRESSED'; readonly reason: SuppressedReason };

export type ReportOutcome = 'APPLIED' | 'NO_CHANGE' | 'UNKNOWN_MESSAGE' | 'IGNORED' | 'REPLAYED' | 'REJECTED_SIGNATURE' | 'REJECTED_MALFORMED';

export interface ProviderReportRecord {
  readonly id: string;
  readonly provider: string;
  readonly reportKey: string | null;
  readonly outcome: ReportOutcome;
  readonly messageId: string | null;
  readonly reportedStatus: 'DELIVERED' | 'FAILED' | null;
  readonly payloadHash: Buffer;
  readonly sourceIp: string | null;
  readonly receivedAt: Date;
  readonly actorId: string;
}

/** NTF's own tables (migration 0335). */
export interface NtfStore {
  insertTemplate(tx: Transaction, t: Omit<TemplateRecord, 'version' | 'position'> & { readonly at: Date }): Promise<void>;
  template(tx: Transaction, id: string, lock: boolean): Promise<TemplateRecord | null>;
  templates(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, TemplateRecord>>;
  /** The highest version number of a code, channel and locale, locking its versions; 0 for a new one. */
  lastVersionNo(tx: Transaction, code: string, channel: string, locale: string): Promise<number>;
  activeTemplate(tx: Transaction, code: string, channel: string, locale: string, lock: boolean): Promise<TemplateRecord | null>;
  setTemplateStatus(tx: Transaction, id: string, status: 'ACTIVE' | 'RETIRED', at: Date, actorId: string): Promise<void>;
  templatePage(tx: Transaction, filters: TemplateFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<TemplateRecord[]>;

  /** Inserts the message unless its idempotency key exists; true when this call wrote it (FR-NTF-003). */
  insertMessage(tx: Transaction, m: NewMessage): Promise<boolean>;
  /** Messages queued to the keyed address since the instant, suppressed ones left out (abuse case 58). */
  queuedToAddressSince(tx: Transaction, addressHash: Buffer, since: Date): Promise<number>;
  /** Claims up to `limit` due messages for one sender (SKIP LOCKED): queued and due, or held past an expired claim. */
  claimDue(tx: Transaction, c: { readonly now: Date; readonly until: Date; readonly token: string; readonly limit: number; readonly actorId: string }): Promise<ClaimedMessage[]>;
  /** Writes the attempt and the message's new state, only while the claim is still this sender's; false when it is not. */
  finishAttempt(tx: Transaction, f: { readonly id: string; readonly token: string; readonly attemptNo: number; readonly outcome: AttemptOutcome | null; readonly providerResponse: string | null; readonly result: SendResult; readonly at: Date; readonly actorId: string }): Promise<boolean>;
  message(tx: Transaction, id: string, lock: boolean): Promise<MessageRecord | null>;
  messagePage(tx: Transaction, filters: MessageFilters, order: SortOrder, position: readonly string[] | null, limit: number): Promise<MessageRecord[]>;
  attemptsOf(tx: Transaction, messageIds: readonly string[]): Promise<AttemptRecord[]>;
  requeue(tx: Transaction, id: string, at: Date, actorId: string): Promise<void>;
  /** A delivery report's one change: the message's delivery status, and when. */
  applyReport(tx: Transaction, id: string, status: 'DELIVERED' | 'FAILED', at: Date, actorId: string): Promise<void>;
  /** Logs a report; false when one with its provider and key was already logged (a replay). */
  insertReport(tx: Transaction, r: ProviderReportRecord): Promise<boolean>;
}
