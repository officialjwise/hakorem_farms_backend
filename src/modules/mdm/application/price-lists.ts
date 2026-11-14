import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError, ValidationFailedError, VersionConflictError, type ErrorDetail } from '../../../platform/errors/api-error';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Approvals, ApprovalHandler, ApprovalRecord, Authoriser, PrincipalNames, PrincipalRef } from '../../iam';
import { activationWindow, defineEntries, definePriceList, defineVersionWindow, planActivation, type EntryInput } from '../domain/pricing/price-list';
import type { FieldRule } from '../domain/product';
import type { Channel, PriceListKind } from '../domain/pricing/pricing-engine';
import type { PriceListVersionActivated } from '../events';
import { DuplicateRecordError, PriceEntryDuplicateError, PriceEntryInvalidError, referencesNotFound } from './errors';
import type { PriceListRow, PriceListStore, VersionRow, VersionStatus } from './price-list-store';

export const CREATE_PRICE_LIST = 'createPriceList';
export const CREATE_PRICE_LIST_VERSION = 'createPriceListVersion';
export const REPLACE_PRICE_LIST_ENTRIES = 'replacePriceListEntries';
export const SUBMIT_PRICE_LIST_VERSION = 'submitPriceListVersion';
export const PRICE_LIST_ACTIVATION = 'PRICE_LIST_ACTIVATION';

/** Unique indexes of migration 0011, for a race that reaches the database before the check sees it. */
const UNIQUE_POINTER: Readonly<Record<string, string>> = { uq_price_list_code: '/code', uq_price_list_slot: '/kind' };

export interface PriceListDraft {
  readonly code: string;
  readonly name: string;
  readonly kind: PriceListKind;
  readonly channel?: Channel | undefined;
  readonly customerTierId?: string | undefined;
  readonly branchId?: string | undefined;
  readonly taxInclusive: boolean;
}

export interface VersionDraft {
  readonly validFrom: Date;
  readonly validTo?: Date | undefined;
  readonly copyFromVersionId?: string | undefined;
  readonly notes?: string | undefined;
}

/** The contract's `PriceList`. */
export interface PriceListView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PriceListKind;
  readonly channel: Channel | null;
  readonly customerTier: PriceListRow['customerTier'];
  readonly branch: PriceListRow['branch'];
  readonly taxInclusive: boolean;
  readonly currency: 'GHS';
  readonly activeVersion: { readonly id: string; readonly versionNo: number; readonly validFrom: string; readonly validTo: string | null } | null;
  readonly draftVersionId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `PriceListVersion`. */
export interface PriceListVersionView {
  readonly id: string;
  readonly priceListId: string;
  readonly versionNo: number;
  readonly status: VersionStatus;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly approvalRequestId: string | null;
  readonly activatedAt: string | null;
  readonly activatedBy: PrincipalRef | null;
  readonly notes: string | null;
  readonly entryCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: PrincipalRef;
}

/** The contract's `ApprovalPending`, the 202 body of submitPriceListVersion. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: typeof PRICE_LIST_ACTIVATION;
  readonly subject: { readonly id: string; readonly docType: 'PRICE_LIST_VERSION'; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

function fieldDetails(fields: readonly FieldRule[]): ErrorDetail[] {
  return fields.map((field) => ({ field: field.field, code: field.rule, message: translate('mdm.price_list_rule') }));
}

function notDraft(version: VersionRow, action: string): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`price list version ${version.id} is ${version.status}; ${action} needs DRAFT`, [
    { field: null, code: version.status, message: translate('error.invalid_state_transition') },
  ]);
}

/**
 * Price lists and their versions (FR-MDM-015): create a list in its slot, draft a version, replace its entries,
 * submit it. Activation is always maker-checker (PRICE_LIST_ACTIVATION): this class is also the approval handler
 * IAM calls, in the approval's transaction, to activate or reject the version. Every write is serializable, claims
 * its idempotency key first and writes its audit event in the same transaction.
 */
export class PriceListAdmin implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: PriceListStore,
    private readonly authoriser: Authoriser,
    private readonly approvals: Approvals,
    private readonly principals: PrincipalNames,
    private readonly documents: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async createList(actor: Actor | undefined, draft: PriceListDraft, idempotencyKey: string): Promise<StoredResponse<PriceListView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, 'mdm.price_list.create', draft.branchId === undefined ? {} : { branchId: draft.branchId });
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_PRICE_LIST, principalId: actor!.principalId, key: idempotencyKey, request: draft });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<PriceListView>;
        }
        const slot = definePriceList(draft);
        if (!slot.ok) {
          throw new ValidationFailedError('the price list does not fit its slot', fieldDetails(slot.error));
        }
        const unknown = [
          ...(draft.customerTierId !== undefined && !(await this.store.tierExists(tx, draft.customerTierId)) ? ['/customerTierId'] : []),
          ...(draft.branchId !== undefined && !(await this.store.branchExists(tx, draft.branchId)) ? ['/branchId'] : []),
        ];
        if (unknown.length > 0) {
          throw referencesNotFound(unknown);
        }
        const id = this.nextId();
        await this.store.insertList(tx, id, { ...slot.value, code: draft.code, name: draft.name, branchId: draft.branchId ?? null, taxInclusive: draft.taxInclusive }, actor!.principalId);
        const view = await this.listView(tx, id);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'PriceList', entityId: id, branchId: draft.branchId ?? null, before: null, after: { ...view } });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      const pointer = sqlStateOf(error) === '23505' ? UNIQUE_POINTER[(error as { constraint?: string }).constraint ?? ''] : undefined;
      if (pointer !== undefined) {
        throw new DuplicateRecordError([pointer]);
      }
      throw error;
    }
  }

  async getList(actor: Actor | undefined, id: string): Promise<PriceListView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.price_list.read');
      return this.listView(tx, id);
    });
  }

  async createVersion(actor: Actor | undefined, listId: string, draft: VersionDraft, idempotencyKey: string): Promise<StoredResponse<PriceListVersionView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        const list = await this.store.list(tx, listId);
        await this.authoriser.authorise(tx, actor, 'mdm.price_list.update', list?.branch === null || list === null ? {} : { branchId: list.branch.id });
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_PRICE_LIST_VERSION, principalId: actor!.principalId, key: idempotencyKey, request: { listId, ...draft } });
        if (claim.kind === 'REPLAY') {
          return claim.response as StoredResponse<PriceListVersionView>;
        }
        if (list === null) {
          throw new NotFoundError('no such price list');
        }
        const window = defineVersionWindow(draft.validFrom, draft.validTo ?? null);
        if (!window.ok) {
          throw new ValidationFailedError('the validity window is empty', fieldDetails(window.error));
        }
        const source = draft.copyFromVersionId === undefined ? null : await this.store.version(tx, draft.copyFromVersionId, false);
        if (draft.copyFromVersionId !== undefined && (source === null || source.priceListId !== listId)) {
          throw referencesNotFound(['/copyFromVersionId']);
        }
        const open = await this.store.versionsOfInterest(tx, listId, this.clock.now());
        if (open.draftId !== null) {
          throw new InvalidStateTransitionError(`price list ${listId} already has an open version ${open.draftId}`, [
            { field: null, code: 'OPEN_VERSION_EXISTS', message: translate('error.invalid_state_transition') },
          ]);
        }
        const id = this.nextId();
        const branchId = list.branch?.id ?? (await this.store.firstBranchId(tx));
        await this.documents.register(tx, { id, docType: 'PRICE_LIST_VERSION', ownerModule: 'mdm', branchId, actorId: actor!.principalId });
        await this.store.insertVersion(tx, { id, listId, versionNo: await this.store.nextVersionNo(tx, listId), window: window.value, notes: draft.notes ?? null, branchId }, actor!.principalId);
        if (source !== null) {
          await this.store.copyEntries(tx, source.id, id, actor!.principalId, this.nextId);
        }
        const view = await this.versionView(tx, id);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'PriceListVersion', entityId: id, branchId, before: null, after: { ...view } });
        const response = { status: 201, body: view };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (sqlStateOf(error) === '23505' && (error as { constraint?: string }).constraint === 'uq_price_list_version_draft') {
        throw new InvalidStateTransitionError(`price list ${listId} already has an open version`, [
          { field: null, code: 'OPEN_VERSION_EXISTS', message: translate('error.invalid_state_transition') },
        ]);
      }
      throw error;
    }
  }

  async getVersion(actor: Actor | undefined, id: string): Promise<PriceListVersionView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'mdm.price_list.read');
      return this.versionView(tx, id);
    });
  }

  async replaceEntries(
    actor: Actor | undefined,
    versionId: string,
    body: { readonly version: number; readonly entries: readonly EntryInput[] },
    idempotencyKey: string,
  ): Promise<StoredResponse<PriceListVersionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const version = await this.store.version(tx, versionId, true);
      await this.authoriser.authorise(tx, actor, 'mdm.price_list.update', version === null ? {} : { branchId: version.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: REPLACE_PRICE_LIST_ENTRIES, principalId: actor!.principalId, key: idempotencyKey, request: { versionId, ...body } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<PriceListVersionView>;
      }
      if (version === null) {
        throw new NotFoundError('no such price list version');
      }
      if (version.status !== 'DRAFT') {
        throw notDraft(version, 'replacing entries');
      }
      if (version.version !== body.version) {
        throw new VersionConflictError(`price list version ${versionId} is at version ${version.version}, not ${body.version}`);
      }
      const defined = defineEntries(body.entries, await this.store.entryReferences(tx, body.entries));
      if (!defined.ok) {
        const unknown = defined.error.filter((rule) => rule.rule === 'UNKNOWN');
        const duplicates = defined.error.filter((rule) => rule.rule === 'DUPLICATE_ENTRY');
        if (unknown.length > 0) throw referencesNotFound(unknown.map((rule) => rule.field));
        if (duplicates.length > 0 && duplicates.length === defined.error.length) throw new PriceEntryDuplicateError(duplicates);
        throw new PriceEntryInvalidError(defined.error.filter((rule) => rule.rule !== 'DUPLICATE_ENTRY'));
      }
      const before = await this.store.entries(tx, versionId);
      await this.store.replaceEntries(tx, versionId, defined.value, actor!.principalId, this.nextId);
      if (!(await this.store.touchVersion(tx, versionId, version.version, actor!.principalId))) {
        throw new VersionConflictError(`price list version ${versionId} changed while its entries were replaced`);
      }
      const view = await this.versionView(tx, versionId);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'UPDATE',
        entityType: 'PriceListVersion',
        entityId: versionId,
        branchId: version.branchId,
        before: { entryCount: before.length, entriesHash: entriesHash(before) },
        after: { entryCount: view.entryCount, entriesHash: entriesHash(await this.store.entries(tx, versionId)) },
      });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  async submit(actor: Actor | undefined, versionId: string, idempotencyKey: string): Promise<StoredResponse<ApprovalPendingView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const version = await this.store.version(tx, versionId, true);
      await this.authoriser.authorise(tx, actor, 'mdm.price_list.update', version === null ? {} : { branchId: version.branchId });
      const claim = await this.idempotency.claim(tx, { operationId: SUBMIT_PRICE_LIST_VERSION, principalId: actor!.principalId, key: idempotencyKey, request: { versionId } });
      if (claim.kind === 'REPLAY') {
        return claim.response as StoredResponse<ApprovalPendingView>;
      }
      if (version === null) {
        throw new NotFoundError('no such price list version');
      }
      if (version.status !== 'DRAFT') {
        throw notDraft(version, 'submitting');
      }
      if (version.entryCount === 0) {
        throw new InvalidStateTransitionError(`price list version ${versionId} has no entries`, [{ field: '/entries', code: 'NO_ENTRIES', message: translate('error.invalid_state_transition') }]);
      }
      const list = (await this.store.list(tx, version.priceListId))!;
      const summary = `Activate ${list.code} version ${version.versionNo} (${version.entryCount} entries) from ${version.validFrom.toISOString()}`;
      const request = await this.approvals.request(tx, actor, {
        kind: PRICE_LIST_ACTIVATION,
        branchId: version.branchId,
        subjectDocumentId: versionId,
        payloadHash: await this.currentPayloadHash(tx, versionId),
        summary,
      });
      await this.store.markPending(tx, versionId, request.id, actor!.principalId);
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'SUBMIT',
        entityType: 'PriceListVersion',
        entityId: versionId,
        branchId: version.branchId,
        before: { status: 'DRAFT' },
        after: { status: 'PENDING_APPROVAL', approvalRequestId: request.id },
      });
      const body: ApprovalPendingView = {
        status: 'PENDING_APPROVAL',
        approvalRequestId: request.id,
        kind: PRICE_LIST_ACTIVATION,
        subject: { id: versionId, docType: 'PRICE_LIST_VERSION', number: null },
        summary,
        requestedAt: request.requestedAt.toISOString(),
      };
      const response = { status: 202, body };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** ApprovalHandler: the hash of the version and its entries; nothing in it can change while it is submitted. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const version = await this.store.version(tx, subjectDocumentId, false);
    if (version === null) {
      throw new NotFoundError('no such price list version');
    }
    const payload = { priceListId: version.priceListId, versionNo: version.versionNo, validFrom: version.validFrom.toISOString(), validTo: version.validTo?.toISOString() ?? null, notes: version.notes };
    return createHash('sha256').update(canonicalJson({ ...payload, entries: await this.store.entries(tx, subjectDocumentId) })).digest('hex');
  }

  /**
   * ApprovalHandler: activates the version in the approval's transaction. It starts at its valid-from or now, if
   * later; versions it overlaps are ended where it starts or superseded (ADR-0036).
   */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const version = (await this.store.version(tx, request.subjectDocumentId, true))!;
    const now = this.clock.now();
    const window = activationWindow(version, now);
    if (!window.ok) {
      throw new InvalidStateTransitionError(`price list version ${version.id} ended before it was approved`, [
        { field: '/validTo', code: 'WINDOW_PASSED', message: translate('error.invalid_state_transition') },
      ]);
    }
    const steps = planActivation(window.value, await this.store.activeWindows(tx, version.priceListId));
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
      entityType: 'PriceListVersion',
      entityId: version.id,
      branchId: version.branchId,
      before: { status: version.status, validFrom: version.validFrom.toISOString() },
      after: { status: 'ACTIVE', validFrom: window.value.validFrom.toISOString(), validTo: window.value.validTo?.toISOString() ?? null, steps: steps.map((step) => ({ ...step })) },
      metadata: { approvalRequestId: request.id },
    });
    const payload: PriceListVersionActivated = {
      priceListId: version.priceListId,
      versionId: version.id,
      versionNo: version.versionNo,
      validFrom: window.value.validFrom.toISOString(),
      validTo: window.value.validTo?.toISOString() ?? null,
      endedVersionIds: steps.filter((step) => step.action === 'END').map((step) => step.id),
      supersededVersionIds: steps.filter((step) => step.action === 'SUPERSEDE').map((step) => step.id),
    };
    await this.events.publish(tx, { type: 'mdm.PriceListVersionActivated', subjectType: 'PriceListVersion', subjectId: version.id, branchId: version.branchId, payload });
  }

  /** ApprovalHandler: a rejected version is REJECTED, frozen, and the list keeps the prices it had. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const version = (await this.store.version(tx, request.subjectDocumentId, true))!;
    await this.store.reject(tx, version.id, request.decidedBy!);
    await this.audit.record(tx, {
      module: 'mdm',
      action: 'REJECT',
      entityType: 'PriceListVersion',
      entityId: version.id,
      branchId: version.branchId,
      before: { status: version.status },
      after: { status: 'REJECTED' },
      metadata: { approvalRequestId: request.id },
    });
  }

  private async listView(tx: Transaction, id: string): Promise<PriceListView> {
    const list = await this.store.list(tx, id);
    if (list === null) {
      throw new NotFoundError('no such price list');
    }
    const { active, draftId } = await this.store.versionsOfInterest(tx, id, this.clock.now());
    return {
      id: list.id,
      code: list.code,
      name: list.name,
      kind: list.kind,
      channel: list.channel,
      customerTier: list.customerTier,
      branch: list.branch,
      taxInclusive: list.taxInclusive,
      currency: 'GHS',
      activeVersion: active === null ? null : { id: active.id, versionNo: active.versionNo, validFrom: active.validFrom.toISOString(), validTo: active.validTo?.toISOString() ?? null },
      draftVersionId: draftId,
      version: list.version,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
    };
  }

  private async versionView(tx: Transaction, id: string): Promise<PriceListVersionView> {
    const version = await this.store.version(tx, id, false);
    if (version === null) {
      throw new NotFoundError('no such price list version');
    }
    const names = await this.principals.refs(tx, [version.createdBy, ...(version.activatedBy === null ? [] : [version.activatedBy])]);
    return {
      id: version.id,
      priceListId: version.priceListId,
      versionNo: version.versionNo,
      status: version.status,
      validFrom: version.validFrom.toISOString(),
      validTo: version.validTo?.toISOString() ?? null,
      approvalRequestId: version.approvalRequestId,
      activatedAt: version.activatedAt?.toISOString() ?? null,
      activatedBy: version.activatedBy === null ? null : (names.get(version.activatedBy) ?? { id: version.activatedBy, displayName: '' }),
      notes: version.notes,
      entryCount: version.entryCount,
      version: version.version,
      createdAt: version.createdAt.toISOString(),
      createdBy: names.get(version.createdBy) ?? { id: version.createdBy, displayName: '' },
    };
  }
}

function entriesHash(entries: readonly unknown[]): string {
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}
