import { Quantity } from '@hakorem/kernel';

/**
 * Reorder levels and stock alerts (FR-INV-015, FR-INV-016). A level alert belongs to a reorder rule: `LOW_STOCK` when
 * available stock is at or below the reorder point, `BELOW_MINIMUM` when it is under the minimum. An expiry alert
 * belongs to a lot where it stands: `EXPIRING` within the lead time, `EXPIRED` once its date has passed. Each is
 * raised once per crossing and cleared when the condition ends, so a further sale below the point raises nothing.
 */
export type LevelAlertKind = 'LOW_STOCK' | 'BELOW_MINIMUM';
export type ExpiryAlertKind = 'EXPIRING' | 'EXPIRED';
export type StockAlertKind = LevelAlertKind | ExpiryAlertKind;

/** FR-INV-016's seed: a lot raises an expiring alert this many days before its expiry, unless its rule says otherwise. */
export const DEFAULT_EXPIRY_ALERT_DAYS = 3;
/** The longest lead time a rule may set: a year. */
export const MAX_EXPIRY_ALERT_DAYS = 365;
const MS_PER_DAY = 86_400_000;

export interface ReorderLevels {
  readonly minQty: Quantity;
  readonly reorderPointQty: Quantity;
  readonly maxQty: Quantity;
}

export interface AlertRuleBroken {
  readonly field: string;
  readonly rule: string;
}

/** The levels a rule may hold: minimum, at or under the reorder point, at or under a maximum above zero. */
export function checkReorderLevels(levels: ReorderLevels, expiryAlertDays: number | null): AlertRuleBroken[] {
  const broken: AlertRuleBroken[] = [];
  if (levels.reorderPointQty.compareTo(levels.minQty) < 0) broken.push({ field: '/reorderPointQty', rule: 'BELOW_MINIMUM' });
  if (levels.maxQty.compareTo(levels.reorderPointQty) < 0) broken.push({ field: '/maxQty', rule: 'BELOW_REORDER_POINT' });
  if (levels.maxQty.isZero()) broken.push({ field: '/maxQty', rule: 'MAXIMUM_REQUIRED' });
  if (expiryAlertDays !== null && (!Number.isInteger(expiryAlertDays) || expiryAlertDays < 1 || expiryAlertDays > MAX_EXPIRY_ALERT_DAYS)) {
    broken.push({ field: '/expiryAlertDays', rule: 'OUT_OF_RANGE' });
  }
  return broken;
}

/** What brings available stock back to the maximum; nothing when it is already there. */
export function suggestedQty(available: Quantity, maxQty: Quantity): Quantity {
  const gap = maxQty.minus(available);
  return gap.compareTo(Quantity.zero()) > 0 ? gap : Quantity.zero();
}

export interface LevelAlertToRaise {
  readonly kind: LevelAlertKind;
  readonly thresholdQty: Quantity;
  readonly suggestedQty: Quantity;
}

/**
 * The alerts a rule raises and clears now, given what is available and which of its alerts are open. `LOW_STOCK` is
 * raised at or below the reorder point and cleared once above it; `BELOW_MINIMUM` under the minimum, cleared at it.
 */
export function judgeLevels(available: Quantity, levels: ReorderLevels, open: ReadonlySet<LevelAlertKind>): { readonly raise: LevelAlertToRaise[]; readonly clear: LevelAlertKind[] } {
  const raise: LevelAlertToRaise[] = [];
  const clear: LevelAlertKind[] = [];
  const conditions: ReadonlyArray<{ readonly kind: LevelAlertKind; readonly holds: boolean; readonly threshold: Quantity }> = [
    { kind: 'LOW_STOCK', holds: available.compareTo(levels.reorderPointQty) <= 0, threshold: levels.reorderPointQty },
    { kind: 'BELOW_MINIMUM', holds: available.compareTo(levels.minQty) < 0, threshold: levels.minQty },
  ];
  for (const condition of conditions) {
    if (condition.holds && !open.has(condition.kind)) {
      raise.push({ kind: condition.kind, thresholdQty: condition.threshold, suggestedQty: suggestedQty(available, levels.maxQty) });
    } else if (!condition.holds && open.has(condition.kind)) {
      clear.push(condition.kind);
    }
  }
  return { raise, clear };
}

/** Whole days from today (`YYYY-MM-DD` in Africa/Accra) to a lot's expiry date; negative once it has passed. */
export function daysToExpiry(expiresOn: string, today: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
}

/** The lead time a lot is alerted with: its rule's, or the seeded default. */
export function expiryLeadDays(ruleDays: number | null | undefined): number {
  return ruleDays ?? DEFAULT_EXPIRY_ALERT_DAYS;
}

/** Which expiry condition a lot is in today: expired after its date, expiring within the lead time, or neither. */
export function expiryKind(expiresOn: string, today: string, leadDays: number): ExpiryAlertKind | null {
  const days = daysToExpiry(expiresOn, today);
  if (days < 0) return 'EXPIRED';
  return days <= leadDays ? 'EXPIRING' : null;
}

/**
 * The expiry alert a lot at one location raises today, and the ones it clears: a lot with nothing on hand there
 * clears every alert; an expired lot clears its expiring alert; an alert already open is not raised again.
 */
export function judgeExpiry(
  lot: { readonly expiresOn: string; readonly onHand: Quantity },
  today: string,
  leadDays: number,
  open: ReadonlySet<ExpiryAlertKind>,
): { readonly raise: ExpiryAlertKind | null; readonly clear: ExpiryAlertKind[] } {
  const kind = lot.onHand.compareTo(Quantity.zero()) > 0 ? expiryKind(lot.expiresOn, today, leadDays) : null;
  return { raise: kind !== null && !open.has(kind) ? kind : null, clear: [...open].filter((k) => k !== kind).sort() };
}
