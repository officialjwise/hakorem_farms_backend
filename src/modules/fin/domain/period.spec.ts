import { describe, expect, it } from 'vitest';
import { choosePostingDate, fiscalYearOf, type PeriodFacts } from './period';

const period = (id: string, startDate: string, endDate: string, status: PeriodFacts['status']): PeriodFacts => ({ id, startDate, endDate, status });
const periods = [
  period('2026-10', '2026-10-01', '2026-10-31', 'CLOSED'),
  period('2026-11', '2026-11-01', '2026-11-30', 'OPEN'),
  period('2026-12', '2026-12-01', '2026-12-31', 'LOCKED'),
  period('2027-01', '2027-01-01', '2027-01-31', 'FUTURE'),
];

describe('the posting date of an event (FR-FIN-009)', () => {
  it('posts on the day the event happened when its period is open', () => {
    expect(choosePostingDate('2026-11-15', '2026-11-16', periods)).toEqual({ ok: true, value: { postingDate: '2026-11-15', periodId: '2026-11', late: false } });
  });

  it('posts on its first and last day too', () => {
    expect(choosePostingDate('2026-11-01', '2026-11-01', periods)).toEqual({ ok: true, value: { postingDate: '2026-11-01', periodId: '2026-11', late: false } });
    expect(choosePostingDate('2026-11-30', '2026-11-30', periods)).toEqual({ ok: true, value: { postingDate: '2026-11-30', periodId: '2026-11', late: false } });
  });

  it('posts a late event dated in a closed period on the day it is recorded, keeping it marked late', () => {
    expect(choosePostingDate('2026-10-15', '2026-11-02', periods)).toEqual({ ok: true, value: { postingDate: '2026-11-02', periodId: '2026-11', late: true } });
  });

  it('posts an event dated before any period on the day it is recorded', () => {
    expect(choosePostingDate('2025-06-01', '2026-11-02', periods)).toEqual({ ok: true, value: { postingDate: '2026-11-02', periodId: '2026-11', late: true } });
  });

  it('refuses when the recording day is itself in a period that is not open', () => {
    expect(choosePostingDate('2026-10-15', '2026-12-02', periods)).toEqual({ ok: false, error: { rule: 'PERIOD_NOT_OPEN', date: '2026-12-02' } });
    expect(choosePostingDate('2027-01-05', '2027-01-05', periods)).toEqual({ ok: false, error: { rule: 'PERIOD_NOT_OPEN', date: '2027-01-05' } });
  });

  it('refuses when no period holds the recording day', () => {
    expect(choosePostingDate('2031-03-01', '2031-03-01', periods)).toEqual({ ok: false, error: { rule: 'PERIOD_NOT_OPEN', date: '2031-03-01' } });
  });
});

describe('the fiscal year of a posting date (A-028: the calendar year)', () => {
  it('is the year of the date', () => {
    expect(fiscalYearOf('2026-12-31')).toBe(2026);
    expect(fiscalYearOf('2027-01-01')).toBe(2027);
  });
});
