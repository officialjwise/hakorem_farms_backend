import { Rate, type Money, type Quantity } from '@hakorem/kernel';

/**
 * The three-way match (FR-PUR-009, SA-08): each supplier invoice line against its purchase order line and what was
 * received. Pure: the application supplies the order line's price, the quantity received and the quantity other live
 * invoices already hold against it, and the rejected quantity its open claims allow beyond what was received
 * (ADR-0076), all in the product's base unit.
 */
export type MatchStatus = 'UNMATCHED' | 'MATCHED' | 'MISMATCH' | 'NOT_REQUIRED';

/** Why a line does not match, in the fixed order they are reported. */
export type MatchReason = 'NO_ORDER_LINE' | 'PRODUCT_DIFFERS' | 'QTY_EXCEEDS_RECEIVED' | 'PRICE_OUTSIDE_TOLERANCE' | 'LEVY_DIFFERS';

/** SA-08: the invoice unit price may differ from the order price by at most 1 percent, either way. */
export const PRICE_TOLERANCE = Rate.parsePercent('1');

export interface InvoiceLineFacts {
  /** Null for a pure expense line (transport, a service) that names no product. */
  readonly productId: string | null;
  /** The invoiced quantity in the product's base unit; null exactly when there is no product. */
  readonly qtyBase: Quantity | null;
  /** Per the unit the supplier charges by, which is the order line's unit. */
  readonly unitPrice: Money;
  /** Each levy as the supplier charged it beside the calculator's amount for the line (ADR-0020). */
  readonly levies: readonly { readonly charged: Money; readonly calculated: Money }[];
  /** The order line the invoice line names, or null when it names none. */
  readonly order: {
    readonly productId: string;
    readonly unitPrice: Money;
    readonly qtyReceived: Quantity;
    /** What other live invoices (matched, approved or paid) already hold against this order line. */
    readonly qtyInvoicedElsewhere: Quantity;
    /**
     * The rejected quantity of this order line's claims not settled by an invoice (ADR-0076): the supplier may invoice
     * it, and a credit note drafted from the claim takes it off again. Zero without a claim.
     */
    readonly qtyClaimed: Quantity;
  } | null;
}

export interface LineMatch {
  readonly status: Exclude<MatchStatus, 'UNMATCHED'>;
  readonly reasons: readonly MatchReason[];
  /** Invoiced minus what is left to invoice of the receipt; positive is more than was received. */
  readonly qtyVariance: Quantity | null;
  /** The absolute difference per unit from the order price. */
  readonly priceVariance: Money | null;
  readonly priceVarianceDirection: 'OVER' | 'UNDER' | null;
}

function levyReasons(line: InvoiceLineFacts): MatchReason[] {
  return line.levies.some((levy) => !levy.charged.equals(levy.calculated)) ? ['LEVY_DIFFERS'] : [];
}

function withinTolerance(difference: Money, orderPrice: Money): boolean {
  return difference.pesewas * PRICE_TOLERANCE.denominator <= orderPrice.pesewas * PRICE_TOLERANCE.numerator;
}

/** One invoice line's match, with every reason it fails on. */
export function matchLine(line: InvoiceLineFacts): LineMatch {
  const noVariance = { qtyVariance: null, priceVariance: null, priceVarianceDirection: null } as const;
  if (line.productId === null) {
    const reasons = levyReasons(line);
    return { status: reasons.length > 0 ? 'MISMATCH' : 'NOT_REQUIRED', reasons, ...noVariance };
  }
  if (line.qtyBase === null) {
    throw new Error('a product line carries its quantity in the base unit');
  }
  if (line.order === null) {
    return { status: 'MISMATCH', reasons: ['NO_ORDER_LINE', ...levyReasons(line)], ...noVariance };
  }
  if (line.order.productId !== line.productId) {
    return { status: 'MISMATCH', reasons: ['PRODUCT_DIFFERS', ...levyReasons(line)], ...noVariance };
  }
  const reasons: MatchReason[] = [];
  const qtyVariance = line.qtyBase.minus(line.order.qtyReceived.minus(line.order.qtyInvoicedElsewhere));
  if (qtyVariance.compareTo(line.order.qtyClaimed) > 0) reasons.push('QTY_EXCEEDS_RECEIVED');
  const over = line.unitPrice.compareTo(line.order.unitPrice);
  const priceVariance = over >= 0 ? line.unitPrice.minus(line.order.unitPrice) : line.order.unitPrice.minus(line.unitPrice);
  if (!withinTolerance(priceVariance, line.order.unitPrice)) reasons.push('PRICE_OUTSIDE_TOLERANCE');
  reasons.push(...levyReasons(line));
  return {
    status: reasons.length > 0 ? 'MISMATCH' : 'MATCHED',
    reasons,
    qtyVariance,
    priceVariance,
    priceVarianceDirection: over > 0 ? 'OVER' : over < 0 ? 'UNDER' : null,
  };
}

/** The invoice is MATCHED only if every payable line matches; NOT_REQUIRED when no line needs a match. */
export function matchInvoice(lines: readonly LineMatch[]): Exclude<MatchStatus, 'UNMATCHED'> {
  if (lines.length === 0) {
    throw new Error('an invoice has at least one line');
  }
  if (lines.some((line) => line.status === 'MISMATCH')) return 'MISMATCH';
  return lines.every((line) => line.status === 'NOT_REQUIRED') ? 'NOT_REQUIRED' : 'MATCHED';
}
