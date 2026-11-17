import { err, Money, ok, type Result } from '@hakorem/kernel';

/**
 * The till's cash (FR-POS-005, FR-POS-016, FR-POS-018, FR-POS-019). Pure: every amount is an exact integer of pesewas;
 * nothing here rounds, because a till only adds and takes away whole pesewas.
 */

export type CashMovementKind = 'FLOAT_IN' | 'CASH_DROP' | 'PAY_OUT' | 'PAY_IN';
export type OverShortDirection = 'OVER' | 'SHORT' | 'EXACT';

/** The reasons each movement a person records may carry (A-273 (c)): a drop goes to the safe, a pay-in comes from it. */
export const REASONS_BY_KIND: Readonly<Record<Exclude<CashMovementKind, 'FLOAT_IN'>, readonly string[]>> = {
  CASH_DROP: ['SAFE_DROP'],
  PAY_OUT: ['FUEL_PAYOUT', 'SUPPLIER_PAYOUT', 'OTHER_PAYOUT'],
  PAY_IN: ['FLOAT_TOP_UP'],
};
const REASON_DOMAIN = 'CASH_MOVEMENT';

export interface TillFigures {
  readonly float: Money;
  /** The cash payments of the shift that stand (not reversed): what each sale kept after change. */
  readonly cashTaken: Money;
  readonly payIns: Money;
  readonly drops: Money;
  readonly payOuts: Money;
}

/** Float plus cash taken plus pay-ins, less drops and pay-outs; a till never holds less than nothing. */
export function expectedCash(f: TillFigures): Result<Money, 'TILL_OVERDRAWN'> {
  const into = f.float.plus(f.cashTaken).plus(f.payIns);
  const out = f.drops.plus(f.payOuts);
  if (out.compareTo(into) > 0) return err('TILL_OVERDRAWN');
  return ok(into.minus(out));
}

/** Declared minus expected, as an amount that is never negative and its direction. */
export function overShort(declared: Money, expected: Money): { readonly amount: Money; readonly direction: OverShortDirection } {
  const order = declared.compareTo(expected);
  if (order < 0) return { amount: expected.minus(declared), direction: 'SHORT' };
  if (order > 0) return { amount: declared.minus(expected), direction: 'OVER' };
  return { amount: Money.zero(), direction: 'EXACT' };
}

/**
 * The amounts of `pos.ShiftClosed` (ADR-0003, FR-POS-019): the till is emptied of what it should hold (Cr 1000), what
 * was counted goes to the safe (Dr 1010), and the difference to 6900 (Dr when short, Cr when over). Balanced by
 * construction: returnedToSafe + short = expected + over.
 */
export function closeAmounts(declared: Money, expected: Money): { readonly expected: Money; readonly returnedToSafe: Money; readonly short: Money; readonly over: Money } {
  const difference = overShort(declared, expected);
  return {
    expected,
    returnedToSafe: declared,
    short: difference.direction === 'SHORT' ? difference.amount : Money.zero(),
    over: difference.direction === 'OVER' ? difference.amount : Money.zero(),
  };
}

export type TenderKind = 'CASH' | 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'STORE_CREDIT';

/** The change a sale gives: what each cash tender was handed over beyond what it applies; only cash gives change. */
export function changeDue(tenders: readonly { readonly kind: TenderKind; readonly amount: Money; readonly tendered: Money | null }[]): Result<Money, 'TENDERED_BELOW_AMOUNT' | 'CHANGE_ONLY_FROM_CASH'> {
  let change = Money.zero();
  for (const tender of tenders) {
    if (tender.tendered === null) continue;
    if (tender.kind !== 'CASH') return err('CHANGE_ONLY_FROM_CASH');
    if (tender.tendered.compareTo(tender.amount) < 0) return err('TENDERED_BELOW_AMOUNT');
    change = change.plus(tender.tendered.minus(tender.amount));
  }
  return ok(change);
}

export interface CashMovementFacts {
  readonly kind: Exclude<CashMovementKind, 'FLOAT_IN'>;
  readonly amount: Money;
  readonly reasonCode: string | null;
  /** The domain of the reason as MDM holds it; null when the code is unknown. */
  readonly reasonDomain: string | null;
  readonly reasonNeedsNote: boolean;
  readonly note: string | null;
  readonly witnessId: string | null;
  readonly cashierId: string;
  readonly actorId: string;
  /** The witness holds the count sign-off permission at the shift's branch (A-273 (d)). */
  readonly witnessIsSupervisor: boolean;
  /** What the till should hold before this movement. */
  readonly tillHolds: Money;
}

export interface CashMovementRule {
  readonly field: string;
  readonly rule: string;
}

/**
 * What a cash movement breaks (FR-POS-016, A-273): a reason from the fixed list for its kind, a note when the reason
 * needs one, a drop witnessed by a supervisor who is neither the cashier nor the person recording it, and never more
 * taken out than the till holds.
 */
export function judgeCashMovement(m: CashMovementFacts): CashMovementRule[] {
  const broken: CashMovementRule[] = [];
  if (m.amount.isZero()) broken.push({ field: '/amountPesewas', rule: 'AMOUNT_NOT_POSITIVE' });
  if (m.reasonCode === null) broken.push({ field: '/reasonCode', rule: 'REASON_REQUIRED' });
  else if (m.reasonDomain !== REASON_DOMAIN || !REASONS_BY_KIND[m.kind].includes(m.reasonCode)) broken.push({ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' });
  else if (m.reasonNeedsNote && (m.note === null || m.note.trim() === '')) broken.push({ field: '/note', rule: 'NOTE_REQUIRED' });
  if (m.kind === 'CASH_DROP') {
    if (m.witnessId === null) broken.push({ field: '/witnessId', rule: 'WITNESS_REQUIRED' });
    else if (m.witnessId === m.cashierId || m.witnessId === m.actorId) broken.push({ field: '/witnessId', rule: 'WITNESS_IS_MAKER' });
    else if (!m.witnessIsSupervisor) broken.push({ field: '/witnessId', rule: 'WITNESS_NOT_SUPERVISOR' });
  } else if (m.witnessId !== null) {
    broken.push({ field: '/witnessId', rule: 'WITNESS_ONLY_ON_DROP' });
  }
  if (m.kind !== 'PAY_IN' && m.amount.compareTo(m.tillHolds) > 0) broken.push({ field: '/amountPesewas', rule: 'TILL_OVERDRAWN' });
  return broken;
}

/** The supervisor signing off a count is never its cashier (FR-POS-018, held again by `ck_shift_close_checker`). */
export function judgeCountSignOff(cashierId: string, approverId: string): Result<string, 'CLOSE_APPROVER_IS_CASHIER'> {
  return approverId === cashierId ? err('CLOSE_APPROVER_IS_CASHIER') : ok(approverId);
}
