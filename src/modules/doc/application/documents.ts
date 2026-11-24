import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import { currentRequestContext, type Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, ValidationFailedError } from '../../../platform/errors/api-error';
import type { AsyncConsumer, DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { issueLinkToken, linkTokenHash } from '../../../platform/crypto/link-tokens';
import { scrubString } from '../../../platform/logging/log-scrubber';
import type { FileStore, PutFile, StoredFileRecord } from '../../../platform/storage/file-store';
import type { Authoriser } from '../../iam';
import type { DocumentArchived, RenderRequested } from '../events';
import type { ArchiveFilter, ArchivedRecord, DocStore, TemplateRecord } from './doc-store';
import { ArchiveHashMismatchError, DocumentNotArchivedError } from './errors';
import { FileNotCleanError, type SignedUrlView } from './files';
import { PLATFORM_RENDERER, renderBody, type DocumentRenderer } from './rendering';

export const RENDER_REQUESTED = 'doc.RenderRequested';
export const DOCUMENT_ARCHIVED = 'doc.DocumentArchived';
const READ = 'doc.document.read';
const ARCHIVE_PREFIX = 'archive';
const PDF_TYPE = 'application/pdf';
const ESC_POS_TYPE = 'application/octet-stream';
const MAX_ERROR = 500;
/** A document link's token (B11 continued 13, ADR-0074): `doc_` and 32 random bytes; only its SHA-256 is stored. */
export const DOCUMENT_LINK_PREFIX = 'doc_';
/** How long a document link sent by message opens its document (A-288 (b)): thirty days, as a tracking link. */
export const DOCUMENT_LINK_TTL_MS = 30 * 24 * 3_600_000;
/** The principal a public read of a document link is logged under (the Storefront's, as a quote's buyer link). */
const STOREFRONT_PRINCIPAL = '01900000-0000-7000-8000-000000000006';
/** The one answer to every token that opens nothing: never sent, mistyped, guessed, expired or another kind's. */
const NO_SUCH_LINK = 'no document opens with this link';

/** What `issueLinkIn` answers while a document's archive is not yet made or not yet scanned: wait and try again. */
export interface LinkNotReady {
  readonly notReady: true;
}
export const LINK_NOT_READY: LinkNotReady = { notReady: true };

/** The contract's `SharedDocument`: what a document link opens, a short-lived signed link to the archived PDF. */
export interface SharedDocumentView {
  readonly docType: string;
  readonly documentNo: string | null;
  readonly issuedAt: string;
  readonly sha256: string;
  readonly url: string;
  readonly expiresAt: string;
}

/** A document's archived PDF, hash-checked, to attach to an email (B11 continued 13). */
export interface DocumentAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/** What a module asks DOC to render and archive after its transaction commits. */
export interface RenderRequest {
  readonly businessDocumentId: string;
  readonly docType: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  /** The exact data the template renders, kept with the archive so the document can be verified (doc.md). */
  readonly renderData: Record<string, unknown>;
  /** The event that asked for the document, when one did (the remittance advice: `pur.SupplierRemittanceReady`). */
  readonly causationId?: string | undefined;
  /**
   * The revision this rendering is of the document, 1 unless the type is revised (a quote's version, a signed delivery
   * note; `ck_archived_document_revision`). Each revision is archived once (`uq_archived_document_revision`).
   */
  readonly revision?: number | undefined;
}

/** The contract's `ArchivedDocument`. */
export interface ArchivedDocumentView {
  readonly id: string;
  readonly businessDocument: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly docType: string;
  readonly documentNo: string | null;
  readonly branchId: string;
  readonly templateVersionId: string;
  readonly sha256: string;
  readonly revision: number;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string };
  readonly createdAt: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export type ArchiveQuery = Omit<ArchiveFilter, 'branchIds'>;

const describe = (error: unknown) => scrubString(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, MAX_ERROR);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();

/**
 * The document archive (FR-DOC-001 to FR-DOC-003, FR-DOC-007, ADR-0010, ADR-0061). A module asks for a rendering with
 * `requestRenderIn`, in its own transaction: DOC records the template versions active at that moment and publishes
 * `doc.RenderRequested` to the outbox. After commit the worker's consumer renders the document once, writes the bytes
 * to the private bucket, archives them with their SHA-256 (insert-only, held by the database) and publishes
 * `doc.DocumentArchived`. Nothing here can fail or roll back the business transaction that issued the document: a
 * render that throws is retried by the outbox with backoff, and the document waits, `RENDERING`, until it is archived.
 */
export class Documents {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: DocStore,
    private readonly files: FileStore,
    private readonly events: DomainEvents,
    private readonly authoriser: Authoriser,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly signedUrlTtlSeconds: number,
    private readonly logger: Logger,
    private readonly renderer: DocumentRenderer = PLATFORM_RENDERER,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /**
   * Requests the rendering of an issued document, in the issuing transaction. It renders nothing and calls nothing
   * outside the database; it fails only if the document type has no active A4 template, which the seed guarantees.
   */
  async requestRenderIn(tx: Transaction, request: RenderRequest): Promise<void> {
    const a4 = await this.store.activeTemplate(tx, request.docType, 'PDF_A4');
    if (a4 === null) throw new Error(`no active PDF_A4 template for ${request.docType}`);
    const thermal: TemplateRecord | null = (await this.store.activeTemplate(tx, request.docType, 'THERMAL_80MM')) ?? (await this.store.activeTemplate(tx, request.docType, 'THERMAL_58MM'));
    const payload: RenderRequested = {
      businessDocumentId: request.businessDocumentId,
      docType: request.docType,
      documentNo: request.documentNo,
      branchId: request.branchId,
      templateVersionId: a4.activeVersionId!,
      thermalTemplateVersionId: thermal?.activeVersionId ?? null,
      ...(request.revision === undefined ? {} : { revision: request.revision }),
    };
    const envelope = await this.events.publish(tx, {
      type: RENDER_REQUESTED,
      subjectType: 'BusinessDocument',
      subjectId: request.businessDocumentId,
      branchId: request.branchId,
      ...(request.causationId === undefined ? {} : { causationId: request.causationId }),
      payload,
    });
    await this.store.insertJob(tx, {
      id: this.nextId(),
      businessDocumentId: request.businessDocumentId,
      sourceEventRef: envelope.id,
      templateVersionId: payload.templateVersionId,
      thermalTemplateVersionId: payload.thermalTemplateVersionId,
      renderData: request.renderData,
    });
  }

  /** The worker's consumer of `doc.RenderRequested`: renders and archives once per requesting message. */
  readonly renderConsumer: AsyncConsumer = {
    name: 'doc.render',
    eventTypes: [RENDER_REQUESTED],
    isolation: 'read committed',
    handle: (tx, event) => this.render(tx, event),
  };

  private async render(tx: Transaction, event: EventEnvelope): Promise<void> {
    const job = await this.store.jobBySource(tx, event.id);
    if (job === null) throw new Error(`render job for message ${event.id} does not exist`);
    if (job.status === 'DONE') return;
    const request = event.payload as unknown as RenderRequested;
    const actorId = currentRequestContext()!.actor!.principalId;
    const a4 = (await this.store.version(tx, job.templateVersionId))!;
    const thermalVersion = job.thermalTemplateVersionId === null ? null : (await this.store.version(tx, job.thermalTemplateVersionId))!;
    const thermalOutput = thermalVersion === null ? null : (await this.store.template(tx, thermalVersion.templateId))!.output;
    const name = request.documentNo ?? request.businessDocumentId;
    // Rendering and the object writes are the part that can fail: the attempt is recorded apart, the delivery rolls
    // back and the outbox retries it with backoff. No row of this transaction has been written yet.
    let pdfObject: PutFile;
    let thermalObject: PutFile | null = null;
    try {
      pdfObject = await this.files.put(ARCHIVE_PREFIX, renderBody(this.renderer, a4.body, 'PDF_A4', job.renderData), PDF_TYPE);
      if (thermalVersion !== null) thermalObject = await this.files.put(ARCHIVE_PREFIX, renderBody(this.renderer, thermalVersion.body, thermalOutput!, job.renderData), ESC_POS_TYPE);
    } catch (error) {
      await this.uow.runApart({ isolation: 'read committed' }, (failure) => this.store.jobFailed(failure, job.id, describe(error)));
      throw error;
    }
    const pdfFile = await this.files.register(tx, { object: pdfObject, originalName: `${name}.pdf`, contentType: PDF_TYPE, purpose: 'ARCHIVE', classification: 'CONFIDENTIAL', ownerModule: 'doc', actorId });
    let thermal: ArchivedRecord['thermal'] = null;
    if (thermalObject !== null) {
      const file = await this.files.register(tx, { object: thermalObject, originalName: `${name}.escpos`, contentType: ESC_POS_TYPE, purpose: 'ARCHIVE', classification: 'CONFIDENTIAL', ownerModule: 'doc', actorId });
      thermal = { templateVersionId: thermalVersion!.id, fileId: file.id, sha256: thermalObject.sha256 };
    }
    const archivedId = this.nextId();
    await this.store.insertArchived(tx, {
      id: archivedId,
      businessDocumentId: request.businessDocumentId,
      docType: request.docType,
      documentNo: request.documentNo,
      branchId: request.branchId,
      templateVersionId: a4.id,
      fileId: pdfFile.id,
      sha256: pdfObject.sha256,
      thermal,
      renderData: job.renderData,
      revision: request.revision ?? 1,
      actorId,
    });
    await this.store.jobDone(tx, job.id, archivedId);
    const archived: DocumentArchived = {
      archivedDocumentId: archivedId,
      businessDocumentId: request.businessDocumentId,
      docType: request.docType,
      documentNo: request.documentNo,
      branchId: request.branchId,
      sha256: pdfObject.sha256.toString('hex'),
      revision: request.revision ?? 1,
    };
    await this.events.publish(tx, { type: DOCUMENT_ARCHIVED, subjectType: 'BusinessDocument', subjectId: request.businessDocumentId, branchId: request.branchId, causationId: event.id, payload: archived });
  }

  /**
   * A signed, expiring URL to an archived rendering's PDF, for a module that hands its own document to someone it has
   * already authorised (a quote's buyer by the link's token or their own session, FR-QUO-007), in the caller's
   * transaction. Logged to `platform.file_access_log` with `purpose` and the actor; null until the scan has passed it.
   */
  async signedUrlIn(tx: Transaction, archivedDocumentId: string, purpose: string, actorId: string): Promise<SignedUrlView | null> {
    const [record] = await this.store.archived(tx, [archivedDocumentId]);
    if (record === undefined) return null;
    const file = await this.files.find(tx, record.fileId);
    if (file === null || file.scanStatus !== 'CLEAN') return null;
    const link = await this.files.signedLink(tx, file, purpose, this.signedUrlTtlSeconds, actorId);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /**
   * A link of its own for a document sent by message (B11 continued 13, ADR-0074, ADR-0084): made by NTF's sending
   * worker at each attempt, in its own transaction, for the latest archived rendering of the business document. Only the
   * token's SHA-256 is stored; the token is answered once, to go into the message. While the document is still rendering
   * or its file not yet scanned, `LINK_NOT_READY` (the message waits and tries again, never fails for good); a document
   * with no rendering asked for answers null (no link to give).
   */
  async issueLinkIn(tx: Transaction, businessDocumentId: string, actorId: string): Promise<string | LinkNotReady | null> {
    const latest = await this.sendableIn(tx, businessDocumentId);
    if (latest === null) return (await this.store.jobsOf(tx, [businessDocumentId])).length === 0 ? null : LINK_NOT_READY;
    const issued = issueLinkToken(DOCUMENT_LINK_PREFIX);
    const at = this.clock.now();
    await this.store.insertLink(tx, { id: this.nextId(), archivedDocumentId: latest.id, tokenHash: issued.hash, expiresAt: new Date(at.getTime() + DOCUMENT_LINK_TTL_MS), at, actorId });
    return issued.token;
  }

  /**
   * The archived PDF of a business document's latest rendering, hash-checked, for an email (B11 continued 13): null while
   * there is none or its file is not yet scanned. Read outside any transaction but for the short lookup.
   */
  async attachmentOf(businessDocumentId: string): Promise<DocumentAttachment | null> {
    const latest = await this.uow.run({ isolation: 'read committed' }, (tx) => this.sendableIn(tx, businessDocumentId));
    if (latest === null) return null;
    const bytes = await this.content(latest, 'PDF');
    return { fileName: `${latest.documentNo ?? latest.docType.toLowerCase()}.pdf`, contentType: PDF_TYPE, bytes };
  }

  /**
   * `getSharedDocument` (B11 continued 13): anonymous, rate-limited, by the token alone. A live link answers a signed
   * link, five minutes long and logged, to exactly the archived rendering it was made for, whose bytes and SHA-256 never
   * change; anything else (never sent, altered, guessed, expired, a document's id or number) is the same 404.
   */
  openLink(token: string): Promise<SharedDocumentView> {
    const hash = linkTokenHash(DOCUMENT_LINK_PREFIX, token);
    if (hash === null) return Promise.reject(new NotFoundError(NO_SUCH_LINK));
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const archivedId = await this.store.liveLink(tx, hash, this.clock.now());
      const [record] = archivedId === null ? [] : await this.store.archived(tx, [archivedId]);
      if (record === undefined) throw new NotFoundError(NO_SUCH_LINK);
      const file = await this.files.find(tx, record.fileId);
      if (file === null || file.scanStatus !== 'CLEAN' || !file.sha256.equals(record.sha256)) throw new NotFoundError(NO_SUCH_LINK);
      const link = await this.files.signedLink(tx, file, 'doc.link.open', this.signedUrlTtlSeconds, STOREFRONT_PRINCIPAL);
      return { docType: record.docType, documentNo: record.documentNo, issuedAt: record.recordedAt.toISOString(), sha256: record.sha256.toString('hex'), url: link.url, expiresAt: link.expiresAt.toISOString() };
    });
  }

  /** The latest archived rendering of a business document whose PDF has passed the scan, or null. */
  private async sendableIn(tx: Transaction, businessDocumentId: string): Promise<ArchivedRecord | null> {
    const archived = await this.store.archivedOf(tx, [businessDocumentId]);
    const latest = archived.reduce<ArchivedRecord | null>((best, r) => (best === null || r.revision > best.revision ? r : best), null);
    if (latest === null) return null;
    const file = await this.files.find(tx, latest.fileId);
    return file !== null && file.scanStatus === 'CLEAN' ? latest : null;
  }

  /** Archived renderings by id, for a module that serves or checks them (BIL's reprints and numbering audit). */
  archivedIn(tx: Transaction, ids: readonly string[]): Promise<ArchivedRecord[]> {
    return this.store.archived(tx, ids);
  }

  /** Every archived rendering of these documents and their render jobs: the archive completeness check (FR-DOC-002). */
  async archiveStateIn(tx: Transaction, businessDocumentIds: readonly string[]): Promise<{ archived: ArchivedRecord[]; failedJobs: number }> {
    const jobs = await this.store.jobsOf(tx, businessDocumentIds);
    return { archived: await this.store.archivedOf(tx, businessDocumentIds), failedJobs: jobs.filter((j) => j.status === 'FAILED').length };
  }

  /**
   * The archived bytes of a rendering, read outside any transaction, served only once the scan has passed them and
   * only if they hash to the archived SHA-256 (FR-DOC-001). A mismatch is logged as an error and never served.
   */
  async content(archived: ArchivedRecord, which: 'PDF' | 'THERMAL'): Promise<Buffer> {
    const ref = which === 'PDF' ? { fileId: archived.fileId, sha256: archived.sha256 } : archived.thermal;
    if (ref === null) throw new DocumentNotArchivedError('NO_THERMAL_RENDITION');
    const file = await this.uow.run({ isolation: 'read committed' }, (tx) => this.files.find(tx, ref.fileId));
    if (file === null || file.scanStatus !== 'CLEAN') throw new DocumentNotArchivedError('NOT_SCANNED');
    const bytes = await this.files.content(file);
    if (!sha256(bytes).equals(ref.sha256) || !file.sha256.equals(ref.sha256)) {
      this.logger.error({ archivedDocumentId: archived.id, businessDocumentId: archived.businessDocumentId, which }, 'archived document does not match its SHA-256');
      throw new ArchiveHashMismatchError(archived.id);
    }
    return bytes;
  }

  list(actor: Actor | undefined, query: ArchiveQuery, cursor: string | undefined, limit: number): Promise<Page<ArchivedDocumentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listArchivedDocuments', principalId: actor!.principalId, filters: query };
      const afterId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.listArchived(tx, { ...query, branchIds }, afterId, limit + 1);
      const data = await this.views(tx, rows.slice(0, limit));
      const hasMore = rows.length > limit;
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ArchivedDocumentView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.authorised(tx, actor, id);
      return (await this.views(tx, [record]))[0]!;
    });
  }

  /**
   * `downloadArchivedDocument` (FR-DOC-007): a signed link to the archived PDF that lives five minutes, logged with
   * the user, the file and the time. A reprint is never made here: it is `reprintBillingDocument`, which numbers the
   * copy and marks it (FR-BIL-009, A-202).
   */
  download(actor: Actor | undefined, id: string, body: { readonly reprint?: boolean | undefined }): Promise<SignedUrlView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.authorised(tx, actor, id);
      if (body.reprint === true) {
        throw new ValidationFailedError('a reprint is made by reprintBillingDocument', [{ field: '/reprint', code: 'REPRINT_THROUGH_BILLING', message: 'Reprint the document from its billing record.' }]);
      }
      const file = (await this.files.find(tx, record.fileId))!;
      if (file.scanStatus !== 'CLEAN') throw new FileNotCleanError(`file ${file.id} is ${file.scanStatus}`);
      const link = await this.files.signedLink(tx, file, 'doc.archive.download', this.signedUrlTtlSeconds);
      return { url: link.url, expiresAt: link.expiresAt.toISOString() };
    });
  }

  private async authorised(tx: Transaction, actor: Actor | undefined, id: string): Promise<ArchivedRecord> {
    await this.authoriser.authorise(tx, actor, READ);
    const [record] = await this.store.archived(tx, [id]);
    if (record === undefined) throw new NotFoundError(`archived document ${id} does not exist`);
    await this.authoriser.authorise(tx, actor, READ, { branchId: record.branchId });
    return record;
  }

  private async views(tx: Transaction, records: readonly ArchivedRecord[]): Promise<ArchivedDocumentView[]> {
    const files = new Map<string, StoredFileRecord>();
    for (const record of records) {
      const file = await this.files.find(tx, record.fileId);
      if (file !== null) files.set(file.id, file);
    }
    return records.map((r) => {
      const file = files.get(r.fileId)!;
      return {
        id: r.id,
        businessDocument: { id: r.businessDocumentId, docType: r.docType, number: r.documentNo },
        docType: r.docType,
        documentNo: r.documentNo,
        branchId: r.branchId,
        templateVersionId: r.templateVersionId,
        sha256: r.sha256.toString('hex'),
        revision: r.revision,
        file: { id: file.id, originalName: file.originalName, contentType: file.contentType },
        createdAt: r.recordedAt.toISOString(),
      };
    });
  }
}
