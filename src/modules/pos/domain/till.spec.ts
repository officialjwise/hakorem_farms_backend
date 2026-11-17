import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { changeDue, closeAmounts, expectedCash, judgeCashMovement, isUnwitnessedDrop, judgeCountSignOff, overShort, type CashMovementFacts } from './till';

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
