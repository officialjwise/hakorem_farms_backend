import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';

/** Why a credit order is refused (CR-046): the account is on hold, the order takes it over its limit, or it is past its terms. */
export type CreditRefusalReason = 'ON_HOLD' | 'OVER_LIMIT' | 'PAST_TERMS';

/** The order as a credit policy judges it. */
export interface CreditOrder {
  readonly id: string;
  readonly orderNo: string | null;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly estimatedTotalPesewas: bigint;
}

/** A policy's judgement of a credit order, worked out in the caller's transaction. */
export interface CreditPolicyAnswer {
  /** PASSED within the limit and terms; OVERRIDDEN refused but covered by an approved override; REFUSED otherwise. */
  readonly verdict: 'PASSED' | 'OVERRIDDEN' | 'REFUSED';
  /** Every reason that holds, the hold first, then the limit, then the terms; empty when it passes on its own. */
  readonly reasons: readonly CreditRefusalReason[];
  readonly customerName: string;
  readonly limitPesewas: bigint;
  readonly exposurePesewas: bigint;
  readonly overLimitPesewas: bigint;
  readonly overduePesewas: bigint;
  readonly oldestOverdueDays: number | null;
  /** True while an override asked for this order waits for its approver. */
  readonly overridePending: boolean;
}

/** The 202 a credit override answers: the approval and the figures it was asked on. */
export interface CreditOverridePending {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
  readonly creditCheck: unknown;
}

/**
 * The `OrderConfirmationPolicy` port (MODULE_BOUNDARIES section 6): ORD asks the registered policies whether a credit
 * order may be confirmed, and WHL answers for its credit limit, terms and account hold (B10 continued). The first policy
 * that answers decides; with none answering a credit order is refused (A-224), never waved through.
 */
export interface OrderConfirmationPolicy {
  /** The judgement of a credit order, or null when this policy has nothing to say about its customer. */
  creditFor(tx: Transaction, order: CreditOrder): Promise<CreditPolicyAnswer | null>;
  /**
   * Asks for a credit override of a refused order with the asker's written reason (CR-046), in the caller's transaction:
   * an approval by someone other than the asker. Called only after `creditFor` answered REFUSED with none pending.
   */
  requestOverrideIn(tx: Transaction, actor: Actor, order: CreditOrder, reason: string): Promise<CreditOverridePending>;
  /**
   * The judgement of an order on account at its dispatch or hand-over (B11 continued 8), `order.estimatedTotalPesewas`
   * being the gross of the document on what is sent, or null when this policy has nothing to say about its customer.
   * `documentId` is that document, issued in the caller's transaction just before: it is the order judged, never counted
   * again among the customer's open items. An approved override covers it when the gross is no more than the amount it
   * was approved for. `requestOverrideIn` with the same amount asks for a new one.
   */
  creditAtDispatchFor(tx: Transaction, order: CreditOrder, documentId: string | null): Promise<CreditPolicyAnswer | null>;
  /**
   * The due date (`YYYY-MM-DD`) of an invoice issued today to the customer on account: the business date plus the
   * customer's payment terms (B11 continued 8), or null when this policy keeps no open account for them.
   */
  dueDateFor(tx: Transaction, customerId: string): Promise<string | null>;
}

export const ORDER_CONFIRMATION_POLICIES = Symbol('ORDER_CONFIRMATION_POLICIES');
