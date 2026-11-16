import { createHash } from 'node:crypto';
import { createUuidV7Generator, Money, Quantity, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { FileStore, StoredFileRecord } from '../../../platform/storage/file-store';
import type { ApprovalHandler, ApprovalRecord, Approvals, AuthoriseScope, Authoriser, PrincipalNames } from '../../iam';
import { issue, type Stock, type StockUnitFacts, type StockUnits } from '../../inv';
import type { MasterDataRefs } from '../../mdm';
import { headOf } from '../domain/cost-spread';
import { checkMortalityReport, evidenceVerdict, judgeSubmission, type MortalityKind } from '../domain/mortality';
import type { MortalityApproved, MortalityPhotoReused, MortalityReported, MortalityReturned } from '../events';
import { EvidenceNotScannedError, LivestockRecordInvalidError, LivReferenceNotFoundError, MortalityPhotoRequiredError } from './errors';
import type { LivestockStore, MortalityFilters, MortalityRecord, MortalityReturnReason, MortalityStatus } from './livestock-store';
import { afterOf, pageOf, pageProbe, placesOf, readScopeOf, runWrite, writePermissions, type Page, type WriteDoor } from './support';

export const MORTALITY_WRITE_OFF = 'MORTALITY_WRITE_OFF';
/** A write-off below the threshold reported by someone who may not post one (the Farm hand), confirmed by a holder of `liv.mortality.confirm` (B06r). */
export const MORTALITY_CONFIRMATION = 'MORTALITY_CONFIRMATION';
/** Who may post a write-off below the threshold without a second person. */
const POST_PERMISSION = 'liv.mortality.post';
/** Waiting records the evidence returns job looks at in one run; the next run, a minute later, takes the rest. */
const RETURNS_BATCH = 200;
/** Threat model abuse case 2: a healthy animal recorded as dead and sold privately. */
const ABUSE_CASE_HEALTHY_RECORDED_DEAD = 2;
const EVIDENCE = 'EVIDENCE';
const UNKNOWN_PRINCIPAL = { id: '', displayName: 'Unknown' };

export interface MortalityReportRequest {
  readonly id?: string | undefined;
  readonly kind: MortalityKind;
  readonly stockUnitId: string;
  readonly head?: number | undefined;
  readonly reasonCode: string;
  readonly foundAt: Date;
  readonly photoFileId?: string | undefined;
  readonly disposalNote?: string | undefined;
}

interface Ref {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/** The contract's `MortalityRecord`. */
export interface MortalityRecordView {
  readonly id: string;
  readonly kind: MortalityKind;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' };
  readonly animal: { readonly id: string; readonly tagNo: string } | null;
  readonly head: number;
  readonly reasonCode: string;
  readonly foundAt: string;
  readonly location: Ref | null;
  readonly reportedBy: { readonly id: string; readonly displayName: string };
  readonly photoFileId: string | null;
  readonly valuePesewas: number;
  readonly currency: 'GHS';
  readonly status: MortalityStatus;
  /** Why the record went back to its maker (status RETURNED): the scanner rejected its photograph. */
  readonly returnedReason: MortalityReturnReason | null;
  readonly approvalRequestId: string | null;
  readonly movementId: string | null;
  readonly disposalNote: string | null;
  readonly version: number;
}

/** The contract's `ApprovalPending`. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: null };
  readonly summary: string;
  readonly requestedAt: string;
}

/**
 * Deaths and culls (FR-LIV-012, FR-LIV-013; threat model abuse case 2). A record is REPORTED with the animal or the
 * birds lost from a flock, a reason from the fixed list, where and when it was found and, at will, a photograph (an
 * EVIDENCE file, which may still be PENDING its scan); its value is what the write-off would carry out of the cost pool
 * now. Submitting values it again and asks IAM's `Approvals.judgeIn` for the MORTALITY_WRITE_OFF threshold: at or above
 * it, a photograph is required before anything else, and the record waits as PENDING_APPROVAL, with the stock still on
 * hand, until a different person holding `liv.mortality.approve` approves it; below it, a reporter holding
 * `liv.mortality.post` posts the MORTALITY or CULL movement at once, and one who does not (the Farm hand, owner
 * 2026-11-15) waits for a MORTALITY_CONFIRMATION by a different holder of `liv.mortality.confirm` (the Owner, the Manager). Either approval posts
 * the movement in its own transaction, and only once the photograph is CLEAN; a photograph the scanner rejects sends
 * the waiting record back to its maker (RETURNED, `MortalityEvidenceReturns`). Only the reporter submits, so the maker
 * IAM keeps from checking is the reporter. A photograph whose exact bytes were already attached to another record is
 * published for the exception report. The database refuses a posted record at or above its threshold without a
 * photograph and an approval, one that needed a confirmation without one, and a photograph that is not CLEAN.
 */
export class MortalityRecords implements ApprovalHandler {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly refs: MasterDataRefs,
    private readonly units: StockUnits,
    private readonly stock: Stock,
    private readonly approvals: Approvals,
    private readonly files: FileStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly documents: DocumentRegistry,
    private readonly principals: PrincipalNames,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  report(
    actor: Actor | undefined,
    body: MortalityReportRequest,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'reportMortality', answerPermission: 'liv.mortality.read' },
  ): Promise<StoredResponse<MortalityRecordView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      writePermissions('liv.mortality.report', door),
      door.operationId,
      { ...body, foundAt: body.foundAt.toISOString() },
      idempotencyKey,
      async (tx) => {
        const unit = (await this.units.factsIn(tx, [body.stockUnitId], this.clock.now())).get(body.stockUnitId);
        return unit === undefined ? {} : { branchId: unit.branchId, locationId: (await placesOf(tx, this.units, [unit])).get(unit.id) ?? null };
      },
      async (tx, who) => ({ status: 201, body: await this.reportIn(tx, who, body) }),
    );
  }

  /** Reports a death or cull in the caller's transaction, every rule applied; the caller authorised it. */
  async reportIn(tx: Transaction, actor: Actor, body: MortalityReportRequest): Promise<MortalityRecordView> {
    if (body.id !== undefined) {
      const existing = await this.store.mortality(tx, body.id);
      if (existing !== null) return this.view(tx, existing);
    }
    const now = this.clock.now();
    const unit = (await this.units.factsIn(tx, [body.stockUnitId], now)).get(body.stockUnitId);
    const reason = (await this.refs.reasonCodesIn(tx, [body.reasonCode])).get(body.reasonCode);
    const missing = [...(unit === undefined ? ['/stockUnitId'] : []), ...(reason === undefined ? ['/reasonCode'] : [])];
    if (missing.length > 0) throw new LivReferenceNotFoundError(missing);
    const product = (await this.refs.productsIn(tx, [unit!.productId])).get(unit!.productId)!;
    const animal = (await this.store.animals(tx, [unit!.id]))[0];
    if (product.speciesId === null || (unit!.tracking === 'SERIAL' && animal === undefined)) throw new LivestockRecordInvalidError([{ field: '/stockUnitId', rule: 'NOT_LIVESTOCK' }]);
    const head = body.head ?? 1;
    const place = (await placesOf(tx, this.units, [unit!])).get(unit!.id) ?? null;
    const broken = checkMortalityReport({
      kind: body.kind,
      reasonDomain: reason!.domain,
      tracking: unit!.tracking,
      head,
      headOnHand: headOf(unit!.tracking, unit!.poolQty),
      alive: unit!.status === 'ACTIVE' && place !== null && (animal === undefined || animal.status === 'ALIVE'),
      foundAt: body.foundAt,
      now,
    });
    if (unit!.tracking === 'SERIAL' && (await this.store.openMortalityOf(tx, unit!.id, null)) !== null) broken.push({ field: '/stockUnitId', rule: 'ALREADY_AWAITING_APPROVAL' });
    if (broken.length > 0) throw new LivestockRecordInvalidError(broken);
    const photo = body.photoFileId === undefined ? null : await this.usablePhoto(tx, body.photoFileId);
    const id = body.id ?? this.nextId();
    await this.documents.register(tx, { id, docType: 'MORTALITY_RECORD', ownerModule: 'liv', branchId: unit!.branchId, actorId: actor.principalId });
    await this.store.insertMortality(
      tx,
      {
        id,
        kind: body.kind,
        stockUnitId: unit!.id,
        locationId: place!,
        head,
        reasonCode: body.reasonCode,
        foundAt: body.foundAt,
        reportedBy: actor.principalId,
        photoFileId: body.photoFileId ?? null,
        photoSha256: photo?.sha256 ?? null,
        valuePesewas: this.valueOf(unit!, head).pesewas,
        disposalNote: body.disposalNote ?? null,
        branchId: unit!.branchId,
      },
      actor.principalId,
    );
    const record = (await this.store.mortality(tx, id))!;
    const view = await this.view(tx, record);
    await this.audit.record(tx, { module: 'liv', action: 'CREATE', entityType: 'MortalityRecord', entityId: id, branchId: unit!.branchId, before: null, after: { ...view } });
    if (photo !== null) await this.flagReusedPhoto(tx, record, photo);
    return view;
  }

  submit(
    actor: Actor | undefined,
    id: string,
    idempotencyKey: string,
    door: WriteDoor = { operationId: 'submitMortalityRecord', answerPermission: 'liv.mortality.read' },
  ): Promise<StoredResponse<MortalityRecordView | ApprovalPendingView>> {
    return runWrite(
      this.uow,
      this.authoriser,
      this.idempotency,
      actor,
      writePermissions('liv.mortality.report', door),
      door.operationId,
      { id },
      idempotencyKey,
      (tx) => this.scopeOf(tx, id),
      (tx, who) => this.submitIn(tx, who, id),
    );
  }

  /** Values a REPORTED record again and posts it or asks for approval, in the caller's serializable transaction. */
  async submitIn(tx: Transaction, actor: Actor, id: string): Promise<StoredResponse<MortalityRecordView | ApprovalPendingView>> {
    const before = await this.locked(tx, id, 'REPORTED');
    if (before.reportedBy !== actor.principalId) throw new LivestockRecordInvalidError([{ field: '/id', rule: 'SUBMITTER_NOT_REPORTER' }]);
    const photo = before.photoFileId === null ? null : await this.usablePhoto(tx, before.photoFileId);
    const unit = await this.liveUnit(tx, before);
    const value = this.valueOf(unit, before.head);
    const judgement = await this.approvals.judgeIn(tx, MORTALITY_WRITE_OFF, before.branchId, value.pesewas);
    const threshold = Money.ofPesewas(judgement.thresholdPesewas);
    const reporterMayPost = await this.mayPost(tx, actor, before);
    const verdict = judgeSubmission(value, threshold, { hasPhoto: photo !== null, reporterMayPost });
    if (!verdict.ok) throw new MortalityPhotoRequiredError(value.pesewas, threshold.pesewas);
    if (verdict.value === 'POST') {
      if (photo !== null && !evidenceVerdict(photo.scanStatus).post) throw new EvidenceNotScannedError(photo.id);
      const movementId = await this.postIn(tx, actor.principalId, before);
      await this.store.updateMortality(tx, id, { status: 'POSTED', value_pesewas: value.pesewas.toString(), threshold_pesewas: threshold.pesewas.toString(), movement_id: movementId, posted_at: this.clock.now(), posted_by: actor.principalId }, actor.principalId);
      await this.reported(tx, before, value, threshold, null, null);
      return { status: 200, body: await this.audited(tx, 'POST', before) };
    }
    const kind = verdict.value === 'APPROVAL' ? MORTALITY_WRITE_OFF : MORTALITY_CONFIRMATION;
    const summary = `${before.kind === 'CULL' ? 'Cull' : 'Death'} of ${unit.identifier}${before.head > 1 ? ` (${before.head} head)` : ''} (${before.reasonCode}), valued ${value.pesewas} pesewas${kind === MORTALITY_CONFIRMATION ? ', reported by someone who may not write off alone' : ''}`;
    const request = await this.approvals.request(tx, actor, {
      kind,
      branchId: before.branchId,
      subjectDocumentId: id,
      payloadHash: mortalityHash(before, value),
      amountPesewas: value.pesewas,
      summary,
      evidenceFileId: before.photoFileId,
    });
    await this.store.updateMortality(
      tx,
      id,
      { status: 'PENDING_APPROVAL', value_pesewas: value.pesewas.toString(), threshold_pesewas: threshold.pesewas.toString(), confirmation_required: !reporterMayPost, approval_request_id: request.id },
      actor.principalId,
    );
    await this.reported(tx, before, value, threshold, request.id, kind);
    await this.audited(tx, 'SUBMIT', before, { approvalRequestId: request.id, approvalKind: kind });
    return {
      status: 202,
      body: { status: 'PENDING_APPROVAL', approvalRequestId: request.id, kind, subject: { id, docType: 'MORTALITY_RECORD', number: null }, summary, requestedAt: request.requestedAt.toISOString() },
    };
  }

  /** ApprovalHandler: the record as it would post now; a pool that moved since the request voids the approval. */
  async currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string> {
    const record = await this.store.mortality(tx, subjectDocumentId);
    if (record === null) throw new NotFoundError(`no mortality record ${subjectDocumentId}`);
    const unit = (await this.units.factsIn(tx, [record.stockUnitId], this.clock.now())).get(record.stockUnitId)!;
    return mortalityHash(record, this.valueOf(unit, record.head));
  }

  /** ApprovalHandler: posts the write-off in the approval's transaction, as the checker who let it happen. */
  async onApproved(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, 'PENDING_APPROVAL');
    if (before.photoFileId !== null) {
      const photo = await this.usablePhoto(tx, before.photoFileId);
      if (!evidenceVerdict(photo.scanStatus).post) throw new EvidenceNotScannedError(photo.id);
    }
    await this.liveUnit(tx, before);
    const approver = request.decidedBy!;
    const movementId = await this.postIn(tx, approver, before);
    await this.store.updateMortality(tx, before.id, { status: 'POSTED', movement_id: movementId, posted_at: this.clock.now(), posted_by: approver }, approver);
    await this.events.publish<MortalityApproved>(tx, {
      type: 'liv.MortalityApproved',
      subjectType: 'MortalityRecord',
      subjectId: before.id,
      branchId: before.branchId,
      payload: { mortalityRecordId: before.id, branchId: before.branchId, reportedBy: before.reportedBy, approvedBy: approver, valuePesewas: Money.ofPesewas(before.valuePesewas).toJsonInteger(), movementId },
    });
    await this.audited(tx, 'POST', before, { approvalRequestId: request.id, approvalKind: request.kind, approvedBy: approver });
  }

  /** ApprovalHandler: a rejected or withdrawn record is final; the animal stays on hand. */
  async onRejected(tx: Transaction, request: ApprovalRecord): Promise<void> {
    const before = await this.locked(tx, request.subjectDocumentId, 'PENDING_APPROVAL');
    await this.store.updateMortality(tx, before.id, { status: 'REJECTED' }, request.decidedBy ?? request.requestedBy);
    await this.audited(tx, 'REJECT', before, { approvalRequestId: request.id, decision: request.status });
  }

  list(actor: Actor | undefined, filters: MortalityFilters, cursor: string | undefined, limit: number): Promise<Page<MortalityRecordView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'liv.mortality.read');
      const scope = await readScopeOf(tx, this.authoriser, this.units, actor!, 'liv.mortality.read');
      const binding = { operationId: 'listMortalityRecords', principalId: actor!.principalId, filters: { ...filters, from: filters.from?.toISOString(), to: filters.to?.toISOString() } };
      const rows = await this.store.listMortality(tx, filters, scope, afterOf(this.cursors, binding, cursor), pageProbe(limit));
      const views: MortalityRecordView[] = [];
      for (const row of rows.slice(0, limit)) views.push(await this.view(tx, row));
      return pageOf(this.cursors, binding, rows, limit, (r) => r.id, views);
    });
  }

  get(actor: Actor | undefined, id: string): Promise<MortalityRecordView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const record = await this.store.mortality(tx, id);
      await this.authoriser.authorise(tx, actor, 'liv.mortality.read', record === null ? {} : { branchId: record.branchId, locationId: record.locationId });
      if (record === null) throw new NotFoundError(`no mortality record ${id}`);
      return this.view(tx, record);
    });
  }

  /** What writing off `head` of the unit carries now: the whole pool of an animal, or of a flock the average share. */
  private valueOf(unit: StockUnitFacts, head: number): Money {
    if (unit.tracking === 'SERIAL') return Money.ofPesewas(unit.poolValuePesewas);
    return issue({ qty: Quantity.parse(unit.poolQty), value: Money.ofPesewas(unit.poolValuePesewas) }, Quantity.ofUnits(BigInt(head))).carried;
  }

  /** The MORTALITY or CULL movement to the branch's virtual LOSS location; the trigger values it from the pool. */
  private async postIn(tx: Transaction, actorId: string, record: MortalityRecord): Promise<string> {
    const loss = await this.refs.virtualLocationIn(tx, record.branchId, 'LOSS');
    if (loss === null) throw new Error(`branch ${record.branchId} has no virtual LOSS location; every branch is created with one (ADR-0042)`);
    const unit = (await this.units.factsIn(tx, [record.stockUnitId], this.clock.now())).get(record.stockUnitId)!;
    const posted = await this.stock.postIn(tx, actorId, {
      movementType: record.kind === 'CULL' ? 'CULL' : 'MORTALITY',
      productId: unit.productId,
      stockUnitId: unit.id,
      branchId: record.branchId,
      fromLocationId: record.locationId,
      toLocationId: loss,
      qty: Quantity.ofUnits(BigInt(record.head)),
      reasonCode: record.reasonCode,
      sourceDocumentId: record.id,
      occurredAt: this.clock.now(),
    });
    return posted.id;
  }

  /** The unit as it stands now, still alive with the head the record loses; refused otherwise. */
  private async liveUnit(tx: Transaction, record: MortalityRecord): Promise<StockUnitFacts> {
    const unit = (await this.units.factsIn(tx, [record.stockUnitId], this.clock.now())).get(record.stockUnitId)!;
    const animal = (await this.store.animals(tx, [unit.id]))[0];
    const alive = unit.status === 'ACTIVE' && (await placesOf(tx, this.units, [unit])).get(unit.id) === record.locationId && (animal === undefined || animal.status === 'ALIVE');
    if (!alive) throw new LivestockRecordInvalidError([{ field: '/stockUnitId', rule: 'ANIMAL_NOT_ALIVE' }]);
    if (BigInt(record.head) > headOf(unit.tracking, unit.poolQty)) throw new LivestockRecordInvalidError([{ field: '/head', rule: 'HEAD_ABOVE_FLOCK' }]);
    return unit;
  }

  /** The photograph as the file store has it: an EVIDENCE file still PENDING its scan or CLEAN; one the scanner rejected is refused. */
  private async usablePhoto(tx: Transaction, fileId: string): Promise<StoredFileRecord> {
    const file = await this.files.find(tx, fileId);
    if (file === null) throw new LivReferenceNotFoundError(['/photoFileId']);
    if (file.purpose !== EVIDENCE || !evidenceVerdict(file.scanStatus).submit) throw new LivestockRecordInvalidError([{ field: '/photoFileId', rule: 'PHOTO_NOT_USABLE' }]);
    return file;
  }

  /** Whether the reporter may post a write-off below the threshold without a second person, where the record stands. */
  private async mayPost(tx: Transaction, actor: Actor, record: MortalityRecord): Promise<boolean> {
    const scopes = await this.authoriser.scopes(tx, actor, POST_PERMISSION);
    return scopes.some((s) => s.branchId === record.branchId && (s.locationId === null || s.locationId === record.locationId));
  }

  /**
   * A photograph whose exact bytes are already on another death or cull record goes to the exception report (abuse
   * case 2). Matched by SHA-256 only: a re-saved, resized or cropped copy has other bytes and is not found (BL-061).
   */
  private async flagReusedPhoto(tx: Transaction, record: MortalityRecord, photo: StoredFileRecord): Promise<void> {
    const earlier = await this.store.mortalityWithPhotoHash(tx, photo.sha256, record.id);
    if (earlier.length === 0) return;
    await this.events.publish<MortalityPhotoReused>(tx, {
      type: 'liv.MortalityPhotoReused',
      subjectType: 'MortalityRecord',
      subjectId: record.id,
      branchId: record.branchId,
      payload: {
        mortalityRecordId: record.id,
        branchId: record.branchId,
        stockUnitId: record.stockUnitId,
        reportedBy: record.reportedBy,
        photoFileId: photo.id,
        photoSha256: photo.sha256.toString('hex'),
        earlierMortalityRecordIds: earlier,
        matchedBy: 'SHA256',
        abuseCases: [ABUSE_CASE_HEALTHY_RECORDED_DEAD],
      },
    });
  }

  /**
   * Sends a waiting record back to its maker because the scanner rejected its photograph (B06r): its approval request
   * is withdrawn with the reason, the record becomes RETURNED, nothing is written off, and `liv.MortalityReturned`
   * tells the maker (B11). The job's step, in its transaction; a record whose photograph is still PENDING or CLEAN
   * is left waiting.
   */
  async returnIfEvidenceRejectedIn(tx: Transaction, system: Pick<Actor, 'principalId'>, record: MortalityRecord): Promise<boolean> {
    const file = await this.files.find(tx, record.photoFileId!);
    const reason = file === null ? null : evidenceVerdict(file.scanStatus).returnReason;
    if (reason === null) return false;
    await this.approvals.withdrawIn(tx, record.approvalRequestId!, `The photograph was refused by the malware scan (${reason})`);
    await this.store.updateMortality(tx, record.id, { status: 'RETURNED', returned_reason: reason }, system.principalId);
    await this.events.publish<MortalityReturned>(tx, {
      type: 'liv.MortalityReturned',
      subjectType: 'MortalityRecord',
      subjectId: record.id,
      branchId: record.branchId,
      payload: {
        mortalityRecordId: record.id,
        branchId: record.branchId,
        stockUnitId: record.stockUnitId,
        reportedBy: record.reportedBy,
        photoFileId: record.photoFileId!,
        reason,
        approvalRequestId: record.approvalRequestId!,
      },
    });
    await this.audited(tx, 'RETURN', record, { returnedReason: reason });
    return true;
  }

  private async reported(tx: Transaction, record: MortalityRecord, value: Money, threshold: Money, approvalRequestId: string | null, approvalKind: MortalityReported['approvalKind']): Promise<void> {
    await this.events.publish<MortalityReported>(tx, {
      type: 'liv.MortalityReported',
      subjectType: 'MortalityRecord',
      subjectId: record.id,
      branchId: record.branchId,
      occurredAt: record.foundAt,
      payload: {
        mortalityRecordId: record.id,
        kind: record.kind,
        stockUnitId: record.stockUnitId,
        branchId: record.branchId,
        locationId: record.locationId,
        head: record.head,
        reasonCode: record.reasonCode,
        reportedBy: record.reportedBy,
        valuePesewas: value.toJsonInteger(),
        thresholdPesewas: threshold.toJsonInteger(),
        needsApproval: approvalRequestId !== null,
        approvalKind,
        approvalRequestId,
        abuseCases: [ABUSE_CASE_HEALTHY_RECORDED_DEAD],
      },
    });
  }

  private async scopeOf(tx: Transaction, id: string): Promise<AuthoriseScope> {
    const record = await this.store.mortality(tx, id);
    return record === null ? {} : { branchId: record.branchId, locationId: record.locationId };
  }

  private async locked(tx: Transaction, id: string, status: MortalityStatus): Promise<MortalityRecord> {
    const record = await this.store.lockMortality(tx, id);
    if (record === null) throw new NotFoundError(`no mortality record ${id}`);
    if (record.status !== status) throw new InvalidStateTransitionError(`mortality record ${id} is ${record.status}`);
    return record;
  }

  private async audited(tx: Transaction, action: string, before: MortalityRecord, extra: Record<string, unknown> = {}): Promise<MortalityRecordView> {
    const beforeView = await this.view(tx, before);
    const after = await this.view(tx, (await this.store.mortality(tx, before.id))!);
    await this.audit.record(tx, { module: 'liv', action, entityType: 'MortalityRecord', entityId: before.id, branchId: before.branchId, before: { ...beforeView }, after: { ...after, ...extra } });
    return after;
  }

  private async view(tx: Transaction, r: MortalityRecord): Promise<MortalityRecordView> {
    const unit = (await this.units.factsIn(tx, [r.stockUnitId], this.clock.now())).get(r.stockUnitId)!;
    const animal = (await this.store.animals(tx, [r.stockUnitId]))[0];
    const location = (await this.refs.locationsIn(tx, [r.locationId])).get(r.locationId);
    const reporter = (await this.principals.refs(tx, [r.reportedBy])).get(r.reportedBy);
    return {
      id: r.id,
      kind: r.kind,
      stockUnit: { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
      animal: animal === undefined ? null : { id: animal.stockUnitId, tagNo: animal.tagNo },
      head: r.head,
      reasonCode: r.reasonCode,
      foundAt: r.foundAt.toISOString(),
      location: location === undefined ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
      reportedBy: reporter ?? UNKNOWN_PRINCIPAL,
      photoFileId: r.photoFileId,
      valuePesewas: Money.ofPesewas(r.valuePesewas).toJsonInteger(),
      currency: 'GHS',
      status: r.status,
      returnedReason: r.returnedReason,
      approvalRequestId: r.approvalRequestId,
      movementId: r.movementId,
      disposalNote: r.disposalNote,
      version: r.version,
    };
  }
}

/** The canonical payload an approval is taken against: what would be written off, and its value now. */
function mortalityHash(record: Pick<MortalityRecord, 'kind' | 'stockUnitId' | 'head' | 'reasonCode' | 'photoFileId' | 'foundAt'>, value: Money): string {
  const payload = [record.kind, record.stockUnitId, record.head, record.reasonCode, record.photoFileId, record.foundAt.toISOString(), value.pesewas.toString()];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * The scheduled evidence returns (B06r; docs/OPERATIONS.md "mortality-evidence-returns", every minute): every death or
 * cull waiting for approval whose photograph the scanner has since rejected goes back to its maker. Rows a concurrent
 * run holds are skipped, so each record is returned once. Runs as a SYSTEM principal only.
 */
export class MortalityEvidenceReturns {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LivestockStore,
    private readonly records: MortalityRecords,
  ) {}

  run(system: Pick<Actor, 'kind' | 'principalId'>): Promise<{ readonly returned: number }> {
    if (system.kind !== 'SYSTEM') throw new Error('the mortality evidence returns run as a SYSTEM principal only');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const returned: string[] = [];
      for (const record of await this.store.lockWaitingWithPhoto(tx, RETURNS_BATCH)) {
        if (await this.records.returnIfEvidenceRejectedIn(tx, system, record)) returned.push(record.id);
      }
      return { returned: returned.length };
    });
  }
}
