import { describe, expect, it } from 'vitest';
import { counterGaps, inCounterOrder, lateEntrySeverity, lateEntryShiftState, latePostingReason, lineNoOf, MAX_SALE_AGE_HOURS, MAX_SYNC_BATCH, newGaps, provisionalRef, saleTooOld, secondsBetween, severityOfLatePosting, tally, tillClockVerdict, tillTakesCash, type ShiftAtSync } from './offline-sync';

const at = (iso: string) => new Date(iso);
const OPEN: ShiftAtSync = { status: 'OPEN', forceClosed: false, closedAt: null };

describe('the device counter: gap-free per shift, a missing value is reported (FR-POS-013, OFFLINE_SYNC 4.2, abuse case 10)', () => {
  it('names every value missing below the highest synced, in order', () => {
    expect(counterGaps([1, 2, 3, 4, 5, 7, 8])).toEqual([6]);
    expect(counterGaps([8, 1, 3])).toEqual([2, 4, 5, 6, 7]);
  });

  it('has no gap for a dense run, nothing synced, or one sale', () => {
    expect(counterGaps([])).toEqual([]);
    expect(counterGaps([1])).toEqual([]);
    expect(counterGaps([3, 1, 2, 2])).toEqual([]);
  });

  it('counts from 1, so a first sale numbered 3 leaves 1 and 2 missing', () => {
    expect(counterGaps([3])).toEqual([1, 2]);
  });

  it('reports a value newly missing once, and a value that arrives closes its gap', () => {
    expect(newGaps([], [6])).toEqual([6]);
    expect(newGaps([6], [6, 9])).toEqual([9]);
    expect(newGaps([6, 9], [9])).toEqual([]);
  });
});

describe('the provisional reference printed offline (ADR-0015, OFFLINE_SYNC 4.3)', () => {
  it('is P-<register>-<shift sequence>-<counter padded to four>', () => {
    expect(provisionalRef('T2', 311, 42)).toBe('P-T2-311-0042');
    expect(provisionalRef('T1', 1, 12345)).toBe('P-T1-1-12345');
  });
});

describe('a till clock outside the tolerance is flagged, never refused (the owner on A-273 (g))', () => {
  const received = at('2026-11-18T12:00:00.000Z');
  const opened = at('2026-11-18T06:00:00.000Z');

  it('is within at exactly 300 seconds either way', () => {
    expect(tillClockVerdict(at('2026-11-18T12:05:00.000Z'), received, opened, 300)).toBeNull();
    expect(tillClockVerdict(at('2026-11-18T05:55:00.000Z'), received, opened, 300)).toBeNull();
  });

  it('is AHEAD at 301 seconds after the server received it', () => {
    expect(tillClockVerdict(at('2026-11-18T12:05:01.000Z'), received, opened, 300)).toBe('AHEAD_OF_SERVER');
  });

  it('is BEFORE_SHIFT at 301 seconds before its shift opened', () => {
    expect(tillClockVerdict(at('2026-11-18T05:54:59.000Z'), received, opened, 300)).toBe('BEFORE_SHIFT_OPENED');
  });

  it('takes a sale hours old within its shift as normal offline time', () => {
    expect(tillClockVerdict(at('2026-11-18T07:00:00.000Z'), received, opened, 300)).toBeNull();
  });
});

describe('how old an offline sale may be before it is flagged (A-278 (c))', () => {
  it('defaults to 8 hours and flags a sale older than that, never refusing it', () => {
    expect(MAX_SALE_AGE_HOURS).toBe(8);
    const received = at('2026-11-18T16:00:00.000Z');
    expect(saleTooOld(at('2026-11-18T08:00:00.000Z'), received, 8)).toBe(false);
    expect(saleTooOld(at('2026-11-18T07:59:59.999Z'), received, 8)).toBe(true);
  });
});

describe('a sale posted on a later date, or on a shift that has closed, is flagged (ADR-0027 point 6, OFFLINE_SYNC 9.4)', () => {
  const occurredAt = at('2026-11-12T15:10:00.000Z');
  const closed = (forceClosed: boolean): ShiftAtSync => ({ status: 'CLOSED', forceClosed, closedAt: at('2026-11-12T18:00:00.000Z') });

  it('is not flagged on an open shift in an open period', () => {
    expect(latePostingReason({ occurredDate: '2026-11-12', postingDate: '2026-11-12', occurredAt, shift: OPEN })).toBeNull();
  });

  it('is PERIOD_LOCKED when its own date is locked and it posts on the first open date', () => {
    expect(latePostingReason({ occurredDate: '2026-10-31', postingDate: '2026-11-03', occurredAt, shift: OPEN })).toBe('PERIOD_LOCKED');
  });

  it('is SHIFT_CLOSED for a closing or closed shift, and for a sale before a force close', () => {
    expect(latePostingReason({ occurredDate: '2026-11-12', postingDate: '2026-11-12', occurredAt, shift: { status: 'CLOSING', forceClosed: false, closedAt: null } })).toBe('SHIFT_CLOSED');
    expect(latePostingReason({ occurredDate: '2026-11-12', postingDate: '2026-11-12', occurredAt, shift: closed(false) })).toBe('SHIFT_CLOSED');
    expect(latePostingReason({ occurredDate: '2026-11-12', postingDate: '2026-11-12', occurredAt, shift: closed(true) })).toBe('SHIFT_CLOSED');
  });

  it('is AFTER_FORCE_CLOSE for a sale dated after its shift was force-closed, which outranks a locked period', () => {
    expect(latePostingReason({ occurredDate: '2026-11-12', postingDate: '2026-11-13', occurredAt: at('2026-11-12T18:35:00.000Z'), shift: closed(true) })).toBe('AFTER_FORCE_CLOSE');
  });

  it('is URGENT only after a force close', () => {
    expect(severityOfLatePosting('AFTER_FORCE_CLOSE')).toBe('URGENT');
    expect(severityOfLatePosting('SHIFT_CLOSED')).toBe('REVIEW');
    expect(severityOfLatePosting('PERIOD_LOCKED')).toBe('REVIEW');
  });
});

describe('cash from the queue goes onto its own shift, late if the shift has closed (ADR-0077 Amendments, the owner on 2026-11-18)', () => {
  it('takes the cash on an OPEN shift, and as a late entry on a closing, closed or force-closed shift, never refusing it', () => {
    expect(tillTakesCash(OPEN)).toBe('ON_SHIFT');
    expect(tillTakesCash({ status: 'CLOSING', forceClosed: false, closedAt: null })).toBe('LATE_ENTRY');
    expect(tillTakesCash({ status: 'CLOSED', forceClosed: false, closedAt: at('2026-11-12T18:00:00.000Z') })).toBe('LATE_ENTRY');
    expect(tillTakesCash({ status: 'CLOSED', forceClosed: true, closedAt: at('2026-11-12T18:00:00.000Z') })).toBe('LATE_ENTRY');
  });

  it('is URGENT when the till dates it after the shift closed, REVIEW otherwise, so a supervisor reviews every one', () => {
    const closed = { status: 'CLOSED' as const, forceClosed: false, closedAt: at('2026-11-12T18:00:00.000Z') };
    expect(lateEntrySeverity(closed, at('2026-11-12T17:59:59.999Z'))).toBe('REVIEW');
    expect(lateEntrySeverity(closed, at('2026-11-12T18:00:00.000Z'))).toBe('REVIEW');
    expect(lateEntrySeverity(closed, at('2026-11-12T18:00:00.001Z'))).toBe('URGENT');
    expect(lateEntrySeverity({ ...closed, forceClosed: true }, at('2026-11-12T18:35:00.000Z'))).toBe('URGENT');
    expect(lateEntrySeverity({ status: 'CLOSING', forceClosed: false, closedAt: null }, at('2026-11-12T18:35:00.000Z'))).toBe('REVIEW');
  });

  it('names the shift\'s state the entry arrived in', () => {
    expect(lateEntryShiftState({ status: 'CLOSING', forceClosed: false, closedAt: null })).toBe('CLOSING');
    expect(lateEntryShiftState({ status: 'CLOSED', forceClosed: false, closedAt: at('2026-11-12T18:00:00.000Z') })).toBe('CLOSED');
    expect(lateEntryShiftState({ status: 'CLOSED', forceClosed: true, closedAt: at('2026-11-12T18:00:00.000Z') })).toBe('FORCE_CLOSED');
    expect(() => lateEntryShiftState(OPEN)).toThrow(/open/);
  });
});

describe('a batch in counter order, and its tallies (OFFLINE_SYNC 6.2 and 6.3)', () => {
  it('takes at most 500 sales and applies them in ascending counter whatever order they came in', () => {
    expect(MAX_SYNC_BATCH).toBe(500);
    expect(inCounterOrder([{ deviceCounter: 3 }, { deviceCounter: 1 }, { deviceCounter: 2 }]).map((s) => s.deviceCounter)).toEqual([1, 2, 3]);
  });

  it('numbers lines from 1, counts outcomes, and measures seconds between two instants', () => {
    expect([lineNoOf(0), lineNoOf(4)]).toEqual([1, 5]);
    expect(tally(['APPLIED', 'DUPLICATE', 'APPLIED'])).toEqual({ APPLIED: 2, DUPLICATE: 1 });
    expect(secondsBetween(at('2026-11-18T12:05:01.400Z'), at('2026-11-18T12:00:00.000Z'))).toBe(301);
  });
});
