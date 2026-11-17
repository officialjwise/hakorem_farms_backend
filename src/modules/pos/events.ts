/**
 * POS's published events (DOMAIN_MODEL 5.11). Each ◆ event posts to the ledger in the publisher's transaction (ADR-0003):
 * FIN reads `register`, `amountsPesewas` and `reasonCode`, and posts against the till's register on 1000.
 */

interface TillPosting {
  readonly shiftId: string;
  /** What posts once: the shift for an open or a close, the cash movement otherwise. */
  readonly subjectId: string;
  readonly branchId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly cashierId: string;
  readonly reasonCode: string | null;
}

/** ◆ `pos.ShiftOpened`: the float from the safe into the till (Dr 1000, Cr 1010). */
export interface ShiftOpened extends TillPosting {
  readonly shiftNo: string;
  readonly shiftSeq: number;
  readonly openedAt: string;
  readonly amountsPesewas: { readonly float: number };
}

/** ◆ `pos.CashDropped`, `pos.CashPaidIn` and `pos.CashPaidOut`: a cash movement recorded on an open shift. */
export interface CashMoved extends TillPosting {
  readonly movementId: string;
  readonly kind: 'CASH_DROP' | 'PAY_IN' | 'PAY_OUT';
  readonly witnessId: string | null;
  readonly actorId: string;
  readonly occurredAt: string;
  /**
   * Present on a drop taken while no supervisor was signed in at the branch (the owner on A-273 (d)): it reaches the
   * daily exception report's source as `UNWITNESSED_CASH_DROP` with abuse case 17, the cashier and the amount (B12).
   */
  readonly unwitnessed?: true;
  readonly abuseCases?: readonly number[];
  readonly amountsPesewas: { readonly drop: number } | { readonly payIn: number } | { readonly payOut: number };
}

/**
 * ◆ `pos.ShiftClosed`: a count signed off. It names the cashier, the supervisor and the over or short for the daily
 * exception report (`SHIFT_OVER_SHORT`, abuse case 17, B12).
 */
export interface ShiftClosed extends TillPosting {
  readonly shiftNo: string;
  readonly approvedBy: string;
  readonly reason: string;
  readonly declaredCashPesewas: number;
  readonly expectedCashPesewas: number;
  readonly overShortPesewas: number;
  readonly overShortDirection: 'OVER' | 'SHORT' | 'EXACT';
  readonly closedAt: string;
  readonly abuseCases: readonly number[];
  readonly amountsPesewas: { readonly expected: number; readonly returnedToSafe: number; readonly short: number; readonly over: number };
}
