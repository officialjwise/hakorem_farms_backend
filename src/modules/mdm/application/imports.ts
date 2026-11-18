import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { BusinessRuleError, InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { registerMessages } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { FORMAT_CONTENT_TYPE, FORMAT_EXTENSION, readSheet, SheetUnreadableError, writeSheet, type SheetFormat } from '../../../platform/spreadsheet/spreadsheet';
import type { FileStore, StoredFileRecord } from '../../../platform/storage/file-store';
import type { Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { isAvailable, isBulkExport, judgeApply, MAX_IMPORT_ROWS, readHeader, records, sortErrors, canCancel, type ImportDirection, type ImportEntity, type RowError } from '../domain/imports';
import { referencesNotFound } from './errors';
import type { EntitySheet } from './import-sheets';
import type { ImportJobRecord, ImportStore } from './import-store';
import type { Page } from './product-catalogue';

registerMessages({
  'mdm.import_file_not_clean': 'This file has not passed its virus check yet. Try again in a moment.',
  'mdm.import_entity_not_available': 'Spreadsheets of this kind of record cannot be imported or exported yet.',
  'mdm.import_not_validated': 'This import cannot be applied: it must be a checked dry run with no row errors.',
});

const READ = 'mdm.import.read';
const CREATE = 'mdm.import.create';
const APPLY = 'mdm.import.apply';
const EXPORT = 'mdm.export.create';
const FILE_READ = 'platform.file.read';
const FILE_READ_ANY = 'platform.file.read.any';
export const CREATE_IMPORT_JOB = 'createImportJob';
export const APPLY_IMPORT_JOB = 'applyImportJob';
export const CANCEL_IMPORT_JOB = 'cancelImportJob';
export const CREATE_EXPORT_JOB = 'createExportJob';

/** 422: the import file has not passed its malware scan, or failed it, and is never read. */
export class ImportFileNotCleanError extends BusinessRuleError {
  readonly code = 'FILE_NOT_CLEAN';
  readonly messageKey = 'mdm.import_file_not_clean';
}

/** 422: no sheet is registered for the entity (A-128, A-130, ADR-0050). */
export class ImportEntityNotAvailableError extends BusinessRuleError {
  readonly code = 'IMPORT_ENTITY_NOT_AVAILABLE';
  readonly messageKey = 'mdm.import_entity_not_available';
}

/** 422: apply on a job that is not a validated import with every row valid (FR-MDM-019). */
export class ImportNotValidatedError extends BusinessRuleError {
  readonly code = 'IMPORT_NOT_VALIDATED';
  readonly messageKey = 'mdm.import_not_validated';
}

/** The dry run of an apply found errors the first one did not: thrown inside the apply so it writes nothing. */
class ImportDrifted extends Error {
  constructor(readonly errors: readonly RowError[]) {
    super('the import no longer validates');
  }
}

/** The contract's `ImportJob`. */
export interface ImportJobView {
  readonly id: string;
  readonly entity: ImportEntity;
  readonly direction: ImportDirection;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string };
  readonly status: ImportJobRecord['status'];
  readonly rowsTotal: number | null;
  readonly rowsValid: number | null;
  readonly rowsApplied: number | null;
  readonly rowsToCreate: number | null;
  readonly rowsToUpdate: number | null;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

export interface ImportRowErrorView {
  readonly rowNo: number;
  readonly column: string | null;
  readonly message: string;
}

/** What a sheet's rows gave: the checked plan, or the reason the file could not be read as this entity's sheet. */
type Reading = { readonly kind: 'UNREADABLE'; readonly errors: readonly RowError[] } | { readonly kind: 'CHECKED'; readonly rowsTotal: number; readonly errors: readonly RowError[]; readonly toCreate: number; readonly toUpdate: number; readonly plan: unknown };

/**
 * Master data imports and exports (FR-MDM-019, FR-MDM-020, SEC-009, ADR-0046). Every handler authorises first
 * through IAM's policy engine, deny by default. An import reads a CLEAN `IMPORT` file through the platform file
 * store and checks every row as a dry run that writes only the job and its row errors. Apply checks the rows again
 * inside one serializable transaction and writes every row through the entity's own service, or none. An export
 * needs the export permission with a fresh step-up, writes an `EXPORT` file through the file store, and is audited
 * with the user, its parameters and its row count; above 100 rows it is marked bulk for the exception report. Its
 * signed, expiring link is issued by `createFileSignedUrl` once the worker's scan has passed the file (A-128).
 */
export class MdmImports {
  private readonly nextId: () => string;
  private readonly sheets: Map<ImportEntity, EntitySheet>;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ImportStore,
    private readonly files: FileStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    sheets: readonly EntitySheet[],
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.sheets = new Map(sheets.map((sheet) => [sheet.entity, sheet]));
  }

  /**
   * The import sheet port (ADR-0050): a higher module that owns an entity's rows registers its sheet here when it
   * starts, as INV does for `OPENING_STOCK`. One sheet per entity; MDM's own are given to the constructor.
   */
  registerSheet(sheet: EntitySheet): void {
    if (this.sheets.has(sheet.entity)) throw new Error(`an import sheet for ${sheet.entity} is already registered`);
    this.sheets.set(sheet.entity, sheet);
  }

  // Reading.

  list(actor: Actor | undefined, filters: { readonly entity?: ImportEntity | undefined; readonly direction?: ImportDirection | undefined }, cursor: string | undefined, limit: number): Promise<Page<ImportJobView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listImportJobs', principalId: actor!.principalId, filters: { entity: filters.entity ?? null, direction: filters.direction ?? null } };
      const before = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await this.store.jobs(tx, filters, before, limit + 1);
      const data = found.slice(0, limit);
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<ImportJobView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const job = await this.store.job(tx, id);
      if (job === null) throw new NotFoundError('no such import job');
      return (await this.views(tx, [job]))[0]!;
    });
  }

  errors(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<ImportRowErrorView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      if ((await this.store.job(tx, id)) === null) throw new NotFoundError('no such import job');
      const binding = { operationId: 'listImportErrors', principalId: actor!.principalId, filters: { id } };
      const decoded = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const after = decoded === null ? null : { rowNo: Number(decoded['rowNo']), id: decoded['id'] as string };
      const found = await this.store.errors(tx, id, after, limit + 1);
      const data = found.slice(0, limit);
      const hasMore = found.length > limit;
      const last = data.at(-1);
      return {
        data: data.map((error) => ({ rowNo: error.rowNo, column: error.column, message: error.message })),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { rowNo: String(last.rowNo), id: last.id }) : null, limit, hasMore },
      };
    });
  }

  // Imports.

  /** createImportJob: the dry run. Writes the job, VALIDATED (with any row errors) or FAILED, and nothing else. */
  async create(actor: Actor | undefined, body: { readonly entity: ImportEntity; readonly fileId: string }, idempotencyKey: string): Promise<StoredResponse<ImportJobView>> {
    // The file is read outside any transaction (ADR-0044), after the same checks the write repeats.
    const file = await this.uow.run({ isolation: 'read committed' }, (tx) => this.importFile(tx, actor, body.entity, body.fileId));
    const content = await this.files.content(file);
    const sheet = this.sheets.get(body.entity)!;
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.importFile(tx, actor, body.entity, body.fileId);
      const claim = await this.idempotency.claim(tx, { operationId: CREATE_IMPORT_JOB, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ImportJobView>;
      const reading = await this.read(tx, sheet, content, file.contentType);
      const id = this.nextId();
      const failed = reading.kind === 'UNREADABLE';
      await this.store.insertJob(
        tx,
        {
          id,
          entity: body.entity,
          direction: 'IMPORT',
          fileId: file.id,
          status: failed ? 'FAILED' : 'VALIDATED',
          rowsTotal: failed ? null : reading.rowsTotal,
          rowsValid: failed ? 0 : reading.rowsTotal - new Set(reading.errors.map((error) => error.rowNo)).size,
          rowsApplied: null,
          rowsToCreate: failed ? null : reading.toCreate,
          rowsToUpdate: failed ? null : reading.toUpdate,
          branchId: await this.store.headOfficeBranchId(tx),
          postedAt: failed ? this.clock.now() : null,
        },
        actor!.principalId,
      );
      await this.recordErrors(tx, id, reading.errors);
      const view = await this.viewOf(tx, id);
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'ImportJob', entityId: id, before: null, after: { ...this.auditable(view), errorCount: reading.errors.length } });
      const response = { status: 202, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** applyImportJob: every row, through the entity's own service, in one serializable transaction, or none. */
  async apply(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ImportJobView>> {
    const { file, entity } = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, APPLY);
      const job = await this.store.job(tx, id);
      if (job === null) throw new NotFoundError('no such import job');
      return { file: await this.files.find(tx, job.fileId), entity: job.entity };
    });
    const content = file === null || file.scanStatus !== 'CLEAN' ? null : await this.files.content(file);
    // The entity's own create lock, taken before the transaction begins, so the import queues with single creates.
    const seriesLocks = [...(this.sheets.get(entity)?.createLocks ?? [])];
    try {
      return await this.uow.run({ isolation: 'serializable', seriesLocks }, async (tx) => {
        await this.authoriser.authorise(tx, actor, APPLY);
        const claim = await this.idempotency.claim(tx, { operationId: APPLY_IMPORT_JOB, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ImportJobView>;
        const job = await this.store.lockJob(tx, id);
        if (job === null) throw new NotFoundError('no such import job');
        const refusal = judgeApply(job, await this.store.errorCount(tx, id));
        if (refusal !== null || content === null) throw new ImportNotValidatedError(`import ${id} cannot be applied: ${refusal ?? 'its file cannot be read'}`);
        const sheet = this.sheets.get(job.entity)!;
        if ((job.rowsToCreate ?? 0) > 0) await this.authoriser.authorise(tx, actor, sheet.permissions.create);
        if ((job.rowsToUpdate ?? 0) > 0) await this.authoriser.authorise(tx, actor, sheet.permissions.update);
        // Checked again inside the transaction that writes: the database may have moved since the dry run.
        const reading = await this.read(tx, sheet, content, file!.contentType);
        if (reading.kind === 'UNREADABLE' || reading.errors.length > 0 || reading.rowsTotal !== job.rowsTotal) {
          throw new ImportDrifted(reading.errors);
        }
        const applied = await sheet.apply(tx, actor!, reading.plan);
        if (!(await this.store.updateJob(tx, id, job.version, { status: 'APPLIED', rowsApplied: applied, posted: true }, actor!.principalId, this.clock.now()))) {
          throw new InvalidStateTransitionError(`import ${id} changed while it was applied`);
        }
        const view = await this.viewOf(tx, id);
        await this.audit.record(tx, { module: 'mdm', action: 'APPLY', entityType: 'ImportJob', entityId: id, before: { status: job.status }, after: this.auditable(view) });
        const response = { status: 202, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (!(error instanceof ImportDrifted)) throw error;
      // Nothing was written. The new errors are kept on the job, so the preview shows why it was refused.
      await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        const job = await this.store.lockJob(tx, id);
        if (job === null || job.status !== 'VALIDATED') return;
        const errors = error.errors.length > 0 ? error.errors : [{ rowNo: 1, column: null, message: 'The file no longer has the rows the dry run checked' }];
        await this.recordErrors(tx, id, errors);
        await this.store.updateJob(tx, id, job.version, { status: 'VALIDATED', rowsValid: Math.max((job.rowsTotal ?? 0) - new Set(errors.map((e) => e.rowNo)).size, 0), posted: false }, actor!.principalId, this.clock.now());
      });
      throw new ImportNotValidatedError(`import ${id} no longer validates: ${error.errors.length} row error(s)`);
    }
  }

  /** cancelImportJob: an import not yet applied is set aside; its job and errors stay readable. */
  cancel(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<ImportJobView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const claim = await this.idempotency.claim(tx, { operationId: CANCEL_IMPORT_JOB, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ImportJobView>;
      const job = await this.store.lockJob(tx, id);
      if (job === null) throw new NotFoundError('no such import job');
      if (!canCancel(job)) throw new InvalidStateTransitionError(`a ${job.direction} job that is ${job.status} cannot be cancelled`);
      await this.store.updateJob(tx, id, job.version, { status: 'CANCELLED', posted: true }, actor!.principalId, this.clock.now());
      const view = await this.viewOf(tx, id);
      await this.audit.record(tx, { module: 'mdm', action: 'CANCEL', entityType: 'ImportJob', entityId: id, before: { status: job.status }, after: this.auditable(view) });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  // Exports.

  /** createExportJob: step-up, the rows, the file, and the audit event with the row count (FR-MDM-020, SEC-009). */
  async export(actor: Actor | undefined, body: { readonly entity: ImportEntity; readonly format: SheetFormat }, idempotencyKey: string): Promise<StoredResponse<ImportJobView>> {
    const authorise = async (tx: Transaction, sheet: EntitySheet | undefined) => {
      await this.authoriser.authorise(tx, actor, EXPORT);
      if (sheet === undefined || !isAvailable(body.entity)) throw new ImportEntityNotAvailableError(`${body.entity} cannot be exported yet`);
      await this.authoriser.authorise(tx, actor, sheet.permissions.read);
      return sheet;
    };
    const sheet = this.sheets.get(body.entity);
    // One serializable snapshot, so a long export's pages agree with each other.
    const rows = await this.uow.run({ isolation: 'serializable' }, async (tx) => (await authorise(tx, sheet)).exportRows(tx));
    const content = writeSheet(body.format, sheet!.sheetName, rows);
    const contentType = FORMAT_CONTENT_TYPE[body.format];
    // The object is written before the transaction that registers it, never inside one (ADR-0044).
    const object = await this.files.put('export', content, contentType);
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await authorise(tx, sheet);
      const claim = await this.idempotency.claim(tx, { operationId: CREATE_EXPORT_JOB, principalId: actor!.principalId, key: idempotencyKey, request: body });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ImportJobView>;
      const now = this.clock.now();
      const originalName = `${sheet!.fileStem}-export-${now.toISOString().slice(0, 10)}.${FORMAT_EXTENSION[body.format]}`;
      const file = await this.files.register(tx, { object, originalName, contentType, purpose: 'EXPORT', classification: 'CONFIDENTIAL', ownerModule: 'mdm', actorId: actor!.principalId });
      const rowCount = rows.length - 1;
      const id = this.nextId();
      await this.store.insertJob(
        tx,
        { id, entity: body.entity, direction: 'EXPORT', fileId: file.id, status: 'APPLIED', rowsTotal: rowCount, rowsValid: rowCount, rowsApplied: rowCount, rowsToCreate: null, rowsToUpdate: null, branchId: await this.store.headOfficeBranchId(tx), postedAt: now },
        actor!.principalId,
      );
      const view = await this.viewOf(tx, id);
      // SEC-009: the user (the event's actor), the parameters and the row count; bulk above 100 rows.
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'EXPORT',
        entityType: 'ImportJob',
        entityId: id,
        before: null,
        after: { entity: body.entity, format: body.format, rowCount, bulk: isBulkExport(rowCount), fileId: file.id },
      });
      const response = { status: 202, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  // Shared.

  /** The import permission, the file's use and owner, its scan and the entity: everything checked before a file is read. */
  private async importFile(tx: Transaction, actor: Actor | undefined, entity: ImportEntity, fileId: string): Promise<StoredFileRecord> {
    await this.authoriser.authorise(tx, actor, CREATE);
    if (!isAvailable(entity) || !this.sheets.has(entity)) throw new ImportEntityNotAvailableError(`${entity} cannot be imported yet`);
    const file = await this.files.find(tx, fileId);
    if (file === null || file.purpose !== 'IMPORT') throw referencesNotFound(['/fileId']);
    await this.authoriser.authorise(tx, actor, FILE_READ, { owner: { principalId: file.createdBy, anyPermission: FILE_READ_ANY } });
    if (file.scanStatus !== 'CLEAN') throw new ImportFileNotCleanError(`file ${fileId} is ${file.scanStatus}`);
    return file;
  }

  private async read(tx: Transaction, sheet: EntitySheet, content: Buffer, contentType: string): Promise<Reading> {
    let rows: string[][];
    try {
      // The header and MAX_IMPORT_ROWS records; one more row is refused.
      rows = readSheet(content, contentType, MAX_IMPORT_ROWS + 1);
    } catch (error) {
      if (!(error instanceof SheetUnreadableError)) throw error;
      return { kind: 'UNREADABLE', errors: [{ rowNo: 1, column: null, message: `The file cannot be read as a spreadsheet: ${error.message}`.slice(0, 300) }] };
    }
    const header = readHeader(rows[0], sheet.columns);
    if (!header.ok) return { kind: 'UNREADABLE', errors: header.errors };
    const found = records(rows, header.index);
    if (found.length === 0) return { kind: 'UNREADABLE', errors: [{ rowNo: 1, column: null, message: 'The file has no rows below the header' }] };
    const checked = await sheet.check(tx, found);
    return { kind: 'CHECKED', rowsTotal: found.length, errors: checked.errors, toCreate: checked.toCreate, toUpdate: checked.toUpdate, plan: checked.plan };
  }

  private recordErrors(tx: Transaction, jobId: string, errors: readonly RowError[]): Promise<void> {
    return this.store.insertErrors(tx, jobId, sortErrors(errors).map((error) => ({ ...error, id: this.nextId() })));
  }

  private async viewOf(tx: Transaction, id: string): Promise<ImportJobView> {
    return (await this.views(tx, [(await this.store.job(tx, id))!]))[0]!;
  }

  private async views(tx: Transaction, jobs: readonly ImportJobRecord[]): Promise<ImportJobView[]> {
    const names = await this.principals.refs(tx, [...new Set(jobs.map((job) => job.createdBy))]);
    const views: ImportJobView[] = [];
    for (const job of jobs) {
      const file = await this.files.find(tx, job.fileId);
      views.push({
        id: job.id,
        entity: job.entity,
        direction: job.direction,
        file: { id: job.fileId, originalName: file?.originalName ?? '', contentType: file?.contentType ?? '' },
        status: job.status,
        rowsTotal: job.rowsTotal,
        rowsValid: job.rowsValid,
        rowsApplied: job.rowsApplied,
        rowsToCreate: job.rowsToCreate,
        rowsToUpdate: job.rowsToUpdate,
        createdAt: job.createdAt.toISOString(),
        createdBy: names.get(job.createdBy) ?? { id: job.createdBy, displayName: '' },
      });
    }
    return views;
  }

  private auditable(view: ImportJobView): Record<string, string | number | null> {
    return { entity: view.entity, direction: view.direction, fileId: view.file.id, status: view.status, rowsTotal: view.rowsTotal, rowsValid: view.rowsValid, rowsApplied: view.rowsApplied, rowsToCreate: view.rowsToCreate, rowsToUpdate: view.rowsToUpdate };
  }
}
