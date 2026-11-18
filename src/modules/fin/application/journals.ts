import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { jsonPesewas, sidedBalance, signedLine } from '../domain/balance';
import type { Side } from '../domain/posting';
import { JOURNAL_DOCUMENT_TYPE } from './ledger';
import type { AccountRefRow, ActivityFilters, ActivityPosition, EntryFilters, EntryHeader, EntryLine, JournalStore, PartyRow, ReceivableLineRow } from './journal-store';
import type { Page } from './periods';
import { readableBranches } from './read-scope';

const READ = 'fin.journal.read';

/** The contract's `SubledgerRef`: the party's id is its `fin.subledger_party` id, the one a manual journal line names. */
export interface SubledgerView {
  readonly kind: PartyRow['kind'];
  readonly id: string;
  readonly displayName: string;
}

export interface JournalLineView {
  readonly lineNo: number;
  readonly account: AccountRefRow;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly branchId: string;
  readonly subledger: SubledgerView | null;
  readonly productLine: string | null;
  readonly memo: string | null;
}

/** The contract's `JournalEntry`. */
export interface JournalEntryView {
  readonly id: string;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly period: { readonly id: string; readonly fiscalYear: number; readonly periodNo: number };
  readonly branchId: string;
  readonly kind: EntryHeader['kind'];
  readonly eventCode: string | null;
  readonly sourceDocument: DocumentRefRecord;
  readonly postingGroupId: string;
  readonly description: string;
  readonly currency: 'GHS';
  readonly reversesEntryId: string | null;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actor: PrincipalRef;
  readonly totalPesewas: number;
  readonly lines: readonly JournalLineView[];
}

export interface AccountActivityLineView {
  readonly journalEntryId: string;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly description: string;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly runningBalancePesewas: number;
  readonly runningSide: Side;
  readonly sourceDocument: DocumentRefRecord;
}

/** The contract's `AccountActivity`: a page of lines with the range's opening and closing balance. */
export interface AccountActivityView extends Page<AccountActivityLineView> {
  readonly account: AccountRefRow;
  readonly openingBalancePesewas: number;
  readonly openingSide: Side;
  readonly closingBalancePesewas: number;
  readonly closingSide: Side;
  readonly currency: 'GHS';
}

export interface EntryQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly accountId?: string | undefined;
  readonly sourceDocumentId?: string | undefined;
  readonly postingGroupId?: string | undefined;
  readonly eventCode?: string | undefined;
  readonly kind?: string | undefined;
}

export interface ActivityQuery {
  readonly from: string;
  readonly to: string;
  readonly subledgerPartyId?: string | undefined;
  readonly branchId?: string | undefined;
}

/** A customer's 1200 line, named by its source document: its own number where it has one (an invoice's), else null (a payment). */
export interface CustomerReceivableLine extends ReceivableLineRow {
  readonly sourceNumber: string | null;
}

/** A customer's trade receivables at one branch for a range: the signed balance before it (debits less credits) and its lines. */
export interface CustomerReceivables {
  readonly openingPesewas: bigint;
  readonly lines: readonly CustomerReceivableLine[];
}

const json = jsonPesewas;

export function subledgerView(party: PartyRow | null): SubledgerView | null {
  return party === null ? null : { kind: party.kind, id: party.id, displayName: party.displayName };
}

/**
 * Posted journals, read only (FR-FIN-004): they come from events and are never edited, so there is no write here. The
 * Owner and the Accountant search entries, open one with its lines, and read an account's activity with a running
 * balance and the range's opening and closing balance computed over the whole filter, never summed by the client.
 * Each read authorises first, deny by default; the ledger is one book for the legal entity, so no branch scope applies.
 */
export class Journals {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: JournalStore,
    private readonly authoriser: Authoriser,
    private readonly documents: DocumentRegistry,
    private readonly names: PrincipalNames,
    private readonly cursors: Cursors,
  ) {}

  list(actor: Actor | undefined, query: EntryQuery, cursor: string | undefined, limit: number): Promise<Page<JournalEntryView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters: EntryFilters = {
        from: query.from ?? null,
        to: query.to ?? null,
        accountId: query.accountId ?? null,
        sourceDocumentId: query.sourceDocumentId ?? null,
        postingGroupId: query.postingGroupId ?? null,
        eventCode: query.eventCode ?? null,
        kind: query.kind ?? null,
      };
      const binding = { operationId: 'listJournalEntries', principalId: actor!.principalId, filters };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const before = position === null ? null : { postingDate: position['postingDate']!, id: position['id']! };
      const found = await this.store.entries(tx, filters, before, limit + 1, await readableBranches(this.authoriser, tx, actor!, READ));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const last = rows.at(-1);
      return {
        data: await this.views(tx, rows),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { postingDate: last.postingDate, id: last.id }) : null, limit, hasMore },
      };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<JournalEntryView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const entry = await this.store.entry(tx, id);
      if (entry === null) throw new NotFoundError(`no journal entry ${id}`);
      await this.authoriser.authorise(tx, actor, READ, { branchId: entry.branchId });
      return (await this.views(tx, [entry]))[0]!;
    });
  }

  activity(actor: Actor | undefined, accountId: string, query: ActivityQuery, cursor: string | undefined, limit: number): Promise<AccountActivityView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const account = (await this.store.accountFacts(tx, [accountId])).get(accountId);
      if (account === undefined) throw new NotFoundError(`no account ${accountId}`);
      const filters: ActivityFilters = { accountId, from: query.from, to: query.to, partyId: query.subledgerPartyId ?? null, branchId: query.branchId ?? null };
      const binding = { operationId: 'listAccountActivity', principalId: actor!.principalId, filters };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after: ActivityPosition | null = position === null ? null : { postingDate: position['postingDate']!, entryId: position['entryId']!, lineNo: Number(position['lineNo']) };
      const opening = await this.store.activityBefore(tx, filters);
      const closing = opening + (await this.store.activityTotal(tx, filters, null));
      let running = opening + (after === null ? 0n : await this.store.activityTotal(tx, filters, after));
      const found = await this.store.activityLines(tx, filters, after, limit + 1);
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const documents = await this.documentRefs(tx, rows.map((r) => r.sourceDocumentId));
      const data = rows.map((r) => {
        running += signedLine(r.side, r.amountPesewas);
        const balance = sidedBalance(running, account.normalSide);
        return {
          journalEntryId: r.entryId,
          entryNo: r.entryNo,
          postingDate: r.postingDate,
          description: r.description,
          side: r.side,
          amountPesewas: json(r.amountPesewas),
          runningBalancePesewas: json(balance.pesewas),
          runningSide: balance.side,
          sourceDocument: documents.get(r.sourceDocumentId)!,
        };
      });
      const last = rows.at(-1);
      const open = sidedBalance(opening, account.normalSide);
      const close = sidedBalance(closing, account.normalSide);
      return {
        data,
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { postingDate: last.postingDate, entryId: last.entryId, lineNo: String(last.lineNo) }) : null, limit, hasMore },
        account: { id: account.id, code: account.code, name: account.name },
        openingBalancePesewas: json(open.pesewas),
        openingSide: open.side,
        closingBalancePesewas: json(close.pesewas),
        closingSide: close.side,
        currency: 'GHS',
      };
    });
  }

  /**
   * A customer's trade receivables (1200 against the customer's subledger party) at one branch from `from` to `to`
   * inclusive, oldest first, with the balance before the range (B08 continued 2d, ADR-0085): every invoice, receipt,
   * credit and debit note, payment, refund, reversal and journal that touched the customer's account, whatever posted it,
   * so an opening balance entered by manual journal is in it too. Read in the caller's transaction; it authorises nothing
   * (WHL's statement command has). A customer never posted to reads zero and no lines.
   */
  async customerReceivablesIn(tx: Transaction, query: { readonly customerId: string; readonly branchId: string; readonly from: string; readonly to: string }): Promise<CustomerReceivables> {
    const openingPesewas = await this.store.receivableBefore(tx, query);
    const rows = await this.store.receivableLines(tx, query);
    const numbers = await this.documents.numberedRefs(tx, [...new Set(rows.map((r) => r.sourceDocumentId))]);
    return { openingPesewas, lines: rows.map((r) => ({ ...r, sourceNumber: numbers.get(r.sourceDocumentId)?.number ?? null })) };
  }

  /**
   * Each customer's trade receivables (1200 against its `CUSTOMER` subledger party) at the branches given, as at the end
   * of a business day: the signed balance, debits less credits, of every line posted on or before it, whatever posted
   * it (an opening balance journal included). Customers whose balance is nil are absent. WHL's ageing ties its buckets
   * to it (FR-WHL-010, ADR-0089). Read in the caller's transaction; it authorises nothing.
   */
  async customerReceivableBalancesIn(tx: Transaction, query: { readonly branchIds: readonly string[]; readonly customerId: string | null; readonly asOf: string }): Promise<ReadonlyMap<string, bigint>> {
    if (query.branchIds.length === 0) return new Map();
    return this.store.receivableBalances(tx, query);
  }

  /** Entries as the contract shows them, with their lines, actors and source documents. */
  async views(tx: Transaction, entries: readonly EntryHeader[]): Promise<JournalEntryView[]> {
    const lines = await this.store.linesOf(tx, entries.map((e) => e.id));
    const byEntry = new Map<string, EntryLine[]>();
    for (const line of lines) {
      byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
    }
    const people = await this.names.refs(tx, [...new Set(entries.map((e) => e.actorId))]);
    const documents = await this.documentRefs(tx, entries.map((e) => e.sourceDocumentId));
    return entries.map((e) => ({
      id: e.id,
      entryNo: e.entryNo,
      postingDate: e.postingDate,
      period: { id: e.periodId, fiscalYear: e.fiscalYear, periodNo: e.periodNo },
      branchId: e.branchId,
      kind: e.kind,
      eventCode: e.eventCode,
      sourceDocument: documents.get(e.sourceDocumentId)!,
      postingGroupId: e.postingGroupId,
      description: e.description,
      currency: 'GHS',
      reversesEntryId: e.reversesEntryId,
      occurredAt: e.occurredAt.toISOString(),
      recordedAt: e.recordedAt.toISOString(),
      actor: people.get(e.actorId)!,
      totalPesewas: json(e.totalPesewas),
      lines: (byEntry.get(e.id) ?? []).map((l) => ({
        lineNo: l.lineNo,
        account: l.account,
        side: l.side,
        amountPesewas: json(l.amountPesewas),
        branchId: l.branchId,
        subledger: subledgerView(l.party),
        productLine: l.productLine,
        memo: l.memo,
      })),
    }));
  }

  /** Source documents by id; a journal's own number is its entry number. */
  private async documentRefs(tx: Transaction, ids: readonly string[]): Promise<Map<string, DocumentRefRecord>> {
    const unique = [...new Set(ids)];
    const refs = await this.documents.refs(tx, unique);
    const numbered = new Map<string, DocumentRefRecord>();
    for (const id of unique) {
      const ref = refs.get(id) ?? { id, docType: 'UNKNOWN', number: null };
      numbered.set(id, ref.docType === JOURNAL_DOCUMENT_TYPE ? { ...ref, number: (await this.store.entry(tx, id))?.entryNo ?? null } : ref);
    }
    return numbered;
  }
}
