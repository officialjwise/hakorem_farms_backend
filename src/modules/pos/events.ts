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

/** Where an offline sale was made: the till, the shift, the device and the cashier it is attributed to. */
interface OfflineSaleSource {
  readonly saleId: string;
  readonly shiftId: string;
  readonly branchId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly deviceId: string;
  readonly cashierId: string;
  readonly deviceCounter: number;
  readonly provisionalRef: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/**
 * `pos.OfflineSaleFlagged`: something about a synced offline sale a person must look at (ADR-0027 point 10, OFFLINE_SYNC
 * 8, B09b continued 2b). The sale is recorded whatever it is; this reaches the daily exception report's source with the
 * cashier, the register, the shift, the amount and the two conflicting facts (`claim`, what the till said; `fact`, what
 * the server holds), for B12. One event per finding.
 */
export interface OfflineSaleFlagged extends OfflineSaleSource {
  readonly exceptionKind:
    | 'STOCK_EXCEPTION'
    | 'PRICE_OVERRIDE'
    | 'NOT_PRICED_AT_SYNC'
    | 'UNIT_NOT_SOLD'
    | 'PROVISIONAL_REF_MISMATCH'
    | 'TENDERS_DIFFER'
    | 'UNMATCHED_PAYMENT'
    | 'OFFLINE_CASH_NOT_TAKEN'
    | 'OFFLINE_LATE_POSTING'
    | 'TILL_CLOCK_OUT_OF_TOLERANCE'
    | 'OFFLINE_SALE_TOO_OLD'
    | 'AUTHORISATION_FAILURE';
  readonly severity: 'URGENT' | 'REVIEW';
  readonly summary: string;
  readonly amountPesewas: number;
  readonly claim: Readonly<Record<string, unknown>>;
  readonly fact: Readonly<Record<string, unknown>>;
  readonly abuseCases: readonly number[];
}

/**
 * `pos.OfflineSaleRejected`: a queued sale refused for integrity (OFFLINE_SYNC 9.8): its content no longer matches the
 * hash the till printed it with, its id was used before for other content, its counter belongs to another sale, or the
 * catalogue cannot read it. Nothing is recorded but the log row and this; it carries the submission as received and both
 * hashes, URGENT, for the daily exception report (`SYNC_REJECTED`, abuse case 10).
 */
export interface OfflineSaleRejected extends OfflineSaleSource {
  readonly exceptionKind: 'SYNC_REJECTED';
  readonly severity: 'URGENT';
  readonly rule: string;
  readonly receivedHash: string;
  readonly recomputedHash: string;
  readonly submitted: unknown;
  readonly amountPesewas: number;
  readonly abuseCases: readonly number[];
}

/**
 * `pos.DeviceCounterGap`: device counter values of a shift that have not arrived while higher ones have (FR-POS-013,
 * OFFLINE_SYNC 9.5, abuse case 10): raised once for each value newly missing, URGENT, for the daily exception report.
 */
export interface DeviceCounterGap {
  readonly shiftId: string;
  readonly branchId: string;
  readonly register: { readonly id: string; readonly code: string };
  readonly deviceId: string;
  readonly cashierId: string;
  readonly missing: readonly number[];
  readonly highestSynced: number;
  readonly exceptionKind: 'DEVICE_COUNTER_GAP';
  readonly severity: 'URGENT';
  readonly abuseCases: readonly number[];
}
