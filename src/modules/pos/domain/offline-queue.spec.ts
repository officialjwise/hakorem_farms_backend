import { describe, expect, it } from 'vitest';
import { cashMovementTimeAtSync, inMovementOrder, offlineShiftOpenTime, priorMovementAnswer, unverifiedTenderVerdict, type UnverifiedTenderFacts } from './offline-queue';

const at = (iso: string) => new Date(iso);
const TOLERANCE = 300;
const MAX_AGE = 8;

describe('a shift opened offline, at sync (OFFLINE_SYNC 10, the owner on A-273 (g))', () => {
  const received = at('2026-11-13T13:40:00Z');

  it('keeps the till time of a shift opened hours ago, never refusing it', () => {
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T06:00:00Z'), receivedAt: received, previousClosedAt: at('2026-11-12T18:00:00Z'), toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({
      openedAt: at('2026-11-13T06:00:00Z'),
      verdict: null,
      tooOld: false,
    });
  });

  it('records a shift opened within the tolerance at the server time, as an online open always was', () => {
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T13:35:00Z'), receivedAt: received, previousClosedAt: null, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: received, verdict: null, tooOld: false });
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T13:45:00Z'), receivedAt: received, previousClosedAt: null, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: received, verdict: null, tooOld: false });
  });

  it('flags a till time ahead of the server by 301 seconds and records the server time; 300 is not flagged', () => {
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T13:45:01Z'), receivedAt: received, previousClosedAt: null, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: received, verdict: 'AHEAD_OF_SERVER', tooOld: false });
  });

  it('flags a till time 301 seconds before the till last closed and records the server time; 300 before is kept', () => {
    const closed = at('2026-11-13T06:00:00Z');
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T05:54:59Z'), receivedAt: received, previousClosedAt: closed, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: received, verdict: 'BEFORE_PREVIOUS_SHIFT_CLOSED', tooOld: false });
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T05:55:00Z'), receivedAt: received, previousClosedAt: closed, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: at('2026-11-13T05:55:00Z'), verdict: null, tooOld: false });
  });

  it('flags a shift opened more than the bound before it reached the server, keeping its time; exactly the bound is not', () => {
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T05:39:59Z'), receivedAt: received, previousClosedAt: null, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: at('2026-11-13T05:39:59Z'), verdict: null, tooOld: true });
    expect(offlineShiftOpenTime({ tillOpenedAt: at('2026-11-13T05:40:00Z'), receivedAt: received, previousClosedAt: null, toleranceSeconds: TOLERANCE, maxAgeHours: MAX_AGE })).toEqual({ openedAt: at('2026-11-13T05:40:00Z'), verdict: null, tooOld: false });
  });
});

describe('a cash movement from the queue, at sync (OFFLINE_SYNC 10)', () => {
  const received = at('2026-11-13T13:40:00Z');
  const opened = at('2026-11-13T06:00:00Z');

  it('keeps the till time of a movement hours old within its shift', () => {
    expect(cashMovementTimeAtSync(at('2026-11-13T09:15:00Z'), received, opened, TOLERANCE)).toEqual({ occurredAt: at('2026-11-13T09:15:00Z'), verdict: null });
  });

  it('records a till time ahead of the server at the server time, flagged; 300 seconds ahead is kept', () => {
    expect(cashMovementTimeAtSync(at('2026-11-13T13:45:01Z'), received, opened, TOLERANCE)).toEqual({ occurredAt: received, verdict: 'AHEAD_OF_SERVER' });
    expect(cashMovementTimeAtSync(at('2026-11-13T13:45:00Z'), received, opened, TOLERANCE)).toEqual({ occurredAt: at('2026-11-13T13:45:00Z'), verdict: null });
  });

  it('records a till time before its shift opened at the shift opening, flagged; 300 seconds before is kept', () => {
    expect(cashMovementTimeAtSync(at('2026-11-13T05:54:59Z'), received, opened, TOLERANCE)).toEqual({ occurredAt: opened, verdict: 'BEFORE_SHIFT_OPENED' });
    expect(cashMovementTimeAtSync(at('2026-11-13T05:55:00Z'), received, opened, TOLERANCE)).toEqual({ occurredAt: at('2026-11-13T05:55:00Z'), verdict: null });
  });

  it('applies a batch\'s movements in the till\'s order, by time and then by id, whatever order they came in', () => {
    const m = (id: string, iso: string) => ({ id, occurredAt: at(iso) });
    expect(inMovementOrder([m('b', '2026-11-13T09:00:00Z'), m('c', '2026-11-13T08:00:00Z'), m('a', '2026-11-13T09:00:00Z')]).map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('answers a movement seen before: a duplicate of the one applied, the first refusal again, or other content refused', () => {
    const incoming = { shiftId: 's1', kind: 'CASH_DROP' as const, amountPesewas: 100_000n };
    expect(priorMovementAnswer(null, incoming)).toBeNull();
    expect(priorMovementAnswer({ ...incoming, outcome: 'APPLIED', reason: null }, incoming)).toEqual({ outcome: 'DUPLICATE', reason: null });
    expect(priorMovementAnswer({ ...incoming, outcome: 'REJECTED', reason: 'SHIFT_NOT_OPEN' }, incoming)).toEqual({ outcome: 'REJECTED', reason: 'SHIFT_NOT_OPEN' });
    expect(priorMovementAnswer({ ...incoming, outcome: 'APPLIED', reason: null }, { ...incoming, amountPesewas: 100_001n })).toEqual({ outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' });
    expect(priorMovementAnswer({ ...incoming, outcome: 'APPLIED', reason: null }, { ...incoming, kind: 'PAY_OUT' })).toEqual({ outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' });
    expect(priorMovementAnswer({ ...incoming, outcome: 'REJECTED', reason: 'SHIFT_NOT_OPEN' }, { ...incoming, shiftId: 's2' })).toEqual({ outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' });
  });
});

describe('the unverified mobile money tender, at sync (OFFLINE_SYNC 5.3 and 9.9, abuse case 4)', () => {
  const allowed: UnverifiedTenderFacts = { methodKind: 'MOBILE_MONEY', branchAllows: true, carriesDetails: true, offeredOffline: true, shiftTakesMoney: true, approverIsSupervisor: true, walletKnown: true };

  it('takes a mobile money tender with its details while the branch allows it, for review', () => {
    expect(unverifiedTenderVerdict(allowed)).toEqual({ take: true, severity: 'REVIEW' });
  });

  it('takes it as urgent when the pack did not offer the method, or the till names an approver who is no supervisor', () => {
    expect(unverifiedTenderVerdict({ ...allowed, offeredOffline: false })).toEqual({ take: true, severity: 'URGENT' });
    expect(unverifiedTenderVerdict({ ...allowed, approverIsSupervisor: false })).toEqual({ take: true, severity: 'URGENT' });
  });

  it('never takes it while the branch does not allow it, without its details, for another kind of method, or onto a shift no longer open, or with no wallet to hold it in', () => {
    expect(unverifiedTenderVerdict({ ...allowed, branchAllows: false })).toEqual({ take: false, reason: 'BRANCH_DOES_NOT_ALLOW' });
    expect(unverifiedTenderVerdict({ ...allowed, carriesDetails: false })).toEqual({ take: false, reason: 'NO_UNVERIFIED_DETAILS' });
    expect(unverifiedTenderVerdict({ ...allowed, methodKind: 'CARD' })).toEqual({ take: false, reason: 'NOT_MOBILE_MONEY' });
    expect(unverifiedTenderVerdict({ ...allowed, shiftTakesMoney: false })).toEqual({ take: false, reason: 'SHIFT_NOT_OPEN' });
    expect(unverifiedTenderVerdict({ ...allowed, walletKnown: false })).toEqual({ take: false, reason: 'NO_MOBILE_MONEY_WALLET' });
  });

  it('judges the branch setting before anything else, so a branch that does not allow it records nothing whatever arrives', () => {
    expect(unverifiedTenderVerdict({ methodKind: 'CARD', branchAllows: false, carriesDetails: false, offeredOffline: false, shiftTakesMoney: false, approverIsSupervisor: false, walletKnown: false })).toEqual({ take: false, reason: 'BRANCH_DOES_NOT_ALLOW' });
  });
});
