/**
 * The rules of the queue's other records at sync (OFFLINE_SYNC 5.3, 9.9 and 10, B09b continued 2c): a shift the till
 * opened offline, its cash movements, and a mobile money tender taken unverified. Pure: every time is passed in
 * (ADR-0067). A record that passes authentication and integrity is recorded or raised, never silently dropped (A-279).
 */

const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_HOUR = 3_600_000;

export type ShiftOpenClockVerdict = 'AHEAD_OF_SERVER' | 'BEFORE_PREVIOUS_SHIFT_CLOSED';

/**
 * When a shift sent by its till is recorded as opened (OFFLINE_SYNC 10, the owner on A-273 (g), A-279 (b)). A till time
 * within the tolerance of the server is an online open, recorded at the server's time as it always was (ADR-0067); one
 * hours old is a shift opened offline, kept at the till's time. A till time later than the server by more than the
 * tolerance, or earlier than the till's previous shift closed by more than it, cannot be the truth: the shift is
 * recorded at the server's time and flagged, never refused. A shift opened longer ago than the bound is kept and
 * flagged too old.
 */
export function offlineShiftOpenTime(f: {
  readonly tillOpenedAt: Date;
  readonly receivedAt: Date;
  readonly previousClosedAt: Date | null;
  readonly toleranceSeconds: number;
  readonly maxAgeHours: number;
}): { readonly openedAt: Date; readonly verdict: ShiftOpenClockVerdict | null; readonly tooOld: boolean } {
  const tolerance = f.toleranceSeconds * MILLISECONDS_PER_SECOND;
  const till = f.tillOpenedAt.getTime();
  const now = f.receivedAt.getTime();
  if (till - now > tolerance) return { openedAt: f.receivedAt, verdict: 'AHEAD_OF_SERVER', tooOld: false };
  if (f.previousClosedAt !== null && f.previousClosedAt.getTime() - till > tolerance) return { openedAt: f.receivedAt, verdict: 'BEFORE_PREVIOUS_SHIFT_CLOSED', tooOld: false };
  if (now - till <= tolerance) return { openedAt: f.receivedAt, verdict: null, tooOld: false };
  return { openedAt: f.tillOpenedAt, verdict: null, tooOld: now - till > f.maxAgeHours * MILLISECONDS_PER_HOUR };
}

/**
 * When a cash movement from the queue is recorded as having happened (OFFLINE_SYNC 10, A-279 (e)): at the till's time,
 * though hours old; a till time later than the server by more than the tolerance at the server's time, and one earlier
 * than its shift opened by more than it at the shift's opening, each flagged, so the movement stays inside its shift.
 */
export function cashMovementTimeAtSync(tillTime: Date, receivedAt: Date, shiftOpenedAt: Date, toleranceSeconds: number): { readonly occurredAt: Date; readonly verdict: 'AHEAD_OF_SERVER' | 'BEFORE_SHIFT_OPENED' | null } {
  const tolerance = toleranceSeconds * MILLISECONDS_PER_SECOND;
  if (tillTime.getTime() - receivedAt.getTime() > tolerance) return { occurredAt: receivedAt, verdict: 'AHEAD_OF_SERVER' };
  if (shiftOpenedAt.getTime() - tillTime.getTime() > tolerance) return { occurredAt: shiftOpenedAt, verdict: 'BEFORE_SHIFT_OPENED' };
  return { occurredAt: tillTime, verdict: null };
}

/** What a movement's content is judged by when its id was seen before. */
export interface MovementContent {
  readonly shiftId: string;
  readonly kind: 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN';
  readonly amountPesewas: bigint;
}

/**
 * The answer for a cash movement whose client id was decided before (exactly once, OFFLINE_SYNC 10, A-279 (d)): the
 * same content applied is a `DUPLICATE`; the same content refused is refused again for the first reason, so a refusal
 * never turns into an application on a later sync; other content under that id is refused. Null when never seen.
 */
export function priorMovementAnswer(
  prior: (MovementContent & { readonly outcome: 'APPLIED' | 'REJECTED'; readonly reason: string | null }) | null,
  incoming: MovementContent,
): { readonly outcome: 'DUPLICATE' | 'REJECTED'; readonly reason: string | null } | null {
  if (prior === null) return null;
  if (prior.shiftId !== incoming.shiftId || prior.kind !== incoming.kind || prior.amountPesewas !== incoming.amountPesewas) return { outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' };
  return prior.outcome === 'APPLIED' ? { outcome: 'DUPLICATE', reason: null } : { outcome: 'REJECTED', reason: prior.reason };
}

/** What sync knows of a tender that says it is mobile money taken unverified (OFFLINE_SYNC 5.3, 9.9). */
export interface UnverifiedTenderFacts {
  readonly methodKind: string;
  /** `pos.offline.allow_unverified_mobile_money` is on for the till's branch. */
  readonly branchAllows: boolean;
  /** The tender carries `unverifiedMobileMoney` (the payer's phone, the network, who approved it). */
  readonly carriesDetails: boolean;
  /** The pack offered the method offline: a live mobile money method sold at the till. */
  readonly offeredOffline: boolean;
  /** The shift still takes money (`tillTakesCash`, ADR-0077). */
  readonly shiftTakesMoney: boolean;
  /** The approver the till names holds the supervisor's permission at the branch and is not the cashier. */
  readonly approverIsSupervisor: boolean;
  /** The farm has a mobile money wallet to hold it in (1110, OFFLINE_SYNC 9.9). */
  readonly walletKnown: boolean;
}

export type UnverifiedTenderVerdict =
  | { readonly take: true; readonly severity: 'REVIEW' | 'URGENT' }
  | { readonly take: false; readonly reason: 'BRANCH_DOES_NOT_ALLOW' | 'NOT_MOBILE_MONEY' | 'NO_UNVERIFIED_DETAILS' | 'SHIFT_NOT_OPEN' | 'NO_MOBILE_MONEY_WALLET' };

/**
 * Whether a tender is recorded as an `UNVERIFIED` payment (ADR-0027 principle 8, OFFLINE_SYNC 9.9, abuse case 4,
 * A-279 (g)): only while the branch allows it, only mobile money with its details, only onto its own shift while open, and only when the farm has a wallet to hold it in.
 * Its break is for review, or urgent when the pack did not offer the method (a modified client) or the approver the
 * till names is no supervisor (their PIN is B09b continued 3's). Anything not taken stays as B09b continued 2b built it:
 * not recorded, and raised.
 */
export function unverifiedTenderVerdict(f: UnverifiedTenderFacts): UnverifiedTenderVerdict {
  if (!f.branchAllows) return { take: false, reason: 'BRANCH_DOES_NOT_ALLOW' };
  if (f.methodKind !== 'MOBILE_MONEY') return { take: false, reason: 'NOT_MOBILE_MONEY' };
  if (!f.carriesDetails) return { take: false, reason: 'NO_UNVERIFIED_DETAILS' };
  if (!f.shiftTakesMoney) return { take: false, reason: 'SHIFT_NOT_OPEN' };
  if (!f.walletKnown) return { take: false, reason: 'NO_MOBILE_MONEY_WALLET' };
  return { take: true, severity: f.offeredOffline && f.approverIsSupervisor ? 'REVIEW' : 'URGENT' };
}

/** A batch's cash movements in the till's order (OFFLINE_SYNC 6.2): by the till's time, then by id. */
export function inMovementOrder<T extends { readonly id: string; readonly occurredAt: Date }>(movements: readonly T[]): T[] {
  return [...movements].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
}
