import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { cancelApproval, decideApproval, type ApprovalRefusal, type ApprovalStatus } from '../domain/approval';
import type { Authoriser } from './authoriser';
import { ApprovalAlreadyDecidedError, ApprovalExpiredError, ApprovalNotRequesterError, ApprovalSubjectChangedError, MakerCannotCheckError } from './errors';

/** What the owning module of an approval kind provides (MODULE_BOUNDARIES section 6, "Approval handlers"). */
export interface ApprovalHandler {
  /** Hex SHA-256 of the subject's canonical payload as it is now; it must equal the hash taken at request time. */
  currentPayloadHash(tx: Transaction, subjectDocumentId: string): Promise<string>;
  /** Applies the approved action, in the same transaction as the approval. */
  onApproved(tx: Transaction, request: ApprovalRecord): Promise<void>;
  /** Optional: undoes a pending effect when a request is rejected or cancelled. */
  onRejected?(tx: Transaction, request: ApprovalRecord): Promise<void>;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly kind: string;
  readonly branchId: string;
  readonly subjectDocumentId: string;
  readonly payloadHash: string;
  readonly amountPesewas: bigint | null;
  readonly summary: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly status: ApprovalStatus;
  readonly decidedBy: string | null;
  readonly expiresAt: Date | null;
  /** A photograph or document the maker attached, in the platform file store (B04e continued 2). */
  readonly evidenceFileId: string | null;
  readonly version: number;
}

export interface NewApproval {
  readonly kind: string;
  readonly branchId: string;
  readonly subjectDocumentId: string;
  readonly payloadHash: string;
  readonly amountPesewas?: bigint | null;
  readonly summary: string;
  readonly expiresAt?: Date | null;
  /** A file the maker uploaded as evidence (`platform.file.upload`, purpose EVIDENCE); the database checks it exists. */
  readonly evidenceFileId?: string | null;
}

/** A request as the inbox shows it (B04e continued). */
export interface ApprovalListing extends ApprovalRecord {
  readonly requestedByName: string;
  readonly decidedByName: string | null;
  readonly decidedAt: Date | null;
  readonly decisionReason: string | null;
}

export interface ApprovalFilter {
  readonly viewerId: string;
  readonly status: ApprovalStatus | null;
  readonly kind: string | null;
  readonly decidableByMe: boolean;
  readonly requestedByMe: boolean;
  /** Newest first: only ids below this one. */
  readonly beforeId: string | null;
  readonly limit: number;
  readonly now: Date;
}

/** What a kind's policy asks of the checker at a branch. */
export interface ApproverRule {
  readonly permission: string;
  readonly requiresStepUp: boolean;
  /** At or above this amount the kind needs approval; null means always. */
  readonly thresholdPesewas: bigint | null;
}

/** Whether an action of a kind and amount needs a second person, and the threshold it was judged against. */
export interface ApprovalJudgement {
  readonly required: boolean;
  readonly thresholdPesewas: bigint;
}

/** IAM's approval tables. */
export interface ApprovalStore {
  insert(tx: Transaction, record: ApprovalRecord): Promise<void>;
  byIdForUpdate(tx: Transaction, id: string): Promise<ApprovalRecord | null>;
  decide(tx: Transaction, id: string, status: ApprovalStatus, decidedBy: string | null, reason: string | null, now: Date): Promise<void>;
  /** What the checker must hold for this kind at this branch (`iam.approval_policy`), or null if no policy names it. */
  approverRule(tx: Transaction, kind: string, branchId: string): Promise<ApproverRule | null>;
  /**
   * The requests the viewer may see: at a branch where a branch-wide grant gives them `iam.approval.read`. Newest
   * first. `decidableByMe` keeps the pending, unlapsed requests of others that a current grant of the viewer's lets
   * them decide (the policy's permission at the request's branch).
   */
  list(tx: Transaction, filter: ApprovalFilter): Promise<ApprovalListing[]>;
  listing(tx: Transaction, id: string): Promise<ApprovalListing | null>;
  /** The ids among `ids` that the viewer could decide now, by the same rule as `decidableByMe`. */
  decidableBy(tx: Transaction, viewerId: string, ids: readonly string[], now: Date): Promise<Set<string>>;
}

export const APPROVAL_STORE = Symbol('APPROVAL_STORE');

const REFUSALS: Readonly<Record<ApprovalRefusal, (message: string) => Error>> = {
  MAKER_CANNOT_CHECK: (m) => new MakerCannotCheckError(m),
  APPROVAL_ALREADY_DECIDED: (m) => new ApprovalAlreadyDecidedError(m),
  APPROVAL_EXPIRED: (m) => new ApprovalExpiredError(m),
  APPROVAL_SUBJECT_CHANGED: (m) => new ApprovalSubjectChangedError(m),
};

/**
 * One maker-checker mechanism for every module (ADR-0017). A module asks for approval inside its own transaction
 * and gets a request id (the 202 `ApprovalPending`); a different person with the policy's approver permission decides;
 * on approval the module's handler runs in the same transaction, so approval and effect commit together. The maker
 * cannot be the checker: the domain refuses it, and so does the database.
 */
export class Approvals {
  private readonly handlers = new Map<string, ApprovalHandler>();
  private readonly nextId: () => string;

  constructor(
    private readonly store: ApprovalStore,
    private readonly authoriser: Authoriser,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  registerHandler(kind: string, handler: ApprovalHandler): void {
    if (this.handlers.has(kind)) {
      throw new Error(`approval kind ${kind} already has a handler`);
    }
    this.handlers.set(kind, handler);
  }

  /**
   * Judges an amount against the kind's policy at the branch (`iam.approval_policy`, the branch's own row before the
   * default): at or above the threshold it needs approval; a policy with no threshold always does. The owning module
   * keeps the threshold it was judged against on its document, so the database can hold the rule on its own row.
   */
  async judgeIn(tx: Transaction, kind: string, branchId: string, amountPesewas: bigint): Promise<ApprovalJudgement> {
    const rule = await this.store.approverRule(tx, kind, branchId);
    if (rule === null) {
      throw new Error(`approval kind ${kind} has no policy at branch ${branchId}`);
    }
    const thresholdPesewas = rule.thresholdPesewas ?? 0n;
    return { required: amountPesewas >= thresholdPesewas, thresholdPesewas };
  }

  async request(tx: Transaction, actor: Actor | undefined, request: NewApproval): Promise<ApprovalRecord> {
    if (actor === undefined) {
      throw new UnauthenticatedError('an approval request needs an actor');
    }
    if (!this.handlers.has(request.kind)) {
      throw new Error(`approval kind ${request.kind} has no registered handler`);
    }
    const record: ApprovalRecord = {
      id: this.nextId(),
      kind: request.kind,
      branchId: request.branchId,
      subjectDocumentId: request.subjectDocumentId,
      payloadHash: request.payloadHash,
      amountPesewas: request.amountPesewas ?? null,
      summary: request.summary,
      requestedBy: actor.principalId,
      requestedAt: this.clock.now(),
      status: 'PENDING',
      decidedBy: null,
      expiresAt: request.expiresAt ?? null,
      evidenceFileId: request.evidenceFileId ?? null,
      version: 1,
    };
    await this.store.insert(tx, record);
    await this.audit.record(tx, {
      module: 'iam',
      action: 'APPROVAL_REQUESTED',
      entityType: 'ApprovalRequest',
      entityId: record.id,
      branchId: record.branchId,
      after: { kind: record.kind, subjectDocumentId: record.subjectDocumentId, summary: record.summary, amountPesewas: record.amountPesewas, evidenceFileId: record.evidenceFileId },
    });
    return record;
  }

  async decide(tx: Transaction, actor: Actor | undefined, id: string, decision: 'APPROVED' | 'REJECTED', reason: string | null): Promise<ApprovalRecord> {
    if (actor === undefined) {
      throw new UnauthenticatedError('a decision needs an actor');
    }
    const request = await this.store.byIdForUpdate(tx, id);
    if (request === null) {
      throw new NotFoundError('no such approval request');
    }
    const rule = await this.store.approverRule(tx, request.kind, request.branchId);
    if (rule === null) {
      throw new Error(`approval kind ${request.kind} has no policy naming the approver's permission`);
    }
    await this.authoriser.authorise(tx, actor, rule.permission, { branchId: request.branchId, stepUp: rule.requiresStepUp });
    const handler = this.handlers.get(request.kind);
    if (handler === undefined) {
      throw new Error(`approval kind ${request.kind} has no registered handler`);
    }
    const now = this.clock.now();
    const verdict = decideApproval(request, {
      decidedBy: actor.principalId,
      decision,
      currentPayloadHash: await handler.currentPayloadHash(tx, request.subjectDocumentId),
      now,
    });
    if (!verdict.ok) {
      throw REFUSALS[verdict.code](`approval ${id}: ${verdict.code}`);
    }
    await this.store.decide(tx, id, decision, actor.principalId, reason, now);
    const decided: ApprovalRecord = { ...request, status: decision, decidedBy: actor.principalId, version: request.version + 1 };
    if (decision === 'APPROVED') {
      await handler.onApproved(tx, decided);
    } else {
      await handler.onRejected?.(tx, decided);
    }
    await this.audit.record(tx, {
      module: 'iam',
      action: 'APPROVAL',
      entityType: 'ApprovalRequest',
      entityId: id,
      branchId: request.branchId,
      before: { status: request.status },
      after: { status: decision, reason },
      metadata: { kind: request.kind, requestedBy: request.requestedBy, subjectDocumentId: request.subjectDocumentId },
    });
    await this.events.publish(tx, {
      type: 'iam.ApprovalDecided',
      subjectType: 'ApprovalRequest',
      subjectId: id,
      branchId: request.branchId,
      payload: { kind: request.kind, decision, requestedBy: request.requestedBy, decidedBy: actor.principalId, subjectDocumentId: request.subjectDocumentId },
    });
    return decided;
  }

  /**
   * The maker withdraws their own pending request (A-122). The owning module's `onRejected` undoes any pending
   * effect in the same transaction, as for a rejection. Nobody else may withdraw it.
   */
  async cancel(tx: Transaction, actor: Actor | undefined, id: string, reason: string): Promise<ApprovalRecord> {
    if (actor === undefined) {
      throw new UnauthenticatedError('a withdrawal needs an actor');
    }
    const request = await this.store.byIdForUpdate(tx, id);
    if (request === null) {
      throw new NotFoundError('no such approval request');
    }
    const verdict = cancelApproval(request, actor.principalId, this.clock.now());
    if (!verdict.ok) {
      if (verdict.code === 'NOT_REQUESTER') {
        await this.audit.recordDetached({
          module: 'iam',
          action: 'AUTHORISATION_FAILURE',
          entityType: 'ApprovalRequest',
          entityId: id,
          branchId: request.branchId,
          metadata: { permission: 'iam.approval.cancel.own', reason: 'NOT_OWNER', ownerPrincipalId: request.requestedBy },
        });
        throw new ApprovalNotRequesterError(`approval ${id} was requested by someone else`);
      }
      throw REFUSALS[verdict.code](`approval ${id}: ${verdict.code}`);
    }
    await this.store.decide(tx, id, 'CANCELLED', null, reason, this.clock.now());
    const cancelled: ApprovalRecord = { ...request, status: 'CANCELLED', version: request.version + 1 };
    await this.handlers.get(request.kind)?.onRejected?.(tx, cancelled);
    await this.audit.record(tx, {
      module: 'iam',
      action: 'APPROVAL_CANCELLED',
      entityType: 'ApprovalRequest',
      entityId: id,
      branchId: request.branchId,
      before: { status: request.status },
      after: { status: 'CANCELLED', reason },
      metadata: { kind: request.kind, subjectDocumentId: request.subjectDocumentId },
    });
    return cancelled;
  }
}
