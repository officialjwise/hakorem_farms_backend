import { err, Money, ok, type Quantity, type Result, type Weight } from '@hakorem/kernel';

/**
 * The pricing engine (ADR-0004, ADR-0036; FR-MDM-016, FR-MDM-017). Pure: the application layer loads the price
 * lists in force and passes them in, in resolution order. The engine never throws for a business outcome, never
 * returns zero and never guesses: anything it cannot price is `QuoteRequired`.
 */

export const CHANNELS = ['POS', 'ONLINE', 'WHOLESALE', 'QUOTE'] as const;
export type Channel = (typeof CHANNELS)[number];
export const PRICE_LIST_KINDS = ['CUSTOMER', 'TIER', 'CHANNEL', 'BASE'] as const;
export type PriceListKind = (typeof PRICE_LIST_KINDS)[number];
export const PRICE_BASES = ['PER_HEAD', 'PER_KG', 'PER_UNIT'] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export type QuoteRequiredReason = 'NO_RULE' | 'QUOTE_ONLY' | 'MISSING_GRADE_OR_WEIGHT';

/** A live-weight range of one species, half-open: `min` inclusive, `max` exclusive (FR-MDM-005). */
export interface WeightBand {
  readonly id: string;
  readonly code: string;
  readonly min: Weight;
  readonly max: Weight;
}

export interface PriceListRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: PriceListKind;
}

/** One entry of the version in force, for the product being priced. Floor <= list <= ceiling (database CHECK). */
export interface PriceEntry {
  readonly id: string;
  readonly gradeId: string | null;
  readonly weightBandId: string | null;
  readonly basis: PriceBasis;
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
  readonly quoteOnly: boolean;
  readonly minQty: Quantity;
}

/** A list in its slot of the resolution order, with its entries for the product. */
export interface PriceListCandidate {
  readonly list: PriceListRef;
  readonly entries: readonly PriceEntry[];
}

export interface PricingQuery {
  readonly gradeId: string | null;
  readonly weight: Weight | null;
  readonly quantity: Quantity;
}

export type PriceResolution =
  | { readonly kind: 'Resolved'; readonly list: PriceListRef; readonly entry: PriceEntry; readonly weightBand: WeightBand | null }
  | { readonly kind: 'QuoteRequired'; readonly reason: QuoteRequiredReason; readonly stoppedAt: PriceListRef | null };

/** The one band whose half-open range holds the weight, or null when it falls outside every band. */
export function weightBandFor(bands: readonly WeightBand[], weight: Weight): WeightBand | null {
  return bands.find((band) => weight.compareTo(band.min) >= 0 && weight.compareTo(band.max) < 0) ?? null;
}

/** Product with grade and band, then with band, then with grade, then alone. */
function specificity(entry: PriceEntry): number {
  return (entry.weightBandId === null ? 0 : 2) + (entry.gradeId === null ? 0 : 1);
}

/**
 * Walks the candidates in the order given and stops at the first list with a matching entry; inside a list the
 * most specific entry wins, then the largest quantity break not above the quantity. A matching `quote_only` entry
 * stops the walk. With no match anywhere, the reason is MISSING_GRADE_OR_WEIGHT if some entry would have matched
 * once given the grade or weight the request lacks, otherwise NO_RULE: a weight outside every band is NO_RULE, and so
 * is a missing grade that no grade could fix.
 */
export function resolvePrice(query: PricingQuery, bands: readonly WeightBand[], candidates: readonly PriceListCandidate[]): PriceResolution {
  const band = query.weight === null ? null : weightBandFor(bands, query.weight);
  let lackedAttribute = false;
  for (const candidate of candidates) {
    let best: PriceEntry | null = null;
    for (const entry of candidate.entries) {
      const gradeMissing = entry.gradeId !== null && query.gradeId === null;
      const weightMissing = entry.weightBandId !== null && query.weight === null;
      const gradeFits = entry.gradeId === null || gradeMissing || entry.gradeId === query.gradeId;
      const bandFits = entry.weightBandId === null || weightMissing || entry.weightBandId === band?.id;
      if (!gradeFits || !bandFits || entry.minQty.compareTo(query.quantity) > 0) {
        continue;
      }
      if (gradeMissing || weightMissing) {
        // It would match if the request carried the grade or weight it lacks.
        lackedAttribute = true;
      } else if (best === null || outranks(entry, best)) {
        best = entry;
      }
    }
    if (best !== null) {
      return best.quoteOnly
        ? { kind: 'QuoteRequired', reason: 'QUOTE_ONLY', stoppedAt: candidate.list }
        : { kind: 'Resolved', list: candidate.list, entry: best, weightBand: best.weightBandId === null ? null : band };
    }
  }
  return { kind: 'QuoteRequired', reason: lackedAttribute ? 'MISSING_GRADE_OR_WEIGHT' : 'NO_RULE', stoppedAt: null };
}

function outranks(entry: PriceEntry, other: PriceEntry): boolean {
  const mine = specificity(entry);
  const theirs = specificity(other);
  return mine !== theirs ? mine > theirs : entry.minQty.compareTo(other.minQty) > 0;
}

export interface PriceBand {
  readonly listPricePesewas: bigint;
  readonly floorPricePesewas: bigint;
  readonly ceilingPricePesewas: bigint;
}

/** Why an agreed price needs a second person (ADR-0004, ADR-0017). */
export type VarianceApproval = 'OUTSIDE_BAND' | 'BEYOND_ROLE_LIMIT';

export type AgreedPriceVerdict =
  | { readonly kind: 'AT_LIST' }
  | { readonly kind: 'VARIANCE'; readonly amountPesewas: bigint; readonly direction: 'BELOW' | 'ABOVE'; readonly approval: VarianceApproval | null };

/**
 * Judges an agreed unit price against the resolved band (FR-MDM-017). Between floor and ceiling it is a recorded
 * variance with no approval, as long as a discount stays within what the user's role has left for the shift
 * (`remainingAllowancePesewas`, from `iam.role_limit`, worked out by the selling module). Outside the band, or a
 * discount beyond the allowance, it needs approval by a different user. A price above list costs the farm
 * nothing, so the allowance does not apply to it; the ceiling does.
 */
export function judgeAgreedPrice(band: PriceBand, agreedPesewas: bigint, remainingAllowancePesewas: bigint): AgreedPriceVerdict {
  if (agreedPesewas === band.listPricePesewas) {
    return { kind: 'AT_LIST' };
  }
  if (agreedPesewas > band.listPricePesewas) {
    const approval = agreedPesewas > band.ceilingPricePesewas ? 'OUTSIDE_BAND' : null;
    return { kind: 'VARIANCE', amountPesewas: agreedPesewas - band.listPricePesewas, direction: 'ABOVE', approval };
  }
  const amountPesewas = band.listPricePesewas - agreedPesewas;
  const approval = agreedPesewas < band.floorPricePesewas ? 'OUTSIDE_BAND' : amountPesewas > remainingAllowancePesewas ? 'BEYOND_ROLE_LIMIT' : null;
  return { kind: 'VARIANCE', amountPesewas, direction: 'BELOW', approval };
}

/**
 * A unit price extended to a line anchor, rounded half-up once (ADR-0001): per kilogram times the weight, per
 * head or per unit times the quantity. A per-kilogram line without a weight is refused, never estimated.
 */
export function extendPrice(
  unitPesewas: bigint,
  basis: PriceBasis,
  measure: { readonly quantity: Quantity; readonly weight: Weight | null },
): Result<bigint, 'WEIGHT_REQUIRED'> {
  const unit = Money.ofPesewas(unitPesewas);
  if (basis === 'PER_KG') {
    return measure.weight === null ? err('WEIGHT_REQUIRED') : ok(unit.timesWeight(measure.weight).pesewas);
  }
  return ok(unit.timesQuantity(measure.quantity).pesewas);
}
