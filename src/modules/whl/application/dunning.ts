import { createUuidV7Generator, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Billing } from '../../bil';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { byLevel, judgeLevels, levelDue, type DunningChannel, type DunningLevelRule } from '../domain/dunning';
import { pageProbe } from '../domain/paging';
import { daysPastDue } from '../domain/time';
import type { DunningNoticeRecord, DunningStore } from './dunning-store';
import { DunningPolicyInvalidError } from './errors';
import type { Page } from './statements';

const READ = 'whl.dunning.read';
const MANAGE = 'whl.dunning.manage';
/** The outbox event NTF sends a reminder from (B11): one per notice, in the notice's own transaction. */
export const DUNNING_NOTICE_DUE = 'whl.DunningNoticeDue';
const DUNNED_KINDS = new Set(['INVOICE', 'DEBIT_NOTE']);
const ACCOUNT_BATCH = 100;

/** The contract's `DunningLevel`. */
export interface DunningLevelView {
  readonly level: number;
  readonly daysOverdue: number;
  readonly channels: readonly DunningChannel[];
  readonly templateCode: string;
}

/** The contract's `DunningNotice`. */
export interface DunningNoticeView {
  readonly id: string;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly billingDocument: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly level: number;
  readonly daysPastDue: number;
  readonly outstandingPesewas: number;
  readonly channels: readonly DunningChannel[];
  readonly templateCode: string;
  readonly sentAt: string;
  readonly currency: 'GHS';
}

/** `whl.DunningNoticeDue` v1: a reminder level reached an invoice; NTF (B11) sends it by the first channel the customer has not opted out of. */
export interface DunningNoticeDue {
  readonly noticeId: string;
  readonly customerId: string;
  readonly billingDocumentId: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  readonly level: number;
  readonly daysPastDue: number;
  readonly outstandingPesewas: number;
  readonly channels: readonly DunningChannel[];
  readonly templateCode: string;
  readonly noticeDate: string;
}

/**
 * Dunning (FR-WHL-011, A-318): the reminder levels, the reminders queued, and the daily job that queues them. Each day
 * every invoice and debit note of a business account (on hold or not, never closed) that is still owed is given the
 * highest level whose days overdue it has reached, unless a level as high or higher has reached it already: the notice
 * is written and `whl.DunningNoticeDue` published in one transaction per account, so a level reaches a document at most
 * once however often the job runs, and a run stopped midway leaves each account either done or untouched (the database
 * holds both: `uq_dunning_notice_level`, `ck_dunning_notice_order`). A paid document is no longer owed and gets none.
 * Sending, and skipping an opted-out channel for the next, are NTF's (B11). Each handler authorises first.
 */
export class Dunning {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DunningStore,
    private readonly billing: Billing,
    private readonly refs: MasterDataRefs,
    private readonly registry: DocumentRegistry,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** listDunningLevels: the live levels, lowest first. */
  levels(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<DunningLevelView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listDunningLevels', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? 0 : Number(this.cursors.decode(cursor, binding)['level'] ?? '0');
      const rows = (await this.store.levels(tx)).filter((l) => l.level > after);
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return { data: page.map(levelView), page: { nextCursor: hasMore ? this.cursors.encode(binding, { level: String(page.at(-1)!.level) }) : null, limit, hasMore } };
    });
  }

  /** replaceDunningLevels: the whole set at once, audited; no levels at all turns reminders off. Replayed by its Idempotency-Key. */
  replace(actor: Actor | undefined, levels: readonly DunningLevelRule[], key: string): Promise<StoredResponse<Page<DunningLevelView>>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'replaceDunningLevels', principalId: actor!.principalId, key, request: { levels } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<Page<DunningLevelView>>;
      const broken = judgeLevels(levels);
      if (broken.length > 0) throw new DunningPolicyInvalidError(broken);
      const before = await this.store.levels(tx);
      const ordered = byLevel(levels);
      await this.store.replaceLevels(tx, ordered.map((l) => ({ ...l, id: this.nextId() })), actor!.principalId, this.clock.now());
      await this.audit.record(tx, { module: 'whl', action: 'REPLACE', entityType: 'DunningPolicy', entityId: null, branchId: null, before: { levels: before.map(levelView) }, after: { levels: ordered.map(levelView) } });
      const response = { status: 200, body: { data: ordered.map(levelView), page: { nextCursor: null, limit: Math.max(ordered.length, 1), hasMore: false } } };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** listDunningNotices: the reminders queued at the branches the reader holds `whl.dunning.read` for, newest first. */
  notices(actor: Actor | undefined, query: { readonly customerId: string | null; readonly from: string | null }, cursor: string | undefined, limit: number): Promise<Page<DunningNoticeView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listDunningNotices', principalId: actor!.principalId, filters: query };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.notices(tx, { branchIds, customerId: query.customerId, from: query.from === null ? null : new Date(query.from) }, beforeId, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /** The worker's `dunning` job, run as the Scheduler: the notices queued this run. */
  async run(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the dunning job runs as a SYSTEM principal only');
    const queued: string[] = [];
    let after: string | null = null;
    for (;;) {
      const batch = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.openAccounts(tx, after, ACCOUNT_BATCH));
      for (const account of batch) queued.push(...(await this.uow.run({ isolation: 'serializable' }, (tx) => this.dunIn(tx, account.customerId, system.principalId))));
      if (batch.length < ACCOUNT_BATCH) return queued;
      after = batch.at(-1)!.customerId;
    }
  }

  /** One account's reminders due today, written with their events in the caller's transaction. */
  private async dunIn(tx: Transaction, customerId: string, actorId: string): Promise<string[]> {
    const levels = await this.store.levels(tx);
    if (levels.length === 0) return [];
    const now = this.clock.now();
    const today = toBusinessDate(now);
    const owed = (await this.billing.customerOpenItemsIn(tx, customerId)).filter((i) => DUNNED_KINDS.has(i.kind));
    const sent = await this.store.sentLevels(tx, owed.map((i) => i.id));
    const due = owed.flatMap((i) => {
      const days = daysPastDue(i.dueDate ?? i.issueDate, today);
      const rule = levelDue(days, levels, sent.get(i.id) ?? []);
      return rule === null ? [] : [{ item: i, days, rule }];
    });
    const facts = await this.billing.settleableIn(tx, due.map((d) => d.item.id));
    const queued: string[] = [];
    for (const { item, days, rule } of due) {
      const notice: DunningNoticeRecord = {
        id: this.nextId(),
        customerId,
        billingDocumentId: item.id,
        branchId: facts.get(item.id)!.branchId,
        level: rule.level,
        daysPastDue: days,
        outstandingPesewas: item.outstandingPesewas,
        channels: rule.channels,
        templateCode: rule.templateCode,
        noticeDate: today,
        queuedAt: now,
      };
      if (!(await this.store.insertNotice(tx, notice, actorId))) continue;
      const payload: DunningNoticeDue = {
        noticeId: notice.id,
        customerId,
        billingDocumentId: item.id,
        documentNo: item.documentNo,
        branchId: notice.branchId,
        level: notice.level,
        daysPastDue: days,
        outstandingPesewas: Money.ofPesewas(item.outstandingPesewas).toJsonInteger(),
        channels: notice.channels,
        templateCode: notice.templateCode,
        noticeDate: today,
      };
      await this.events.publish(tx, { type: DUNNING_NOTICE_DUE, subjectType: 'DunningNotice', subjectId: notice.id, branchId: notice.branchId, payload: { ...payload } });
      await this.audit.record(tx, { module: 'whl', action: 'DUNNING_NOTICE', entityType: 'DunningNotice', entityId: notice.id, branchId: notice.branchId, before: null, after: { ...payload } });
      queued.push(notice.id);
    }
    return queued;
  }

  private async views(tx: Transaction, rows: readonly DunningNoticeRecord[]): Promise<DunningNoticeView[]> {
    const customers = await this.refs.customersIn(tx, [...new Set(rows.map((r) => r.customerId))]);
    const documents = await this.registry.numberedRefs(tx, rows.map((r) => r.billingDocumentId));
    return rows.map((r) => {
      const customer = customers.get(r.customerId)!;
      const document = documents.get(r.billingDocumentId);
      return {
        id: r.id,
        customer: { id: customer.id, publicId: customer.publicId, name: customer.name },
        billingDocument: { id: r.billingDocumentId, docType: document?.docType ?? 'INVOICE', number: document?.number ?? null },
        level: r.level,
        daysPastDue: r.daysPastDue,
        outstandingPesewas: Money.ofPesewas(r.outstandingPesewas).toJsonInteger(),
        channels: r.channels,
        templateCode: r.templateCode,
        sentAt: r.queuedAt.toISOString(),
        currency: 'GHS',
      };
    });
  }
}

function levelView(l: DunningLevelRule): DunningLevelView {
  return { level: l.level, daysOverdue: l.daysOverdue, channels: l.channels, templateCode: l.templateCode };
}
