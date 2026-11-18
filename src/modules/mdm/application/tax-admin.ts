import { createHash } from 'node:crypto';
import { createUuidV7Generator, Rate, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Approvals, ApprovalHandler, ApprovalRecord, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import type { TaxBaseKind, TaxTreatment } from '../domain/tax/tax-calculator';
import { defineTaxMatrix, planTaxActivation, taxActivationWindow, type MatrixCellInput } from '../domain/tax/tax-scheme';
import type { TaxSchemeVersionActivated } from '../events';
import { DuplicateRecordError, referencesNotFound, TaxCellInvalidError, TaxMatrixIncompleteError } from './errors';
import type { TaxCellRow, TaxStore, TaxVersionRow, TaxVersionStatus } from './tax-store';

export const CREATE_TAX_LEVY = 'createTaxLevy';
export const CREATE_TAX_CATEGORY = 'createTaxCategory';
export const CREATE_TAX_SCHEME_VERSION = 'createTaxSchemeVersion';
export const REPLACE_TAX_SCHEME_CELLS = 'replaceTaxSchemeCells';
export const SUBMIT_TAX_SCHEME_VERSION = 'submitTaxSchemeVersion';
export const LIST_TAX_SCHEME_VERSIONS = 'listTaxSchemeVersions';
export const LIST_TAX_LEVIES = 'listTaxLevies';
export const LIST_TAX_CATEGORIES = 'listTaxCategories';
export const TAX_SCHEME_ACTIVATION = 'TAX_SCHEME_ACTIVATION';

/** Unique indexes of migrations 0009 and 0014, for a race that reaches the database before the check sees it. */
const UNIQUE_POINTER: Readonly<Record<string, string>> = { uq_tax_levy_code: '/code', uq_tax_category_code: '/code' };

export interface TaxLevyView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly version: number;
}

export interface TaxCategoryView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly productCount: number;
  readonly version: number;
}

/** The contract's `TaxCell`. */
export interface TaxCellView {
  readonly taxCategory: { readonly id: string; readonly code: string; readonly name: string };
  readonly levy: { readonly id: string; readonly code: string; readonly name: string };
  readonly treatment: TaxTreatment;
  readonly ratePercent: string;
  readonly baseKind: TaxBaseKind;
  readonly baseIncludes: readonly string[];
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

/** The contract's `TaxSchemeVersion`. */
export interface TaxSchemeVersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly status: TaxVersionStatus;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceNote: string;
  readonly approvalRequestId: string | null;
  readonly cells: readonly TaxCellView[];
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/** The contract's `ApprovalPending`, the 202 body of submitTaxSchemeVersion. */
export interface TaxApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof TAX_SCHEME_ACTIVATION;
  readonly subject: { readonly id: string; readonly docType: 'TAX_SCHEME_VERSION'; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

export interface TaxCellRequest {
  readonly taxCategoryId: string;
  readonly levyId: string;
  readonly treatment: TaxTreatment;
  readonly ratePercent: string;
  readonly baseKind: TaxBaseKind;
  readonly baseIncludesLevyIds?: readonly string[] | undefined;
  readonly isReclaimable: boolean;
  readonly calcOrder: number;
}

/** Percent as the contract prints it: at least two decimal places, trailing zeros beyond them dropped ("15.00", "2.50"). */
export function percentText(numeric: string): string {
  const [whole, fraction = ''] = numeric.split('.');
  return `${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

function notDraft(version: TaxVersionRow, action: string): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`tax scheme version ${version.id} is ${version.status}; ${action} needs DRAFT`, [
    { field: null, code: version.status, message: translate('error.invalid_state_transition') },
  ]);
}

function openVersionExists(id: string | null): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`tax scheme version ${id ?? ''} is still open`, [{ field: null, code: 'OPEN_VERSION_EXISTS', message: translate('error.invalid_state_transition') }]);
}

/** A cell as the contract's `TaxCell` shows it; the offline pack carries the cells in force the same way (B09b continued 2). */
export function cellView(cell: TaxCellRow): TaxCellView {
  return {
    taxCategory: cell.category,
    levy: cell.levy,
    treatment: cell.treatment,
    ratePercent: percentText(cell.ratePercent),
    baseKind: cell.baseKind,
    baseIncludes: cell.baseLevies.map((levy) => levy.code),
    isReclaimable: cell.isReclaimable,
    calcOrder: cell.calcOrder,
  };
}

/**
 * Tax configuration (FR-MDM-012, ADR-0020, ADR-0039): named levies, tax categories, and scheme versions drafted by the
 * accountant, filled with a cell for every category and levy, and submitted. Activation is always maker-checker
 * (TAX_SCHEME_ACTIVATION): this class is also the approval handler IAM calls, in the approval's transaction. Every
 * write is serializable, claims its idempotency key first and writes its audit event in the same transaction.
 */
export class TaxAdmin implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: TaxStore,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly principals: PrincipalNames,
    private readonly documents: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** Levies and categories are a few dozen rows at most: read whole, then paged by position in their order. */
  async listLevies(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<TaxLevyView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.read');
      return this.pageOf(await this.store.levies(tx), { operationId: LIST_TAX_LEVIES, principalId: actor!.principalId, filters: {} }, cursor, limit);
    });
  }

  async listCategories(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<TaxCategoryView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.read');
      return this.pageOf(await this.store.categories(tx), { operationId: LIST_TAX_CATEGORIES, principalId: actor!.principalId, filters: {} }, cursor, limit);
    });
  }

  async createLevy(actor: Actor | undefined, draft: { readonly code: string; readonly name: string; readonly sortOrder?: number | undefined }, idempotencyKey: string): Promise<StoredResponse<TaxLevyView>> {
    return this.createReference(actor, CREATE_TAX_LEVY, draft, idempotencyKey, async (tx, id) => {
      await this.store.insertLevy(tx, id, { code: draft.code, name: draft.name, sortOrder: draft.sortOrder ?? 0 }, actor!.principalId);
      return { entityType: 'TaxLevy', view: (await this.store.levies(tx)).find((levy) => levy.id === id)! };
    });
  }

  async createCategory(actor: Actor | undefined, draft: { readonly code: string; readonly name: string }, idempotencyKey: string): Promise<StoredResponse<TaxCategoryView>> {
    return this.createReference(actor, CREATE_TAX_CATEGORY, draft, idempotencyKey, async (tx, id) => {
      await this.store.insertCategory(tx, id, draft, actor!.principalId);
      return { entityType: 'TaxCategory', view: (await this.store.categories(tx)).find((category) => category.id === id)! };
    });
  }

  async listVersions(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<TaxSchemeVersionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.read');
      const binding = { operationId: LIST_TAX_SCHEME_VERSIONS, principalId: actor!.principalId, filters: {} };
      const position = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const rows = await this.store.versionPage(tx, position === null ? null : Number(position['versionNo']), limit);
      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      // The list carries no cells (contract 1.5.0): a matrix is 21 cells or more, fetched with getTaxSchemeVersion.
      const data = await Promise.all(pageRows.map((row) => this.versionView(tx, row, [])));
      const last = pageRows.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { versionNo: String(last.versionNo) }) : null, limit, hasMore } };
    });
  }

  async getVersion(actor: Actor | undefined, id: string): Promise<TaxSchemeVersionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.read');
      return this.fullView(tx, id);
    });
  }

  async createVersion(
    actor: Actor | undefined,
    draft: { readonly validFrom: string; readonly sourceNote: string; readonly copyFromVersionId?: string | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<TaxSchemeVersionView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.tax.manage');
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_TAX_SCHEME_VERSION, principalId: actor!.principalId, key: idempotencyKey, request: draft });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<TaxSchemeVersionView>;
        }
        // The contract's TaxSchemeVersionCreate takes no end date: a version runs until a later one is activated.
        const window = { validFrom: draft.validFrom, validTo: null };
        const source = draft.copyFromVersionId === undefined ? null : await this.store.version(tx, draft.copyFromVersionId, false);
        if (draft.copyFromVersionId !== undefined && source === null) {
          throw referencesNotFound(['/copyFromVersionId']);
        }
        const open = await this.store.openVersionId(tx);
        if (open !== null) {
          throw openVersionExists(open);
        }
        const id = this.nextId();
        const branchId = await this.store.firstBranchId(tx);
        await this.documents.register(tx, { id, docType: 'TAX_SCHEME_VERSION', ownerModule: 'mdm', branchId, actorId: actor!.principalId });
        await this.store.insertVersion(tx, { id, versionNo: await this.store.nextVersionNo(tx), window, sourceNote: draft.sourceNote, branchId }, actor!.principalId);
        if (source !== null) {
          const cells = await this.store.cells(tx, source.id);
          await this.store.replaceCells(
            tx,
            id,
            cells.map((cell) => ({
              categoryId: cell.category.id,
              levyId: cell.levy.id,
              treatment: cell.treatment,
              ratePercent: cell.ratePercent,
              baseKind: cell.baseKind,
              baseLevyIds: cell.baseLevies.map((levy) => levy.id),
              isReclaimable: cell.isReclaimable,
              calcOrder: cell.calcOrder,
            })),
            actor!.principalId,
            this.nextId,
          );
        }
        const view = await this.fullView(tx, id);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'TaxSchemeVersion', entityId: id, branchId, before: null, after: { ...view, cells: view.cells.length } });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === 'uq_tax_scheme_version_open') {
        throw openVersionExists(null);
      }
      throw error;
    }
  }

  /**
   * Replaces the whole matrix of a draft. Refused unless every cell names a live category and levy, each category's
   * cells form a valid rule, and there is a cell for every live category and levy (the contract's TaxCellsReplace).
   */
  async replaceCells(
    actor: Actor | undefined,
    versionId: string,
    body: { readonly version: number; readonly cells: readonly TaxCellRequest[] },
    idempotencyKey: string,
  ): Promise<StoredResponse<TaxSchemeVersionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.manage');
      const claim = await this.idempotency.claim(tx, { operationId: REPLACE_TAX_SCHEME_CELLS, principalId: actor!.principalId, key: idempotencyKey, request: { versionId, ...body } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<TaxSchemeVersionView>;
      }
      const version = await this.store.version(tx, versionId, true);
      if (version === null) {
        throw new NotFoundError('no such tax scheme version');
      }
      if (version.status !== 'DRAFT') {
        throw notDraft(version, 'replacing cells');
      }
      if (version.version !== body.version) {
        throw new VersionConflictError(`tax scheme version ${versionId} is at version ${version.version}, not ${body.version}`);
      }
      await this.validateMatrix(tx, versionId, body.cells);
      const before = await this.store.cells(tx, versionId);
      await this.store.replaceCells(
        tx,
        versionId,
        body.cells.map((cell) => ({
          categoryId: cell.taxCategoryId,
          levyId: cell.levyId,
          treatment: cell.treatment,
          ratePercent: cell.ratePercent,
          baseKind: cell.baseKind,
          baseLevyIds: cell.baseIncludesLevyIds ?? [],
          isReclaimable: cell.isReclaimable,
          calcOrder: cell.calcOrder,
        })),
        actor!.principalId,
        this.nextId,
      );
      if (!(await this.store.touchVersion(tx, versionId, version.version, actor!.principalId))) {
        throw new VersionConflictError(`tax scheme version ${versionId} changed while its cells were replaced`);
      }
      const view = await this.fullView(tx, versionId);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'UPDATE',
        entityType: 'TaxSchemeVersion',
        entityId: versionId,
        branchId: version.branchId,
        before: { cellCount: before.length, cellsHash: hashOf(before.map(cellView)) },
        after: { cellCount: view.cells.length, cellsHash: hashOf(view.cells) },
      });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  async submit(actor: Actor | undefined, versionId: string, idempotencyKey: string): Promise<StoredResponse<TaxApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.tax.manage');
      const claim = await this.idempotency.claim(tx, { operationId: SUBMIT_TAX_SCHEME_VERSION, principalId: actor!.principalId, key: idempotencyKey, request: { versionId } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<TaxApprovalPendingView>;
      }
      const version = await this.store.version(tx, versionId, true);
      if (version === null) {
        throw new NotFoundError('no such tax scheme version');
      }
      if (version.status !== 'DRAFT') {
        throw notDraft(version, 'submitting');
      }
      // Checked again here: a levy or category added since the cells were written leaves a gap (ADR-0020).
      const cells = await this.store.cells(tx, versionId);
      await this.validateMatrix(
        tx,
        versionId,
        cells.map((cell) => ({
          taxCategoryId: cell.category.id,
          levyId: cell.levy.id,
          treatment: cell.treatment,
          ratePercent: cell.ratePercent,
          baseKind: cell.baseKind,
          baseIncludesLevyIds: cell.baseLevies.map((levy) => levy.id),
          isReclaimable: cell.isReclaimable,
          calcOrder: cell.calcOrder,
        })),
      );
      const summary = `Activate tax scheme version ${version.versionNo} (${cells.length} cells) from ${version.validFrom}`;
      const request = await this.approvals.request(tx, actor, {
        kind: TAX_SCHEME_ACTIVATION,
        branchId: version.branchId,
        subjectDocumentId: versionId,
        payloadHash: await this.currentPayloadHash(tx, versionId),
        summary,
      });
      await this.store.markPending(tx, versionId, request.id, actor!.principalId);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'SUBMIT',
        entityType: 'TaxSchemeVersion',
        entityId: versionId,
        branchId: version.branchId,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id },
      });
      const body: TaxApprovalPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: TAX_SCHEME_ACTIVATION,
        subject: { id: versionId, docType: 'TAX_SCHEME_VERSION', number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      const response = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** ApprovalHandler: the hash of the version and its cells; nothing in it can change while it is submitted. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const version = await this.store.version(tx, subjectDocumentId, false);
    if (version === null) {
      throw new NotFoundError('no such tax scheme version');
    }
    const payload = { versionNo: version.versionNo, validFrom: version.validFrom, validTo: version.validTo, sourceNote: version.sourceNote };
    return createHash('sha256')
      .update(canonicalJson({ ...payload, cells: (await this.store.cells(tx, subjectDocumentId)).map(cellView) }))
      .digest('hex');
  }

  /**
   * ApprovalHandler: activates the version in the approval's transaction, from its first day or from the day of
   * approval if later; active versions it overlaps are ended the day it starts or superseded (ADR-0039).
   */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const version = (await this.store.version(tx, request.subjectDocumentId, true))!;
    const now = this.clock.now();
    const window = taxActivationWindow(version, toBusinessDate(now));
    if (!window.ok) {
      throw new InvalidStateTransitionError(`tax scheme version ${version.id} ended before it was approved`, [
        { field: '/validTo', code: 'WINDOW_PASSED', message: translate('error.invalid_state_transition') },
      ]);
    }
    const steps = planTaxActivation(window.value, await this.store.activeWindows(tx, true));
    for (const step of steps) {
      if (step.action === 'END') {
        await this.store.endVersion(tx, step.id, step.validTo, request.decidedBy!);
      } else {
        await this.store.supersede(tx, step.id, request.decidedBy!);
      }
    }
    await this.store.activate(tx, version.id, window.value.validFrom, request.decidedBy!, now);
    await this.audit.record(tx, {
      module: 'mdm',
      action: 'ACTIVATE',
      entityType: 'TaxSchemeVersion',
      entityId: version.id,
      branchId: version.branchId,
      before: { status: version.status, validFrom: version.validFrom },
      after: { status: 'ACTIVE', validFrom: window.value.validFrom, validTo: window.value.validTo, steps: steps.map((step) => ({ ...step })) },
      metadata: { approvalRequestId: request.id },
    });
    const payload: TaxSchemeVersionActivated = {
      versionId: version.id,
      versionNo: version.versionNo,
      validFrom: window.value.validFrom,
      validTo: window.value.validTo,
      endedVersionIds: steps.filter((step) => step.action === 'END').map((step) => step.id),
      supersededVersionIds: steps.filter((step) => step.action === 'SUPERSEDE').map((step) => step.id),
    };
    await this.events.publish(tx, { type: 'mdm.TaxSchemeVersionActivated', subjectType: 'TaxSchemeVersion', subjectId: version.id, branchId: version.branchId, payload });
  }

  /** ApprovalHandler: a rejected version is REJECTED and frozen; the scheme in force is unchanged. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const version = (await this.store.version(tx, request.subjectDocumentId, true))!;
    await this.store.reject(tx, version.id, request.decidedBy!);
    await this.audit.record(tx, {
      module: 'mdm',
      action: 'REJECT',
      entityType: 'TaxSchemeVersion',
      entityId: version.id,
      branchId: version.branchId,
      before: { status: version.status },
      after: { status: 'REJECTED' },
      metadata: { approvalRequestId: request.id },
    });
  }

  private async validateMatrix(tx: Transaction, versionId: string, cells: readonly TaxCellRequest[]): Promise<void> {
    const levies = await this.store.levies(tx);
    const levyById = new Map(levies.map((levy) => [levy.id, levy]));
    const categories = await this.store.categories(tx);
    const inputs: MatrixCellInput[] = cells.map((cell) => ({
      categoryId: cell.taxCategoryId,
      levy: levyById.get(cell.levyId) ?? { id: cell.levyId, code: cell.levyId, name: '' },
      treatment: cell.treatment,
      rate: Rate.parsePercent(cell.ratePercent),
      baseKind: cell.baseKind,
      baseLevyIds: cell.baseIncludesLevyIds ?? [],
      isReclaimable: cell.isReclaimable,
      calcOrder: cell.calcOrder,
    }));
    const matrix = defineTaxMatrix(versionId, inputs, { categories, levies });
    if (matrix.ok) {
      return;
    }
    const { code, missing, cell } = matrix.error;
    const index = cell === null ? -1 : inputs.findIndex((input) => input.categoryId === cell.categoryId && input.levy.code === cell.levyCode);
    const at = index < 0 ? '/cells' : `/cells/${index}`;
    if (code === 'TAX_CELL_UNKNOWN_REFERENCE') {
      throw referencesNotFound([at]);
    }
    if (code === 'TAX_MATRIX_INCOMPLETE') {
      throw new TaxMatrixIncompleteError(missing);
    }
    throw new TaxCellInvalidError([{ field: at, rule: code }]);
  }

  private async createReference<V extends TaxLevyView | TaxCategoryView>(
    actor: Actor | undefined,
    operationId: string,
    draft: object,
    idempotencyKey: string,
    write: (tx: Transaction, id: string) => Promise<{ readonly entityType: string; readonly view: V }>,
  ): Promise<StoredResponse<V>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.tax.manage');
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request: draft });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<V>;
        }
        const id = this.nextId();
        const { entityType, view } = await write(tx, id);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType, entityId: id, branchId: null, before: null, after: { ...view } });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      const pointer = sqlStateOf(error) === '23505' ? UNIQUE_POINTER[databaseErrorOf(error)?.constraint ?? ''] : undefined;
      if (pointer !== undefined) {
        throw new DuplicateRecordError([pointer]);
      }
      throw error;
    }
  }

  private pageOf<T extends { readonly id: string }>(
    rows: readonly T[],
    binding: { readonly operationId: string; readonly principalId: string; readonly filters: object },
    cursor: string | undefined,
    limit: number,
  ): Page<T> {
    const after = cursor === undefined ? null : this.cursors.decode(cursor, binding)['id'];
    const start = after === null || after === undefined ? 0 : rows.findIndex((row) => row.id === after) + 1;
    const data = rows.slice(start, start + limit);
    const hasMore = rows.length > start + limit;
    return { data, page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: data.at(-1)!.id }) : null, limit, hasMore } };
  }

  private async fullView(tx: Transaction, id: string): Promise<TaxSchemeVersionView> {
    const version = await this.store.version(tx, id, false);
    if (version === null) {
      throw new NotFoundError('no such tax scheme version');
    }
    return this.versionView(tx, version, await this.store.cells(tx, id));
  }

  private async versionView(tx: Transaction, version: TaxVersionRow, cells: readonly TaxCellRow[]): Promise<TaxSchemeVersionView> {
    const names = await this.principals.refs(tx, [version.createdBy]);
    return {
      id: version.id,
      versionNo: version.versionNo,
      status: version.status,
      validFrom: version.validFrom,
      validTo: version.validTo,
      sourceNote: version.sourceNote,
      approvalRequestId: version.approvalRequestId,
      cells: cells.map(cellView),
      version: version.version,
      createdAt: version.createdAt.toISOString(),
      createdBy: names.get(version.createdBy) ?? { id: version.createdBy, displayName: '' },
    };
  }
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
