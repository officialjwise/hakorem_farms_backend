import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { decodePosition, encodePosition, resolveSort, type SortSpec } from '../../../platform/http/keyset-sort';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { isTemplateCode, judgeTemplate, preview, type Category, type Channel } from '../domain/templates';
import { TemplateInvalidError, TemplateNotActivatableError } from './errors';
import type { NtfStore, TemplateFilters, TemplateRecord } from './ntf-store';

const READ = 'ntf.template.read';
const MANAGE = 'ntf.template.manage';
export const CREATE_TEMPLATE = 'createNotificationTemplate';
export const ACTIVATE_TEMPLATE = 'activateNotificationTemplate';
/** English ships first (FR-NTF-001); the column makes other languages data. */
export const DEFAULT_LOCALE = 'en-GH';

/** The contract's `NotificationTemplate`. */
export interface NotificationTemplateView {
  readonly id: string;
  readonly code: string;
  readonly channel: Channel;
  readonly locale: string;
  readonly category: Category;
  readonly subject: string | null;
  readonly body: string;
  readonly providerTemplateRef: string | null;
  readonly versionNo: number;
  readonly status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  readonly version: number;
  readonly createdAt: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface TemplateCreate {
  readonly code: string;
  readonly channel: Channel;
  readonly locale?: string | undefined;
  readonly category: Category;
  readonly subject?: string | undefined;
  readonly body: string;
  readonly providerTemplateRef?: string | undefined;
}

/** Templates list by code, channel, then the newest version first, then the id (index ix_template_code). */
const TEMPLATE_ORDER: SortSpec<'code'> = {
  fields: { code: { expression: "(t.code || '/' || t.channel || '/' || lpad((100000000 - t.version_no)::text, 9, '0'))", type: 'text' } },
  tieBreaker: { expression: 't.id', type: 'uuid' },
  defaultOrder: { field: 'code', direction: 'asc' },
};

export function templateView(t: TemplateRecord): NotificationTemplateView {
  return {
    id: t.id,
    code: t.code,
    channel: t.channel,
    locale: t.locale,
    category: t.category,
    subject: t.subject,
    body: t.body,
    providerTemplateRef: t.providerTemplateRef,
    versionNo: t.versionNo,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
  };
}

/**
 * Message templates (FR-NTF-001, the owner 2026-11-23: listed, so a reminder level picks one instead of typing a code).
 * A template is a version of a code, channel and locale; a change is a new DRAFT version, made active by a second person
 * (never its drafter: abuse case 57, the database holds it too), which retires the version it replaces. A version's text
 * never changes, so a message keeps the version it was rendered from. A template names only its code's merge fields and
 * never carries a link of its own. Each handler authorises first, deny by default; templates are farm-wide master data.
 */
export class Templates {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, query: { readonly code?: string | undefined; readonly channel?: string | undefined; readonly status?: string | undefined }, cursor: string | undefined, limit: number): Promise<Page<NotificationTemplateView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const filters: TemplateFilters = { code: query.code ?? null, channel: query.channel ?? null, status: query.status ?? null };
      const order = resolveSort(TEMPLATE_ORDER, undefined, undefined);
      const binding = { operationId: 'listNotificationTemplates', principalId: actor!.principalId, filters };
      const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
      const found = await this.store.templatePage(tx, filters, order, position, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: rows.map(templateView), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<NotificationTemplateView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      return templateView(await this.found(tx, id, false));
    });
  }

  create(actor: Actor | undefined, body: TemplateCreate, idempotencyKey: string): Promise<StoredResponse<NotificationTemplateView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: CREATE_TEMPLATE, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<NotificationTemplateView>;
      const judged = judgeTemplate({ code: body.code, channel: body.channel, category: body.category, subject: body.subject ?? null, body: body.body, providerTemplateRef: body.providerTemplateRef ?? null });
      if (!judged.ok) throw new TemplateInvalidError(judged.error);
      const locale = body.locale ?? DEFAULT_LOCALE;
      const versionNo = (await this.store.lastVersionNo(tx, body.code, body.channel, locale)) + 1;
      const at = this.clock.now();
      const id = this.nextId();
      await this.store.insertTemplate(tx, {
        id,
        code: body.code,
        channel: body.channel,
        locale,
        category: body.category,
        subject: body.subject ?? null,
        body: body.body,
        providerTemplateRef: body.providerTemplateRef ?? null,
        versionNo,
        status: 'DRAFT',
        createdAt: at,
        createdBy: actor!.principalId,
        at,
      });
      const view = templateView((await this.store.template(tx, id, false))!);
      await this.audit.record(tx, { module: 'ntf', action: 'CREATE', entityType: 'NotificationTemplate', entityId: id, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  activate(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<NotificationTemplateView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: ACTIVATE_TEMPLATE, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<NotificationTemplateView>;
      const draft = await this.found(tx, id, true);
      if (draft.status !== 'DRAFT') throw new TemplateNotActivatableError('NOT_DRAFT');
      if (draft.createdBy === actor!.principalId) throw new TemplateNotActivatableError('OWN_DRAFT');
      const at = this.clock.now();
      const replaced = await this.store.activeTemplate(tx, draft.code, draft.channel, draft.locale, true);
      if (replaced !== null) await this.store.setTemplateStatus(tx, replaced.id, 'RETIRED', at, actor!.principalId);
      await this.store.setTemplateStatus(tx, id, 'ACTIVE', at, actor!.principalId);
      const view = templateView((await this.store.template(tx, id, false))!);
      await this.audit.record(tx, {
        module: 'ntf',
        action: 'ACTIVATE',
        entityType: 'NotificationTemplate',
        entityId: id,
        before: { status: draft.status, replacedTemplateId: replaced?.id ?? null, replacedVersionNo: replaced?.versionNo ?? null },
        after: { status: view.status, code: view.code, channel: view.channel, versionNo: view.versionNo, body: view.body, draftedBy: draft.createdBy },
      });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  preview(actor: Actor | undefined, id: string, data: Readonly<Record<string, string>>): Promise<{ readonly subject: string | null; readonly body: string; readonly characterCount: number; readonly smsSegments: number }> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const template = await this.found(tx, id, false);
      if (!isTemplateCode(template.code)) throw new TemplateInvalidError([{ field: '/code', rule: 'UNKNOWN_TEMPLATE_CODE' }]);
      const shown = preview(template.code, template.subject, template.body, data);
      if (!shown.ok) throw new TemplateInvalidError(shown.error);
      return shown.value;
    });
  }

  private async found(tx: Transaction, id: string, lock: boolean): Promise<TemplateRecord> {
    const template = await this.store.template(tx, id, lock);
    if (template === null) throw new NotFoundError(`no notification template ${id}`);
    return template;
  }
}
