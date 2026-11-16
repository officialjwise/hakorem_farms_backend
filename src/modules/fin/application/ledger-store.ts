import type { Transaction } from '../../../platform/database/unit-of-work';
import type { PeriodFacts } from '../domain/period';
import type { Determination, DeterminantType, LedgerAccount, PostingRule, Side, SubledgerRef } from '../domain/posting';
import type { AccountActivity } from '../domain/trial-balance';

export const LEDGER_STORE = Symbol('LEDGER_STORE');

export interface EventTypeRow {
  readonly code: string;
  readonly description: string;
  readonly amountKeys: readonly string[];
}

export interface EntryRow {
  readonly id: string;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly periodId: string;
  readonly branchId: string;
  readonly kind: 'AUTO' | 'REVERSAL' | 'MANUAL' | 'OPENING';
  readonly eventCode: string;
  readonly eventId: string;
  readonly eventSubjectId: string;
  readonly sourceDocumentId: string;
  readonly postingGroupId: string;
  readonly description: string;
  readonly reversesEntryId: string | null;
  readonly occurredAt: Date;
  readonly actorId: string;
}

/** A journal line as stored: the subledger is the party's id in `fin.subledger_party`. */
export interface LineRow {
  readonly lineNo: number;
  readonly accountId: string;
  readonly side: Side;
  readonly amountPesewas: bigint;
  readonly subledgerPartyId: string | null;
  readonly memo: string | null;
  readonly costObjectId: string | null;
}

export interface UnbalancedEntry {
  readonly entryId: string;
  readonly entryNo: string;
  readonly lineCount: number;
  readonly debitPesewas: bigint;
  readonly creditPesewas: bigint;
}

/** The ledger in PostgreSQL. The triggers of migration 0123 decide; this inserts and reads. */
export interface LedgerStore {
  /** The periods that contain any of the dates. */
  periodsOn(tx: Transaction, dates: readonly string[]): Promise<PeriodFacts[]>;
  eventType(tx: Transaction, code: string): Promise<EventTypeRow | null>;
  /** The rules of one event in force on the date. */
  rulesFor(tx: Transaction, eventCode: string, date: string): Promise<PostingRule[]>;
  determinations(tx: Transaction, date: string): Promise<Determination[]>;
  accounts(tx: Transaction): Promise<Map<string, LedgerAccount>>;
  /** The party's id, writing it on first use (UNIQUE kind and ref). */
  subledgerPartyIn(tx: Transaction, party: SubledgerRef, newId: string): Promise<string>;
  insertEntry(tx: Transaction, entry: EntryRow, lines: readonly LineRow[]): Promise<void>;
  /** The AUTO entry an event about this subject posted, with its lines, for a reversal; null if it posted none. */
  originalEntryOf(tx: Transaction, eventSubjectId: string): Promise<{ readonly id: string; readonly lines: LineRow[] } | null>;
  /** Every posting event type and every rule in force on the date, for the boot assertion. */
  catalogue(tx: Transaction, date: string): Promise<{ readonly eventTypes: EventTypeRow[]; readonly rules: { readonly eventCode: string; readonly amountKey: string; readonly side: Side }[] }>;
  /** Each account's lines summed before `from` and from `from` to `to`, both inclusive dates; every account listed. */
  accountActivity(tx: Transaction, from: string, to: string): Promise<AccountActivity[]>;
  /** Entries with fewer than two lines or whose debits differ from their credits. */
  unbalancedEntries(tx: Transaction): Promise<UnbalancedEntry[]>;
  /** Debits less credits of each account over the whole ledger. */
  accountBalances(tx: Transaction, accountIds: readonly string[]): Promise<Map<string, bigint>>;
  /** The subledger parties among `ids`, as a manual journal names them. */
  subledgerParties(tx: Transaction, ids: readonly string[]): Promise<Map<string, SubledgerRef>>;
  /** Accounts by code, for statements and reconciliation. */
  accountCodes(tx: Transaction): Promise<Map<string, string>>;
}

/** A subledger a higher module keeps for a control account (ADR-0056): FIN compares the two each night. */
export interface SubledgerSource {
  /** `<module>.<name>`, for the report. */
  readonly name: string;
  readonly determinantType: DeterminantType;
  readonly role: string;
  /** The subledger's value per determinant key, read in the reconciliation's transaction. */
  valuesIn(tx: Transaction): Promise<readonly { readonly key: string; readonly pesewas: bigint }[]>;
}
