import { createHash } from 'node:crypto';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys } from '../../../platform/crypto/subject-keys';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents, EventEnvelope } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore } from '../../../platform/storage/file-store';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { judgePayoutDetails, maskPayout, type PayoutDetails, type PayoutMethod } from '../domain/payout-details';
import type { SupplierPayoutChanged, SupplierPayoutChangeRequested } from '../events';
import { SupplierDocumentInvalidError, SupplierProfileInvalidError, translatePurRefusal, type BrokenRule } from './errors';
import { runPurchaseCommand, type ApprovalPendingView, type Page } from './purchase-command';
import type { PayoutChangeRecord, ProfileRecord, ProfileTerms, SupplierDocumentKind, SupplierDocumentRecord, SupplierRegisterStore } from './supplier-register-store';

export const SUPPLIER_PAYOUT_CHANGE_KIND = 'SUPPLIER_PAYOUT_CHANGE';
const DOC_TYPE = 'SUPPLIER_PAYOUT_CHANGE';
const READ = 'pur.supplier.read';
const UPDATE = 'pur.supplier.update';
const PAYOUT_READ = 'pur.supplier.payout_read';
/** Asking for a payout change, kept apart from every supplier payment permission (owner, 2026-11-15, A-169). */
const PAYOUT_CHANGE = 'pur.supplier.payout_change';
const DOCUMENT_FILE = 'SUPPLIER_DOCUMENT';
const WITHDRAWN = 'Approval request withdrawn by its maker';
/** THREAT_MODEL section 4, case 13: supplier payout details changed to divert a payment. */
const PAYOUT_ABUSE_CASE = 13;
/** Audit fields that hold a supplier's payout details, even masked: encrypted with the supplier's key (ADR-0022). */
const PAYOUT_PERSONAL = ['payoutDetailsMasked'] as const;

export interface SupplierProfileUpdate {
  readonly version: number;
  readonly paymentTermsDays?: number | undefined;
  readonly leadTimeDays?: number | undefined;
  readonly notes?: string | undefined;
  readonly payoutDetails?: PayoutDetails | undefined;
}

/** The contract's `SupplierProfile`: payout details only ever masked. */
export interface SupplierProfileView {
  readonly supplierId: string;
  readonly paymentTermsDays: number;
  readonly payoutMethod: PayoutMethod | null;
  readonly payoutDetailsMasked: string | null;
  readonly pendingPayoutChangeApprovalId: string | null;
  readonly leadTimeDays: number | null;
  readonly notes: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

/** The contract's `PayoutDetailsView`: one set of payout details in full, every field present. */
export interface PayoutDetailsView {
  readonly method: PayoutMethod;
  readonly bankName: string | null;
  readonly accountName: string | null;
  readonly accountNumber: string | null;
  readonly bankBranch: string | null;
  readonly momoNetwork: string | null;
  readonly momoNumber: string | null;
}

/** The contract's `SupplierPayoutDetails`: the details in force and any change waiting, decrypted for the checker. */
export interface SupplierPayoutDetailsView {
  readonly supplierId: string;
  readonly inForce: PayoutDetailsView | null;
  readonly pending: (PayoutDetailsView & { readonly approvalRequestId: string; readonly requestedBy: string; readonly requestedAt: string }) | null;
}

export interface SupplierDocumentCreate {
  readonly kind: SupplierDocumentKind;
  readonly fileId: string;
  readonly expiresOn?: string | undefined;
}

/** The contract's `SupplierDocument`. */
export interface SupplierDocumentView {
  readonly id: string;
  readonly kind: SupplierDocumentKind;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string };
  readonly expiresOn: string | null;
  readonly createdAt: string;
}

/** Where a change's sealed details belong, so a ciphertext copied to another row does not open. */
const payoutPlace = (changeId: string) => `pur.supplier_payout_change.payout_details_enc:${changeId}`;

function changeHash(change: PayoutChangeRecord): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        supplierId: change.supplierId,
        method: change.method,
        masked: change.masked,
        details: change.detailsEnc === null ? null : change.detailsEnc.toString('base64'),
        terms: change.terms,
      }),
    )
    .digest('hex');
}

function fullView(details: PayoutDetails): PayoutDetailsView {
  return {
    method: details.method,
    bankName: details.bankName ?? null,
    accountName: details.accountName ?? null,
    accountNumber: details.accountNumber ?? null,
    bankBranch: details.bankBranch ?? null,
    momoNetwork: details.momoNetwork ?? null,
    momoNumber: details.momoNumber ?? null,
  };
}

/**
 * The supplier register's procurement half (FR-PUR-001 to FR-PUR-003, ADR-0022, A-166): a supplier's terms, payout
 * details and documents. Payout details are sealed with the supplier's own key and shown only masked; reading them in
 * full needs its own permission with a fresh step-up and is audited. Any change of payout details, the first set
 * included, waits as a SUPPLIER_PAYOUT_CHANGE for a different person's approval, and the details in force stay in
 * force until then (payments pay what was in force when they were prepared). Suppliers are farm-wide, so a payout
 * change is held and approved at the head office branch.
 */
export class Suppliers implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: SupplierRegisterStore,
    private readonly refs: MasterDataRefs,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly subjectKeys: SubjectKeys,
    private readonly files: FileStore,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  getProfile(actor: Actor | undefined, supplierId: string): Promise<SupplierProfileView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      return this.profileView(tx, await this.liveProfile(tx, supplierId, false));
    });
  }

  updateProfile(actor: Actor | undefined, supplierId: string, body: SupplierProfileUpdate, idempotencyKey: string): Promise<StoredResponse<SupplierProfileView | ApprovalPendingView>> {
    return runPurchaseCommand<SupplierProfileView | ApprovalPendingView>(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      UPDATE,
      'updateSupplierProfile',
      { supplierId, ...body },
      idempotencyKey,
      async () => ({}),
      async (tx) => {
        if ((await this.refs.suppliersIn(tx, [supplierId])).get(supplierId) === undefined) throw new NotFoundError(`no supplier ${supplierId}`);
        // Version 0 opens the profile of a supplier registered before procurement opened one for each (A-166).
        const opened = (await this.store.profile(tx, supplierId, true)) !== null;
        if (!opened && body.version === 0) await this.store.openProfile(tx, supplierId, actor!.principalId);
        const before = await this.liveProfile(tx, supplierId, true);
        if (opened && before.version !== body.version) throw new VersionConflictError(`supplier profile ${supplierId} is at version ${before.version}, not ${body.version}`);
        if (!opened && body.version !== 0) throw new VersionConflictError(`supplier ${supplierId} has no profile yet; send version 0 to open it`);
        const terms: ProfileTerms = { paymentTermsDays: body.paymentTermsDays, leadTimeDays: body.leadTimeDays, notes: body.notes?.trim() };
        if (body.payoutDetails === undefined) {
          const beforeView = await this.profileView(tx, before);
          await this.store.updateTerms(tx, supplierId, terms, actor!.principalId);
          const view = await this.profileView(tx, (await this.store.profile(tx, supplierId, false))!);
          await this.audited(tx, 'UPDATE', supplierId, beforeView, view);
          return { status: 200, body: view };
        }
        return { status: 202, body: await this.requestPayoutChange(tx, actor!, before, body.payoutDetails, terms) };
      },
    ).catch(translatePurRefusal);
  }

  /** The full payout details, decrypted for a holder of the payout permission (fresh step-up) and audited (FR-PUR-002). */
  payoutDetails(actor: Actor | undefined, supplierId: string): Promise<SupplierPayoutDetailsView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, PAYOUT_READ);
      const profile = await this.liveProfile(tx, supplierId, false);
      const inForce = profile.payoutChangeId === null ? null : await this.store.payoutChange(tx, profile.payoutChangeId, false);
      const pending = await this.store.pendingPayoutChange(tx, supplierId);
      const view: SupplierPayoutDetailsView = {
        supplierId,
        inForce: inForce === null ? null : fullView(await this.open(tx, inForce, actor!)),
        pending:
          pending === null
            ? null
            : { ...fullView(await this.open(tx, pending, actor!)), approvalRequestId: pending.approvalRequestId, requestedBy: pending.createdBy, requestedAt: pending.createdAt.toISOString() },
      };
      await this.audit.record(tx, {
        module: 'pur',
        action: 'DECRYPT',
        entityType: 'SupplierPayoutDetails',
        entityId: supplierId,
        metadata: { inForce: inForce?.id ?? null, pending: pending?.id ?? null },
      });
      return view;
    });
  }

  listDocuments(actor: Actor | undefined, supplierId: string, cursor: string | undefined, limit: number): Promise<Page<SupplierDocumentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      if ((await this.refs.suppliersIn(tx, [supplierId])).get(supplierId) === undefined) throw new NotFoundError(`no supplier ${supplierId}`);
      const binding = { operationId: 'listSupplierDocuments', principalId: actor!.principalId, filters: { supplierId } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.documents(tx, supplierId, before, limit + 1);
      const kept = rows.slice(0, limit);
      const last = kept.at(-1);
      const hasMore = rows.length > limit;
      return {
        data: await this.documentViews(tx, kept),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore },
      };
    });
  }

  /**
   * Files a document the file store holds for a supplier (FR-PUR-003): an upload of purpose SUPPLIER_DOCUMENT that the
   * scanner passed. The upload itself typed the file by its bytes, so a disguised file never got this far.
   */
  addDocument(actor: Actor | undefined, supplierId: string, body: SupplierDocumentCreate, idempotencyKey: string): Promise<StoredResponse<SupplierDocumentView>> {
    return runPurchaseCommand(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      UPDATE,
      'addSupplierDocument',
      { supplierId, ...body },
      idempotencyKey,
      async () => ({}),
      async (tx) => {
        if ((await this.refs.suppliersIn(tx, [supplierId])).get(supplierId) === undefined) throw new NotFoundError(`no supplier ${supplierId}`);
        const file = await this.files.find(tx, body.fileId);
        const broken: BrokenRule[] = [];
        if (file === null) broken.push({ field: '/fileId', rule: 'REFERENCE_NOT_FOUND' });
        else if (file.purpose !== DOCUMENT_FILE || file.scanStatus !== 'CLEAN') broken.push({ field: '/fileId', rule: 'FILE_NOT_USABLE' });
        else if ((await this.store.documentOfFile(tx, file.id)) !== null) broken.push({ field: '/fileId', rule: 'FILE_ALREADY_FILED' });
        if (body.expiresOn !== undefined && body.expiresOn < toBusinessDate(this.clock.now())) broken.push({ field: '/expiresOn', rule: 'EXPIRED' });
        if (broken.length > 0) throw new SupplierDocumentInvalidError(broken);
        const id = this.nextId();
        await this.store.insertDocument(tx, { id, supplierId, kind: body.kind, fileId: body.fileId, expiresOn: body.expiresOn ?? null }, actor!.principalId);
        const view = (await this.documentViews(tx, (await this.store.documents(tx, supplierId, null, 1)).filter((d) => d.id === id)))[0]!;
        await this.audit.record(tx, { module: 'pur', action: 'CREATE', entityType: 'SupplierDocument', entityId: id, before: null, after: { supplierId, ...view } });
        return { status: 201, body: view };
      },
    ).catch(translatePurRefusal);
  }

  /** Transactional subscriber to `mdm.SupplierRegistered`: every supplier gets its commercial profile, with no terms. */
  readonly registered = async (tx: Transaction, event: EventEnvelope): Promise<void> => {
    const supplierId = (event.payload as { readonly supplierId: string }).supplierId;
    await this.store.openProfile(tx, supplierId, event.actorId);
  };

  /** ApprovalHandler: what the change asks for never changes (the database freezes it), so its hash is fixed. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const change = await this.store.payoutChange(tx, subjectDocumentId, false);
    if (change === null) throw new NotFoundError(`no payout change ${subjectDocumentId}`);
    return changeHash(change);
  }

  /** ApprovalHandler: the approved details go into force, with the terms asked for beside them, in the approval's transaction. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const change = await this.pendingChange(tx, request.subjectDocumentId);
    const before = await this.liveProfile(tx, change.supplierId, true);
    const beforeView = await this.profileView(tx, before);
    await this.store.decidePayoutChange(tx, change.id, 'APPROVED', null, request.decidedBy!);
    await this.store.putPayoutInForce(tx, change.supplierId, change.id, request.decidedBy!);
    await this.store.updateTerms(tx, change.supplierId, change.terms, request.decidedBy!);
    const view = await this.profileView(tx, (await this.store.profile(tx, change.supplierId, false))!);
    await this.audited(tx, 'PAYOUT_CHANGE_APPROVED', change.supplierId, beforeView, view, { approvalRequestId: request.id, payoutChangeId: change.id });
    await this.events.publish<SupplierPayoutChanged>(tx, {
      type: 'pur.SupplierPayoutChanged',
      subjectType: 'SupplierPayoutChange',
      subjectId: change.id,
      branchId: change.branchId,
      payload: {
        payoutChangeId: change.id,
        supplierId: change.supplierId,
        approvalRequestId: request.id,
        method: change.method,
        previousPayoutMasked: beforeView.payoutDetailsMasked,
        payoutMasked: change.masked,
        requestedBy: change.createdBy,
        approvedBy: request.decidedBy!,
        abuseCase: PAYOUT_ABUSE_CASE,
      },
    });
  }

  /** ApprovalHandler: a refused change is REJECTED, a withdrawn one CANCELLED; the details in force never moved. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const change = await this.pendingChange(tx, request.subjectDocumentId);
    const withdrawn = request.status === 'CANCELLED';
    await this.store.decidePayoutChange(tx, change.id, withdrawn ? 'CANCELLED' : 'REJECTED', withdrawn ? WITHDRAWN : null, request.decidedBy ?? request.requestedBy);
    await this.audit.record(tx, {
      module: 'pur',
      action: withdrawn ? 'PAYOUT_CHANGE_CANCELLED' : 'PAYOUT_CHANGE_REJECTED',
      entityType: 'SupplierPayoutChange',
      entityId: change.id,
      branchId: change.branchId,
      metadata: { approvalRequestId: request.id, supplierId: change.supplierId },
    });
  }

  private async requestPayoutChange(tx: Transaction, actor: Actor, before: ProfileRecord, input: PayoutDetails, terms: ProfileTerms): Promise<ApprovalPendingView> {
    await this.authoriser.authorise(tx, actor, PAYOUT_CHANGE);
    const judged = judgePayoutDetails(input);
    if (!judged.ok) throw new SupplierProfileInvalidError(judged.error);
    if ((await this.store.pendingPayoutChange(tx, before.supplierId)) !== null) {
      throw new SupplierProfileInvalidError([{ field: '/payoutDetails', rule: 'PAYOUT_CHANGE_PENDING' }]);
    }
    const branchId = await this.refs.headOfficeBranchIn(tx);
    if (branchId === null) throw new Error('no live branch exists to hold a payout change');
    const id = this.nextId();
    const details = judged.value;
    const masked = maskPayout(details);
    const restricted = details.method === 'BANK' || details.method === 'MOBILE_MONEY';
    const key = await this.subjectKeys.keyFor(tx, { type: 'SUPPLIER', id: before.supplierId }, actor.principalId);
    const detailsEnc = restricted ? sealWithSubjectKey(key, canonicalJson(details), payoutPlace(id)) : null;
    const supplier = (await this.refs.suppliersIn(tx, [before.supplierId])).get(before.supplierId)!;
    const summary = `Pay ${supplier.name} by ${masked} from now on`;
    await this.documents.register(tx, { id, docType: DOC_TYPE, ownerModule: 'pur', branchId, actorId: actor.principalId });
    const draft: PayoutChangeRecord = {
      id,
      supplierId: before.supplierId,
      method: details.method,
      detailsEnc,
      masked,
      terms,
      approvalRequestId: '',
      status: 'PENDING_APPROVAL',
      branchId,
      createdAt: this.clock.now(),
      createdBy: actor.principalId,
    };
    const request = await this.approvals.request(tx, actor, { kind: SUPPLIER_PAYOUT_CHANGE_KIND, branchId, subjectDocumentId: id, payloadHash: changeHash(draft), summary });
    await this.store.insertPayoutChange(tx, { ...draft, approvalRequestId: request.id });
    const beforeView = await this.profileView(tx, before);
    await this.audited(tx, 'PAYOUT_CHANGE_REQUESTED', before.supplierId, beforeView, { ...beforeView, payoutMethod: details.method, payoutDetailsMasked: masked }, { approvalRequestId: request.id, payoutChangeId: id });
    await this.events.publish<SupplierPayoutChangeRequested>(tx, {
      type: 'pur.SupplierPayoutChangeRequested',
      subjectType: 'SupplierPayoutChange',
      subjectId: id,
      branchId,
      payload: {
        payoutChangeId: id,
        supplierId: before.supplierId,
        approvalRequestId: request.id,
        method: details.method,
        previousPayoutMasked: beforeView.payoutDetailsMasked,
        payoutMasked: masked,
        requestedBy: actor.principalId,
        abuseCase: PAYOUT_ABUSE_CASE,
      },
    });
    return { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind: SUPPLIER_PAYOUT_CHANGE_KIND, subject: { id, docType: DOC_TYPE, number: null }, summary, requestedAt: request.requestedAt.toISOString() };
  }

  private async open(tx: Transaction, change: PayoutChangeRecord, actor: Actor): Promise<PayoutDetails> {
    if (change.detailsEnc === null) return { method: change.method };
    const key = await this.subjectKeys.keyFor(tx, { type: 'SUPPLIER', id: change.supplierId }, actor.principalId);
    return JSON.parse(openWithSubjectKey(key.key, change.detailsEnc, payoutPlace(change.id))) as PayoutDetails;
  }

  private async liveProfile(tx: Transaction, supplierId: string, lock: boolean): Promise<ProfileRecord> {
    const profile = await this.store.profile(tx, supplierId, lock);
    if (profile === null) throw new NotFoundError(`no profile for supplier ${supplierId}`);
    return profile;
  }

  private async pendingChange(tx: Transaction, id: string): Promise<PayoutChangeRecord> {
    const change = await this.store.payoutChange(tx, id, true);
    if (change === null) throw new NotFoundError(`no payout change ${id}`);
    if (change.status !== 'PENDING_APPROVAL') throw new Error(`payout change ${id} is ${change.status}, not waiting for a decision`);
    return change;
  }

  private async profileView(tx: Transaction, profile: ProfileRecord): Promise<SupplierProfileView> {
    const inForce = profile.payoutChangeId === null ? null : await this.store.payoutChange(tx, profile.payoutChangeId, false);
    const pending = await this.store.pendingPayoutChange(tx, profile.supplierId);
    return {
      supplierId: profile.supplierId,
      paymentTermsDays: profile.paymentTermsDays,
      payoutMethod: inForce?.method ?? null,
      payoutDetailsMasked: inForce?.masked ?? null,
      pendingPayoutChangeApprovalId: pending?.approvalRequestId ?? null,
      leadTimeDays: profile.leadTimeDays,
      notes: profile.notes,
      version: profile.version,
      updatedAt: profile.updatedAt.toISOString(),
    };
  }

  private async documentViews(tx: Transaction, records: readonly SupplierDocumentRecord[]): Promise<SupplierDocumentView[]> {
    const views: SupplierDocumentView[] = [];
    for (const record of records) {
      const file = (await this.files.find(tx, record.fileId))!;
      views.push({
        id: record.id,
        kind: record.kind,
        file: { id: file.id, originalName: file.originalName, contentType: file.contentType },
        expiresOn: record.expiresOn,
        createdAt: record.createdAt.toISOString(),
      });
    }
    return views;
  }

  private async audited(tx: Transaction, action: string, supplierId: string, before: SupplierProfileView, after: SupplierProfileView, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.audit.record(tx, {
      module: 'pur',
      action,
      entityType: 'SupplierProfile',
      entityId: supplierId,
      before: { ...before },
      after: { ...after },
      metadata: JSON.parse(JSON.stringify(metadata)),
      subject: { type: 'SUPPLIER', id: supplierId },
      personalFields: PAYOUT_PERSONAL,
    });
  }
}
