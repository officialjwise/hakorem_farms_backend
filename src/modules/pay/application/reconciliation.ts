import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { readSheet, SheetUnreadableError } from '../../../platform/spreadsheet/spreadsheet';
import type { FileStore, StoredFileRecord } from '../../../platform/storage/file-store';
import type { BankAccounts } from '../../fin';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { chooseBankCandidate, judgeLineMatch, matchSettlementLine, readSettlementFile, readStatementFile, settlementPosting, type FileRefusal } from '../domain/reconciliation';
import { jsonPesewas as json } from '../domain/tender';
import type { PaymentCleared, ProviderSettled } from '../events';
import type { Breaks } from './breaks';
import { ReconciliationInvalidError, type PaymentRule } from './errors';
import { PAYMENT_CLEARED, PROVIDER_SETTLED, type Page } from './payments';
import type { ReconciliationStore, SettlementLineRecord, SettlementReportRecord, StatementLineRecord, StatementRecord } from './reconciliation-store';

const READ = 'pay.reconciliation.read';
const MANAGE = 'pay.reconciliation.manage';
const FILE_READ = 'platform.file.read';
const FILE_READ_ANY = 'platform.file.read.any';
/** The most lines one reconciliation file may carry. */
const MAX_FILE_ROWS = 5_000;

export interface BankAccountRefView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'BANK' | 'MOBILE_MONEY';
  readonly last4: string;
}

/** The contract's `SettlementReport`. */
export interface SettlementReportView {
  readonly id: string;
  readonly provider: string;
  readonly settlementRef: string;
  readonly settledOn: string;
  readonly bankAccount: BankAccountRefView;
  readonly grossPesewas: number;
  readonly feePesewas: number;
  readonly netPesewas: number;
  readonly status: string;
  readonly matchedCount: number;
  readonly breakCount: number;
  readonly currency: 'GHS';
  readonly lines: readonly {
    readonly id: string;
    readonly providerReference: string;
    readonly amountPesewas: number;
    readonly feePesewas: number;
    readonly matchedPayment: { readonly id: string; readonly paymentNo: string | null } | null;
    readonly matchStatus: 'UNMATCHED' | 'MATCHED' | 'AMOUNT_DIFFERS' | 'NOT_FOUND';
  }[];
}

/** The contract's `BankStatement`. */
export interface BankStatementView {
  readonly id: string;
  readonly bankAccount: BankAccountRefView;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingPesewas: number;
  readonly closingPesewas: number;
  readonly status: string;
  readonly lineCount: number;
  readonly unmatchedCount: number;
  readonly currency: 'GHS';
  readonly lines: readonly {
    readonly id: string;
    readonly valueDate: string;
    readonly direction: 'IN' | 'OUT';
    readonly amountPesewas: number;
    readonly narration: string | null;
    readonly bankReference: string | null;
    readonly matchedJournalEntryId: string | null;
    readonly matchStatus: 'MATCHED' | 'UNMATCHED';
  }[];
}

/**
 * Settlement and bank reconciliation (FR-PAY-011, FR-PAY-016, ADR-0065). A provider's settlement file is imported once
 * (by file hash and by settlement reference) and matched once: each line to the cleared payment its reference names,
 * for exactly its amount; the matched lines post ◆ `pay.ProviderSettled` (Dr 1100 net, Dr 6910 fee, Cr 1120 gross) and
 * every other line is a break, nothing corrected. A bank statement is imported once per file and period; its lines are
 * matched automatically only by reference and amount, never on amount alone and never on a tie (a pending bank
 * transfer clears from its line, ◆ `pay.PaymentCleared` into 1100; a settlement's payout links to its entry), or by
 * hand; a line nothing matched is a `BANK_LINE_UNMATCHED` break.
 */
export class Reconciliation {
  private readonly nextId: () => string;

  constructor(
    private readonly store: ReconciliationStore,
    private readonly breaks: Breaks,
    private readonly bankAccounts: BankAccounts,
    private readonly refs: MasterDataRefs,
    private readonly files: FileStore,
    private readonly documents: DocumentRegistry,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly uow: UnitOfWork,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // Settlement reports.

  /** `importSettlementReport`: 202 with the report IMPORTED, its lines read from the file; nothing posts until it is matched. */
  async importSettlement(actor: Actor | undefined, body: { readonly provider: string; readonly fileId: string; readonly bankAccountId: string | null }, key: string): Promise<StoredResponse<SettlementReportView>> {
    const { file, content } = await this.readFile(actor, body.fileId);
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.authoriseManage(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'importSettlementReport', principalId: actor!.principalId, key, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SettlementReportView>;
      await this.fileAllowedIn(tx, actor, body.fileId);
      const broken: PaymentRule[] = [];
      if (body.bankAccountId === null) broken.push({ field: '/bankAccountId', rule: 'BANK_ACCOUNT_REQUIRED' });
      else broken.push(...(await this.bankAccountRules(tx, body.bankAccountId)));
      const read = readSettlementFile(this.rowsOf(content, file.contentType), toBusinessDate(this.clock.now()));
      if (!read.ok) broken.push(...fileRules(read.error));
      if (broken.length > 0 || !read.ok) throw new ReconciliationInvalidError(broken);
      if ((await this.store.settlementByFileOrRef(tx, body.provider, file.sha256, read.value.settlementRef)) !== null) throw new ReconciliationInvalidError([{ field: '/fileId', rule: 'ALREADY_IMPORTED' }]);
      // A transaction is settled once: a reference another report already carries is named, and the database holds it too.
      const settled = await this.store.settledReferences(tx, body.provider, read.value.lines.map((l) => l.reference));
      const repeated = read.value.lines.filter((l) => settled.has(l.reference)).map((l) => ({ field: `/file/rows/${l.lineNo + 1}`, rule: 'REFERENCE_ALREADY_SETTLED' }));
      if (repeated.length > 0) throw new ReconciliationInvalidError(repeated);

      const id = this.nextId();
      await this.documents.register(tx, { id, docType: 'SETTLEMENT_REPORT', ownerModule: 'pay', branchId, actorId: actor!.principalId });
      await this.store.insertSettlement(
        tx,
        { id, provider: body.provider, settlementRef: read.value.settlementRef, settledOn: read.value.settledOn, bankAccountId: body.bankAccountId!, grossPesewas: read.value.grossPesewas, feePesewas: read.value.feePesewas, netPesewas: read.value.netPesewas, status: 'IMPORTED', branchId, fileId: file.id, sha256: file.sha256 },
        read.value.lines.map((l) => ({ id: this.nextId(), settlementReportId: id, lineNo: l.lineNo, provider: body.provider, providerReference: l.reference, amountPesewas: l.amountPesewas, feePesewas: l.feePesewas })),
        actor!.principalId,
      );
      const view = (await this.settlementViews(tx, [(await this.store.settlement(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'pay', action: 'IMPORT', entityType: 'SettlementReport', entityId: id, branchId, before: null, after: { ...summaryOf(view), fileId: file.id, lineCount: read.value.lines.length } });
      const response = { status: 202, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `matchSettlementReport` (FR-PAY-016): every line against the payment its reference names, once. The matched lines
   * post one ◆ `pay.ProviderSettled`; a line for another amount is `SETTLEMENT_AMOUNT_DIFFERS`, one with no cleared
   * payment of ours `SETTLEMENT_NOT_FOUND`, each a break and nothing posted for it.
   */
  matchSettlement(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<SettlementReportView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriseManage(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'matchSettlementReport', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<SettlementReportView>;
      const report = await this.store.settlement(tx, id, true);
      if (report === null) throw new NotFoundError('no such settlement report');
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: report.branchId });
      if (report.status !== 'IMPORTED') throw new ReconciliationInvalidError([{ field: '', rule: 'ALREADY_MATCHED' }]);
      const lines = await this.store.settlementLines(tx, [id]);
      const references = lines.map((l) => l.providerReference);
      const payments = await this.store.providerPayments(tx, report.provider, references);
      const judged = lines.map((l) => {
        const payment = payments.get(l.providerReference) ?? null;
        return { line: l, payment, match: matchSettlementLine(report.provider, l, payment) };
      });
      const actorId = actor!.principalId;
      for (const { line, payment, match } of judged) {
        await this.store.markSettlementLine(tx, line.id, { status: match.status, reason: match.reason, paymentId: match.status === 'MATCHED' ? payment!.id : null }, actorId);
        if (match.status === 'MATCHED') continue;
        await this.breaks.raiseIn(tx, actorId, {
          kind: match.status === 'AMOUNT_DIFFERS' ? 'SETTLEMENT_AMOUNT_DIFFERS' : 'SETTLEMENT_NOT_FOUND',
          branchId: report.branchId,
          paymentId: payment?.id ?? null,
          refundId: null,
          provider: report.provider,
          reference: line.providerReference,
          amountPesewas: match.status === 'AMOUNT_DIFFERS' ? absDifference(line.amountPesewas, payment!.amountPesewas) : line.amountPesewas,
          details: {
            reason: match.reason,
            settlementRef: report.settlementRef,
            lineNo: line.lineNo,
            lineAmountPesewas: json(line.amountPesewas),
            lineFeePesewas: json(line.feePesewas),
            ...(payment === null ? {} : { paymentAmountPesewas: json(payment.amountPesewas), paymentStatus: payment.status }),
          },
          sourceDocumentId: report.id,
          settlementLineId: line.id,
        });
      }
      const matched = judged.filter((j) => j.match.status === 'MATCHED');
      const posting = settlementPosting(judged.map((j) => ({ status: j.match.status, amountPesewas: j.line.amountPesewas, feePesewas: j.line.feePesewas })));
      if (matched.length > 0) {
        const payload: ProviderSettled = {
          settlementReportId: report.id,
          branchId: report.branchId,
          provider: report.provider,
          settlementRef: report.settlementRef,
          bankAccountId: report.bankAccountId,
          grossPesewas: json(posting.grossPesewas),
          feePesewas: json(posting.feePesewas),
          netPesewas: json(posting.netPesewas),
          settledOn: report.settledOn,
          paymentIds: matched.map((m) => m.payment!.id),
        };
        await this.events.publish(tx, { type: PROVIDER_SETTLED, subjectType: 'SettlementReport', subjectId: report.id, branchId: report.branchId, payload });
      }
      const status = matched.length === lines.length ? 'POSTED' : 'HAS_BREAKS';
      await this.store.markSettlement(tx, report.id, status, this.clock.now(), actorId);
      const view = (await this.settlementViews(tx, [(await this.store.settlement(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'pay', action: 'MATCH', entityType: 'SettlementReport', entityId: id, branchId: report.branchId, before: { status: report.status }, after: { ...summaryOf(view), postedGrossPesewas: json(posting.grossPesewas), postedFeePesewas: json(posting.feePesewas), postedNetPesewas: json(posting.netPesewas) } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  settlement(actor: Actor | undefined, id: string): Promise<SettlementReportView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const report = await this.store.settlement(tx, id, false);
      if (report === null || !(await this.readable(tx, actor!, report.branchId))) throw new NotFoundError('no such settlement report');
      return (await this.settlementViews(tx, [report]))[0]!;
    });
  }

  settlements(actor: Actor | undefined, query: { readonly status: string | null; readonly from: string | null; readonly to: string | null }, cursor: string | undefined, limit: number): Promise<Page<SettlementReportView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listSettlementReports', principalId: actor!.principalId, filters: query };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { settledOn: position['settledOn'] as string, id: position['id'] as string };
      const found = await this.store.settlements(tx, { ...query, branchIds: await this.readableBranches(tx, actor!) }, after, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.settlementViews(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { settledOn: last.settledOn, id: last.id }) : null, limit, hasMore } };
    });
  }

  // Bank statements.

  /** `importBankStatement`: 202 with the statement IMPORTED, its lines read from the file and their running balance checked. */
  async importStatement(actor: Actor | undefined, body: { readonly bankAccountId: string; readonly fileId: string; readonly periodStart: string; readonly periodEnd: string }, key: string): Promise<StoredResponse<BankStatementView>> {
    const { file, content } = await this.readFile(actor, body.fileId);
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const branchId = await this.authoriseManage(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'importBankStatement', principalId: actor!.principalId, key, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BankStatementView>;
      await this.fileAllowedIn(tx, actor, body.fileId);
      const broken = await this.bankAccountRules(tx, body.bankAccountId);
      const read = readStatementFile(this.rowsOf(content, file.contentType), { start: body.periodStart, end: body.periodEnd }, toBusinessDate(this.clock.now()));
      if (!read.ok) broken.push(...fileRules(read.error));
      if (broken.length > 0 || !read.ok) throw new ReconciliationInvalidError(broken);
      if ((await this.store.statementByFileOrPeriod(tx, body.bankAccountId, file.sha256, { start: body.periodStart, end: body.periodEnd })) !== null) {
        throw new ReconciliationInvalidError([{ field: '/fileId', rule: 'ALREADY_IMPORTED' }]);
      }
      const id = this.nextId();
      await this.documents.register(tx, { id, docType: 'BANK_STATEMENT', ownerModule: 'pay', branchId, actorId: actor!.principalId });
      await this.store.insertStatement(
        tx,
        { id, bankAccountId: body.bankAccountId, periodStart: body.periodStart, periodEnd: body.periodEnd, openingPesewas: read.value.openingPesewas, closingPesewas: read.value.closingPesewas, status: 'IMPORTED', branchId, fileId: file.id, sha256: file.sha256 },
        read.value.lines.map((l) => ({
          id: this.nextId(),
          bankStatementId: id,
          lineNo: l.lineNo,
          bankAccountId: body.bankAccountId,
          valueDate: l.valueDate,
          direction: l.direction,
          amountPesewas: l.amountPesewas,
          balancePesewas: l.balancePesewas,
          narration: l.narration,
          bankReference: l.reference,
          branchId,
        })),
        actor!.principalId,
      );
      const view = await this.statementViewIn(tx, id);
      await this.audit.record(tx, { module: 'pay', action: 'IMPORT', entityType: 'BankStatement', entityId: id, branchId, before: null, after: { ...statementSummary(view), fileId: file.id } });
      const response = { status: 202, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `matchBankStatement`: every line still unmatched, automatically, by reference and amount only. One pending bank
   * transfer whose reference the line carries, at exactly its amount, clears from it; one settlement payout likewise
   * links to its entry. Anything else (no candidate, the right reference at another amount, a tie, money going out) is a
   * `BANK_LINE_UNMATCHED` break, raised once while open. Run again, it matches only what is new.
   */
  matchStatement(actor: Actor | undefined, id: string, key: string): Promise<StoredResponse<BankStatementView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriseManage(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'matchBankStatement', principalId: actor!.principalId, key, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BankStatementView>;
      const statement = await this.store.statement(tx, id, true);
      if (statement === null) throw new NotFoundError('no such bank statement');
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: statement.branchId });
      const before = await this.statementViewIn(tx, id);
      const actorId = actor!.principalId;
      const transfers = await this.store.pendingTransfers(tx, statement.bankAccountId);
      const payouts = await this.store.payouts(tx, statement.bankAccountId);
      const taken = new Set<string>();
      for (const line of (await this.store.statementLines(tx, [id])).filter((l) => l.matchStatus === 'UNMATCHED')) {
        const candidates = [
          ...transfers.filter((t) => t.externalReference !== null && !taken.has(t.id)).map((t) => ({ id: `payment:${t.id}`, reference: t.externalReference!, amountPesewas: t.amountPesewas })),
          ...payouts.filter((p) => !taken.has(p.settlementReportId)).map((p) => ({ id: `payout:${p.settlementReportId}`, reference: p.settlementRef, amountPesewas: p.netPesewas })),
        ];
        const choice = chooseBankCandidate({ direction: line.direction, amountPesewas: line.amountPesewas, reference: line.bankReference, narration: line.narration }, candidates);
        if (choice.kind === 'MATCH') {
          const [kind, targetId] = choice.candidateId.split(':') as ['payment' | 'payout', string];
          const matched = kind === 'payment' ? await this.clearTransferIn(tx, line, targetId, actorId) : await this.linkPayoutIn(tx, line, targetId, actorId);
          if (matched) {
            taken.add(targetId);
            continue;
          }
        }
        await this.breaks.raiseIn(tx, actorId, {
          kind: 'BANK_LINE_UNMATCHED',
          branchId: statement.branchId,
          paymentId: null,
          refundId: null,
          provider: null,
          reference: null,
          amountPesewas: line.amountPesewas,
          details: { reason: choice.kind === 'BREAK' ? choice.reason : 'ALREADY_MATCHED', direction: line.direction, valueDate: line.valueDate, lineNo: line.lineNo, bankReference: line.bankReference, narration: line.narration },
          sourceDocumentId: statement.id,
          bankStatementLineId: line.id,
        });
      }
      await this.settleStatusIn(tx, id, actorId);
      const view = await this.statementViewIn(tx, id);
      await this.audit.record(tx, { module: 'pay', action: 'MATCH', entityType: 'BankStatement', entityId: id, branchId: statement.branchId, before: statementSummary(before), after: statementSummary(view) });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `matchBankStatementLine`: one line matched by hand, to a pending bank transfer (which clears from it) or to a journal
   * entry whose leg on this account shows the line exactly. A break the line raised stays open: it is resolved through
   * a second person's approval (FR-PAY-017).
   */
  matchLine(actor: Actor | undefined, lineId: string, body: { readonly paymentId: string | null; readonly journalEntryId: string | null }, key: string): Promise<StoredResponse<BankStatementView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriseManage(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: 'matchBankStatementLine', principalId: actor!.principalId, key, request: { lineId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<BankStatementView>;
      const line = await this.store.statementLine(tx, lineId, true);
      if (line === null) throw new NotFoundError('no such bank statement line');
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId: line.branchId });
      if ((body.paymentId === null) === (body.journalEntryId === null)) throw new ReconciliationInvalidError([{ field: '', rule: 'PAYMENT_OR_JOURNAL_ENTRY' }]);
      const actorId = actor!.principalId;
      const before = await this.statementViewIn(tx, line.bankStatementId);
      const matchedLine = { direction: line.direction, amountPesewas: line.amountPesewas, matched: line.matchStatus === 'MATCHED' };
      if (body.paymentId !== null) {
        const transfer = await this.store.pendingTransfer(tx, body.paymentId);
        if (transfer === null) throw new ReconciliationInvalidError([{ field: '/paymentId', rule: 'PAYMENT_UNKNOWN' }]);
        const judged = judgeLineMatch(matchedLine, {
          kind: 'PAYMENT',
          methodKind: transfer.methodKind,
          status: transfer.status,
          sameBankAccount: transfer.bankAccountId === line.bankAccountId,
          amountPesewas: transfer.amountPesewas,
          alreadyMatched: await this.store.lineMatching(tx, { paymentId: transfer.id }),
        });
        if (!judged.ok) throw new ReconciliationInvalidError(judged.error.map((rule) => ({ field: '/paymentId', rule })));
        await this.clearTransferIn(tx, line, transfer.id, actorId);
      } else {
        const entryId = body.journalEntryId!;
        const judged = judgeLineMatch(matchedLine, { kind: 'JOURNAL', leg: await this.bankAccounts.bankLegIn(tx, entryId, line.bankAccountId), alreadyMatched: await this.store.lineMatching(tx, { journalEntryId: entryId }) });
        if (!judged.ok) throw new ReconciliationInvalidError(judged.error.map((rule) => ({ field: '/journalEntryId', rule })));
        await this.store.markLineMatched(tx, line.id, { journalEntryId: entryId }, this.clock.now(), actorId);
      }
      await this.settleStatusIn(tx, line.bankStatementId, actorId);
      const view = await this.statementViewIn(tx, line.bankStatementId);
      await this.audit.record(tx, { module: 'pay', action: 'MATCH_LINE', entityType: 'BankStatementLine', entityId: line.id, branchId: line.branchId, before: statementSummary(before), after: { ...statementSummary(view), ...body } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  statement(actor: Actor | undefined, id: string): Promise<BankStatementView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const found = await this.store.statement(tx, id, false);
      if (found === null || !(await this.readable(tx, actor!, found.branchId))) throw new NotFoundError('no such bank statement');
      return this.statementViewIn(tx, id);
    });
  }

  statements(actor: Actor | undefined, query: { readonly bankAccountId: string | null; readonly status: string | null }, cursor: string | undefined, limit: number): Promise<Page<BankStatementView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listBankStatements', principalId: actor!.principalId, filters: query };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = position === null ? null : { periodEnd: position['periodEnd'] as string, id: position['id'] as string };
      const found = await this.store.statements(tx, { ...query, branchIds: await this.readableBranches(tx, actor!) }, after, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.statementViews(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { periodEnd: last.periodEnd, id: last.id }) : null, limit, hasMore } };
    });
  }

  /**
   * A pending bank transfer cleared from its statement line (FR-PAY-005, FR-PAY-011): the line first (the database
   * clears a transfer only once a line names it), then the payment, then ◆ `pay.PaymentCleared` Dr 1100 against the
   * bank account, Cr 2200 against the customer, dated the line's value date.
   */
  private async clearTransferIn(tx: Transaction, line: StatementLineRecord, paymentId: string, actorId: string): Promise<boolean> {
    const transfer = await this.store.pendingTransfer(tx, paymentId);
    if (transfer === null || transfer.status !== 'PENDING' || (await this.store.lineMatching(tx, { paymentId }))) return false;
    const now = this.clock.now();
    await this.store.markLineMatched(tx, line.id, { paymentId }, now, actorId);
    await this.store.clearTransfer(tx, paymentId, now, actorId);
    const payload: PaymentCleared = {
      paymentId,
      branchId: transfer.branchId,
      methodKind: 'BANK_TRANSFER',
      amountPesewas: json(transfer.amountPesewas),
      allocatedPesewas: 0,
      unallocatedPesewas: json(transfer.amountPesewas),
      customerId: transfer.customerId,
      orderDocumentId: transfer.orderDocumentId,
      register: null,
      allocations: [],
      receivedAt: transfer.receivedAt.toISOString(),
      provider: null,
      heldAsUnmatched: false,
      bankAccountId: line.bankAccountId,
      clearedOn: line.valueDate,
    };
    await this.events.publish(tx, { type: PAYMENT_CLEARED, subjectType: 'Payment', subjectId: paymentId, branchId: transfer.branchId, payload });
    await this.audit.record(tx, { module: 'pay', action: 'CLEAR', entityType: 'Payment', entityId: paymentId, branchId: transfer.branchId, before: { status: 'PENDING' }, after: { status: 'CLEARED', bankStatementLineId: line.id, clearedOn: line.valueDate } });
    return true;
  }

  /** A settlement's payout linked to the line that shows it arriving: the line names its `pay.ProviderSettled` entry. */
  private async linkPayoutIn(tx: Transaction, line: StatementLineRecord, settlementReportId: string, actorId: string): Promise<boolean> {
    const entryId = await this.bankAccounts.entryOfIn(tx, PROVIDER_SETTLED, settlementReportId);
    if (entryId === null || (await this.store.lineMatching(tx, { journalEntryId: entryId }))) return false;
    await this.store.markLineMatched(tx, line.id, { journalEntryId: entryId }, this.clock.now(), actorId);
    return true;
  }

  private async settleStatusIn(tx: Transaction, statementId: string, actorId: string): Promise<void> {
    const lines = await this.store.statementLines(tx, [statementId]);
    await this.store.markStatement(tx, statementId, lines.every((l) => l.matchStatus === 'MATCHED') ? 'RECONCILED' : 'HAS_BREAKS', actorId);
  }

  /** The importing person's authority, at the head office that holds the business's reconciliation. */
  private async authoriseManage(tx: Transaction, actor: Actor | undefined): Promise<string> {
    await this.authoriser.authorise(tx, actor, MANAGE);
    const headOffice = await this.refs.headOfficeBranchIn(tx);
    if (headOffice === null) throw new NotFoundError('no head office branch');
    await this.authoriser.authorise(tx, actor, MANAGE, { branchId: headOffice });
    return headOffice;
  }

  /** The uploaded file, read outside any transaction after the same checks the write repeats (ADR-0044). */
  private async readFile(actor: Actor | undefined, fileId: string): Promise<{ file: StoredFileRecord; content: Buffer }> {
    const file = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      return this.fileAllowedIn(tx, actor, fileId);
    });
    return { file, content: await this.files.content(file) };
  }

  private async fileAllowedIn(tx: Transaction, actor: Actor | undefined, fileId: string): Promise<StoredFileRecord> {
    const file = await this.files.find(tx, fileId);
    if (file === null || file.purpose !== 'IMPORT') throw new ReconciliationInvalidError([{ field: '/fileId', rule: 'FILE_UNKNOWN' }]);
    await this.authoriser.authorise(tx, actor, FILE_READ, { owner: { principalId: file.createdBy, anyPermission: FILE_READ_ANY } });
    if (file.scanStatus !== 'CLEAN') throw new ReconciliationInvalidError([{ field: '/fileId', rule: 'FILE_NOT_CLEAN' }]);
    return file;
  }

  private rowsOf(content: Buffer, contentType: string): string[][] {
    try {
      return readSheet(content, contentType, MAX_FILE_ROWS + 1);
    } catch (error) {
      if (error instanceof SheetUnreadableError) throw new ReconciliationInvalidError([{ field: '/fileId', rule: 'FILE_UNREADABLE' }]);
      throw error;
    }
  }

  private async bankAccountRules(tx: Transaction, bankAccountId: string): Promise<PaymentRule[]> {
    const account = (await this.bankAccounts.payoutAccountsIn(tx, [bankAccountId])).get(bankAccountId);
    return account === undefined || account.kind !== 'BANK' || !account.isActive ? [{ field: '/bankAccountId', rule: 'BANK_ACCOUNT_NOT_USABLE' }] : [];
  }

  private async readableBranches(tx: Transaction, actor: Actor): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, READ)).map((s) => s.branchId))];
  }

  private async readable(tx: Transaction, actor: Actor, branchId: string): Promise<boolean> {
    return (await this.readableBranches(tx, actor)).includes(branchId);
  }

  private async bankAccountRefs(tx: Transaction, ids: readonly string[]): Promise<ReadonlyMap<string, BankAccountRefView>> {
    const accounts = await this.bankAccounts.payoutAccountsIn(tx, ids);
    return new Map([...accounts].map(([id, a]) => [id, { id: a.id, name: a.name, kind: a.kind, last4: a.last4 }] as const));
  }

  private async settlementViews(tx: Transaction, reports: readonly SettlementReportRecord[]): Promise<SettlementReportView[]> {
    const lines = await this.store.settlementLines(tx, reports.map((r) => r.id));
    const accounts = await this.bankAccountRefs(tx, reports.map((r) => r.bankAccountId));
    return reports.map((r) => {
      const own = lines.filter((l) => l.settlementReportId === r.id);
      return {
        id: r.id,
        provider: r.provider,
        settlementRef: r.settlementRef,
        settledOn: r.settledOn,
        bankAccount: accounts.get(r.bankAccountId)!,
        grossPesewas: json(r.grossPesewas),
        feePesewas: json(r.feePesewas),
        netPesewas: json(r.netPesewas),
        status: r.status,
        matchedCount: own.filter((l) => l.matchStatus === 'MATCHED').length,
        breakCount: own.filter((l) => l.matchStatus === 'AMOUNT_DIFFERS' || l.matchStatus === 'NOT_FOUND').length,
        currency: 'GHS',
        lines: own.map(lineView),
      };
    });
  }

  private async statementViewIn(tx: Transaction, id: string): Promise<BankStatementView> {
    return (await this.statementViews(tx, [(await this.store.statement(tx, id, false))!]))[0]!;
  }

  private async statementViews(tx: Transaction, statements: readonly StatementRecord[]): Promise<BankStatementView[]> {
    const lines = await this.store.statementLines(tx, statements.map((s) => s.id));
    const accounts = await this.bankAccountRefs(tx, statements.map((s) => s.bankAccountId));
    const clearings = new Map<string, string | null>();
    for (const l of lines) {
      if (l.matchedPaymentId !== null) clearings.set(l.id, await this.bankAccounts.entryOfIn(tx, PAYMENT_CLEARED, l.matchedPaymentId));
    }
    return statements.map((s) => {
      const own = lines.filter((l) => l.bankStatementId === s.id);
      return {
        id: s.id,
        bankAccount: accounts.get(s.bankAccountId)!,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        openingPesewas: json(s.openingPesewas),
        closingPesewas: json(s.closingPesewas),
        status: s.status,
        lineCount: own.length,
        unmatchedCount: own.filter((l) => l.matchStatus === 'UNMATCHED').length,
        currency: 'GHS',
        lines: own.map((l) => ({
          id: l.id,
          valueDate: l.valueDate,
          direction: l.direction,
          amountPesewas: json(l.amountPesewas),
          narration: l.narration,
          bankReference: l.bankReference,
          matchedJournalEntryId: l.matchedJournalEntryRef ?? clearings.get(l.id) ?? null,
          matchStatus: l.matchStatus,
        })),
      };
    });
  }
}

/** A line as the contract's `SettlementLine`: `UNMATCHED` until its report is matched. */
function lineView(l: SettlementLineRecord): SettlementReportView['lines'][number] {
  return {
    id: l.id,
    providerReference: l.providerReference,
    amountPesewas: json(l.amountPesewas),
    feePesewas: json(l.feePesewas),
    matchedPayment: l.matchedPaymentId === null ? null : { id: l.matchedPaymentId, paymentNo: l.matchedPaymentNo },
    matchStatus: l.matchStatus,
  };
}

function summaryOf(v: SettlementReportView): Record<string, unknown> {
  return { provider: v.provider, settlementRef: v.settlementRef, settledOn: v.settledOn, bankAccountId: v.bankAccount.id, grossPesewas: v.grossPesewas, feePesewas: v.feePesewas, netPesewas: v.netPesewas, status: v.status, matchedCount: v.matchedCount, breakCount: v.breakCount };
}

function statementSummary(v: BankStatementView): Record<string, unknown> {
  return { bankAccountId: v.bankAccount.id, periodStart: v.periodStart, periodEnd: v.periodEnd, openingPesewas: v.openingPesewas, closingPesewas: v.closingPesewas, status: v.status, lineCount: v.lineCount, unmatchedCount: v.unmatchedCount };
}

function fileRules(refusals: readonly FileRefusal[]): PaymentRule[] {
  return refusals.map((r) => ({ field: r.row === 0 ? '/periodEnd' : `/file/rows/${r.row}`, rule: r.rule }));
}

function absDifference(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}
