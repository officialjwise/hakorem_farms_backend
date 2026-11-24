import { createHash } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys } from '../../../platform/crypto/subject-keys';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore } from '../../../platform/storage/file-store';
import type { AccessAdmin, ApprovalHandler, ApprovalRecord, Approvals } from '../../iam';
import { judgeIdNumber, judgePayout, maskPayout, payoutLast4, type InvestorPayout } from '../domain/investor/payout';
import type { CapBooksStore, InvestorDocumentRecord, PayoutChangeRecord } from './cap-books-store';
import type { CapStore, InvestorRecord } from './cap-store';
import { INVESTOR_MANAGE, INVESTOR_READ, type Capital, type Page } from './capital';
import { probe } from './counting';
import { InvestorInvalidError, MakerCannotCheckError, type CapRule } from './errors';

export const INVESTOR_PAYOUT_READ = 'cap.investor.payout.read';
export const INVESTOR_PAYOUT_CHANGE = 'INVESTOR_PAYOUT_CHANGE';
/** Published for the daily exception report (B12 continued 3): a change asked for, and a change applied. */
export const INVESTOR_PAYOUT_CHANGE_REQUESTED = 'cap.InvestorPayoutChangeRequested';
export const INVESTOR_PAYOUT_CHANGED = 'cap.InvestorPayoutChanged';
const FILE_PURPOSES = new Set(['INVESTOR_DOCUMENT', 'AGREEMENT']);

/** The contract's `InvestorDocument`. */
export interface InvestorDocumentView {
  readonly id: string;
  readonly kind: InvestorDocumentRecord['kind'];
  readonly name: string;
  readonly file: { readonly id: string; readonly originalName: string; readonly contentType: string };
  readonly createdAt: string;
}

/** The contract's `InvestorPayoutDetails`: the details in force and any change waiting, in full, for the payout permission. */
export interface InvestorPayoutDetailsView {
  readonly investorId: string;
  readonly idNumber: string | null;
  readonly inForce: InvestorPayout | null;
  readonly pending: (InvestorPayout & { readonly approvalRequestId: string; readonly requestedBy: string; readonly requestedAt: string }) | null;
}

/** What createInvestor and updateInvestor may ask of the sealed and linked fields (FR-CAP-002, FR-IAM-013). */
export interface ProfileRequest {
  readonly idNumber?: string | undefined;
  readonly payout?: InvestorPayout | undefined;
  readonly agreementFileId?: string | undefined;
  readonly createPortalLogin?: boolean | undefined;
}

const payoutPlace = (changeId: string): string => `cap.investor_payout_change:${changeId}`;
const idNumberPlace = (investorId: string): string => `cap.investor.id_number:${investorId}`;
const changeHash = (c: Pick<PayoutChangeRecord, 'id' | 'investorId' | 'method' | 'masked' | 'last4'> & { readonly detailsHash: string }) =>
  createHash('sha256').update(canonicalJson({ id: c.id, investorId: c.investorId, method: c.method, masked: c.masked, last4: c.last4, details: c.detailsHash }), 'utf8').digest('hex');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * An investor's sealed and linked particulars (FR-CAP-002, ADR-0022, ADR-0101): the identity number and payout details
 * sealed with the investor's own key and only ever shown masked; every setting of the payout details, the first
 * included, waits for a different person holding `cap.investor.payout.approve` (`INVESTOR_PAYOUT_CHANGE`); the full
 * details revealed only to `cap.investor.payout.read` with a fresh step-up, each decryption audited; documents and the
 * agreement held privately; and the investor's portal login (FR-IAM-013). Kept at the head office branch like the rest
 * of the investor books (A-381).
 */
export class InvestorProfiles {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly books: CapBooksStore,
    private readonly capital: Capital,
    private readonly subjectKeys: SubjectKeys,
    private readonly files: FileStore,
    private readonly access: AccessAdmin,
    private readonly approvals: Approvals,
    private readonly registry: DocumentRegistry,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** createInvestor's and updateInvestor's sealed and linked fields, in their transaction, after the register's own change. */
  async applyIn(tx: Transaction, actor: Actor, branchId: string, investor: InvestorRecord, request: ProfileRequest): Promise<void> {
    const broken: CapRule[] = [];
    const idNumber = request.idNumber === undefined ? null : judgeIdNumber(request.idNumber);
    if (idNumber !== null && !idNumber.ok) broken.push(...idNumber.rules);
    const payout = request.payout === undefined ? null : judgePayout(request.payout);
    if (payout !== null && !payout.ok) broken.push(...payout.rules);
    if (payout !== null && (await this.books.pendingPayoutChange(tx, investor.id)) !== null) broken.push({ field: '/payout', rule: 'PAYOUT_CHANGE_PENDING' });
    if (request.agreementFileId !== undefined && !(await this.usableFile(tx, request.agreementFileId))) broken.push({ field: '/agreementFileId', rule: 'FILE_NOT_USABLE' });
    if (request.createPortalLogin === true) {
      if (investor.principalId !== null) broken.push({ field: '/createPortalLogin', rule: 'PORTAL_LOGIN_EXISTS' });
      else if (investor.email === null && investor.phone === null) broken.push({ field: '/createPortalLogin', rule: 'NO_CONTACT_FOR_LOGIN' });
    }
    if (broken.length > 0) throw new InvestorInvalidError(broken);
    const at = this.clock.now();
    if (idNumber?.ok === true) {
      const key = await this.subjectKeys.keyFor(tx, { type: 'INVESTOR', id: investor.id }, actor.principalId);
      await this.books.sealIdNumber(tx, investor.id, sealWithSubjectKey(key, idNumber.value.value, idNumberPlace(investor.id)), idNumber.value.masked, actor.principalId, at);
      await this.audit.record(tx, { module: 'cap', action: 'ID_NUMBER_SET', entityType: 'Investor', entityId: investor.id, branchId, metadata: { idNumberMasked: idNumber.value.masked } });
    }
    if (request.agreementFileId !== undefined) {
      await this.attachIn(tx, actor, investor.id, { kind: 'AGREEMENT', name: 'Investment agreement', fileId: request.agreementFileId }, at);
    }
    if (request.createPortalLogin === true) {
      const principalId = await this.access.createInvestorLoginIn(tx, actor, { displayName: investor.legalName, email: investor.email, phone: investor.phone });
      await this.books.setPortalLogin(tx, investor.id, principalId, actor.principalId, at);
      await this.audit.record(tx, { module: 'cap', action: 'PORTAL_LOGIN_CREATED', entityType: 'Investor', entityId: investor.id, branchId, metadata: { principalId } });
    }
    if (payout?.ok === true) await this.requestPayoutChangeIn(tx, actor, branchId, investor, payout.value);
  }

  /** The approval waiting on the investor's payout details, if any, for the `Investor` view. */
  async pendingApprovalsIn(tx: Transaction, investorIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (const id of investorIds) {
      const pending = await this.books.pendingPayoutChange(tx, id);
      if (pending !== null) result.set(id, pending.approvalRequestId);
    }
    return result;
  }

  /** getInvestorPayoutDetails (FR-CAP-002): the details in full for the payout permission, step-up, each decryption audited. */
  payoutDetails(actor: Actor | undefined, investorId: string): Promise<InvestorPayoutDetailsView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const branchId = await this.capital.authoriseIn(tx, actor, INVESTOR_PAYOUT_READ);
      const sealed = await this.books.sealedOf(tx, investorId);
      if (sealed === null) throw new NotFoundError(`no investor ${investorId}`);
      const key = await this.subjectKeys.keyFor(tx, { type: 'INVESTOR', id: investorId }, actor!.principalId);
      const open = (enc: Buffer, place: string): string => openWithSubjectKey(key.key, enc, place);
      const pending = await this.books.pendingPayoutChange(tx, investorId);
      const view: InvestorPayoutDetailsView = {
        investorId,
        idNumber: sealed.idNumberEnc === null ? null : open(sealed.idNumberEnc, idNumberPlace(investorId)),
        inForce: sealed.payoutEnc === null ? null : (JSON.parse(open(sealed.payoutEnc, payoutPlace(sealed.payoutChangeId!))) as InvestorPayout),
        pending:
          pending === null
            ? null
            : {
                ...(JSON.parse(open(pending.detailsEnc, payoutPlace(pending.id))) as InvestorPayout),
                approvalRequestId: pending.approvalRequestId,
                requestedBy: pending.createdBy,
                requestedAt: pending.createdAt.toISOString(),
              },
      };
      await this.audit.record(tx, {
        module: 'cap',
        action: 'DECRYPT',
        entityType: 'InvestorPayoutDetails',
        entityId: investorId,
        branchId,
        metadata: { payoutChangeId: sealed.payoutChangeId, pendingChangeId: pending?.id ?? null, idNumber: sealed.idNumberEnc !== null },
      });
      return view;
    });
  }

  listDocuments(actor: Actor | undefined, investorId: string, cursor: string | undefined, limit: number): Promise<Page<InvestorDocumentView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, INVESTOR_READ);
      if ((await this.store.investor(tx, investorId, false)) === null) throw new NotFoundError(`no investor ${investorId}`);
      return this.documentPageIn(tx, actor!, 'listInvestorDocuments', investorId, cursor, limit);
    });
  }

  /** The investor's own documents, for the portal: the binding names the investor, never an id from the request. */
  async documentPageIn(tx: Transaction, actor: Actor, operationId: string, investorId: string, cursor: string | undefined, limit: number): Promise<Page<InvestorDocumentView>> {
    const binding = { operationId, principalId: actor.principalId, filters: { investorId } };
    const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
    const found = await this.books.documents(tx, investorId, before, probe(limit));
    const rows = found.slice(0, limit);
    const hasMore = found.length > limit;
    return { data: await this.documentViews(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
  }

  /** addInvestorDocument (FR-CAP-002): a scanned, clean file kept privately for the investor; an agreement becomes theirs. */
  addDocument(actor: Actor | undefined, investorId: string, request: { readonly kind: InvestorDocumentRecord['kind']; readonly name: string; readonly fileId: string }, key: string): Promise<StoredResponse<InvestorDocumentView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, INVESTOR_MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: 'addInvestorDocument', principalId: actor!.principalId, key, request: { investorId, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<InvestorDocumentView>;
      if ((await this.store.investor(tx, investorId, true)) === null) throw new NotFoundError(`no investor ${investorId}`);
      if (!(await this.usableFile(tx, request.fileId))) throw new InvestorInvalidError([{ field: '/fileId', rule: 'FILE_NOT_USABLE' }]);
      const record = await this.attachIn(tx, actor!, investorId, request, this.clock.now());
      const response: StoredResponse<InvestorDocumentView> = { status: 201, body: (await this.documentViews(tx, [record]))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A document of the investor's, or null: another investor's id answers nothing (FR-CAP-002). */
  documentOfIn(tx: Transaction, investorId: string, documentId: string): Promise<InvestorDocumentRecord | null> {
    return this.books.document(tx, investorId, documentId);
  }

  /** IAM's `INVESTOR_PAYOUT_CHANGE` handler: on approval the sealed details come into force, in the approving transaction. */
  readonly payoutChangeHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, id) => {
      const change = await this.books.payoutChange(tx, id);
      if (change === null) throw new NotFoundError(`no payout change ${id}`);
      return changeHash({ ...change, detailsHash: sha(change.detailsEnc) });
    },
    onApproved: async (tx: Transaction, approval: ApprovalRecord) => {
      const change = await this.books.payoutChangeByApproval(tx, approval.id);
      if (change === null || change.status !== 'PENDING_APPROVAL') throw new NotFoundError(`no payout change waiting under approval ${approval.id}`);
      // ADR-0017 here as well as in IAM and the database: the maker never checks.
      if (approval.decidedBy === null || approval.decidedBy === change.createdBy) throw new MakerCannotCheckError('the person who asked for this change cannot approve it');
      const at = this.clock.now();
      const investor = (await this.store.investor(tx, change.investorId, true))!;
      await this.books.decidePayoutChange(tx, change.id, 'APPLIED', approval.decidedBy, at);
      await this.books.applyPayout(tx, change, approval.decidedBy, at);
      await this.audit.record(tx, {
        module: 'cap',
        action: 'PAYOUT_CHANGED',
        entityType: 'Investor',
        entityId: change.investorId,
        branchId: change.branchId,
        before: { payoutMethod: investor.payoutMethod, payoutDetailsMasked: investor.payoutMasked },
        after: { payoutMethod: change.method, payoutDetailsMasked: change.masked },
        metadata: { approvalRequestId: approval.id, payoutChangeId: change.id },
      });
      await this.events.publish(tx, {
        type: INVESTOR_PAYOUT_CHANGED,
        subjectType: 'InvestorPayoutChange',
        subjectId: change.id,
        branchId: change.branchId,
        payload: {
          payoutChangeId: change.id,
          investorId: change.investorId,
          approvalRequestId: approval.id,
          method: change.method,
          previousPayoutMasked: investor.payoutMasked,
          payoutMasked: change.masked,
          requestedBy: change.createdBy,
          approvedBy: approval.decidedBy,
        },
        occurredAt: at,
      });
    },
    onRejected: async (tx: Transaction, approval: ApprovalRecord) => {
      const change = await this.books.payoutChangeByApproval(tx, approval.id);
      if (change === null || change.status !== 'PENDING_APPROVAL') return;
      const withdrawn = approval.status === 'CANCELLED';
      await this.books.decidePayoutChange(tx, change.id, withdrawn ? 'CANCELLED' : 'REJECTED', approval.decidedBy ?? approval.requestedBy, this.clock.now());
      await this.audit.record(tx, {
        module: 'cap',
        action: withdrawn ? 'PAYOUT_CHANGE_CANCELLED' : 'PAYOUT_CHANGE_REJECTED',
        entityType: 'InvestorPayoutChange',
        entityId: change.id,
        branchId: change.branchId,
        metadata: { approvalRequestId: approval.id, investorId: change.investorId },
      });
    },
  };

  private async requestPayoutChangeIn(tx: Transaction, actor: Actor, branchId: string, investor: InvestorRecord, details: InvestorPayout): Promise<void> {
    const id = this.nextId();
    const at = this.clock.now();
    const masked = maskPayout(details);
    const key = await this.subjectKeys.keyFor(tx, { type: 'INVESTOR', id: investor.id }, actor.principalId);
    const detailsEnc = sealWithSubjectKey(key, canonicalJson(details), payoutPlace(id));
    const last4 = payoutLast4(details);
    const summary = `Pay ${investor.legalName} (${investor.investorNo}) by ${masked} from now on`;
    await this.registry.register(tx, { id, docType: INVESTOR_PAYOUT_CHANGE, ownerModule: 'cap', branchId, actorId: actor.principalId });
    const approval = await this.approvals.request(tx, actor, {
      kind: INVESTOR_PAYOUT_CHANGE,
      branchId,
      subjectDocumentId: id,
      payloadHash: changeHash({ id, investorId: investor.id, method: details.method, masked, last4, detailsHash: sha(detailsEnc) }),
      summary,
    });
    await this.books.insertPayoutChange(tx, {
      id,
      investorId: investor.id,
      method: details.method,
      detailsEnc,
      masked,
      last4,
      approvalRequestId: approval.id,
      status: 'PENDING_APPROVAL',
      branchId,
      createdBy: actor.principalId,
      createdAt: at,
    });
    await this.audit.record(tx, {
      module: 'cap',
      action: 'PAYOUT_CHANGE_REQUESTED',
      entityType: 'Investor',
      entityId: investor.id,
      branchId,
      before: { payoutMethod: investor.payoutMethod, payoutDetailsMasked: investor.payoutMasked },
      after: { payoutMethod: details.method, payoutDetailsMasked: masked },
      metadata: { approvalRequestId: approval.id, payoutChangeId: id },
    });
    await this.events.publish(tx, {
      type: INVESTOR_PAYOUT_CHANGE_REQUESTED,
      subjectType: 'InvestorPayoutChange',
      subjectId: id,
      branchId,
      payload: { payoutChangeId: id, investorId: investor.id, approvalRequestId: approval.id, method: details.method, previousPayoutMasked: investor.payoutMasked, payoutMasked: masked, requestedBy: actor.principalId },
      occurredAt: at,
    });
  }

  private async attachIn(tx: Transaction, actor: Actor, investorId: string, request: { readonly kind: InvestorDocumentRecord['kind']; readonly name: string; readonly fileId: string }, at: Date): Promise<InvestorDocumentRecord> {
    const record: InvestorDocumentRecord = { id: this.nextId(), investorId, kind: request.kind, name: request.name.trim(), fileId: request.fileId, createdAt: at };
    await this.books.insertDocument(tx, record, actor.principalId);
    if (request.kind === 'AGREEMENT') await this.books.setAgreement(tx, investorId, request.fileId, actor.principalId, at);
    await this.audit.record(tx, { module: 'cap', action: 'DOCUMENT_ADDED', entityType: 'InvestorDocument', entityId: record.id, after: { investorId, kind: record.kind, name: record.name, fileId: record.fileId } });
    return record;
  }

  private async usableFile(tx: Transaction, fileId: string): Promise<boolean> {
    const file = await this.files.find(tx, fileId);
    return file !== null && FILE_PURPOSES.has(file.purpose) && file.scanStatus === 'CLEAN';
  }

  private async documentViews(tx: Transaction, rows: readonly InvestorDocumentRecord[]): Promise<InvestorDocumentView[]> {
    const views: InvestorDocumentView[] = [];
    for (const r of rows) {
      const file = (await this.files.find(tx, r.fileId))!;
      views.push({ id: r.id, kind: r.kind, name: r.name, file: { id: file.id, originalName: file.originalName, contentType: file.contentType }, createdAt: r.createdAt.toISOString() });
    }
    return views;
  }
}
