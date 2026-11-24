import { err, halfUpDivide, Money, ok, type Quantity, type Result } from '@hakorem/kernel';
import type { OrderStatus } from './order';

/** A line of the original sale as a return reads it: what was sold and what returns not rejected already hold. */
export interface SoldLine {
  readonly id: string;
  readonly priceBasis: 'PER_HEAD' | 'PER_KG' | 'PER_UNIT';
  /** One named animal: it comes back whole or not at all. */
  readonly serial: boolean;
  readonly qtySold: Quantity;
  readonly qtyReturned: Quantity;
  /**
   * The pieces in one of the line's unit when it is sold in a unit of several (30 eggs in a crate), so part of one may
   * come back as single pieces; null (or absent) for a line sold in its base unit.
   */
  readonly piecesPerUnit?: bigint | null;
  /** What returns not rejected hold of the line, in pieces: whole units times `piecesPerUnit`, plus single pieces. */
  readonly piecesReturned?: Quantity;
  /** Returns of the line still open (REQUESTED or PENDING_APPROVAL), and of those how many count single pieces. */
  readonly openReturns?: number;
  readonly openPartReturns?: number;
}

export interface ReturnFacts {
  readonly orderStatus: OrderStatus;
  readonly kind: 'RETURN' | 'EXCHANGE';
  readonly sold: readonly SoldLine[];
  readonly asked: readonly {
    readonly orderLineId: string;
    readonly qty: Quantity;
    /** Counted in single pieces of the line's unit (five eggs of a crate), not in the unit it was sold in. */
    readonly inPieces?: boolean;
    /** False when the unit named is neither the line's own nor its single pieces (a kilogram of a crate). */
    readonly unitSold?: boolean;
    readonly disposition?: 'RESTOCK' | 'RETURNS_HOLD' | 'WRITE_OFF';
  }[];
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
    const per = line.piecesPerUnit ?? null;
    if (asked.inPieces === true) {
      if (per === null || asked.unitSold === false) return void broken.push({ field: `/lines/${i}/uom`, rule: 'UNIT_NOT_SOLD' });
      if (asked.qty.thousandths % 1000n !== 0n) return void broken.push({ field: `/lines/${i}/qty`, rule: 'INEXACT_QUANTITY' });
      // Single pieces wait in the returns hold for inspection (or are written off); never straight back onto the shelf.
      if (asked.disposition === 'RESTOCK') return void broken.push({ field: `/lines/${i}/disposition`, rule: 'PART_RETURN_TO_HOLD' });
      // The pro-rata refund reads what came back before it, so it waits for an open return of the line to be decided.
      if ((line.openReturns ?? 0) > 0) return void broken.push({ field: `/lines/${i}/orderLineId`, rule: 'RETURN_OPEN_ON_LINE' });
    } else if ((line.openPartReturns ?? 0) > 0) return void broken.push({ field: `/lines/${i}/orderLineId`, rule: 'RETURN_OPEN_ON_LINE' });
    const exceeds =
      per === null
        ? line.qtyReturned.plus(asked.qty).compareTo(line.qtySold) > 0
        : (line.piecesReturned?.thousandths ?? 0n) + (asked.inPieces === true ? asked.qty.thousandths : asked.qty.thousandths * per) > line.qtySold.thousandths * per;
    if (exceeds) broken.push({ field: `/lines/${i}/qty`, rule: 'RETURN_EXCEEDS_SOLD' });
  });
  return broken.length === 0 ? ok(null) : err(broken);
}

/**
 * The refund of single pieces of a line sold in a unit of several (part of a crate returned as single eggs, owner,
 * 2026-11-18): pro rata at the price actually paid on the line per piece, never the single-piece price, by the running
 * total of the egg cost rule (ADR-0075, half-up once): round(paid x (previous + returning) / pieces sold) less
 * round(paid x previous / pieces sold), so the pieces of a line always add up to what was paid for it, never more.
 * `paid` is the line's anchor on the original document; `piecesSold` the line's quantity in pieces.
 */
export function pieceRefund(paid: Money, piecesSold: Quantity, previous: Quantity, returning: Quantity): Money {
  const upTo = (q: Quantity) => halfUpDivide(paid.pesewas * q.thousandths, piecesSold.thousandths);
  return Money.ofPesewas(upTo(previous.plus(returning)) - upTo(previous));
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
