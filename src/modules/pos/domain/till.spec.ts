import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { changeDue, closeAmounts, expectedCash, judgeCashMovement, isUnwitnessedDrop, judgeCountSignOff, judgeForceClose, judgeLateCount, judgeLateTillCash, judgeTillCash, lateEntryAdjustment, lateEntryEffect, overShort, shiftOverrideRoom, type CashMovementFacts } from './till';

const p = (n: bigint) => Money.ofPesewas(n);
const MAX = 9_007_199_254_740_991n;

describe('expected cash (FR-POS-019)', () => {
  it('is the float plus cash taken plus pay-ins, less drops and pay-outs: 50,000 + 44,000 - 30,000 is 64,000', () => {
    const expected = expectedCash({ float: p(50_000n), cashTaken: p(44_000n), payIns: p(0n), drops: p(30_000n), payOuts: p(0n) });
    expect(expected).toEqual({ ok: true, value: p(64_000n) });
  });

  it('adds a pay-in from the safe and takes off a pay-out to the pesewa', () => {
    const expected = expectedCash({ float: p(20_000n), cashTaken: p(94_001n), payIns: p(5_000n), drops: p(30_000n), payOuts: p(1_250n) });
    expect(expected).toEqual({ ok: true, value: p(87_751n) });
  });

  it('is zero for a till that took nothing and kept no float', () => {
    expect(expectedCash({ float: p(0n), cashTaken: p(0n), payIns: p(0n), drops: p(0n), payOuts: p(0n) })).toEqual({ ok: true, value: p(0n) });
  });

  it('holds the largest amount the pesewa domain carries', () => {
    expect(expectedCash({ float: p(MAX - 1n), cashTaken: p(1n), payIns: p(0n), drops: p(0n), payOuts: p(0n) })).toEqual({ ok: true, value: p(MAX) });
  });

  it('refuses a till that would pay out more than it holds, by one pesewa', () => {
    expect(expectedCash({ float: p(20_000n), cashTaken: p(0n), payIns: p(0n), drops: p(15_000n), payOuts: p(5_001n) })).toEqual({ ok: false, error: 'TILL_OVERDRAWN' });
  });
});

describe('over and short (FR-POS-019): declared minus expected, never negative, with its direction', () => {
  it('is short 500 when 63,500 is declared against 64,000 expected', () => {
    expect(overShort(p(63_500n), p(64_000n))).toEqual({ amount: p(500n), direction: 'SHORT' });
  });

  it('is over 1 when one pesewa more is declared than expected', () => {
    expect(overShort(p(64_001n), p(64_000n))).toEqual({ amount: p(1n), direction: 'OVER' });
  });

  it('is exact at zero', () => {
    expect(overShort(p(64_000n), p(64_000n))).toEqual({ amount: p(0n), direction: 'EXACT' });
  });

  it('posts a short close as 1010 debited 63,500, 6900 debited 500 and 1000 credited 64,000', () => {
    const amounts = closeAmounts(p(63_500n), p(64_000n));
    expect(amounts).toEqual({ expected: p(64_000n), returnedToSafe: p(63_500n), short: p(500n), over: p(0n) });
    expect(amounts.returnedToSafe.plus(amounts.short).equals(amounts.expected.plus(amounts.over))).toBe(true);
  });

  it('posts an over close with the excess credited to 6900, balanced to the pesewa', () => {
    const amounts = closeAmounts(p(64_250n), p(64_000n));
    expect(amounts).toEqual({ expected: p(64_000n), returnedToSafe: p(64_250n), short: p(0n), over: p(250n) });
    expect(amounts.returnedToSafe.plus(amounts.short).equals(amounts.expected.plus(amounts.over))).toBe(true);
  });

  it('posts an empty till with nothing declared as no amount at all', () => {
    expect(closeAmounts(p(0n), p(0n))).toEqual({ expected: p(0n), returnedToSafe: p(0n), short: p(0n), over: p(0n) });
  });
});

describe('change (FR-POS-005): only cash gives change', () => {
  it('gives 6,000 change on 50,000 cash handed over for 44,000, beside 50,000 of mobile money', () => {
    expect(changeDue([
      { kind: 'MOBILE_MONEY', amount: p(50_000n), tendered: null },
      { kind: 'CASH', amount: p(44_000n), tendered: p(50_000n) },
    ])).toEqual({ ok: true, value: p(6_000n) });
  });

  it('gives no change when the cash handed over is not stated, or is exactly what was applied', () => {
    expect(changeDue([{ kind: 'CASH', amount: p(44_000n), tendered: null }])).toEqual({ ok: true, value: p(0n) });
    expect(changeDue([{ kind: 'CASH', amount: p(44_000n), tendered: p(44_000n) }])).toEqual({ ok: true, value: p(0n) });
  });

  it('adds the change of two cash tenders', () => {
    expect(changeDue([
      { kind: 'CASH', amount: p(10_000n), tendered: p(10_500n) },
      { kind: 'CASH', amount: p(4_000n), tendered: p(5_000n) },
    ])).toEqual({ ok: true, value: p(1_500n) });
  });

  it('refuses cash handed over below what it applies, by one pesewa', () => {
    expect(changeDue([{ kind: 'CASH', amount: p(44_000n), tendered: p(43_999n) }])).toEqual({ ok: false, error: 'TENDERED_BELOW_AMOUNT' });
  });

  it('refuses an amount handed over on a tender that is not cash', () => {
    expect(changeDue([{ kind: 'MOBILE_MONEY', amount: p(50_000n), tendered: p(50_000n) }])).toEqual({ ok: false, error: 'CHANGE_ONLY_FROM_CASH' });
  });
});

const movement = (over: Partial<CashMovementFacts> = {}): CashMovementFacts => ({
  kind: 'CASH_DROP',
  amount: p(30_000n),
  reasonCode: 'SAFE_DROP',
  reasonDomain: 'CASH_MOVEMENT',
  reasonNeedsNote: false,
  note: null,
  witnessId: 'witness',
  cashierId: 'cashier',
  actorId: 'cashier',
  witnessIsSupervisor: true,
  supervisorSignedIn: true,
  tillHolds: p(64_000n),
  ...over,
});

describe('a cash movement (FR-POS-016)', () => {
  it('accepts a drop of 30,000 to the safe with its reason and a supervisor as witness', () => {
    expect(judgeCashMovement(movement())).toEqual([]);
  });

  it('refuses a drop with no reason, and a reason of another domain or kind', () => {
    expect(judgeCashMovement(movement({ reasonCode: null, reasonDomain: null }))).toEqual([{ field: '/reasonCode', rule: 'REASON_REQUIRED' }]);
    expect(judgeCashMovement(movement({ reasonDomain: 'PRICE_OVERRIDE' }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
    expect(judgeCashMovement(movement({ reasonCode: 'FUEL_PAYOUT' }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
  });

  it('refuses a drop with no witness, witnessed by the cashier or by the person recording it, or by someone who is not a supervisor', () => {
    expect(judgeCashMovement(movement({ witnessId: null }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_REQUIRED' }]);
    expect(judgeCashMovement(movement({ witnessId: 'cashier' }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_IS_MAKER' }]);
    expect(judgeCashMovement(movement({ actorId: 'manager', witnessId: 'manager' }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_IS_MAKER' }]);
    expect(judgeCashMovement(movement({ witnessIsSupervisor: false }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_NOT_SUPERVISOR' }]);
  });

  it('a drop with no witness while a supervisor is signed in at the branch still needs the witness (the owner on A-273 (d))', () => {
    expect(judgeCashMovement(movement({ witnessId: null, supervisorSignedIn: true }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_REQUIRED' }]);
  });

  it('takes a drop with no witness when no supervisor is signed in at the branch, so a one-person shop is never forced to keep cash in the drawer', () => {
    expect(judgeCashMovement(movement({ witnessId: null, witnessIsSupervisor: false, supervisorSignedIn: false }))).toEqual([]);
    expect(isUnwitnessedDrop(movement({ witnessId: null, witnessIsSupervisor: false, supervisorSignedIn: false }))).toBe(true);
    expect(isUnwitnessedDrop(movement())).toBe(false);
    expect(isUnwitnessedDrop(movement({ kind: 'PAY_OUT', reasonCode: 'OTHER_PAYOUT', witnessId: null, supervisorSignedIn: false }))).toBe(false);
  });

  it('still refuses a named witness who is the maker or not a supervisor when no supervisor is signed in', () => {
    expect(judgeCashMovement(movement({ witnessId: 'cashier', supervisorSignedIn: false }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_IS_MAKER' }]);
    expect(judgeCashMovement(movement({ witnessIsSupervisor: false, supervisorSignedIn: false }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_NOT_SUPERVISOR' }]);
  });

  it('takes a pay-out for fuel with its note and no witness, and refuses one that needs a note without it', () => {
    expect(judgeCashMovement(movement({ kind: 'PAY_OUT', reasonCode: 'FUEL_PAYOUT', reasonNeedsNote: true, note: 'Motorbike fuel, receipt kept', witnessId: null, witnessIsSupervisor: false }))).toEqual([]);
    expect(judgeCashMovement(movement({ kind: 'PAY_OUT', reasonCode: 'FUEL_PAYOUT', reasonNeedsNote: true, note: null, witnessId: null, witnessIsSupervisor: false }))).toEqual([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
  });

  it('takes a pay-in only as the float topped up from the safe', () => {
    expect(judgeCashMovement(movement({ kind: 'PAY_IN', reasonCode: 'FLOAT_TOP_UP', witnessId: null, witnessIsSupervisor: false }))).toEqual([]);
    expect(judgeCashMovement(movement({ kind: 'PAY_IN', reasonCode: 'OTHER_PAYOUT', witnessId: null, witnessIsSupervisor: false }))).toEqual([{ field: '/reasonCode', rule: 'REASON_NOT_FOR_KIND' }]);
  });

  it('refuses a witness on a pay-out or pay-in, since only a drop is witnessed', () => {
    expect(judgeCashMovement(movement({ kind: 'PAY_IN', reasonCode: 'FLOAT_TOP_UP' }))).toEqual([{ field: '/witnessId', rule: 'WITNESS_ONLY_ON_DROP' }]);
  });

  it('refuses taking out one pesewa more than the till holds, and an amount of zero', () => {
    expect(judgeCashMovement(movement({ amount: p(64_001n) }))).toEqual([{ field: '/amountPesewas', rule: 'TILL_OVERDRAWN' }]);
    expect(judgeCashMovement(movement({ amount: p(64_000n) }))).toEqual([]);
    expect(judgeCashMovement(movement({ amount: p(0n) }))).toEqual([{ field: '/amountPesewas', rule: 'AMOUNT_NOT_POSITIVE' }]);
  });

  it('never compares a pay-in with what the till holds, because it brings cash in', () => {
    expect(judgeCashMovement(movement({ kind: 'PAY_IN', reasonCode: 'FLOAT_TOP_UP', witnessId: null, witnessIsSupervisor: false, tillHolds: p(0n), amount: p(5_000n) }))).toEqual([]);
  });
});

describe('the sign-off of a count (FR-POS-018): never the cashier', () => {
  it('refuses the cashier signing off their own close', () => {
    expect(judgeCountSignOff('cashier', 'cashier')).toEqual({ ok: false, error: 'CLOSE_APPROVER_IS_CASHIER' });
  });

  it('accepts a different supervisor', () => {
    expect(judgeCountSignOff('cashier', 'supervisor')).toEqual({ ok: true, value: 'supervisor' });
  });
});

describe('a late entry of cash from the queue (ADR-0077 Amendments, the owner on 2026-11-18)', () => {
  const closed = { status: 'CLOSED' as const, registerId: 'T1', branchId: 'DDW', cashierId: 'adwoa' };
  const cash = { registerId: 'T1', branchId: 'DDW', actorId: 'adwoa', direction: 'IN' as const };

  it('raises the expected cash for a sale\'s cash and a pay-in, lowers it for a drop and a pay-out', () => {
    expect(lateEntryEffect('SALE_CASH')).toBe('RAISES');
    expect(lateEntryEffect('PAY_IN')).toBe('RAISES');
    expect(lateEntryEffect('CASH_DROP')).toBe('LOWERS');
    expect(lateEntryEffect('PAY_OUT')).toBe('LOWERS');
  });

  it('moves the over or short by exactly the entry: short when it raises the expected cash, over when it lowers it', () => {
    expect(lateEntryAdjustment('SALE_CASH', Money.ofPesewas(4_500n))).toEqual({ direction: 'SHORT', amount: Money.ofPesewas(4_500n), amountsPesewas: { short: 4_500, over: 0 } });
    expect(lateEntryAdjustment('CASH_DROP', Money.ofPesewas(10_001n))).toEqual({ direction: 'OVER', amount: Money.ofPesewas(10_001n), amountsPesewas: { short: 0, over: 10_001 } });
    expect(lateEntryAdjustment('PAY_IN', Money.ofPesewas(1n)).amountsPesewas).toEqual({ short: 1, over: 0 });
    expect(lateEntryAdjustment('PAY_OUT', Money.ofPesewas(1n)).amountsPesewas).toEqual({ short: 0, over: 1 });
    expect(() => lateEntryAdjustment('SALE_CASH', Money.zero())).toThrow(/above zero/);
  });

  it('takes cash into the shift it happened in once it is closing, closed or force-closed, by its own cashier on its own till', () => {
    expect(judgeLateTillCash(closed, cash)).toEqual({ ok: true, value: null });
    expect(judgeLateTillCash({ ...closed, status: 'CLOSING' }, cash)).toEqual({ ok: true, value: null });
  });

  it('refuses a shift still open, which takes the cash on it as any cash', () => {
    expect(judgeLateTillCash({ ...closed, status: 'OPEN' }, cash)).toEqual({ ok: false, error: 'SHIFT_STILL_OPEN' });
  });

  it('never takes cash out late, never for another cashier, not even one who may recover a till, and never another till or branch', () => {
    expect(judgeLateTillCash(closed, { ...cash, direction: 'OUT' })).toEqual({ ok: false, error: 'LATE_ENTRY_ONLY_IN' });
    expect(judgeLateTillCash(closed, { ...cash, actorId: 'kwabena' })).toEqual({ ok: false, error: 'SHIFT_NOT_OWN' });
    expect(judgeLateTillCash(closed, { ...cash, registerId: 'T2' })).toEqual({ ok: false, error: 'SHIFT_OTHER_REGISTER' });
    expect(judgeLateTillCash(closed, { ...cash, registerId: null })).toEqual({ ok: false, error: 'SHIFT_OTHER_REGISTER' });
    expect(judgeLateTillCash(closed, { ...cash, branchId: 'KMS' })).toEqual({ ok: false, error: 'SHIFT_OTHER_BRANCH' });
  });
});

describe('cash through a till shift (ADR-0077, A-212 (a), A-273 (i) and (k))', () => {
  const shift = { status: 'OPEN' as const, registerId: 'T1', branchId: 'DDW', cashierId: 'adwoa' };
  const cash = { registerId: 'T1', branchId: 'DDW', actorId: 'adwoa', actorRecoversAnyShift: false };

  it('takes cash into or out of the cashier own open shift on its till', () => {
    expect(judgeTillCash(shift, cash)).toEqual({ ok: true, value: null });
    expect(judgeTillCash(shift, { ...cash, registerId: null })).toEqual({ ok: true, value: null });
  });

  it('refuses a shift that is closing, closed or force-closed', () => {
    expect(judgeTillCash({ ...shift, status: 'CLOSING' }, cash)).toEqual({ ok: false, error: 'SHIFT_NOT_OPEN' });
    expect(judgeTillCash({ ...shift, status: 'CLOSED' }, cash)).toEqual({ ok: false, error: 'SHIFT_NOT_OPEN' });
  });

  it('refuses another cashier, unless they may recover any shift of the branch', () => {
    expect(judgeTillCash(shift, { ...cash, actorId: 'nana' })).toEqual({ ok: false, error: 'SHIFT_NOT_OWN' });
    expect(judgeTillCash(shift, { ...cash, actorId: 'kwabena', actorRecoversAnyShift: true })).toEqual({ ok: true, value: null });
  });

  it('refuses another till or another branch than the shift is on', () => {
    expect(judgeTillCash(shift, { ...cash, registerId: 'T2' })).toEqual({ ok: false, error: 'SHIFT_OTHER_REGISTER' });
    expect(judgeTillCash(shift, { ...cash, branchId: 'KMS' })).toEqual({ ok: false, error: 'SHIFT_OTHER_BRANCH' });
  });

  it('refuses a closed shift before anything else, even to the shift own cashier on its own till', () => {
    expect(judgeTillCash({ ...shift, status: 'CLOSED' }, { ...cash, actorId: 'nana', registerId: 'T2' })).toEqual({ ok: false, error: 'SHIFT_NOT_OPEN' });
  });
});

describe('what a shift has left of its override limit (FR-POS-004)', () => {
  it('is the limit less what the shift already gave below list, never below zero', () => {
    expect(shiftOverrideRoom(p(10_000n), p(4_000n)).pesewas).toBe(6_000n);
    expect(shiftOverrideRoom(p(10_000n), p(10_000n)).pesewas).toBe(0n);
    expect(shiftOverrideRoom(p(10_000n), p(10_001n)).pesewas).toBe(0n);
    expect(shiftOverrideRoom(p(0n), p(0n)).pesewas).toBe(0n);
  });
});

describe('the force close (FR-POS-020): a manager who is not the cashier closes an open shift', () => {
  const open = { status: 'OPEN' as const, cashierId: 'kofi' };

  it('closes the cashier open shift for a manager who is not its cashier', () => {
    expect(judgeForceClose(open, 'kwabena')).toEqual({ ok: true, value: null });
  });

  it('refuses the cashier force-closing their own shift, before anything else', () => {
    expect(judgeForceClose(open, 'kofi')).toEqual({ ok: false, error: 'FORCE_CLOSER_IS_CASHIER' });
    expect(judgeForceClose({ ...open, status: 'CLOSED' }, 'kofi')).toEqual({ ok: false, error: 'FORCE_CLOSER_IS_CASHIER' });
  });

  it('refuses a shift that is closing or closed: a declared count is signed off, not forced', () => {
    expect(judgeForceClose({ ...open, status: 'CLOSING' }, 'kwabena')).toEqual({ ok: false, error: 'SHIFT_NOT_OPEN' });
    expect(judgeForceClose({ ...open, status: 'CLOSED' }, 'kwabena')).toEqual({ ok: false, error: 'SHIFT_NOT_OPEN' });
  });
});

describe('the drawer of a force-closed shift counted later (FR-POS-020): by neither its cashier nor its force-closer', () => {
  const forced = { status: 'CLOSED' as const, forceClosed: true, cashierId: 'kofi', forceClosedBy: 'kwabena', counted: false };

  it('takes the count of a third person', () => {
    expect(judgeLateCount(forced, 'esi')).toEqual({ ok: true, value: null });
  });

  it('refuses the cashier and the manager who force-closed it', () => {
    expect(judgeLateCount(forced, 'kofi')).toEqual({ ok: false, error: 'COUNTER_IS_CASHIER' });
    expect(judgeLateCount(forced, 'kwabena')).toEqual({ ok: false, error: 'COUNTER_IS_FORCE_CLOSER' });
  });

  it('refuses a shift that was not force-closed, and a drawer already counted', () => {
    expect(judgeLateCount({ ...forced, status: 'OPEN', forceClosed: false, forceClosedBy: null }, 'esi')).toEqual({ ok: false, error: 'SHIFT_NOT_FORCE_CLOSED' });
    expect(judgeLateCount({ ...forced, forceClosed: false }, 'esi')).toEqual({ ok: false, error: 'SHIFT_NOT_FORCE_CLOSED' });
    expect(judgeLateCount({ ...forced, counted: true }, 'esi')).toEqual({ ok: false, error: 'SHIFT_ALREADY_COUNTED' });
  });

  it('posts the count against what the shift was closed at: 4,000 expected, 3,750 counted is 250 short to the pesewa', () => {
    expect(closeAmounts(p(3_750n), p(4_000n))).toEqual({ expected: p(4_000n), returnedToSafe: p(3_750n), short: p(250n), over: p(0n) });
    expect(closeAmounts(p(4_001n), p(4_000n))).toEqual({ expected: p(4_000n), returnedToSafe: p(4_001n), short: p(0n), over: p(1n) });
  });
});
