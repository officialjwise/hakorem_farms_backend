import { createHash } from 'node:crypto';
import { formatCedis, Money, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { translate } from '../../../platform/i18n/messages';
import type { ApprovalHandler, ApprovalListing, ApprovalRecord, Approvals, Authoriser } from '../../iam';
import { judgePriceApprover, overridePayload, PRICE_OVERRIDE_KIND, type OverrideApproval, type OverrideLine } from '../domain/price-override';
import type { PriceOverrideApproved, PriceOverrideRequested } from '../events';
import { PriceApproverIsSellerError } from './errors';
import type { ApprovalPendingView } from './order-reversals';
import type { OrderLineRecord, OrderRecord, OrderStore } from './order-store';

export { PRICE_OVERRIDE_KIND };
export const PRICE_OVERRIDE_REQUESTED = 'ord.PriceOverrideRequested';
export const PRICE_OVERRIDE_APPROVED = 'ord.PriceOverrideApproved';
const ABUSE_CASES = [3] as const;

/** A line whose agreed price waits for the approval, with why (A-230). */
export interface FlaggedLine extends OverrideLine {
  readonly approval: Exclude<OverrideApproval, null>;
}

/** What an override is asked for: the order entered, or the sale the sale posting is asked to post. */
export interface OverrideSubject {
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly branchId: string;
  readonly customerId: string | null;
  readonly salespersonId: string;
  readonly lines: readonly FlaggedLine[];
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();

/** The hex SHA-256 an override approval binds (IAM compares it at request and at decision, ADR-0017). */
export function overrideHash(subjectId: string, customerId: string | null, lines: readonly OverrideLine[]): string {
  return createHash('sha256').update(canonicalJson(overridePayload(subjectId, customerId, lines)), 'utf8').digest('hex');
}

/**
 * Price overrides (FR-ORD-003, ADR-0017, abuse case 3, A-230): the one approval of a price outside the band, or below
 * list beyond the seller's per-line limit, for createOrder and the sale posting alike. The seller's limit is the largest
 * `PRICE_OVERRIDE_PER_LINE` of the roles they hold at the branch (none set is 0: every price below list waits). The
 * approval is IAM's `PRICE_OVERRIDE` (threshold 0, step-up), its subject the order, its payload every flagged line's
 * pricing record; it is decided by a holder of `ord.price_override.approve` who is neither the person who asked (IAM),
 * the order's salesperson nor the person who wrote it (here, and `ck_sales_order_settled_lines`). Approved, an order's
 * flagged lines name their approver; a sale not yet posted is posted by its asker with the approval named (SalePosting).
 */
export class PriceOverrides {
  constructor(
    private readonly store: OrderStore,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly events: DomainEvents,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {}

  /** The seller's per-line limit at the branch: what a line may take off list with its reason alone. */
  lineLimitIn(tx: Transaction, actor: Actor, branchId: string): Promise<bigint> {
    return this.authoriser.limitIn(tx, actor, 'PRICE_OVERRIDE_PER_LINE', branchId);
  }

  /** Every override approval asked for on the subject, oldest first. */
  ofSubjectIn(tx: Transaction, subjectId: string): Promise<ApprovalListing[]> {
    return this.approvals.ofSubjectIn(tx, subjectId, PRICE_OVERRIDE_KIND);
  }

  /** Asks for the approval in the caller's transaction and publishes `ord.PriceOverrideRequested` (abuse case 3). */
  async requestIn(tx: Transaction, actor: Actor, subject: OverrideSubject): Promise<ApprovalRecord> {
    const variance = Money.sum(subject.lines.map((l) => Money.ofPesewas(l.variancePesewas)));
    const count = subject.lines.length;
    const summary = `Price override on ${subject.orderNo ?? 'a counter sale'}: ${count} line${count === 1 ? '' : 's'}, ${formatCedis(variance.pesewas)} from list (${subject.lines.map((l) => l.approval).join(', ')})`;
    const approval = await this.approvals.request(tx, actor, {
      kind: PRICE_OVERRIDE_KIND,
      branchId: subject.branchId,
      subjectDocumentId: subject.orderId,
      payloadHash: overrideHash(subject.orderId, subject.customerId, subject.lines),
      amountPesewas: variance.pesewas,
      summary,
    });
    const requested: PriceOverrideRequested = {
      orderId: subject.orderId,
      orderNo: subject.orderNo,
      branchId: subject.branchId,
      approvalRequestId: approval.id,
      requestedBy: actor.principalId,
      salespersonId: subject.salespersonId,
      variancePesewas: variance.toJsonInteger(),
      lines: subject.lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, agreedUnitPricePesewas: json(l.agreedUnitPricePesewas), resolvedUnitPricePesewas: json(l.resolvedUnitPricePesewas), reason: l.approval })),
      requestedAt: approval.requestedAt.toISOString(),
      abuseCases: ABUSE_CASES,
    };
    await this.events.publish(tx, { type: PRICE_OVERRIDE_REQUESTED, subjectType: 'SalesOrder', subjectId: subject.orderId, branchId: subject.branchId, payload: requested, occurredAt: approval.requestedAt });
    return approval;
  }

  /** The 202 the contract answers while the override waits. */
  pendingView(approval: { readonly id: string; readonly summary: string; readonly requestedAt: Date }, subject: { readonly id: string; readonly number: string | null }): ApprovalPendingView {
    return {
      status: 'PENDING_APPROVAL',
      approvalRequestId: approval.id,
      kind: PRICE_OVERRIDE_KIND,
      subject: { id: subject.id, docType: 'SALES_ORDER', number: subject.number },
      summary: approval.summary,
      requestedAt: approval.requestedAt.toISOString(),
    };
  }

  /**
   * The flagged lines of an order not yet approved, each named with `APPROVAL_PENDING` or `APPROVAL_REJECTED` (a
   * rejected, withdrawn or lapsed request): what a confirmation or a proforma refuses with 422
   * PRICE_OVERRIDE_NEEDS_APPROVAL.
   */
  async unapprovedIn(tx: Transaction, order: OrderRecord): Promise<{ readonly field: string; readonly reason: string }[]> {
    const waiting = order.lines.filter((l) => l.varianceRequiresApproval && l.varianceApprovedBy === null && l.lineStatus !== 'CANCELLED');
    if (waiting.length === 0) return [];
    const asked = new Map((await this.ofSubjectIn(tx, order.id)).map((a) => [a.id, a] as const));
    return waiting.map((l: OrderLineRecord) => ({
      field: `/lines/${l.lineNo}/agreedUnitPricePesewas`,
      reason: l.varianceApprovalRequestId !== null && asked.get(l.varianceApprovalRequestId)?.status === 'PENDING' ? 'APPROVAL_PENDING' : 'APPROVAL_REJECTED',
    }));
  }

  /** A cancelled order's override can no longer be decided: its pending request is withdrawn in the same transaction. */
  async withdrawIn(tx: Transaction, orderId: string): Promise<void> {
    for (const a of await this.ofSubjectIn(tx, orderId)) {
      if (a.status === 'PENDING') await this.approvals.withdrawIn(tx, a.id, 'The order was cancelled before its price override was decided');
    }
  }

  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const [order] = await this.store.orders(tx, [subjectDocumentId]);
      if (order !== undefined) return overrideHash(order.id, order.customerId, order.lines);
      // A sale the sale posting has not written yet: nothing of it is stored to change; the posting compares the sale
      // it is asked to post with this hash before it names the approval.
      const pending = (await this.ofSubjectIn(tx, subjectDocumentId)).find((a) => a.status === 'PENDING');
      if (pending === undefined) throw new NotFoundError('no such sale waiting for a price override');
      return pending.payloadHash;
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const approver = request.decidedBy!;
      const at = this.clock.now();
      const [order] = await this.store.orders(tx, [request.subjectDocumentId]);
      const parties =
        order === undefined
          ? { requestedBy: request.requestedBy, salespersonId: request.requestedBy, postedBy: request.requestedBy }
          : { requestedBy: request.requestedBy, salespersonId: order.salespersonId, postedBy: order.createdBy };
      if (!judgePriceApprover(approver, parties).ok) throw new PriceApproverIsSellerError('the seller of this price cannot approve it');
      if (order !== undefined) {
        if (order.status !== 'PLACED') {
          throw new InvalidStateTransitionError(`order ${order.id} is ${order.status}`, [{ field: null, code: order.status, message: translate('error.invalid_state_transition') }]);
        }
        await this.store.approveVariances(tx, order.id, { approvalRequestId: request.id, approvedBy: approver, at });
        await this.audit.record(tx, {
          module: 'ord',
          action: 'APPROVE_PRICE_OVERRIDE',
          entityType: 'SalesOrder',
          entityId: order.id,
          branchId: order.branchId,
          before: { approvedBy: null },
          after: { approvalRequestId: request.id, approvedBy: approver, lines: order.lines.filter((l) => l.varianceApprovalRequestId === request.id).map((l) => l.lineNo) },
        });
      }
      const approved: PriceOverrideApproved = {
        orderId: request.subjectDocumentId,
        branchId: request.branchId,
        approvalRequestId: request.id,
        requestedBy: request.requestedBy,
        approvedBy: approver,
        variancePesewas: json(request.amountPesewas ?? 0n),
        approvedAt: at.toISOString(),
        abuseCases: ABUSE_CASES,
      };
      await this.events.publish(tx, { type: PRICE_OVERRIDE_APPROVED, subjectType: 'SalesOrder', subjectId: request.subjectDocumentId, branchId: request.branchId, payload: approved, occurredAt: at });
    },
  };
}
