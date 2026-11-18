import { err, ok, type Result } from '@hakorem/kernel';

/**
 * Held sales (FR-POS-007, A-276). Pure: a sale parked on the till's open shift by its cashier and recalled once on that
 * shift. It reserves nothing, and it lapses when its shift closes (the cashier's declaration or a force close) or, if the
 * shift runs that long, twelve hours after it was held.
 */

/** The longest a sale stays held while its shift stays open (A-276 (c)). */
export const HELD_SALE_LIFETIME_MS = 43_200_000;

export type HeldSaleStatus = 'HELD' | 'RECALLED' | 'LAPSED';

interface ShiftFacts {
  readonly status: 'OPEN' | 'CLOSING' | 'CLOSED';
  readonly cashierId: string;
}

export interface HeldSaleFacts {
  readonly status: HeldSaleStatus;
  readonly expiresAt: Date;
  /** The shift it was held on. */
  readonly shift: ShiftFacts;
}

/** When a sale held at `heldAt` lapses at the latest. */
export function heldSaleExpiry(heldAt: Date): Date {
  return new Date(heldAt.getTime() + HELD_SALE_LIFETIME_MS);
}

/** A sale is held on the till's open shift, by that shift's own cashier: nobody, a manager included, sells on another's. */
export function judgeHold(shift: ShiftFacts | null, actorId: string): Result<null, 'NO_OPEN_SHIFT' | 'NOT_SHIFT_CASHIER'> {
  if (shift === null || shift.status !== 'OPEN') return err('NO_OPEN_SHIFT');
  if (shift.cashierId !== actorId) return err('NOT_SHIFT_CASHIER');
  return ok(null);
}

/**
 * A held sale is recalled once, before it lapses, while its shift is open, by that shift's cashier. A hold recalled,
 * lapsed, expired or on a shift no longer open is gone, as if it never existed (404).
 */
export function judgeRecall(hold: HeldSaleFacts, actorId: string, now: Date): Result<null, 'HELD_SALE_GONE' | 'NOT_SHIFT_CASHIER'> {
  if (hold.status !== 'HELD' || now.getTime() >= hold.expiresAt.getTime() || hold.shift.status !== 'OPEN') return err('HELD_SALE_GONE');
  if (hold.shift.cashierId !== actorId) return err('NOT_SHIFT_CASHIER');
  return ok(null);
}

/** A held line's number, counted from 1, for the line at `index` of the payload. */
export function lineNoOf(index: number): number {
  return index + 1;
}

/** The payload index of the held line numbered `lineNo`. */
export function indexOfLineNo(lineNo: number): number {
  return lineNo - 1;
}
