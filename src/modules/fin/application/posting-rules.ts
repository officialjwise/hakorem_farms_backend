import { createHash } from 'node:crypto';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { DeterminantType, RuleDeterminant, Side } from '../domain/posting';
import { checkDeterminationChange, checkRuleChange, effectiveFrom, type ChangeFacts, type DeterminationProposal, type RuleProposal } from '../domain/rule-change';
import { postingCatalogueGaps } from '../domain/rule-set';
import { FinStateError, PostingRuleInvalidError } from './errors';
import type { AccountRefRow, JournalStore, RuleChangeRow } from './journal-store';
import type { LedgerStore } from './ledger-store';
import type { Page } from './periods';

export const POSTING_RULE_CHANGE = 'POSTING_RULE_CHANGE' as const;
const READ = 'fin.posting_rule.read';
const MANAGE = 'fin.posting_rule.manage';

export interface PostingEventTypeView {
  readonly code: string;
  readonly ownerModule: string;
  readonly description: string;
  readonly amountKeys: readonly string[];
  readonly hasCompleteRules: boolean;
}

/** The contract's `PostingRule`. `approvalRequestId` is null only for a rule seeded by migration (A-182). */
export interface PostingRuleView {
  readonly id: string;
  readonly eventCode: string;
  readonly amountKey: string;
  readonly side: Side;
  readonly account: AccountRefRow | null;
  readonly determinantType: RuleDeterminant | null;
  readonly determinantRole: string | null;
  readonly subledgerFrom: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly approvalRequestId: string | null;
}

/** The contract's `AccountDetermination`. */
export interface AccountDeterminationView {
  readonly id: string;
  readonly determinantType: DeterminantType;
  readonly determinantKey: string;
  readonly role: string;
  readonly account: AccountRefRow;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface RuleChangePendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof POSTING_RULE_CHANGE;
  readonly subject: { readonly id: string; readonly docType: typeof POSTING_RULE_CHANGE; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface PostingRuleCreateRequest {
  readonly eventCode: string;
  readonly amountKey: string;
  readonly side: Side;
  readonly accountId?: string | undefined;
  readonly determinantType?: DeterminantType | undefined;
  readonly determinantRole?: string | undefined;
  readonly subledgerFrom?: string | undefined;
  readonly validFrom: string;
}

export type AccountDeterminationCreateRequest = DeterminationProposal;

/**
 * Posting rules and account determinations as data (FR-FIN-005, ADR-0003, ADR-0017, ADR-0020, A-191). Anyone with
 * `fin.posting_rule.read` lists the event catalogue, the rules and the determinations; asking to change one needs
 * `fin.posting_rule.manage` with step-up and is always answered 202 `POSTING_RULE_CHANGE`. A different holder of
 * `fin.posting_rule.approve` approves it with step-up; only then is the rule in force end-dated and the new one started,
 * from the later of the date asked for and the approval day, so a change never reaches back and nothing posted is
 * re-posted. A change replaces a rule, never adds one, so every event keeps a balanced, complete rule set and the boot
 * assertion holds. The checks run again at approval against the rules as they then stand.
 */
export class PostingRules implements ApprovalHandler {
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
    private readonly refs: MasterDataRefs,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly handledTypes: () => readonly string[],
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  eventTypes(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<PostingEventTypeView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listPostingEventTypes', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['code'] ?? null);
      const all = await this.store.eventTypes(tx);
      const { rules } = await this.ledgerStore.catalogue(tx, toBusinessDate(this.clock.now()));
      const found = all.filter((t) => after === null || t.code > after).slice(0, limit + 1);
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const data = rows.map((t) => ({
        ...t,
        hasCompleteRules: postingCatalogueGaps({ declared: [], handled: this.handledTypes(), eventTypes: [t], rules: rules.filter((r) => r.eventCode === t.code) }).length === 0,
      }));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { code: rows.at(-1)!.code }) : null, limit, hasMore } };
    });
  }

  rules(actor: Actor | undefined, query: { readonly eventCode?: string | undefined; readonly at?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<PostingRuleView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { eventCode: query.eventCode ?? null, at: query.at ?? null };
      const binding = { operationId: 'listPostingRules', principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.postingRules(tx, filters, after, limit + 1);
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const data = rows.map((r) => ({
        id: r.id,
        eventCode: r.eventCode,
        amountKey: r.amountKey,
        side: r.side,
        account: r.account,
        determinantType: r.determinantType,
        determinantRole: r.determinantRole,
        subledgerFrom: r.subledgerFrom,
        validFrom: r.validFrom,
        validTo: r.validTo,
        approvalRequestId: r.approvalRequestId,
      }));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  determinations(actor: Actor | undefined, query: { readonly determinantType?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<AccountDeterminationView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters = { type: query.determinantType ?? null };
      const binding = { operationId: 'listAccountDeterminations', principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.determinations(tx, filters, after, limit + 1);
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const data = rows.map((d) => ({ id: d.id, determinantType: d.type, determinantKey: d.key, role: d.role, account: d.account, validFrom: d.validFrom, validTo: d.validTo }));
      return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  requestRule(actor: Actor | undefined, body: PostingRuleCreateRequest, idempotencyKey: string): Promise<StoredResponse<RuleChangePendingView>> {
    return this.request(actor, 'createPostingRule', body, idempotencyKey, async (tx, facts) => {
      const proposal = ruleProposal(body);
      const verdict = checkRuleChange(proposal, facts);
      if (!verdict.ok) throw new PostingRuleInvalidError(verdict.error);
      const target = proposal.accountId === null ? `${proposal.determinantType} ${proposal.determinantRole}` : facts.accounts.get(proposal.accountId)!.code;
      return {
        change: { target: 'RULE', eventCode: body.eventCode, amountKey: body.amountKey, side: body.side, accountId: proposal.accountId, determinantType: body.determinantType ?? null, determinantRole: body.determinantRole ?? null, determinantKey: null, subledgerFrom: body.subledgerFrom ?? null, validFrom: body.validFrom },
        summary: `Post ${body.eventCode} ${body.amountKey} (${body.side}) to ${target} from ${body.validFrom}`,
      };
    });
  }

  requestDetermination(actor: Actor | undefined, body: AccountDeterminationCreateRequest, idempotencyKey: string): Promise<StoredResponse<RuleChangePendingView>> {
    return this.request(actor, 'createAccountDetermination', body, idempotencyKey, async (_tx, facts) => {
      const verdict = checkDeterminationChange(body, facts);
      if (!verdict.ok) throw new PostingRuleInvalidError(verdict.error);
      return {
        change: { target: 'DETERMINATION', eventCode: null, amountKey: null, side: null, accountId: body.accountId, determinantType: body.determinantType, determinantRole: body.role, determinantKey: body.determinantKey, subledgerFrom: null, validFrom: body.validFrom },
        summary: `Map ${body.determinantType} ${body.determinantKey} (${body.role}) to ${facts.accounts.get(body.accountId)!.code} from ${body.validFrom}`,
      };
    });
  }

  /** ApprovalHandler: the change asked for, which never changes once asked. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    return changeHash(await this.changeOf(tx, subjectDocumentId, false));
  }

  /**
   * ApprovalHandler: applies the change in the approval's transaction, as the checker. The checks run again from the
   * effective date, the later of the date asked for and today: a rule that moved since is refused and the change waits.
   */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const change = await this.changeOf(tx, request.subjectDocumentId, true);
    if (change.status !== 'PENDING_APPROVAL') throw new FinStateError(`posting rule change ${change.id}`, change.status);
    const today = toBusinessDate(this.clock.now());
    const from = effectiveFrom(change.validFrom, today);
    const facts = await this.facts(tx, today, change.eventCode);
    const decidedBy = request.decidedBy!;
    let postingRuleId: string | null = null;
    let determinationId: string | null = null;
    let replaced: string | null;
    if (change.target === 'RULE') {
      const proposal: RuleProposal = { eventCode: change.eventCode!, amountKey: change.amountKey!, side: change.side!, accountId: change.accountId, determinantType: change.determinantType, determinantRole: change.determinantRole, validFrom: from };
      const verdict = checkRuleChange(proposal, facts);
      if (!verdict.ok) throw new PostingRuleInvalidError(verdict.error);
      replaced = verdict.value.replaces;
      postingRuleId = this.nextId();
      await this.store.endRule(tx, replaced, from, decidedBy);
      await this.store.insertRule(tx, { id: postingRuleId, ...proposal, subledgerFrom: change.subledgerFrom, approvalRequestId: request.id }, decidedBy);
    } else {
      const proposal: DeterminationProposal = { determinantType: change.determinantType!, determinantKey: change.determinantKey!, role: change.determinantRole!, accountId: change.accountId!, validFrom: from };
      const verdict = checkDeterminationChange(proposal, facts);
      if (!verdict.ok) throw new PostingRuleInvalidError(verdict.error);
      replaced = verdict.value.replaces;
      determinationId = this.nextId();
      if (replaced !== null) await this.store.endDetermination(tx, replaced, from, decidedBy);
      await this.store.insertDetermination(tx, { id: determinationId, type: proposal.determinantType, key: proposal.determinantKey, role: proposal.role, accountId: proposal.accountId, validFrom: from, approvalRequestId: request.id }, decidedBy);
    }
    await this.store.decideRuleChange(tx, change.id, { status: 'POSTED', effectiveFrom: from, postingRuleId, determinationId, decidedBy, at: this.clock.now() });
    await this.audit.record(tx, {
      module: 'fin',
      action: 'APPLY_RULE_CHANGE',
      entityType: change.target === 'RULE' ? 'PostingRule' : 'AccountDetermination',
      entityId: postingRuleId ?? determinationId!,
      branchId: change.branchId,
      before: { replaces: replaced, validTo: null },
      after: { ...changeShape(change), effectiveFrom: from, replacedValidTo: replaced === null ? null : from },
      metadata: { approvalRequestId: request.id, changeId: change.id, requestedBy: change.createdBy },
    });
  }

  /** ApprovalHandler: a rejected or withdrawn change is final; the rules stay as they are. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const change = await this.changeOf(tx, request.subjectDocumentId, true);
    await this.store.decideRuleChange(tx, change.id, { status: 'REJECTED', effectiveFrom: null, postingRuleId: null, determinationId: null, decidedBy: request.decidedBy ?? request.requestedBy, at: this.clock.now() });
    await this.audit.record(tx, {
      module: 'fin',
      action: 'REJECT_RULE_CHANGE',
      entityType: 'PostingRuleChange',
      entityId: change.id,
      branchId: change.branchId,
      before: { status: change.status },
      after: { status: 'REJECTED' },
      metadata: { approvalRequestId: request.id, approvalStatus: request.status },
    });
  }

  private request(
    actor: Actor | undefined,
    operationId: string,
    body: object,
    idempotencyKey: string,
    judge: (tx: Transaction, facts: ChangeFacts) => Promise<{ change: Omit<RuleChangeRow, 'id' | 'branchId' | 'status' | 'approvalRequestId' | 'createdBy' | 'version'>; summary: string }>,
  ): Promise<StoredResponse<RuleChangePendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RuleChangePendingView>;
      const eventCode = 'eventCode' in body ? String(body.eventCode) : null;
      const { change, summary } = await judge(tx, await this.facts(tx, toBusinessDate(this.clock.now()), eventCode));
      const branchId = await this.refs.headOfficeBranchIn(tx);
      if (branchId === null) throw new Error('no active branch to hold the posting rule change');
      if (await this.store.ruleChangePending(tx, change)) throw new PostingRuleInvalidError([{ field: change.target === 'RULE' ? '/side' : '/determinantKey', rule: 'CHANGE_PENDING' }]);
      const id = this.nextId();
      await this.documents.register(tx, { id, docType: POSTING_RULE_CHANGE, ownerModule: 'fin', branchId, actorId: actor!.principalId });
      const row: RuleChangeRow = { ...change, id, branchId, status: 'PENDING_APPROVAL', approvalRequestId: '', createdBy: actor!.principalId, version: 1 };
      const approval = await this.approvals.request(tx, actor, { kind: POSTING_RULE_CHANGE, branchId, subjectDocumentId: id, payloadHash: changeHash(row), summary });
      await this.store.insertRuleChange(tx, { ...row, approvalRequestId: approval.id });
      await this.audit.record(tx, {
        module: 'fin',
        action: 'REQUEST_RULE_CHANGE',
        entityType: 'PostingRuleChange',
        entityId: id,
        branchId,
        before: null,
        after: { ...changeShape(row), approvalRequestId: approval.id },
      });
      const response = {
        status: 202,
        body: { status: 'PENDING_APPROVAL' as const, approvalRequestId: approval.id, kind: POSTING_RULE_CHANGE, subject: { id, docType: POSTING_RULE_CHANGE, number: null }, summary, requestedAt: approval.requestedAt.toISOString() },
      };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async facts(tx: Transaction, today: string, eventCode: string | null): Promise<ChangeFacts> {
    const types = await this.store.eventTypes(tx);
    return {
      today,
      eventTypes: new Map(types.map((t) => [t.code, t.amountKeys])),
      rules: eventCode === null ? [] : await this.store.rulesOfEvent(tx, eventCode),
      determinations: await this.store.allDeterminations(tx),
      accounts: await this.store.allAccountFacts(tx),
    };
  }

  private async changeOf(tx: Transaction, id: string, forUpdate: boolean): Promise<RuleChangeRow> {
    const change = await this.store.ruleChange(tx, id, forUpdate);
    if (change === null) throw new NotFoundError(`no posting rule change ${id}`);
    return change;
  }
}

function ruleProposal(body: PostingRuleCreateRequest): RuleProposal {
  return {
    eventCode: body.eventCode,
    amountKey: body.amountKey,
    side: body.side,
    accountId: body.accountId ?? null,
    determinantType: body.determinantType ?? null,
    determinantRole: body.determinantRole ?? null,
    validFrom: body.validFrom,
  };
}

function changeShape(change: Omit<RuleChangeRow, 'approvalRequestId' | 'createdBy' | 'version' | 'branchId' | 'status'>): Record<string, unknown> {
  return {
    target: change.target,
    eventCode: change.eventCode,
    amountKey: change.amountKey,
    side: change.side,
    accountId: change.accountId,
    determinantType: change.determinantType,
    determinantRole: change.determinantRole,
    determinantKey: change.determinantKey,
    subledgerFrom: change.subledgerFrom,
    validFrom: change.validFrom,
  };
}

/** What the checker approves: exactly this rule or mapping, from this date. */
function changeHash(change: Omit<RuleChangeRow, 'approvalRequestId' | 'createdBy' | 'version' | 'branchId' | 'status'>): string {
  return createHash('sha256').update(canonicalJson({ id: change.id, ...changeShape(change) })).digest('hex');
}
