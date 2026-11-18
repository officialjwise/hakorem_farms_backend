/**
 * The rules of an offline sale arriving at sync (ADR-0027, OFFLINE_SYNC 4, 7 and 9, B09b continued 2b). Pure: every
 * time is passed in (ADR-0067). A synced sale is always recorded; what these rules find becomes a flag on the sale and
 * an exception for a person, never a refusal (the owner on A-273 (g), A-278).
 */

/** How old an offline sale may be at sync before it is flagged: the default of `sync.max_sale_age_hours` (A-278 (c)). */
export const MAX_SALE_AGE_HOURS = 8;
/** The setting the bound is read from. */
export const MAX_SALE_AGE_SETTING = 'sync.max_sale_age_hours';
/** The most sales one sync batch takes (OFFLINE_SYNC 6.3). */
export const MAX_SYNC_BATCH = 500;
const COUNTER_PAD = 4;
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_HOUR = 3_600_000;

/** What sync needs to know of the shift a queued sale belongs to. */
export interface ShiftAtSync {
  readonly status: 'OPEN' | 'CLOSING' | 'CLOSED';
  readonly forceClosed: boolean;
  readonly closedAt: Date | null;
}

export type LatePostingReason = 'PERIOD_LOCKED' | 'SHIFT_CLOSED' | 'AFTER_FORCE_CLOSE';
export type Severity = 'URGENT' | 'REVIEW';

/** The device counter values missing below the highest synced on the shift, counted from 1 (OFFLINE_SYNC 4.2). */
export function counterGaps(counters: readonly number[]): number[] {
  const seen = new Set(counters);
  const highest = counters.reduce((max, c) => (c > max ? c : max), 0);
  const missing: number[] = [];
  for (let c = 1; c < highest; c += 1) if (!seen.has(c)) missing.push(c);
  return missing;
}

/** The gaps a sync has opened that were not missing before it, so each missing value is reported once. */
export function newGaps(before: readonly number[], after: readonly number[]): number[] {
  const known = new Set(before);
  return after.filter((c) => !known.has(c));
}

/** `P-<REGISTER>-<SHIFT SEQ>-<COUNTER>`, the counter zero-padded to four digits (OFFLINE_SYNC 4.3). */
export function provisionalRef(registerCode: string, shiftSeq: number, deviceCounter: number): string {
  return `P-${registerCode}-${shiftSeq}-${String(deviceCounter).padStart(COUNTER_PAD, '0')}`;
}

/**
 * Whether a time the till stamped is outside the clock tolerance (OFFLINE_SYNC 4.1, the owner on A-273 (g)): later than
 * the server received it by more than the tolerance, or earlier than its shift opened by more than it. A sale hours
 * old within its shift is ordinary offline time. Null when within.
 */
export function tillClockVerdict(tillTime: Date, receivedAt: Date, shiftOpenedAt: Date, toleranceSeconds: number): 'AHEAD_OF_SERVER' | 'BEFORE_SHIFT_OPENED' | null {
  const tolerance = toleranceSeconds * MILLISECONDS_PER_SECOND;
  if (tillTime.getTime() - receivedAt.getTime() > tolerance) return 'AHEAD_OF_SERVER';
  if (shiftOpenedAt.getTime() - tillTime.getTime() > tolerance) return 'BEFORE_SHIFT_OPENED';
  return null;
}

/** Whether the sale happened longer ago than the bound when the server received it (A-278 (c)). */
export function saleTooOld(occurredAt: Date, receivedAt: Date, maxHours: number): boolean {
  return receivedAt.getTime() - occurredAt.getTime() > maxHours * MILLISECONDS_PER_HOUR;
}

/**
 * Why a synced sale is flagged as posted late (ADR-0027 point 6, OFFLINE_SYNC 9.4): dated after its shift was
 * force-closed first, then any sale of a shift no longer open, then a sale whose own date's period is no longer open
 * and so posts on the first open date. Null for an open shift posting on its own date.
 */
export function latePostingReason(facts: { readonly occurredDate: string; readonly postingDate: string; readonly occurredAt: Date; readonly shift: ShiftAtSync }): LatePostingReason | null {
  const { shift } = facts;
  if (shift.forceClosed && shift.closedAt !== null && facts.occurredAt.getTime() > shift.closedAt.getTime()) return 'AFTER_FORCE_CLOSE';
  if (shift.status !== 'OPEN') return 'SHIFT_CLOSED';
  if (facts.postingDate !== facts.occurredDate) return 'PERIOD_LOCKED';
  return null;
}

/** A sale made on a shift after it was force-closed is the suspicious one (OFFLINE_SYNC 9.4.2). */
export function severityOfLatePosting(reason: LatePostingReason): Severity {
  return reason === 'AFTER_FORCE_CLOSE' ? 'URGENT' : 'REVIEW';
}

/**
 * The one place that decides whether a queued sale's cash goes into its till (ADR-0077 offline, A-278 (e), LOUD): only
 * on its own shift while that shift is OPEN. A closed, closing or force-closed shift takes no cash: the sale and its
 * receipt are recorded, the receipt stays outstanding and an URGENT exception carries the cash the till claimed.
 */
export function tillTakesCash(shift: ShiftAtSync): boolean {
  return shift.status === 'OPEN';
}

/** Whole seconds between two instants, for an exception's facts. */
export function secondsBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / MILLISECONDS_PER_SECOND);
}

/** The sales of a batch in ascending device counter, whatever order they came in (OFFLINE_SYNC 6.2). */
export function inCounterOrder<T extends { readonly deviceCounter: number }>(sales: readonly T[]): T[] {
  return [...sales].sort((a, b) => a.deviceCounter - b.deviceCounter);
}

/** A line's number as the till and the order count it, from 1. */
export function lineNoOf(index: number): number {
  return index + 1;
}

/** How many times each value occurs. */
export function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}
