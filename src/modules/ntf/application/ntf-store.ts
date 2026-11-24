import type { Transaction } from '../../../platform/database/unit-of-work';
import type { SortOrder } from '../../../platform/http/keyset-sort';
import type { LinkKind } from '../domain/links';
import type { AttemptOutcome, MessageStatus, SuppressedReason } from '../domain/messages';
import type { RecipientKind } from '../domain/routing';
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
  readonly recipientKind: 'CUSTOMER' | 'CONTACT' | 'STAFF';
  readonly customerId: string | null;
  /** The member of staff an in-app notification is for (B11 continued 11). */
  readonly principalId?: string | null;
  readonly addressMasked: string;
  readonly addressHash: Buffer | null;
  readonly renderedBody: string;
  /** An in-app notification's title (B11 continued 11). */
  readonly renderedSubject?: string | null;
  /** Where an in-app notification takes its reader in the console: a path, never a URL (B11 continued 11). */
  readonly linkPath?: string | null;
  /** The kind of record the message's link opens and the record, made when it is sent (B11 continued 12, ADR-0074). */
  readonly linkKind?: LinkKind | null;
  readonly linkRecordId?: string | null;
  readonly status: 'QUEUED' | 'DEFERRED_QUIET_HOURS' | 'SUPPRESSED';
  readonly suppressedReason: SuppressedReason | null;
  /** When a message deferred by quiet hours may go (B11 continued 11). */
  readonly sendAfter?: Date | null;
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
  readonly customerId: string | null;
  readonly principalId: string | null;
  readonly category: Category;
  readonly channel: Channel;
  readonly renderedBody: string;
  readonly renderedSubject: string | null;
  readonly linkPath: string | null;
  readonly linkKind: LinkKind | null;
  readonly linkRecordId: string | null;
  /** The attempt this send is: attempts already made plus one. */
  readonly attemptNo: number;
  readonly claimToken: string;
}

export type SendResult =
  | { readonly kind: 'SENT'; readonly providerRef: string; readonly addressMasked: string | null; readonly addressHash: Buffer | null; readonly inApp?: NewInAppNotification }
  | { readonly kind: 'DEFERRED'; readonly sendAfter: Date }
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

export interface TriggerRecord {
  readonly id: string;
  readonly eventType: string;
  readonly templateCode: string;
  readonly recipientKind: RecipientKind;
  readonly recipientRoleCode: string | null;
  readonly channels: readonly Channel[];
  readonly isActive: boolean;
  readonly version: number;
}

/** A recipient whose preferences are kept: a customer by its record, staff and investors by their principal. */
export type PreferenceOwner = { readonly customerId: string } | { readonly principalId: string };

export interface PreferenceRecord {
  readonly category: Category;
  readonly channel: Channel;
  readonly rank: number;
  readonly isEnabled: boolean;
  /** `HH:MM`, Africa/Accra. */
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
}

export interface OptOutRecord {
  readonly id: string;
  readonly addressHash: Buffer;
  readonly addressMasked: string;
  readonly channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
  readonly direction: 'OPT_OUT' | 'OPT_IN';
  readonly source: 'REPLY_STOP' | 'REPLY_START';
  readonly providerReportId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
}

export interface NewInAppNotification {
  readonly id: string;
  readonly principalId: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
}

export interface InAppRecord {
  readonly id: string;
  readonly principalId: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** NTF's own tables (migrations 0335 and 0338). */
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
  /** Whether a message of this source event and template already exists for the record, on any channel (FR-NTF-003). */
  messageExistsFor(tx: Transaction, sourceEventRef: string, code: string, recordId: string): Promise<boolean>;

  /** The live trigger for an event and a template, or null (B11 continued 11, FR-NTF-002). */
  triggerFor(tx: Transaction, eventType: string, templateCode: string): Promise<TriggerRecord | null>;
  trigger(tx: Transaction, id: string, lock: boolean): Promise<TriggerRecord | null>;
  /** Live triggers by event type then template code, after the position (event type, template code). */
  triggerPage(tx: Transaction, after: readonly [string, string] | null, limit: number): Promise<TriggerRecord[]>;
  updateTrigger(tx: Transaction, id: string, change: { readonly channels: readonly Channel[]; readonly isActive: boolean }, at: Date, actorId: string): Promise<void>;

  /** A recipient's live preferences, by category then rank. */
  preferencesOf(tx: Transaction, owner: PreferenceOwner): Promise<PreferenceRecord[]>;
  /** Retires a recipient's live preferences and writes these, ranked in their order within each category. */
  replacePreferences(tx: Transaction, owner: PreferenceOwner, rows: readonly (Omit<PreferenceRecord, 'rank'> & { readonly id: string })[], at: Date, actorId: string): Promise<void>;

  insertOptOut(tx: Transaction, o: OptOutRecord): Promise<void>;
  /** The channels whose latest instruction from this number is OPT_OUT. */
  optedOutChannels(tx: Transaction, addressHash: Buffer): Promise<ReadonlySet<Channel>>;
  /** Every opt-out and opt-in, the newest first, after the position (recorded at, id). */
  optOutPage(tx: Transaction, after: readonly [Date, string] | null, limit: number): Promise<OptOutRecord[]>;

  /** A principal's in-app notifications, the newest first, after the position (created at, id). */
  inAppPage(tx: Transaction, principalId: string, unreadOnly: boolean, after: readonly [Date, string] | null, limit: number): Promise<InAppRecord[]>;
  /** The principal's own notification by id, or null (another's is null too). */
  inApp(tx: Transaction, principalId: string, id: string, lock: boolean): Promise<InAppRecord | null>;
  markInAppRead(tx: Transaction, id: string, at: Date): Promise<void>;
  unreadCount(tx: Transaction, principalId: string): Promise<number>;
}
