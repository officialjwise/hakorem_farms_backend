import { Money, type Quantity } from '@hakorem/kernel';
import type { Tracking } from './goods-receipt';
import type { StockRuleBroken } from './stock-documents';
import { issue, valueAtAverage, type CostPool } from './valuation/cost-pool';

export type StockTakeScope = 'FULL' | 'CYCLE';
export type StockTakeStatus = 'DRAFT' | 'COUNTING' | 'REVIEW' | 'PENDING_APPROVAL' | 'POSTED' | 'CANCELLED';
export type VarianceDirection = 'GAIN' | 'LOSS' | 'NONE';

/** The statuses in which a take holds its scope: no other take of its location may share a product (FR-INV-014). */
export const SCOPE_HOLDING: ReadonlySet<StockTakeStatus> = new Set(['DRAFT', 'COUNTING', 'REVIEW', 'PENDING_APPROVAL']);
/** The statuses a take may be cancelled from; a pending take is decided by its approval instead. */
export const CANCELLABLE: ReadonlySet<StockTakeStatus> = new Set(['DRAFT', 'COUNTING', 'REVIEW']);
/** Location kinds that hold no countable stock of their own: stock passing through, or a whole site's tree. */
const NOT_COUNTED_AT: ReadonlySet<string> = new Set(['IN_TRANSIT', 'SITE']);

/** What master data says about a product a cycle count names. */
export interface CountedProduct {
  readonly tracking: Tracking;
  readonly stockPolicy: string;
}

/** The location a take counts, narrowed to the rules here. */
export interface CountedLocation {
  readonly kind: string;
  readonly isVirtual: boolean;
  readonly isLive: boolean;
}

export interface ScopeDraft {
  readonly location: CountedLocation;
  readonly scope: StockTakeScope;
  /** The listed products, each with its facts; a FULL take lists none. */
  readonly products: ReadonlyArray<{ readonly id: string; readonly product: CountedProduct }>;
}

/**
 * The rules a take's scope keeps (FR-INV-013, FR-INV-014, A-141): a live physical location that holds stock of its
 * own; a cycle count lists at least one product, each once, and a full take lists none; every listed product is
 * stocked; and animals are not counted here, since a missing animal is a death, a cull or a theft with its own controls
 * (B6), never a stock-take loss.
 */
export function checkTakeScope(draft: ScopeDraft): StockRuleBroken[] {
  const broken: StockRuleBroken[] = [];
  if (!draft.location.isLive || draft.location.isVirtual || NOT_COUNTED_AT.has(draft.location.kind)) {
    broken.push({ field: '/locationId', rule: 'NOT_A_STOCK_LOCATION' });
  }
  if (draft.scope === 'FULL' && draft.products.length > 0) broken.push({ field: '/productIds', rule: 'NOT_FOR_FULL_SCOPE' });
  if (draft.scope === 'CYCLE' && draft.products.length === 0) broken.push({ field: '/productIds', rule: 'PRODUCTS_REQUIRED' });
  const seen = new Set<string>();
  draft.products.forEach(({ id, product }, index) => {
    const at = (rule: string): StockRuleBroken => ({ field: `/productIds/${index}`, rule });
    if (seen.has(id)) broken.push(at('PRODUCT_REPEATED'));
    seen.add(id);
    if (product.stockPolicy === 'NON_STOCK') broken.push(at('PRODUCT_NOT_STOCKED'));
    else if (product.tracking === 'SERIAL') broken.push(at('ANIMAL_NOT_COUNTED'));
  });
  return broken;
}

/** One take's claim on its location: the whole of it, or the listed products. */
export interface ScopeClaim {
  readonly locationId: string;
  readonly scope: StockTakeScope;
  readonly productIds: readonly string[];
}

/** Whether two takes would count the same stock: one location, and a full take or a shared product (FR-INV-014). */
export function scopesOverlap(a: ScopeClaim, b: ScopeClaim): boolean {
  if (a.locationId !== b.locationId) return false;
  if (a.scope === 'FULL' || b.scope === 'FULL') return true;
  const listed = new Set(a.productIds);
  return b.productIds.some((id) => listed.has(id));
}

export interface CountedLine {
  readonly expected: Quantity;
  readonly counted: Quantity | null;
  readonly recount: Quantity | null;
}

/** The final count less the frozen expected figure; null until the line is counted. The recount wins over the count. */
export function lineVariance(line: CountedLine): { readonly qty: Quantity; readonly direction: VarianceDirection } | null {
  const final = line.recount ?? line.counted;
  if (final === null) return null;
  const qty = final.minus(line.expected);
  return { qty, direction: qty.isZero() ? 'NONE' : qty.isNegative() ? 'LOSS' : 'GAIN' };
}

/**
 * A line needs a recount in review when its first count differs from the expected figure and it has not been
 * recounted. The tolerance is zero (A-141): any difference is counted twice before it is posted.
 */
export function needsRecount(status: StockTakeStatus, line: CountedLine): boolean {
  if (status !== 'REVIEW' || line.recount !== null) return false;
  const variance = lineVariance(line);
  return variance !== null && variance.direction !== 'NONE';
}

/**
 * The value a variance carries, from its cost pool (ADR-0018, as an adjustment is valued, A-139): a loss at what the
 * pool would give up, a gain at the pool's average, nothing for no variance.
 */
export function varianceValue(pool: CostPool, variance: Quantity): Money {
  if (variance.isZero()) return Money.zero();
  return variance.isNegative() ? issue(pool, variance.negated()).carried : valueAtAverage(pool, variance);
}

/** The gains and the losses of a take, each summed, and together the figure judged against the threshold. */
export function varianceTotals(lines: ReadonlyArray<{ readonly direction: VarianceDirection; readonly value: Money }>): {
  readonly gain: Money;
  readonly loss: Money;
  readonly total: Money;
} {
  const gain = Money.sum(lines.filter((l) => l.direction === 'GAIN').map((l) => l.value));
  const loss = Money.sum(lines.filter((l) => l.direction === 'LOSS').map((l) => l.value));
  return { gain, loss, total: gain.plus(loss) };
}

export interface CountEntry {
  readonly lineId: string;
  readonly isRecount: boolean;
}

/**
 * The rules a batch of counts keeps (FR-INV-013): every line is the take's, each once; while counting, first counts
 * only, as often as the counter corrects them; in review, recounts only, of a line that needs one, once.
 */
export function checkCounts(
  status: StockTakeStatus,
  entries: readonly CountEntry[],
  lines: ReadonlyMap<string, CountedLine>,
): StockRuleBroken[] {
  const broken: StockRuleBroken[] = [];
  if (status !== 'COUNTING' && status !== 'REVIEW') return [{ field: '/counts', rule: 'NOT_COUNTING' }];
  if (entries.length === 0) return [{ field: '/counts', rule: 'NO_COUNTS' }];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const at = (rule: string): StockRuleBroken => ({ field: `/counts/${index}/lineId`, rule });
    const line = lines.get(entry.lineId);
    if (line === undefined) {
      broken.push(at('LINE_UNKNOWN'));
      return;
    }
    if (seen.has(entry.lineId)) broken.push(at('LINE_REPEATED'));
    seen.add(entry.lineId);
    if (status === 'COUNTING' && entry.isRecount) broken.push(at('RECOUNT_IN_REVIEW_ONLY'));
    if (status === 'REVIEW' && !entry.isRecount) broken.push(at('COUNTING_CLOSED'));
    if (status === 'REVIEW' && entry.isRecount && !needsRecount(status, line)) broken.push(at('RECOUNT_NOT_NEEDED'));
  });
  return broken;
}

/** The lines still uncounted, or needing a recount, which keep a take from closing or from being submitted. */
export function unfinishedLines(status: StockTakeStatus, lines: ReadonlyArray<{ readonly id: string } & CountedLine>): StockRuleBroken[] {
  return lines.flatMap((line) => {
    if (line.counted === null) return [{ field: `/lines/${line.id}`, rule: 'NOT_COUNTED' }];
    if (needsRecount(status, line)) return [{ field: `/lines/${line.id}`, rule: 'RECOUNT_REQUIRED' }];
    return [];
  });
}
