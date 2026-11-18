import { describe, expect, it } from 'vitest';
import { judgeSchedule, nextOccurrence, occurrencesBetween, occursOn, type Schedule } from './schedule';

// 17 November 2026 is a Tuesday (FR-WHL-004's acceptance); 16 November a Monday.
const tuesdays: Schedule = { frequency: 'WEEKLY', weekdays: [2], dayOfMonth: null, intervalDays: null, startsOn: '2026-11-16', endsOn: null };

describe('a standing order occurs (FR-WHL-004)', () => {
  it('weekly on named days: every Tuesday from its start, never before it', () => {
    expect(occursOn(tuesdays, '2026-11-17')).toBe(true);
    expect(occursOn(tuesdays, '2026-11-18')).toBe(false);
    expect(occursOn(tuesdays, '2026-11-24')).toBe(true);
    expect(occursOn(tuesdays, '2026-11-10')).toBe(false);
    const monWedFri: Schedule = { ...tuesdays, weekdays: [1, 3, 5] };
    expect(occurrencesBetween(monWedFri, '2026-11-16', '2026-11-22')).toEqual(['2026-11-16', '2026-11-18', '2026-11-20']);
    expect(occursOn({ ...tuesdays, weekdays: [7] }, '2026-11-22')).toBe(true);
  });

  it('never after its end, and on its last day', () => {
    const ending: Schedule = { ...tuesdays, endsOn: '2026-11-24' };
    expect(occursOn(ending, '2026-11-24')).toBe(true);
    expect(occursOn(ending, '2026-12-01')).toBe(false);
    expect(nextOccurrence(ending, '2026-11-25')).toBeNull();
  });

  it('every n days from its start', () => {
    const everyThree: Schedule = { frequency: 'EVERY_N_DAYS', weekdays: [], dayOfMonth: null, intervalDays: 3, startsOn: '2026-11-17', endsOn: null };
    expect(occurrencesBetween(everyThree, '2026-11-15', '2026-11-26')).toEqual(['2026-11-17', '2026-11-20', '2026-11-23', '2026-11-26']);
    expect(occurrencesBetween({ ...everyThree, intervalDays: 1 }, '2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('fortnightly on named days, counted from the week it starts in', () => {
    const fortnight: Schedule = { ...tuesdays, frequency: 'FORTNIGHTLY', startsOn: '2026-11-18' };
    // The week of 16 November holds the start, but its Tuesday is before it.
    expect(occurrencesBetween(fortnight, '2026-11-16', '2026-12-15')).toEqual(['2026-12-01', '2026-12-15']);
  });

  it('monthly on a day of the month', () => {
    const monthly: Schedule = { frequency: 'MONTHLY', weekdays: [], dayOfMonth: 28, intervalDays: null, startsOn: '2026-11-17', endsOn: null };
    expect(occurrencesBetween(monthly, '2026-11-01', '2027-03-01')).toEqual(['2026-11-28', '2026-12-28', '2027-01-28', '2027-02-28']);
  });

  it('answers the first occurrence on or after a date, or none within the search', () => {
    expect(nextOccurrence(tuesdays, '2026-11-17')).toBe('2026-11-17');
    expect(nextOccurrence(tuesdays, '2026-11-18')).toBe('2026-11-24');
    expect(nextOccurrence(tuesdays, '2026-11-01')).toBe('2026-11-17');
    expect(nextOccurrence({ ...tuesdays, weekdays: [] }, '2026-11-17')).toBeNull();
  });
});

describe('a standing order schedule is refused unless it is whole (FR-WHL-004)', () => {
  const rules = (s: Partial<Schedule>) => judgeSchedule({ ...tuesdays, ...s }).map((r) => `${r.field}:${r.rule}`);

  it('accepts each frequency with only its own fields', () => {
    expect(rules({})).toEqual([]);
    expect(rules({ frequency: 'FORTNIGHTLY' })).toEqual([]);
    expect(rules({ frequency: 'MONTHLY', weekdays: [], dayOfMonth: 1 })).toEqual([]);
    expect(rules({ frequency: 'EVERY_N_DAYS', weekdays: [], intervalDays: 365 })).toEqual([]);
  });

  it('names each missing, repeated or stray field', () => {
    expect(rules({ weekdays: [] })).toEqual(['/weekdays:WEEKDAYS_REQUIRED']);
    expect(rules({ weekdays: [2, 2] })).toEqual(['/weekdays:WEEKDAY_REPEATED']);
    expect(rules({ weekdays: [0, 8] })).toEqual(['/weekdays:WEEKDAY_OUT_OF_RANGE']);
    expect(rules({ dayOfMonth: 3 })).toEqual(['/dayOfMonth:NOT_FOR_FREQUENCY']);
    expect(rules({ intervalDays: 3 })).toEqual(['/intervalDays:NOT_FOR_FREQUENCY']);
    expect(rules({ frequency: 'MONTHLY', weekdays: [], dayOfMonth: null })).toEqual(['/dayOfMonth:DAY_OF_MONTH_REQUIRED']);
    expect(rules({ frequency: 'MONTHLY', weekdays: [], dayOfMonth: 29 })).toEqual(['/dayOfMonth:DAY_OF_MONTH_OUT_OF_RANGE']);
    expect(rules({ frequency: 'MONTHLY', dayOfMonth: 1 })).toEqual(['/weekdays:NOT_FOR_FREQUENCY']);
    expect(rules({ frequency: 'EVERY_N_DAYS', weekdays: [], intervalDays: null })).toEqual(['/intervalDays:INTERVAL_REQUIRED']);
    expect(rules({ frequency: 'EVERY_N_DAYS', weekdays: [], intervalDays: 0 })).toEqual(['/intervalDays:INTERVAL_OUT_OF_RANGE']);
    expect(rules({ frequency: 'EVERY_N_DAYS', weekdays: [], intervalDays: 366 })).toEqual(['/intervalDays:INTERVAL_OUT_OF_RANGE']);
    expect(rules({ endsOn: '2026-11-15' })).toEqual(['/endsOn:ENDS_BEFORE_START']);
    expect(rules({ endsOn: '2026-11-16' })).toEqual([]);
  });
});
