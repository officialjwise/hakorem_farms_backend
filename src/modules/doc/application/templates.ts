import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { checkTemplateBody } from '../domain/templates';
import type { DocStore, TemplateRecord, VersionRecord } from './doc-store';
import { PreviewDataRequiredError, TemplateBodyRefusedError } from './errors';
import { PLATFORM_RENDERER, renderPreview, type DocumentRenderer } from './rendering';

const READ = 'doc.template.read';
const MANAGE = 'doc.template.manage';

/** The contract's `DocumentTemplate`. */
export interface DocumentTemplateView {
  readonly id: string;
  readonly docType: string;
  readonly output: TemplateRecord['output'];
  readonly name: string;
  readonly activeVersion: { readonly id: string; readonly versionNo: number; readonly activatedAt: string | null } | null;
  readonly versionCount: number;
  readonly version: number;
}

/** The contract's `TemplateVersion`: the body only on the single-version read. */
export interface TemplateVersionView {
  readonly id: string;
  readonly templateId: string;
  readonly versionNo: number;
  readonly status: VersionRecord['status'];
  readonly body: string | null;
  readonly activatedAt: string | null;
  readonly activatedBy: PrincipalRef | null;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

export interface TemplatePage<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/**
 * The contract's `TemplatePreviewResult` (ADR-0062): the specimen bytes inline, base64, in the version's output; nothing
 * is stored, so no link is issued and no unscanned file is ever served.
 */
export interface TemplatePreviewView {
  readonly templateVersionId: string;
  readonly output: TemplateRecord['output'];
  readonly pdfBase64: string | null;
  readonly escPosBase64: string | null;
  readonly url: null;
  readonly expiresAt: null;
}

export interface VersionCreate {
  readonly body: string;
  readonly sampleData?: Record<string, unknown> | undefined;
}

/**
 * Document templates and their versions (FR-DOC-004, FR-BIL-010). Templates are data: an administrator drafts a new
 * version, which is refused at save if it uses anything outside the sandbox, and activates it, audited, with no
 * deployment. A version's body never changes; an issued document keeps the versions it was rendered with, because
 * its archived bytes are never rendered again. Reads need `doc.template.read`; drafting and activating
 * `doc.template.manage`, both checked here (ADR-0035).
 */
export class Templates {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DocStore,
    private readonly principals: PrincipalNames,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly renderer: DocumentRenderer = PLATFORM_RENDERER,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<TemplatePage<DocumentTemplateView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listDocumentTemplates', principalId: actor!.principalId, filters: {} };
      const afterId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.templates(tx, afterId, limit + 1);
      const data = await this.templateViews(tx, rows.slice(0, limit));
      const hasMore = rows.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<DocumentTemplateView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      return (await this.templateViews(tx, [await this.templateOf(tx, id)]))[0]!;
    });
  }

  listVersions(actor: Actor | undefined, templateId: string, cursor: string | undefined, limit: number): Promise<TemplatePage<TemplateVersionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      await this.templateOf(tx, templateId);
      const binding = { operationId: 'listTemplateVersions', principalId: actor!.principalId, filters: { templateId } };
      const after = cursor === undefined ? undefined : this.cursors.decode(cursor, binding)['versionNo'];
      const rows = await this.store.versions(tx, templateId, after === undefined ? null : Number(after), limit + 1);
      const data = await this.versionViews(tx, rows.slice(0, limit), false);
      const hasMore = rows.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { versionNo: String(last.versionNo) }) : null, limit, hasMore } };
    });
  }

  getVersion(actor: Actor | undefined, id: string): Promise<TemplateVersionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      return (await this.versionViews(tx, [await this.versionOf(tx, id)], true))[0]!;
    });
  }

  /** `createTemplateVersion`: a DRAFT with the next number, refused at save if it breaks the sandbox (FR-DOC-004). */
  createVersion(actor: Actor | undefined, templateId: string, body: VersionCreate, idempotencyKey: string): Promise<StoredResponse<TemplateVersionView>> {
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`TEMPLATE:${templateId}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'createTemplateVersion', principalId: actor!.principalId, key: idempotencyKey, request: { templateId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<TemplateVersionView>;
      await this.templateOf(tx, templateId);
      const broken = checkTemplateBody(body.body);
      if (broken.length > 0) throw new TemplateBodyRefusedError(broken);
      const id = this.nextId();
      await this.store.insertVersion(tx, { id, templateId, versionNo: await this.store.nextVersionNo(tx, templateId), body: body.body, sampleData: body.sampleData ?? null, createdBy: actor!.principalId });
      const created = (await this.store.version(tx, id))!;
      await this.audit.record(tx, { module: 'doc', action: 'CREATE', entityType: 'TemplateVersion', entityId: id, before: null, after: auditShape(created) });
      const response = { status: 201, body: (await this.versionViews(tx, [created], true))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `activateTemplateVersion`: the DRAFT becomes the template's one ACTIVE version and the previous one is RETIRED,
   * audited with before and after. The next document issued uses it; no document already issued changes.
   */
  activate(actor: Actor | undefined, versionId: string, idempotencyKey: string): Promise<StoredResponse<TemplateVersionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'activateTemplateVersion', principalId: actor!.principalId, key: idempotencyKey, request: { versionId } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<TemplateVersionView>;
      const version = await this.versionOf(tx, versionId, true);
      if (version.status !== 'DRAFT') throw new InvalidStateTransitionError(`template version ${versionId} is ${version.status}; only a DRAFT is activated`);
      const broken = checkTemplateBody(version.body);
      if (broken.length > 0) throw new TemplateBodyRefusedError(broken);
      const template = (await this.store.template(tx, version.templateId, true))!;
      const previous = template.activeVersionId === null ? null : await this.store.version(tx, template.activeVersionId);
      await this.store.activate(tx, template, versionId, actor!.principalId, this.clock.now());
      const activated = (await this.store.version(tx, versionId))!;
      await this.audit.record(tx, {
        module: 'doc',
        action: 'ACTIVATE',
        entityType: 'DocumentTemplate',
        entityId: template.id,
        before: { activeVersionId: template.activeVersionId, activeVersionNo: previous?.versionNo ?? null },
        after: { activeVersionId: versionId, activeVersionNo: activated.versionNo },
      });
      const response = { status: 200, body: (await this.versionViews(tx, [activated], false))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /**
   * `previewTemplateVersion` (FR-DOC-004, ADR-0062): renders any version, a draft included, with the data given or the
   * version's sample data, between two specimen markers, and returns the bytes inline. It writes nothing: no render
   * job, no archive row, no stored file, no number, no audit event, so it needs no idempotency key.
   */
  preview(actor: Actor | undefined, versionId: string, data: Record<string, unknown> | undefined): Promise<TemplatePreviewView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const version = await this.versionOf(tx, versionId);
      const template = (await this.store.template(tx, version.templateId))!;
      const values = data ?? version.sampleData;
      if (values === null) throw new PreviewDataRequiredError(versionId);
      const bytes = renderPreview(this.renderer, version.body, template.output, values).toString('base64');
      const pdf = template.output === 'PDF_A4';
      return { templateVersionId: version.id, output: template.output, pdfBase64: pdf ? bytes : null, escPosBase64: pdf ? null : bytes, url: null, expiresAt: null };
    });
  }

  private async templateOf(tx: Transaction, id: string): Promise<TemplateRecord> {
    const template = await this.store.template(tx, id);
    if (template === null) throw new NotFoundError(`document template ${id} does not exist`);
    return template;
  }

  private async versionOf(tx: Transaction, id: string, forUpdate = false): Promise<VersionRecord> {
    const version = await this.store.version(tx, id, forUpdate);
    if (version === null) throw new NotFoundError(`template version ${id} does not exist`);
    return version;
  }

  private async templateViews(tx: Transaction, templates: readonly TemplateRecord[]): Promise<DocumentTemplateView[]> {
    const views: DocumentTemplateView[] = [];
    for (const t of templates) {
      const active = t.activeVersionId === null ? null : await this.store.version(tx, t.activeVersionId);
      views.push({
        id: t.id,
        docType: t.docType,
        output: t.output,
        name: t.name,
        activeVersion: active === null ? null : { id: active.id, versionNo: active.versionNo, activatedAt: active.activatedAt?.toISOString() ?? null },
        versionCount: t.versionCount,
        version: t.version,
      });
    }
    return views;
  }

  private async versionViews(tx: Transaction, versions: readonly VersionRecord[], withBody: boolean): Promise<TemplateVersionView[]> {
    const names = await this.principals.refs(tx, [...new Set(versions.flatMap((v) => (v.activatedBy === null ? [v.createdBy] : [v.createdBy, v.activatedBy])))]);
    const ref = (id: string): PrincipalRef => names.get(id) ?? { id, displayName: 'Unknown' };
    return versions.map((v) => ({
      id: v.id,
      templateId: v.templateId,
      versionNo: v.versionNo,
      status: v.status,
      body: withBody ? v.body : null,
      activatedAt: v.activatedAt?.toISOString() ?? null,
      activatedBy: v.activatedBy === null ? null : ref(v.activatedBy),
      createdAt: v.createdAt.toISOString(),
      createdBy: ref(v.createdBy),
    }));
  }
}

function auditShape(v: VersionRecord): Record<string, unknown> {
  return { templateId: v.templateId, versionNo: v.versionNo, status: v.status, bodyBytes: Buffer.byteLength(v.body, 'utf8') };
}
