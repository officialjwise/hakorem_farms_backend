import type { Transaction } from '../../../platform/database/unit-of-work';
import type { ManualJournalStatus } from '../domain/manual-journal';
import type { DeterminantType, RuleDeterminant, Side, SubledgerKind } from '../domain/posting';
import type { DatedDetermination, DatedRule } from '../domain/rule-change';

export const JOURNAL_STORE = Symbol('JOURNAL_STORE');

export interface AccountRefRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface PartyRow {
  readonly id: string;
  readonly kind: SubledgerKind;
  readonly refId: string;
  readonly displayName: string;
}

/** A posted journal entry's header, with the total of its debits. */
export interface EntryHeader {
  readonly id: string;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly periodId: string;
  readonly fiscalYear: number;
  readonly periodNo: number;
  readonly branchId: string;
  readonly kind: 'AUTO' | 'MANUAL' | 'OPENING' | 'CLOSING' | 'REVERSAL';
  readonly eventCode: string | null;
  readonly sourceDocumentId: string;
  readonly postingGroupId: string;
  readonly description: string;
  readonly reversesEntryId: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorId: string;
  readonly totalPesewas: bigint;
}

export interface EntryLine {
  readonly entryId: string;
  readonly lineNo: number;
  readonly account: AccountRefRow;
  readonly side: Side;
  readonly amountPesewas: bigint;
  readonly branchId: string;
  readonly party: PartyRow | null;
  readonly productLine: string | null;
  readonly memo: string | null;
}

export interface EntryFilters {
  readonly from: string | null;
  readonly to: string | null;
  readonly accountId: string | null;
  readonly sourceDocumentId: string | null;
  readonly postingGroupId: string | null;
  readonly eventCode: string | null;
  readonly kind: string | null;
}

/** Newest first: entries before this position. */
export interface EntryPosition {
  readonly postingDate: string;
  readonly id: string;
}

export interface ActivityFilters {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly partyId: string | null;
  readonly branchId: string | null;
}

/** Oldest first: lines after this position. */
export interface ActivityPosition {
  readonly postingDate: string;
  readonly entryId: string;
  readonly lineNo: number;
}

export interface ActivityLine {
  readonly entryId: string;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly description: string;
  readonly lineNo: number;
  readonly side: Side;
  readonly amountPesewas: bigint;
  readonly sourceDocumentId: string;
}

export interface ManualJournalRow {
  readonly id: string;
  readonly kind: 'MANUAL' | 'OPENING';
  readonly postingDate: string;
  readonly description: string;
  readonly branchId: string;
  readonly status: ManualJournalStatus;
  readonly revision: number;
  readonly approvalRequestId: string | null;
  readonly journalEntryId: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface ManualLineRow {
  readonly id: string;
  readonly lineNo: number;
  readonly account: AccountRefRow;
  readonly side: Side;
  readonly amountPesewas: bigint;
  readonly party: PartyRow | null;
  readonly memo: string | null;
}

export interface NewManualLine {
  readonly id: string;
  readonly lineNo: number;
  readonly accountId: string;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly subledgerPartyId: string | null;
  readonly memo: string | null;
}

/** An account as a manual journal or a rule change checks it. `postable` is postable, active and not archived. */
export interface AccountFactsRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly postable: boolean;
  readonly subledgerKind: SubledgerKind | null;
  readonly normalSide: Side;
}

export interface PostingRuleRow extends DatedRule {
  readonly account: AccountRefRow | null;
  readonly subledgerFrom: string | null;
  readonly approvalRequestId: string | null;
}

export interface DeterminationRow extends DatedDetermination {
  readonly account: AccountRefRow;
  readonly approvalRequestId: string | null;
}

export interface RuleChangeRow {
  readonly id: string;
  readonly branchId: string;
  readonly target: 'RULE' | 'DETERMINATION';
  readonly eventCode: string | null;
  readonly amountKey: string | null;
  readonly side: Side | null;
  readonly accountId: string | null;
  readonly determinantType: DeterminantType | null;
  readonly determinantRole: string | null;
  readonly determinantKey: string | null;
  readonly subledgerFrom: string | null;
  readonly validFrom: string;
  readonly status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';
  readonly approvalRequestId: string;
  readonly createdBy: string;
  readonly version: number;
}

/** FIN's journals, manual journals and rule changes in PostgreSQL. The triggers of 0123 and 0130 decide too. */
export interface JournalStore {
  entries(tx: Transaction, filters: EntryFilters, before: EntryPosition | null, limit: number): Promise<EntryHeader[]>;
  entry(tx: Transaction, id: string): Promise<EntryHeader | null>;
  /** The entry an event about this subject posted (a manual journal's), or null. */
  entryOfSubject(tx: Transaction, subjectId: string): Promise<string | null>;
  linesOf(tx: Transaction, entryIds: readonly string[]): Promise<EntryLine[]>;
  /** Debits less credits of the account's lines before `from`, with the filters. */
  activityBefore(tx: Transaction, filters: ActivityFilters): Promise<bigint>;
  /** Debits less credits from `from` to `to` inclusive, up to and including `upTo` when given. */
  activityTotal(tx: Transaction, filters: ActivityFilters, upTo: ActivityPosition | null): Promise<bigint>;
  activityLines(tx: Transaction, filters: ActivityFilters, after: ActivityPosition | null, limit: number): Promise<ActivityLine[]>;
  accountFacts(tx: Transaction, ids: readonly string[]): Promise<Map<string, AccountFactsRow>>;
  allAccountFacts(tx: Transaction): Promise<Map<string, AccountFactsRow>>;
  accountByCode(tx: Transaction, code: string): Promise<AccountFactsRow | null>;
  parties(tx: Transaction, ids: readonly string[]): Promise<Map<string, PartyRow>>;

  manualJournals(tx: Transaction, filters: { readonly status: string | null; readonly kind: string | null }, beforeId: string | null, limit: number): Promise<ManualJournalRow[]>;
  manualJournal(tx: Transaction, id: string, forUpdate: boolean): Promise<ManualJournalRow | null>;
  /** The lines of each journal's current revision, in line order. */
  manualLines(tx: Transaction, journals: readonly Pick<ManualJournalRow, 'id' | 'revision'>[]): Promise<Map<string, ManualLineRow[]>>;
  insertManualJournal(tx: Transaction, row: ManualJournalRow): Promise<void>;
  insertManualLines(tx: Transaction, journalId: string, revision: number, lines: readonly NewManualLine[], actorId: string): Promise<void>;
  /** A draft's new date, description and revision, at the next version. */
  reviseManualJournal(tx: Transaction, id: string, change: { readonly postingDate: string; readonly description: string; readonly revision: number }, actorId: string): Promise<void>;
  submitManualJournal(tx: Transaction, id: string, approvalRequestId: string, actorId: string): Promise<void>;
  decideManualJournal(tx: Transaction, id: string, decision: { readonly status: 'POSTED' | 'REJECTED'; readonly journalEntryId: string | null; readonly decidedBy: string; readonly at: Date }): Promise<void>;
  /** An opening balance journal is pending or posted (uq_manual_journal_opening). */
  openingTaken(tx: Transaction, exceptId: string): Promise<boolean>;

  eventTypes(tx: Transaction): Promise<{ readonly code: string; readonly ownerModule: string; readonly description: string; readonly amountKeys: readonly string[] }[]>;
  postingRules(tx: Transaction, filters: { readonly eventCode: string | null; readonly at: string | null }, afterId: string | null, limit: number): Promise<PostingRuleRow[]>;
  /** Every live rule of the event, for a change's checks. */
  rulesOfEvent(tx: Transaction, eventCode: string): Promise<DatedRule[]>;
  determinations(tx: Transaction, filters: { readonly type: string | null }, afterId: string | null, limit: number): Promise<DeterminationRow[]>;
  allDeterminations(tx: Transaction): Promise<DatedDetermination[]>;
  /** One change waits per rule (event, amount, side) or per determination key and role (the partial unique indexes). */
  ruleChangePending(tx: Transaction, change: Pick<RuleChangeRow, 'target' | 'eventCode' | 'amountKey' | 'side' | 'determinantType' | 'determinantKey' | 'determinantRole'>): Promise<boolean>;
  insertRuleChange(tx: Transaction, row: RuleChangeRow): Promise<void>;
  ruleChange(tx: Transaction, id: string, forUpdate: boolean): Promise<RuleChangeRow | null>;
  decideRuleChange(
    tx: Transaction,
    id: string,
    decision: { readonly status: 'POSTED' | 'REJECTED'; readonly effectiveFrom: string | null; readonly postingRuleId: string | null; readonly determinationId: string | null; readonly decidedBy: string; readonly at: Date },
  ): Promise<void>;
  endRule(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void>;
  insertRule(tx: Transaction, row: { readonly id: string; readonly eventCode: string; readonly amountKey: string; readonly side: Side; readonly accountId: string | null; readonly determinantType: RuleDeterminant | null; readonly determinantRole: string | null; readonly subledgerFrom: string | null; readonly validFrom: string; readonly approvalRequestId: string }, actorId: string): Promise<void>;
  endDetermination(tx: Transaction, id: string, validTo: string, actorId: string): Promise<void>;
  insertDetermination(tx: Transaction, row: { readonly id: string; readonly type: DeterminantType; readonly key: string; readonly role: string; readonly accountId: string; readonly validFrom: string; readonly approvalRequestId: string }, actorId: string): Promise<void>;
}
