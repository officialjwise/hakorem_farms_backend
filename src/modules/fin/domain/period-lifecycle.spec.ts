import { describe, expect, it } from 'vitest';
import type { PeriodFacts } from './period';
import { judgeClose, judgeLock, judgeReopen } from './period-lifecycle';

const period = (id: string, startDate: string, endDate: string, status: PeriodFacts['status']): PeriodFacts => ({ id, startDate, endDate, status });
const august = period('2026-08', '2026-08-01', '2026-08-31', 'CLOSED');
const september = period('2026-09', '2026-09-01', '2026-09-30', 'LOCKED');
const october = period('2026-10', '2026-10-01', '2026-10-31', 'LOCKED');
const november = period('2026-11', '2026-11-01', '2026-11-30', 'OPEN');
const future = period('2027-01', '2027-01-01', '2027-01-31', 'FUTURE');

describe('locking a period (FR-FIN-009)', () => {
  it('locks an open period, the current one included', () => {
    expect(judgeLock(november)).toEqual({ ok: true, value: undefined });
  });

  it('refuses a period that is not open, naming its status', () => {
    expect(judgeLock(october)).toEqual({ ok: false, error: 'LOCKED' });
    expect(judgeLock(august)).toEqual({ ok: false, error: 'CLOSED' });
    expect(judgeLock(future)).toEqual({ ok: false, error: 'FUTURE' });
  });
});

describe('closing a period (FR-FIN-009, FR-FIN-010)', () => {
  it('closes a locked period that has ended once every earlier period is closed', () => {
    expect(judgeClose(september, [august, september, october, november], '2026-11-16')).toEqual({ ok: true, value: undefined });
  });

  it('closes a period the day after its last day, never on it', () => {
    expect(judgeClose(october, [october], '2026-11-01')).toEqual({ ok: true, value: undefined });
    expect(judgeClose(october, [october], '2026-10-31')).toEqual({ ok: false, error: 'PERIOD_NOT_ENDED' });
  });

  it('refuses a period that is not locked: an open one is locked first, and a closed one is final', () => {
    expect(judgeClose(november, [november], '2026-12-02')).toEqual({ ok: false, error: 'OPEN' });
    expect(judgeClose(august, [august], '2026-11-16')).toEqual({ ok: false, error: 'CLOSED' });
  });

  it('refuses while an earlier period is not closed, so closed periods always run from the first', () => {
    expect(judgeClose(october, [august, september, october], '2026-11-16')).toEqual({ ok: false, error: 'EARLIER_PERIOD_NOT_CLOSED' });
  });
});

describe('reopening a period (FR-FIN-010)', () => {
  it('reopens a locked period', () => {
    expect(judgeReopen(october)).toEqual({ ok: true, value: undefined });
  });

  it('never reopens a closed period, and has nothing to reopen in an open or future one', () => {
    expect(judgeReopen(august)).toEqual({ ok: false, error: 'CLOSED' });
    expect(judgeReopen(november)).toEqual({ ok: false, error: 'OPEN' });
    expect(judgeReopen(future)).toEqual({ ok: false, error: 'FUTURE' });
  });
});
