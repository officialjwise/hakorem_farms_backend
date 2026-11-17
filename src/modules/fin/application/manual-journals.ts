import { createHash } from 'node:crypto';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { jsonPesewas } from '../domain/balance';
import { checkManualJournal, journalTotals, judgeSubmit, type ManualJournalStatus, type ManualLine } from '../domain/manual-journal';
import type { Side } from '../domain/posting';
import type { ManualJournalApproved } from '../events';
import { FinStateError, JournalUnbalancedError, LedgerPostingRefusedError, ManualJournalInvalidError, NotMakerError, OpeningAlreadyPostedError } from './errors';
import type { AccountRefRow, JournalStore, ManualJournalRow, ManualLineRow } from './journal-store';
import { subledgerView, type SubledgerView } from './journals';
import type { LedgerStore } from './ledger-store';
import { readableBranches } from './read-scope';
import type { Page } from './periods';

export const MANUAL_JOURNAL = 'MANUAL_JOURNAL' as const;
export const MANUAL_JOURNAL_APPROVED = 'fin.ManualJournalApproved';
/** Opening balance equity: the opening balance journal's balancing account (A-005). */
export const OPENING_EQUITY_CODE = '3900';
const READ = 'fin.journal.read';
const CREATE = 'fin.journal.create';

export interface ManualLineInput {
  readonly accountId: string;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly subledgerPartyId?: string | undefined;
  readonly memo?: string | undefined;
}

export interface ManualJournalCreateRequest {
  readonly kind: 'MANUAL' | 'OPENING';
  readonly postingDate: string;
  readonly description: string;
  readonly lines: readonly ManualLineInput[];
}

export interface ManualJournalUpdateRequest {
  readonly version: number;
  readonly postingDate?: string | undefined;
  readonly description?: string | undefined;
  readonly lines?: readonly ManualLineInput[] | undefined;
}

export interface ManualJournalLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly account: AccountRefRow;
  readonly side: Side;
  readonly amountPesewas: number;
  readonly subledger: SubledgerView | null;
  readonly memo: string | null;
}

/** The contract's `ManualJournal`. */
export interface ManualJournalView {
  readonly id: string;
  readonly status: ManualJournalStatus;
  readonly kind: 'MANUAL' | 'OPENING';
  readonly postingDate: string;
  readonly description: string;
  readonly debitTotalPesewas: number;
  readonly creditTotalPesewas: number;
  readonly balanced: boolean;
  readonly currency: 'GHS';
  readonly approvalRequestId: string | null;
  readonly journalEntryId: string | null;
  readonly lines: readonly ManualJournalLineView[];
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

/** The contract's `ApprovalPending` for a submitted manual journal. */
export interface ManualJournalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof MANUAL_JOURNAL;
  readonly subject: { readonly id: string; readonly docType: typeof MANUAL_JOURNAL; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

const toLine = (l: ManualLineInput): ManualLine => ({ accountId: l.accountId, side: l.side, amountPesewas: l.amountPesewas, subledgerPartyId: l.subledgerPartyId ?? null, memo: l.memo?.trim() || null });
const fromRow = (l: ManualLineRow): ManualLine => ({ accountId: l.account.id, side: l.side, amountPesewas: jsonPesewas(l.amountPesewas), subledgerPartyId: l.party?.id ?? null, memo: l.memo });

/**
 * Manual journals (FR-FIN-008, ADR-0003, ADR-0017, A-190). The Owner or the Accountant drafts a journal (MANUAL, or the
 * opening balance journal, OPENING, against 3900), changes it while it is a draft, and submits it once it balances:
 * always 202 `MANUAL_JOURNAL`, and nothing posts. A different holder of `fin.journal.approve` approves it with step-up;
 * the approval publishes `fin.ManualJournalApproved` in its own transaction, and the ledger's subscriber posts it as
 * one balanced entry through the same path as every other event: the same rules ("as entered"), numbering, period rule
 * and database triggers. A journal a person dated posts on that date or not at all. Only the person who drafted a
 * journal changes or submits it, so the maker is one person and the checker another. Every change is audited.
 */
export class ManualJournals implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: JournalStore,
    private readonly ledgerStore: LedgerStore,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly refs: MasterDataRefs,
    private readonly names: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly status?: string | undefined; readonly kind?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<ManualJournalView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { status: query.status ?? null, kind: query.kind ?? null };
      const binding = { operationId: 'listManualJournals', principalId: actor!.principalId, filters };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.manualJournals(tx, filters, before, limit + 1, await readableBranches(this.authoriser, tx, actor!, READ));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ManualJournalView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const journal = await this.journalOf(tx, id, false);
      await this.authoriser.authorise(tx, actor, READ, { branchId: journal.branchId });
      return (await this.views(tx, [journal]))[0]!;
    });
  }

  create(actor: Actor | undefined, body: ManualJournalCreateRequest, idempotencyKey: string): Promise<StoredResponse<ManualJournalView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createManualJournal', principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ManualJournalView>;
      const id = this.nextId();
      const lines = body.lines.map(toLine);
      await this.refuseInvalid(tx, { kind: body.kind, postingDate: body.postingDate, lines });
      if (body.kind === 'OPENING' && (await this.store.openingTaken(tx, id))) throw new OpeningAlreadyPostedError();
      const branchId = await this.refs.headOfficeBranchIn(tx);
      if (branchId === null) throw new Error('no active branch to hold the manual journal');
      await this.documents.register(tx, { id, docType: MANUAL_JOURNAL, ownerModule: 'fin', branchId, actorId: actor!.principalId });
      const row: ManualJournalRow = {
        id,
        kind: body.kind,
        postingDate: body.postingDate,
        description: body.description.trim(),
        branchId,
        status: 'DRAFT',
        revision: 1,
        approvalRequestId: null,
        journalEntryId: null,
        version: 1,
        createdAt: this.clock.now(),
        createdBy: actor!.principalId,
      };
      await this.store.insertManualJournal(tx, row);
      await this.store.insertManualLines(tx, id, 1, this.numbered(lines), actor!.principalId);
      const [view] = await this.views(tx, [(await this.store.manualJournal(tx, id, false))!]);
      await this.audit.record(tx, { module: 'fin', action: 'CREATE', entityType: 'ManualJournal', entityId: id, branchId, before: null, after: auditShape(view!) });
      const response = { status: 201, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  update(actor: Actor | undefined, id: string, body: ManualJournalUpdateRequest, idempotencyKey: string): Promise<StoredResponse<ManualJournalView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'updateManualJournal', principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ManualJournalView>;
      const before = await this.journalOf(tx, id, true);
      this.refuseOthers(actor!, before);
      if (before.version !== body.version) throw new VersionConflictError(`manual journal ${id} is at version ${before.version}`);
      if (before.status !== 'DRAFT') throw new FinStateError(`manual journal ${id}`, before.status);
      const [beforeView] = await this.views(tx, [before]);
      const current = (await this.store.manualLines(tx, [before])).get(id)!.map(fromRow);
      const lines = body.lines?.map(toLine) ?? current;
      const postingDate = body.postingDate ?? before.postingDate;
      await this.refuseInvalid(tx, { kind: before.kind, postingDate, lines });
      const revision = body.lines === undefined ? before.revision : before.revision + 1;
      await this.store.reviseManualJournal(tx, id, { postingDate, description: body.description?.trim() ?? before.description, revision }, actor!.principalId);
      if (body.lines !== undefined) await this.store.insertManualLines(tx, id, revision, this.numbered(lines), actor!.principalId);
      const [view] = await this.views(tx, [(await this.store.manualJournal(tx, id, false))!]);
      await this.audit.record(tx, { module: 'fin', action: 'UPDATE', entityType: 'ManualJournal', entityId: id, branchId: before.branchId, before: auditShape(beforeView!), after: auditShape(view!) });
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A balanced draft goes for approval: always 202, and nothing posts until a different person approves it. */
  submit(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ManualJournalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'submitManualJournal', principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ManualJournalPendingView>;
      const journal = await this.journalOf(tx, id, true);
      this.refuseOthers(actor!, journal);
      const lines = (await this.store.manualLines(tx, [journal])).get(id)!.map(fromRow);
      const totals = journalTotals(lines);
      const verdict = judgeSubmit(journal.status, totals);
      if (!verdict.ok) {
        if (verdict.error === 'UNBALANCED') throw new JournalUnbalancedError(totals.debit.pesewas, totals.credit.pesewas);
        throw new FinStateError(`manual journal ${id}`, verdict.error);
      }
      await this.refuseInvalid(tx, { kind: journal.kind, postingDate: journal.postingDate, lines });
      await this.refuseClosedPeriod(tx, journal.postingDate);
      if (journal.kind === 'OPENING' && (await this.store.openingTaken(tx, id))) throw new OpeningAlreadyPostedError();
      const summary = `${journal.kind === 'OPENING' ? 'Opening balance journal' : 'Manual journal'} of ${totals.debit.pesewas} pesewas dated ${journal.postingDate}: ${journal.description}`;
      const request = await this.approvals.request(tx, actor, {
        kind: MANUAL_JOURNAL,
        branchId: journal.branchId,
        subjectDocumentId: id,
        payloadHash: journalHash(journal, lines),
        amountPesewas: totals.debit.pesewas,
        summary,
      });
      await this.store.submitManualJournal(tx, id, request.id, actor!.principalId);
      await this.audit.record(tx, {
        module: 'fin',
        action: 'SUBMIT',
        entityType: 'ManualJournal',
        entityId: id,
        branchId: journal.branchId,
        before: { status: journal.status, version: journal.version },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, debitTotalPesewas: totals.debit.toJsonInteger(), version: journal.version + 1 },
      });
      const body: ManualJournalPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: MANUAL_JOURNAL,
        subject: { id, docType: MANUAL_JOURNAL, number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      const response = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** ApprovalHandler: the journal as it stands; any change since it was submitted voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const journal = await this.journalOf(tx, subjectDocumentId, false);
    return journalHash(journal, (await this.store.manualLines(tx, [journal])).get(journal.id)!.map(fromRow));
  }

  /**
   * ApprovalHandler: posts the journal in the approval's transaction. It publishes `fin.ManualJournalApproved`; the
   * ledger's own subscriber posts it like any other event, and the database holds that the entry is this journal's,
   * line for line (`ck_manual_journal_entry`). A refusal (a closed period, an account closed since) rolls the approval
   * back with it, so the journal stays pending.
   */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const journal = await this.journalOf(tx, request.subjectDocumentId, true);
    if (journal.status !== 'PENDING_APPROVAL') throw new FinStateError(`manual journal ${journal.id}`, journal.status);
    const lines = (await this.store.manualLines(tx, [journal])).get(journal.id)!;
    await this.refuseInvalid(tx, { kind: journal.kind, postingDate: journal.postingDate, lines: lines.map(fromRow) });
    await this.events.publish<ManualJournalApproved>(tx, {
      type: MANUAL_JOURNAL_APPROVED,
      subjectType: 'ManualJournal',
      subjectId: journal.id,
      branchId: journal.branchId,
      payload: {
        manualJournalId: journal.id,
        kind: journal.kind,
        postingDate: journal.postingDate,
        description: journal.description,
        approvalRequestId: request.id,
        requestedBy: request.requestedBy,
        lines: lines.map((l) => ({ lineNo: l.lineNo, accountId: l.account.id, side: l.side, amountPesewas: jsonPesewas(l.amountPesewas), subledgerPartyId: l.party?.id ?? null, memo: l.memo })),
      },
    });
    const entryId = await this.store.entryOfSubject(tx, journal.id);
    if (entryId === null) throw new Error(`manual journal ${journal.id} was approved but the ledger posted no entry`);
    await this.store.decideManualJournal(tx, journal.id, { status: 'POSTED', journalEntryId: entryId, decidedBy: request.decidedBy!, at: this.clock.now() });
    await this.audit.record(tx, {
      module: 'fin',
      action: 'POST',
      entityType: 'ManualJournal',
      entityId: journal.id,
      branchId: journal.branchId,
      before: { status: journal.status, version: journal.version },
      after: { status: 'POSTED', journalEntryId: entryId, version: journal.version + 1 },
      metadata: { approvalRequestId: request.id, requestedBy: request.requestedBy },
    });
  }

  /** ApprovalHandler: a rejected or withdrawn journal is final and never posts. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const journal = await this.journalOf(tx, request.subjectDocumentId, true);
    await this.store.decideManualJournal(tx, journal.id, { status: 'REJECTED', journalEntryId: null, decidedBy: request.decidedBy ?? request.requestedBy, at: this.clock.now() });
    await this.audit.record(tx, {
      module: 'fin',
      action: 'REJECT',
      entityType: 'ManualJournal',
      entityId: journal.id,
      branchId: journal.branchId,
      before: { status: journal.status },
      after: { status: 'REJECTED' },
      metadata: { approvalRequestId: request.id, approvalStatus: request.status },
    });
  }

  private async journalOf(tx: Transaction, id: string, forUpdate: boolean): Promise<ManualJournalRow> {
    const journal = await this.store.manualJournal(tx, id, forUpdate);
    if (journal === null) throw new NotFoundError(`no manual journal ${id}`);
    return journal;
  }

  private refuseOthers(actor: Actor, journal: ManualJournalRow): void {
    if (journal.createdBy !== actor.principalId) throw new NotMakerError(`manual journal ${journal.id} was drafted by someone else`);
  }

  private async refuseInvalid(tx: Transaction, draft: { readonly kind: 'MANUAL' | 'OPENING'; readonly postingDate: string; readonly lines: readonly ManualLine[] }): Promise<void> {
    const accounts = await this.store.accountFacts(tx, [...new Set(draft.lines.map((l) => l.accountId))]);
    const parties = await this.store.parties(tx, [...new Set(draft.lines.flatMap((l) => (l.subledgerPartyId === null ? [] : [l.subledgerPartyId])))]);
    const rules = checkManualJournal(draft, { today: toBusinessDate(this.clock.now()), openingEquityCode: OPENING_EQUITY_CODE, accounts, parties });
    if (rules.length > 0) throw new ManualJournalInvalidError(rules);
  }

  /** A journal posts on its own date: if that date's period is not open, it is refused now rather than at approval. */
  private async refuseClosedPeriod(tx: Transaction, postingDate: string): Promise<void> {
    const periods = await this.ledgerStore.periodsOn(tx, [postingDate]);
    if (!periods.some((p) => p.status === 'OPEN')) throw new LedgerPostingRefusedError(MANUAL_JOURNAL_APPROVED, { rule: 'PERIOD_NOT_OPEN', date: postingDate });
  }

  private numbered(lines: readonly ManualLine[]) {
    return lines.map((l, index) => ({ id: this.nextId(), lineNo: index + 1, accountId: l.accountId, side: l.side, amountPesewas: l.amountPesewas, subledgerPartyId: l.subledgerPartyId, memo: l.memo }));
  }

  private async views(tx: Transaction, rows: readonly ManualJournalRow[]): Promise<ManualJournalView[]> {
    const lines = await this.store.manualLines(tx, rows);
    const people = await this.names.refs(tx, [...new Set(rows.map((r) => r.createdBy))]);
    return rows.map((r) => {
      const own = lines.get(r.id)!;
      const totals = journalTotals(own.map(fromRow));
      return {
        id: r.id,
        status: r.status,
        kind: r.kind,
        postingDate: r.postingDate,
        description: r.description,
        debitTotalPesewas: totals.debit.toJsonInteger(),
        creditTotalPesewas: totals.credit.toJsonInteger(),
        balanced: totals.balanced,
        currency: 'GHS',
        approvalRequestId: r.approvalRequestId,
        journalEntryId: r.journalEntryId,
        lines: own.map((l) => ({ id: l.id, lineNo: l.lineNo, account: l.account, side: l.side, amountPesewas: jsonPesewas(l.amountPesewas), subledger: subledgerView(l.party), memo: l.memo })),
        branchId: r.branchId,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        createdBy: people.get(r.createdBy)!,
      };
    });
  }
}

function auditShape(view: ManualJournalView): Record<string, unknown> {
  return {
    status: view.status,
    kind: view.kind,
    postingDate: view.postingDate,
    description: view.description,
    debitTotalPesewas: view.debitTotalPesewas,
    creditTotalPesewas: view.creditTotalPesewas,
    lines: view.lines.map((l) => ({ lineNo: l.lineNo, accountCode: l.account.code, side: l.side, amountPesewas: l.amountPesewas, subledgerPartyId: l.subledger?.id ?? null, memo: l.memo })),
    version: view.version,
  };
}

/** What the checker approves: this journal, at this revision and version, with exactly these lines. */
function journalHash(journal: ManualJournalRow, lines: readonly ManualLine[]): string {
  return createHash('sha256')
    .update(canonicalJson({ id: journal.id, kind: journal.kind, postingDate: journal.postingDate, description: journal.description, revision: journal.revision, lines }))
    .digest('hex');
}
