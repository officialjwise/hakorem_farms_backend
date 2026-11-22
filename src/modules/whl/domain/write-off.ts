import type { Money } from '@hakorem/kernel';

/** The billing document a write-off is asked against, as BIL answers it. */
export interface WriteOffTarget {
  readonly kind: string;
  readonly status: string;
  readonly customerId: string | null;
  /** What it has outstanding now: gross less credited, paid and already written off. */
  readonly outstanding: Money;
}

export interface WriteOffRule {
  readonly field: string;
  readonly rule: string;
}

const OPEN_ITEM_KINDS = new Set(['INVOICE', 'RECEIPT', 'DEBIT_NOTE']);

/**
 * Whether an amount may be written off a document (FR-WHL-012, A-321): only an issued invoice, receipt or debit note of
 * a named customer, more than nothing and never more than it has outstanding, to the pesewa. The database holds the cap
 * again when the write-off is applied (`bil.apply_write_off`).
 */
export function judgeWriteOff(target: WriteOffTarget, amount: Money): WriteOffRule[] {
  if (!OPEN_ITEM_KINDS.has(target.kind) || target.status !== 'ISSUED') return [{ field: '/billingDocumentId', rule: 'NOT_AN_OPEN_ITEM' }];
  if (target.customerId === null) return [{ field: '/billingDocumentId', rule: 'NO_CUSTOMER' }];
  if (target.outstanding.isZero()) return [{ field: '/billingDocumentId', rule: 'NOTHING_OUTSTANDING' }];
  if (amount.isZero()) return [{ field: '/amountPesewas', rule: 'NOT_POSITIVE' }];
  if (amount.compareTo(target.outstanding) > 0) return [{ field: '/amountPesewas', rule: 'MORE_THAN_OUTSTANDING' }];
  return [];
}
