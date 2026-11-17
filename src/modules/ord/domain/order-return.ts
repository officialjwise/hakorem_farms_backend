import { err, ok, type Money, type Quantity, type Result } from '@hakorem/kernel';
import type { OrderStatus } from './order';

/** A line of the original sale as a return reads it: what was sold and what returns not rejected already hold. */
export interface SoldLine {
  readonly id: string;
  readonly priceBasis: 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';
  /** One named animal: it comes back whole or not at all. */
  readonly serial: boolean;
  readonly qtySold: Quantity;
  readonly qtyReturned: Quantity;
}

export interface ReturnFacts {
  readonly orderStatus: OrderStatus;
  readonly kind: 'RETURN' | 'EXCHANGE';
  readonly sold: readonly SoldLine[];
  readonly asked: readonly { readonly orderLineId: string; readonly qty: Quantity }[];
}

export interface ReturnRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * Whether a return may be taken against the original sale (FR-ORD-015, abuse case 12, A-228): a COMPLETED sale only
 * (a voided or cancelled order is not a sale), kind RETURN (an exchange needs the counter's replacement sale, B9b), and
 * on each line no more than was sold less what returns not rejected already hold. A named animal comes back whole; a
 * line sold by weight waits for catch weight's re-pricing (B11). The database holds the quantity rule too
 * (`ck_order_return_line_cap`); this names every broken rule at once, before anything is written.
 */
export function judgeReturn(f: ReturnFacts): Result<null, ReturnRule[]> {
  if (f.orderStatus !== 'COMPLETED') return err([{ field: '', rule: 'INVALID_STATE_TRANSITION' }]);
  const broken: ReturnRule[] = [];
  if (f.kind === 'EXCHANGE') broken.push({ field: '/kind', rule: 'EXCHANGE_NOT_AVAILABLE' });
  if (f.asked.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
  const byId = new Map(f.sold.map((l) => [l.id, l] as const));
  const seen = new Set<string>();
  f.asked.forEach((asked, i) => {
    const line = byId.get(asked.orderLineId);
    if (line === undefined) return void broken.push({ field: `/lines/${i}/orderLineId`, rule: 'LINE_NOT_ON_ORDER' });
    if (seen.has(line.id)) return void broken.push({ field: `/lines/${i}/orderLineId`, rule: 'LINE_REPEATED' });
    seen.add(line.id);
    if (line.priceBasis === 'PER_KG') return void broken.push({ field: `/lines/${i}/orderLineId`, rule: 'WEIGHED_LINE_NOT_RETURNABLE' });
    if (asked.qty.isZero() || asked.qty.isNegative()) return void broken.push({ field: `/lines/${i}/qty`, rule: 'QUANTITY_NOT_POSITIVE' });
    if (line.serial && asked.qty.compareTo(line.qtySold) !== 0) return void broken.push({ field: `/lines/${i}/qty`, rule: 'SERIAL_RETURNS_WHOLE' });
    if (line.qtyReturned.plus(asked.qty).compareTo(line.qtySold) > 0) broken.push({ field: `/lines/${i}/qty`, rule: 'RETURN_EXCEEDS_SOLD' });
  });
  return broken.length === 0 ? ok(null) : err(broken);
}

/**
 * The person who approves a return is never the person who made it (ADR-0066): IAM already refuses the person who asked
 * for the approval, and the return is submitted only by its maker, who is also the credit note's and the refund's maker.
 */
export function judgeReturnApprover(approverId: string, r: { readonly makerId: string }): Result<null, 'MAKER_CANNOT_CHECK'> {
  return approverId === r.makerId ? err('MAKER_CANNOT_CHECK') : ok(null);
}

/** A payment of the sale as the refund reads it: PAY's `PaymentView` figures. */
export interface SalePayment {
  readonly id: string;
  readonly status: 'PENDING' | 'CLEARED' | 'FAILED' | 'REVERSED';
  readonly allocatedPesewas: number;
}

/**
 * The refund a completed return asks for (ADR-0066): the credit note's amount, never more than the original now owes
 * the customer back (an unpaid document is credited and owes nothing), against the cleared payment that paid the most
 * of the sale (the first taken on a tie). Null when nothing is owed back or no payment cleared. PAY and BIL hold the
 * caps in the database; a refund split across several tenders is B9b's (A-228).
 */
export function planReturnRefund(credit: Money, refundable: Money, payments: readonly SalePayment[]): { readonly paymentId: string; readonly amount: Money } | null {
  const amount = credit.compareTo(refundable) <= 0 ? credit : refundable;
  if (amount.isZero()) return null;
  let best: SalePayment | null = null;
  for (const p of payments) {
    if (p.status === 'CLEARED' && (best === null || p.allocatedPesewas > best.allocatedPesewas)) best = p;
  }
  return best === null ? null : { paymentId: best.id, amount };
}
