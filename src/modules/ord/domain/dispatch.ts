import { err, Money, ok, Quantity, type Result } from '@hakorem/kernel';
import type { OrderStatus } from './order';

/** What a payment taken for the order still holds unallocated, as a deposit (ADR-0003, 2200). */
export interface DepositHeld {
  readonly paymentId: string;
  readonly unallocated: Money;
}

export interface Settlement {
  /** Each deposit's part applied to the invoice, oldest first. */
  readonly allocations: readonly { readonly paymentId: string; readonly amount: Money }[];
  /** What each deposit holds beyond the invoice, asked back to the original method. */
  readonly refunds: readonly { readonly paymentId: string; readonly amount: Money }[];
  /** What is left on the invoice: the cash due on delivery. */
  readonly due: Money;
}

/**
 * The settlement at dispatch (FR-ORD-011, ADR-0021): the deposits applied to the billing document on the weighed
 * quantity, oldest first, each never beyond what is still outstanding; what a deposit holds beyond the document is
 * refunded; what the deposits do not cover is due on delivery. Exact integers: allocated plus due is the document, and
 * allocated plus refunded is what the deposits held. While a backorder of the order is still to be sent (FR-ORD-012),
 * what the deposits hold beyond the document stays held for it (`holdForBackorder`), refunded at the last dispatch.
 */
export function planSettlement(gross: Money, deposits: readonly DepositHeld[], options: { readonly holdForBackorder: boolean } = { holdForBackorder: false }): Settlement {
  let left = gross;
  const allocations: { paymentId: string; amount: Money }[] = [];
  const refunds: { paymentId: string; amount: Money }[] = [];
  for (const deposit of deposits) {
    if (deposit.unallocated.isZero()) continue;
    const applied = deposit.unallocated.compareTo(left) <= 0 ? deposit.unallocated : left;
    if (!applied.isZero()) allocations.push({ paymentId: deposit.paymentId, amount: applied });
    left = left.minus(applied);
    const beyond = deposit.unallocated.minus(applied);
    if (!beyond.isZero() && !options.holdForBackorder) refunds.push({ paymentId: deposit.paymentId, amount: beyond });
  }
  return { allocations, refunds, due: left };
}

/** An order line as a backorder reads it at dispatch. */
export interface LineAtDispatch {
  readonly id: string;
  readonly lineNo: number;
  readonly qtyOrdered: string;
  readonly qtyFulfilled: string;
  readonly qtyBackordered: string;
  readonly agreedUnitPricePesewas: bigint;
  readonly discountPesewas: bigint;
}

/** One line of a backorder: the rest of an order line, at its agreed price, and what the order line becomes. */
export interface BackorderLine {
  readonly fromLineId: string;
  readonly qty: string;
  readonly estimatedLineTotalPesewas: bigint;
  /** PARTIAL when part of the line was sent, BACKORDERED when none of it was. */
  readonly status: 'PARTIAL' | 'BACKORDERED';
}

/**
 * The backorder of a dispatch (FR-ORD-012, ADR-0094): each line with a quantity back-ordered at packing becomes a line of
 * the backorder for exactly what was not sent (ordered less fulfilled, else `BACKORDER_MISMATCH`), at the price agreed on
 * the order, extended once half-up at the line (ADR-0001). A discounted line is never split (`BACKORDER_DISCOUNTED`):
 * its discount belongs to the whole line. Lines with nothing back-ordered are left alone.
 */
export function backorderLines(lines: readonly LineAtDispatch[]): BackorderLine[] {
  const out: BackorderLine[] = [];
  for (const line of lines) {
    const back = Quantity.parse(line.qtyBackordered);
    if (back.isZero()) continue;
    const fulfilled = Quantity.parse(line.qtyFulfilled);
    if (!fulfilled.plus(back).equals(Quantity.parse(line.qtyOrdered))) throw new Error(`BACKORDER_MISMATCH on line ${line.lineNo}`);
    if (line.discountPesewas !== 0n) throw new Error(`BACKORDER_DISCOUNTED on line ${line.lineNo}`);
    out.push({
      fromLineId: line.id,
      qty: back.toDecimalString(),
      estimatedLineTotalPesewas: Money.ofPesewas(line.agreedUnitPricePesewas).timesQuantity(back).pesewas,
      status: fulfilled.isZero() ? 'BACKORDERED' : 'PARTIAL',
    });
  }
  return out;
}

/** A fee line a dispatch's document carries. */
export interface FeeAtDispatch {
  readonly kind: 'DELIVERY' | 'EXTRA_DELIVERY';
  readonly amountPesewas: bigint;
  readonly extraFeeId: string | null;
}

/**
 * The fee lines of a dispatch (A-331 (b), approved by the owner 2026-11-23): the order's delivery fee once, on its first
 * dispatch, never on a backorder the farm sends to complete it; an extra delivery the customer asked for is its own line
 * of exactly the amount staff added (`addExtraDeliveryFee`), never inferred from a second dispatch.
 */
export function feesAtDispatch(f: { readonly deliveryFeePesewas: bigint; readonly isBackorder: boolean; readonly extraFees: readonly { readonly id: string; readonly amountPesewas: bigint }[] }): FeeAtDispatch[] {
  const fees: FeeAtDispatch[] = [];
  if (!f.isBackorder && f.deliveryFeePesewas > 0n) fees.push({ kind: 'DELIVERY', amountPesewas: f.deliveryFeePesewas, extraFeeId: null });
  for (const extra of f.extraFees) fees.push({ kind: 'EXTRA_DELIVERY', amountPesewas: extra.amountPesewas, extraFeeId: extra.id });
  return fees;
}

export type ExtraFeeRefusal = 'NOT_A_DELIVERY' | 'NOT_A_BACKORDER' | 'NOT_BEFORE_DISPATCH' | 'EXTRA_FEE_ALREADY_ADDED' | 'ZONE_HAS_NO_FEE';

const BEFORE_DISPATCH: readonly OrderStatus[] = ['CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED'];

/**
 * Whether an extra delivery fee may be added (the owner, 2026-11-23): only to a delivery backorder not yet dispatched,
 * once, at its zone's own fee (never an amount typed by staff).
 */
export function judgeExtraDeliveryFee(f: {
  readonly fulfilmentMode: 'COUNTER' | 'COLLECTION' | 'DELIVERY';
  readonly isBackorder: boolean;
  readonly status: OrderStatus;
  readonly alreadyAdded: boolean;
  readonly zoneFeePesewas: bigint;
}): Result<bigint, ExtraFeeRefusal> {
  if (f.fulfilmentMode !== 'DELIVERY') return err('NOT_A_DELIVERY');
  if (!f.isBackorder) return err('NOT_A_BACKORDER');
  if (!BEFORE_DISPATCH.includes(f.status)) return err('NOT_BEFORE_DISPATCH');
  if (f.alreadyAdded) return err('EXTRA_FEE_ALREADY_ADDED');
  if (f.zoneFeePesewas <= 0n) return err('ZONE_HAS_NO_FEE');
  return ok(f.zoneFeePesewas);
}

/**
 * A staff delivery order's fee (B11 continued 8): its zone's exact fee, waived only when the goods come to more than the
 * zone's threshold, the rule the checkout applies (FR-SHP-008). Staff never type it.
 */
export function zoneFee(zone: { readonly feePesewas: bigint; readonly freeOverPesewas: bigint | null }, goods: Money): Money {
  if (zone.freeOverPesewas !== null && goods.pesewas > zone.freeOverPesewas) return Money.zero();
  return Money.ofPesewas(zone.feePesewas);
}

/**
 * What the driver collects at the door (ADR-0092): what the deposits do not cover, except on an order on account, whose
 * balance is the invoice itself, due on the customer's terms, and never cash in the driver's hands (B11 continued 8).
 */
export function cashDueOnDelivery(paymentTerms: 'IMMEDIATE' | 'PREPAID' | 'COD' | 'CREDIT', due: Money): Money {
  return paymentTerms === 'CREDIT' ? Money.zero() : due;
}
