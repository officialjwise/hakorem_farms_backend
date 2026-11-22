import type { Transaction } from '../../../platform/database/unit-of-work';

/** Cash going into a till (a tender) or out of it (a refund paid, a payment reversed). */
export type TillCashDirection = 'IN' | 'OUT';

/** What PAY asks before cash moves into or out of a till (the owner on A-212 (a); ADR-0077). */
export interface TillCashRequest {
  /** The till shift the cash is counted in. */
  readonly shiftDocumentId: string;
  /** The till the cash goes into or comes out of, when the caller names one; it must be the shift's. */
  readonly registerId: string | null;
  /** The branch the payment or refund belongs to; the shift's till must be of it. */
  readonly branchId: string;
  /** Who records it: the shift's own cashier, or someone who may recover another cashier's till. */
  readonly actorId: string;
  readonly direction: TillCashDirection;
  /**
   * Cash a till took offline in a shift that has since stopped taking entries, recorded on that shift as a late entry
   * (ADR-0077 Amendments, the owner on 2026-11-18): the shift must no longer take entries, and the actor must be its own
   * cashier. Absent or false, the shift must be OPEN.
   */
  readonly lateEntry?: boolean;
}

/** Why cash may not move through the named shift. */
export type TillCashRefusal = 'SHIFT_UNKNOWN' | 'SHIFT_NOT_OPEN' | 'SHIFT_NOT_OWN' | 'SHIFT_OTHER_REGISTER' | 'SHIFT_OTHER_BRANCH' | 'SHIFT_STILL_OPEN' | 'LATE_ENTRY_ONLY_IN';

export type TillCashAnswer = { readonly ok: true; readonly register: { readonly id: string; readonly code: string; readonly locationId: string } } | { readonly ok: false; readonly refusal: TillCashRefusal };

/**
 * The `TillShiftCheck` port (MODULE_BOUNDARIES section 6, ADR-0077): PAY sits below POS and never reads its tables, so it
 * asks the registered check, in the caller's transaction and under the shift's lock, whether cash may move through a
 * shift: that it is a till shift, OPEN, of the till and branch named, and the actor's own (or the actor may recover another's).
 * Answers null when the document is not a shift this check knows.
 */
export interface TillShiftCheck {
  cashAtIn(tx: Transaction, request: TillCashRequest): Promise<TillCashAnswer | null>;
}

/**
 * Where POS registers its `TillShiftCheck`. Deny by default: with no check registered, or none that knows the shift,
 * every cash movement through a till is refused `SHIFT_UNKNOWN`, so no path in PAY can take or pay out a till's cash
 * that POS has not seen.
 */
export class TillShiftRegistry {
  private readonly checks: TillShiftCheck[] = [];

  register(check: TillShiftCheck): void {
    this.checks.push(check);
  }

  /** One check at a time on the one transaction: a pg client runs one query at a time. */
  async cashAtIn(tx: Transaction, request: TillCashRequest): Promise<TillCashAnswer> {
    for (const check of this.checks) {
      const answer = await check.cashAtIn(tx, request);
      if (answer !== null) return answer;
    }
    return { ok: false, refusal: 'SHIFT_UNKNOWN' };
  }
}
