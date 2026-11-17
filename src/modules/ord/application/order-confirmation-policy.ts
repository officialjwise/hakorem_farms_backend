import type { Transaction } from '../../../platform/database/unit-of-work';
import type { CreditAnswer } from '../domain/confirmation';

/**
 * The `OrderConfirmationPolicy` port (MODULE_BOUNDARIES section 6): ORD asks the registered policies whether a credit
 * order may be confirmed, and WHL answers for its credit limit and account hold (B10). The first policy that answers
 * decides; with none registered a credit order is refused (A-224), never waved through.
 */
export interface OrderConfirmationPolicy {
  /** PASSED or REFUSED for the order, or null when this policy has nothing to say about its customer. */
  creditFor(tx: Transaction, order: { readonly id: string; readonly customerId: string | null; readonly branchId: string; readonly estimatedTotalPesewas: bigint }): Promise<CreditAnswer>;
}

export const ORDER_CONFIRMATION_POLICIES = Symbol('ORDER_CONFIRMATION_POLICIES');
