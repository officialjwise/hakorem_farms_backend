import type { Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { shownStatus, type ApprovalStatus } from '../domain/approval';
import type { Page } from './access-admin';
import type { ApprovalListing, ApprovalStore, Approvals } from './approvals';
import { pesewasJson } from './role-view';
import type { Authoriser } from './authoriser';

/** The contract's `ApprovalRequest`. */
export interface ApprovalRequestView {
  readonly id: string;
  readonly kind: string;
  readonly status: ApprovalStatus;
  readonly branchId: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly amountPesewas: number | null;
  readonly currency: 'GHS';
  readonly evidenceFileId: string | null;
  readonly requestedBy: { readonly id: string; readonly displayName: string };
  readonly requestedAt: string;
  readonly decidedBy: { readonly id: string; readonly displayName: string } | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly expiresAt: string | null;
  readonly canDecide: boolean;
}

export interface ApprovalListFilter {
  readonly status?: ApprovalStatus | undefined;
  readonly kind?: string | undefined;
  readonly decidableByMe?: boolean | undefined;
  readonly requestedByMe?: boolean | undefined;
}

const READ = 'iam.approval.read';
const CANCEL = 'iam.approval.cancel.own';

/**
 * The approval endpoints over the one maker-checker mechanism (FR-IAM-012, ADR-0017, A-122). Reading needs
 * `iam.approval.read` at the request's branch; deciding also needs the permission the kind's policy names there
 * (and a step-up when the policy asks), which `Approvals.decide` checks with the maker-checker rule and the payload
 * hash, running the owning module's handler in the same transaction. Only the maker withdraws a request.
 */
export class ApprovalInbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly approvals: Approvals,
    private readonly store: ApprovalStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly cursors: Cursors,
    private readonly documents: DocumentRegistry,
    private readonly clock: Clock,
  ) {}

  listApprovals(actor: Actor | undefined, filter: ApprovalListFilter, cursor: string | undefined, limit: number): Promise<Page<ApprovalRequestView>> {
    const filters = {
      status: filter.status ?? null,
      kind: filter.kind ?? null,
      decidableByMe: filter.decidableByMe ?? false,
      requestedByMe: filter.requestedByMe ?? false,
    };
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listApprovals', principalId: actor!.principalId, filters };
      const beforeId = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await this.store.list(tx, { viewerId: actor!.principalId, ...filters, beforeId, limit: limit + 1, now: this.clock.now() });
      const hasMore = found.length > limit;
      const data = await this.views(tx, actor!, found.slice(0, limit));
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  getApproval(actor: Actor | undefined, id: string): Promise<ApprovalRequestView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const found = await this.store.listing(tx, id);
      if (found === null) throw new NotFoundError(`no approval request ${id}`);
      await this.authoriser.authorise(tx, actor, READ, { branchId: found.branchId });
      return (await this.views(tx, actor!, [found]))[0]!;
    });
  }

  approveRequest(actor: Actor | undefined, id: string, reason: string | undefined, idempotencyKey: string): Promise<StoredResponse<ApprovalRequestView>> {
    return this.write(actor, READ, 'approveRequest', { id, reason: reason ?? null }, idempotencyKey, id, (tx) => this.approvals.decide(tx, actor, id, 'APPROVED', reason ?? null));
  }

  rejectRequest(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<ApprovalRequestView>> {
    return this.write(actor, READ, 'rejectRequest', { id, reason }, idempotencyKey, id, (tx) => this.approvals.decide(tx, actor, id, 'REJECTED', reason));
  }

  cancelApprovalRequest(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<ApprovalRequestView>> {
    return this.write(actor, CANCEL, 'cancelApprovalRequest', { id, reason }, idempotencyKey, id, (tx) => this.approvals.cancel(tx, actor, id, reason));
  }

  private write(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    id: string,
    work: (tx: Transaction) => Promise<unknown>,
  ): Promise<StoredResponse<ApprovalRequestView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      // Deny by default before anything is read: no inbox permission, no decision and no withdrawal.
      await this.authoriser.authorise(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<ApprovalRequestView>;
      await work(tx);
      const response = { status: 200, body: (await this.views(tx, actor!, [(await this.store.listing(tx, id))!]))[0]! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async views(tx: Transaction, actor: Actor, rows: readonly ApprovalListing[]): Promise<ApprovalRequestView[]> {
    const now = this.clock.now();
    const documents = await this.documents.refs(tx, [...new Set(rows.map((row) => row.subjectDocumentId))]);
    const decidable = await this.store.decidableBy(tx, actor.principalId, rows.map((row) => row.id), now);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: shownStatus(row, now),
      branchId: row.branchId,
      subject: documents.get(row.subjectDocumentId) ?? { id: row.subjectDocumentId, docType: 'UNKNOWN', number: null },
      summary: row.summary,
      amountPesewas: pesewasJson(row.amountPesewas),
      currency: 'GHS',
      evidenceFileId: row.evidenceFileId,
      requestedBy: { id: row.requestedBy, displayName: row.requestedByName },
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: row.decidedBy === null ? null : { id: row.decidedBy, displayName: row.decidedByName ?? '' },
      decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
      decisionReason: row.decisionReason,
      expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
      canDecide: decidable.has(row.id),
    }));
  }
}
