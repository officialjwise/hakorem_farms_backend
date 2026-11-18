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
  /**
   * Present when the count is of a force-closed shift's drawer (FR-POS-020, A-275): `approvedBy` counted it, and
   * `forceClosedBy` is the manager who force-closed it, for the daily exception report (B12).
   */
  readonly forceClosed?: true;
  readonly forceClosedBy?: string;
  readonly amountsPesewas: { readonly expected: number; readonly returnedToSafe: number; readonly short: number; readonly over: number };
}

/**
 * `pos.ShiftForceClosed`: a manager closed an abandoned shift without its count (FR-POS-020). Nothing posts until the
 * drawer is counted (`pos.ShiftClosed` with `forceClosed`). It reaches the daily exception report's source with the
 * cashier, the manager, the reason and the cash the shift was closed at (abuse case 17, B12).
 */
export interface ShiftForceClosed {
  readonly shiftId: string;
  readonly branchId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly cashierId: string;
  readonly shiftNo: string;
  readonly forceClosedBy: string;
  readonly reason: string;
  readonly expectedCashPesewas: number;
  readonly closedAt: string;
  readonly abuseCases: readonly number[];
  readonly exceptionKind: 'SHIFT_FORCE_CLOSED';
}

/**
 * `pos.TillClockOutOfTolerance`: a counter sale whose till time was further from the server's than the tolerance. The
 * sale is recorded at the server's time, never refused (the owner on A-273 (g)); this reaches the daily exception
 * report's source with the device, the cashier and both times (B12).
 */
export interface TillClockOutOfTolerance {
  readonly saleId: string;
  readonly shiftId: string;
  readonly branchId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly deviceId: string;
  readonly cashierId: string;
  readonly tillTime: string;
  readonly serverTime: string;
  readonly differenceSeconds: number;
  readonly toleranceSeconds: number;
  readonly exceptionKind: 'TILL_CLOCK_OUT_OF_TOLERANCE';
}
