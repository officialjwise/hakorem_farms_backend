import { err, ok, type Result } from '@hakorem/kernel';

/** IAM's approval kind for a price override (ADR-0017). */
export const PRICE_OVERRIDE_KIND = 'PRICE_OVERRIDE';

/** The band the engine resolved for a line, per unit of its price basis. */
export interface OverrideBand {
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
}

/** Why a line's agreed price waits for a second person; null when its reason alone is enough. */
/** `BEYOND_SHIFT_LIMIT`: within the line's limit, but past what the seller's till shift has left of its own (FR-POS-004, B09b continued). */
export type OverrideApproval = 'OUTSIDE_BAND' | 'BEYOND_ROLE_LIMIT' | 'BEYOND_SHIFT_LIMIT' | null;

export type OverrideVerdict = { readonly kind: 'AT_LIST' } | { readonly kind: 'VARIANCE'; readonly direction: 'BELOW' | 'ABOVE'; readonly approval: OverrideApproval };

/**
 * Whether a line's agreed price needs an approval by a different user (FR-ORD-003, ADR-0017, abuse case 3, A-230). A
 * price outside the band always does, whatever the limit. A price below list within the band needs none while the
 * line's whole variance (the difference extended over the line, as `variance_pesewas` keeps it) is at or under the
 * seller's per-line limit (`PRICE_OVERRIDE_PER_LINE` of their roles at the branch; none set is 0, so every price below
 * list waits). A price above list up to the ceiling costs the farm nothing and needs only its reason. The per-shift
 * limit needs the shift (B9b).
 */
export function judgeOverride(band: OverrideBand, agreedPesewas: bigint, lineVariancePesewas: bigint, lineLimitPesewas: bigint): OverrideVerdict {
  if (agreedPesewas === band.listPricePesewas) return { kind: 'AT_LIST' };
  const direction = agreedPesewas < band.listPricePesewas ? 'BELOW' : 'ABOVE';
  if (agreedPesewas < band.floorPricePesewas || agreedPesewas > band.ceilingPricePesewas) return { kind: 'VARIANCE', direction, approval: 'OUTSIDE_BAND' };
  if (direction === 'BELOW' && lineVariancePesewas > lineLimitPesewas) return { kind: 'VARIANCE', direction, approval: 'BEYOND_ROLE_LIMIT' };
  return { kind: 'VARIANCE', direction, approval: null };
}

/**
 * The approver of a price override is never the person who asked for it, the order's salesperson or the person who
 * posted the sale (SECURITY_ARCHITECTURE "Separation of duties": the seller makes, a manager checks). IAM refuses the
 * requester; this refuses the other two, and the database holds both (`ck_sales_order_settled_lines`).
 */
export function judgePriceApprover(
  approverId: string,
  parties: { readonly requestedBy: string; readonly salespersonId: string | null; readonly postedBy: string },
): Result<null, 'APPROVER_IS_SELLER'> {
  return approverId === parties.requestedBy || approverId === parties.salespersonId || approverId === parties.postedBy ? err('APPROVER_IS_SELLER') : ok(null);
}

/** A line's pricing record as an override approval binds it (an order line as stored, or a sale's line as priced). */
export interface OverrideLine {
  readonly lineNo: number;
  readonly productId: string;
  readonly stockUnitId: string | null;
  readonly qtyOrdered: string;
  readonly priceBasis: string;
  readonly priceListEntryId: string | null;
  readonly resolvedUnitPricePesewas: bigint;
  readonly floorUnitPricePesewas: bigint;
  readonly ceilingUnitPricePesewas: bigint;
  readonly agreedUnitPricePesewas: bigint;
  readonly variancePesewas: bigint;
  readonly varianceDirection: 'BELOW' | 'ABOVE' | null;
  readonly varianceReasonCode: string | null;
  readonly varianceRequiresApproval: boolean;
}

/**
 * What an override approval is taken against (the payload IAM hashes at request and again at decision, ADR-0017):
 * the subject, the customer and every line that needs the approval, in line order, with its whole pricing record. A
 * change to any of them after the request makes the approval refuse (APPROVAL_SUBJECT_CHANGED).
 */
export function overridePayload(subjectId: string, customerId: string | null, lines: readonly OverrideLine[]): unknown {
  return {
    subject: subjectId,
    customerId,
    lines: lines
      .filter((l) => l.varianceRequiresApproval)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => ({
        lineNo: l.lineNo,
        productId: l.productId,
        stockUnitId: l.stockUnitId,
        qtyOrdered: l.qtyOrdered,
        priceBasis: l.priceBasis,
        priceListEntryId: l.priceListEntryId,
        resolved: l.resolvedUnitPricePesewas.toString(),
        floor: l.floorUnitPricePesewas.toString(),
        ceiling: l.ceilingUnitPricePesewas.toString(),
        agreed: l.agreedUnitPricePesewas.toString(),
        variance: l.variancePesewas.toString(),
        direction: l.varianceDirection,
        reasonCode: l.varianceReasonCode,
      })),
  };
}
