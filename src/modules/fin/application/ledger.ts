import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import { IsolationLevelError, type Transaction } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import type { MasterDataRefs } from '../../mdm';
import { choosePostingDate, closingPostingDate, fiscalYearOf } from '../domain/period';
import { buildJournalLines, reverseLines, type PostingAmount } from '../domain/posting';
import { LedgerPostingRefusedError } from './errors';
import type { LedgerStore, LineRow } from './ledger-store';

/** A financial event as FIN posts it: who, when, where, what document caused it, and its named amounts. */
export interface PostingRequest {
  readonly eventCode: string;
  /** The event's outbox id: a replayed event collides on `fin.journal_entry.event_id`. */
  readonly eventId: string;
  /** What the event is about (a movement, an invoice, a payment), so a later reversal finds this entry. */
  readonly eventSubjectId: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly branchId: string;
  readonly sourceDocumentId: string;
  readonly actorId: string;
  readonly amounts: readonly PostingAmount[];
  /** Set when the event corrects an earlier one: its entry is reversed line for line instead of posting afresh. */
  readonly reversesSubjectId?: string | null;
  /**
   * A manual journal (FR-FIN-008, A-190): its entry's kind and description, and the exact date it was entered for. That
   * date posts as it is or not at all: the late-event rule never moves a journal a person dated (PERIOD_NOT_OPEN).
   */
  readonly manual?: { readonly kind: 'MANUAL' | 'OPENING'; readonly description: string; readonly postingDate: string } | null;
  /**
   * A year close (FR-FIN-010, ADR-0058): a CLOSING entry on the last day of the year, into that year's last period
   * while it is LOCKED, posted in the transaction that closes it. Never moved to another date.
   */
  readonly closing?: { readonly description: string; readonly postingDate: string } | null;
}

export interface PostedEntry {
  readonly entryId: string;
  readonly entryNo: string;
  readonly postingDate: string;
}

export const JOURNAL_DOCUMENT_TYPE = 'JOURNAL';

/**
 * Posts one financial event as one balanced journal entry in the caller's serializable transaction (ADR-0003,
 * ADR-0005). The entry is a numbered business document (`JNL-<YEAR>-<BRANCH>-<SEQ>`, ADR-0015); its lines come from the
 * posting rules in force on the posting date, or, for a correction, are the original's lines with every side swapped.
 * A refusal throws, so the operation that published the event rolls back whole. An event whose amounts are all zero
 * posts nothing. The entries of one transaction share one posting group.
 */
export class Ledger {
  private readonly nextId: () => string;
  private readonly postingGroups = new WeakMap<Transaction, string>();

  constructor(
    private readonly store: LedgerStore,
    private readonly documents: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly refs: MasterDataRefs,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async postIn(tx: Transaction, request: PostingRequest): Promise<PostedEntry | null> {
    if (tx.isolation !== 'serializable') {
      throw new IsolationLevelError(tx.isolation);
    }
    const manual = request.manual ?? null;
    const closing = request.closing ?? null;
    const occurredDate = manual?.postingDate ?? closing?.postingDate ?? toBusinessDate(request.occurredAt);
    const recordedDate = manual?.postingDate ?? closing?.postingDate ?? toBusinessDate(request.recordedAt);
    const eventType = await this.store.eventType(tx, request.eventCode);
    if (eventType === null) {
      throw new LedgerPostingRefusedError(request.eventCode, { rule: 'NOT_CATALOGUED', eventCode: request.eventCode });
    }
    const periods = await this.store.periodsOn(tx, [occurredDate, recordedDate]);
    const dated = closing === null ? choosePostingDate(occurredDate, recordedDate, periods) : closingPostingDate(closing.postingDate, periods);
    if (!dated.ok) {
      throw new LedgerPostingRefusedError(request.eventCode, dated.error);
    }
    const { postingDate, periodId } = dated.value;
    const reverses = request.reversesSubjectId ?? null;
    let lines: LineRow[];
    let reversesEntryId: string | null = null;
    if (reverses !== null) {
      const original = await this.store.originalEntryOf(tx, reverses);
      if (original === null) {
        if (request.amounts.every((a) => a.amount.isZero())) {
          return null;
        }
        throw new LedgerPostingRefusedError(request.eventCode, { rule: 'ORIGINAL_NOT_POSTED', subjectId: reverses });
      }
      reversesEntryId = original.id;
      lines = reverseLines(original.lines);
    } else {
      const rules = await this.store.rulesFor(tx, request.eventCode, postingDate);
      const determinations = await this.store.determinations(tx, postingDate);
      const accounts = await this.store.accounts(tx);
      const built = buildJournalLines(request.amounts, { rules, determinations, accounts }, eventType.amountKeys);
      if (!built.ok) {
        throw new LedgerPostingRefusedError(request.eventCode, built.error);
      }
      if (built.value.length === 0) {
        return null;
      }
      lines = [];
      for (const line of built.value) {
        const subledgerPartyId = line.subledger === null ? null : await this.store.subledgerPartyIn(tx, line.subledger, this.nextId());
        lines.push({ lineNo: line.lineNo, accountId: line.accountId, side: line.side, amountPesewas: line.amount.pesewas, subledgerPartyId, memo: line.memo, costObjectId: line.costObjectId });
      }
    }
    const entryId = this.nextId();
    await this.documents.register(tx, { id: entryId, docType: JOURNAL_DOCUMENT_TYPE, ownerModule: 'fin', branchId: request.branchId, actorId: request.actorId });
    const branch = (await this.refs.branchesIn(tx, [request.branchId])).get(request.branchId);
    if (branch === undefined) {
      throw new Error(`branch ${request.branchId} of ${request.eventCode} does not exist`);
    }
    const entryNo = await this.numbers.allocateIn(tx, {
      docType: JOURNAL_DOCUMENT_TYPE,
      fiscalYear: fiscalYearOf(postingDate),
      branchId: request.branchId,
      branchCode: branch.code,
      documentId: entryId,
    });
    let postingGroupId = this.postingGroups.get(tx);
    if (postingGroupId === undefined) {
      postingGroupId = this.nextId();
      this.postingGroups.set(tx, postingGroupId);
    }
    await this.store.insertEntry(
      tx,
      {
        id: entryId,
        entryNo,
        postingDate,
        periodId,
        branchId: request.branchId,
        kind: manual?.kind ?? (closing === null ? (reversesEntryId === null ? 'AUTO' : 'REVERSAL') : 'CLOSING'),
        eventCode: request.eventCode,
        eventId: request.eventId,
        eventSubjectId: request.eventSubjectId,
        sourceDocumentId: request.sourceDocumentId,
        postingGroupId,
        description: manual?.description ?? closing?.description ?? eventType.description,
        reversesEntryId,
        occurredAt: request.occurredAt,
        actorId: request.actorId,
      },
      lines,
    );
    return { entryId, entryNo, postingDate };
  }
}
