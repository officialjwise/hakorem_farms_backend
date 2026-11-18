import { err, ok, type Result } from '@hakorem/kernel';
import type { MethodKind } from './tender';

/** Method kinds a provider clears, the only ones a counter tender names by payment id (FR-POS-006). */
const PROVIDER_KINDS: ReadonlySet<MethodKind> = new Set(['MOBILE_MONEY', 'CARD']);
/** How a provider payment is confirmed: its callback or a lookup of its status, never a cashier's word (abuse case 4). */
const PROVIDER_VERIFIED: ReadonlySet<string> = new Set(['PROVIDER_CALLBACK', 'PROVIDER_LOOKUP']);

/** The payment a counter tender names, as PAY holds it under the payment's lock. */
export interface ClearedPaymentFacts {
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly methodKind: MethodKind;
  readonly paymentMethodId: string;
  readonly verification: 'NOT_REQUIRED' | 'PROVIDER_CALLBACK' | 'PROVIDER_LOOKUP' | 'UNVERIFIED';
  readonly amountPesewas: bigint;
  readonly allocatedPesewas: bigint;
  readonly refundedPesewas: bigint;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly shiftDocumentId: string | null;
  /** The order it was taken for when it was initiated, if any. */
  readonly orderDocumentId: string | null;
  /** Whether a sale has already taken it as a tender (`pay.payment_order_link`). */
  readonly linkedToOrder: boolean;
}

/** The tender as the sale names it: its method, the amount it applies, and the sale's customer, branch and shift. */
export interface ClearedTenderFacts {
  readonly paymentMethodId: string;
  readonly amountPesewas: bigint;
  readonly customerId: string | null;
  readonly branchId: string;
  readonly shiftDocumentId: string;
}

export type ClearedTenderRefusal =
  | 'PAYMENT_UNKNOWN'
  | 'NOT_A_PROVIDER_PAYMENT'
  | 'PAYMENT_NOT_CLEARED'
  | 'METHOD_DIFFERS'
  | 'PAYMENT_ALREADY_USED'
  | 'OTHER_CUSTOMER'
  | 'OTHER_SHIFT'
  | 'AMOUNT_DIFFERS';

/**
 * Whether a sale may take a payment the provider already cleared as one of its tenders (FR-POS-006, ADR-0079). The
 * payment is a mobile money or card payment the provider confirmed (abuse case 4), taken at this sale's till shift
 * (never another shift's), for this sale's customer or for nobody when the sale is a walk-in (never another customer's),
 * not yet taken for any order, allocated or refunded by a single pesewa (allocated once), and the tender is exactly its
 * amount, so it is applied whole and no change is ever given from it. A payment of another branch is answered as unknown,
 * so its identifier tells a cashier nothing.
 */
export function judgeClearedTender(payment: ClearedPaymentFacts | null, tender: ClearedTenderFacts): Result<null, ClearedTenderRefusal[]> {
  if (payment === null || payment.branchId !== tender.branchId) return err(['PAYMENT_UNKNOWN']);
  if (!PROVIDER_KINDS.has(payment.methodKind)) return err(['NOT_A_PROVIDER_PAYMENT']);
  const refusals: ClearedTenderRefusal[] = [];
  if (payment.status !== 'CLEARED' || !PROVIDER_VERIFIED.has(payment.verification)) refusals.push('PAYMENT_NOT_CLEARED');
  if (payment.paymentMethodId !== tender.paymentMethodId) refusals.push('METHOD_DIFFERS');
  if (payment.linkedToOrder || payment.orderDocumentId !== null || payment.allocatedPesewas !== 0n || payment.refundedPesewas !== 0n) refusals.push('PAYMENT_ALREADY_USED');
  if (payment.customerId !== tender.customerId) refusals.push('OTHER_CUSTOMER');
  if (payment.shiftDocumentId !== tender.shiftDocumentId) refusals.push('OTHER_SHIFT');
  if (payment.amountPesewas !== tender.amountPesewas) refusals.push('AMOUNT_DIFFERS');
  return refusals.length === 0 ? ok(null) : err(refusals);
}
