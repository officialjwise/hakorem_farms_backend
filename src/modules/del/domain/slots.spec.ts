import { describe, expect, it } from 'vitest';
import { judgeCapacity, MAX_GENERATION_DAYS, planSlots, remaining, type SlotGeneration } from './slots';

const morning = { startsAt: '10:00', endsAt: '12:00', capacity: 8 };
const afternoon = { startsAt: '14:00', endsAt: '16:00', capacity: 8 };
const ask = (overrides: Partial<SlotGeneration> = {}): SlotGeneration => ({ from: '2026-11-16', to: '2026-11-29', weekdays: [2, 4, 6], times: [afternoon, morning], ...overrides });
const rules = (request: SlotGeneration, today = '2026-11-16') => {
  const result = planSlots(request, today);
  return result.ok ? [] : result.error.map((r) => `${r.field} ${r.rule}`);
};

describe('generating delivery slots (FR-DEL-001)', () => {
  it('makes one slot per listed weekday and window, windows in time order', () => {
    const result = planSlots(ask(), '2026-11-16');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 16 to 29 November 2026: Tuesdays 17 and 24, Thursdays 19 and 26, Saturdays 21 and 28, two windows each.
    expect(result.value).toHaveLength(12);
    expect(result.value.slice(0, 2)).toEqual([
      { slotDate: '2026-11-17', startsAt: '10:00', endsAt: '12:00', capacity: 8 },
      { slotDate: '2026-11-17', startsAt: '14:00', endsAt: '16:00', capacity: 8 },
    ]);
    expect(result.value.at(-1)).toEqual({ slotDate: '2026-11-28', startsAt: '14:00', endsAt: '16:00', capacity: 8 });
  });

  it('counts Sunday as weekday 7', () => {
    const result = planSlots(ask({ from: '2026-11-22', to: '2026-11-22', weekdays: [7], times: [morning] }), '2026-11-16');
    expect(result.ok && result.value.map((s) => s.slotDate)).toEqual(['2026-11-22']);
  });

  it('refuses a range that starts in the past, ends before it starts, or is longer than a quarter', () => {
    expect(rules(ask({ from: '2026-11-15' }))).toEqual(['/from IN_THE_PAST']);
    expect(rules(ask({ to: '2026-11-15' }))).toEqual(['/to BEFORE_FROM']);
    expect(rules(ask({ to: '2027-02-16' }))).toEqual(['/to RANGE_TOO_LONG']);
    expect(MAX_GENERATION_DAYS).toBe(92);
    expect(planSlots(ask({ to: '2027-02-15' }), '2026-11-16').ok).toBe(true);
  });

  it('refuses dates that are not calendar dates', () => {
    expect(rules(ask({ from: '2026-02-30', to: 'tomorrow' }))).toEqual(['/from INVALID_DATE', '/to INVALID_DATE']);
  });

  it('refuses no weekdays, a weekday out of range and a repeated weekday', () => {
    expect(rules(ask({ weekdays: [] }))).toEqual(['/weekdays REQUIRED']);
    expect(rules(ask({ weekdays: [0, 8, 2.5, 3, 3] }))).toEqual(['/weekdays/0 NOT_A_WEEKDAY', '/weekdays/1 NOT_A_WEEKDAY', '/weekdays/2 NOT_A_WEEKDAY', '/weekdays/4 DUPLICATE']);
  });

  it('refuses no windows, too many, bad times, a window that does not end after it starts, overlaps and capacities out of range', () => {
    expect(rules(ask({ times: [] }))).toEqual(['/times REQUIRED']);
    const many = Array.from({ length: 13 }, (_, i) => ({ startsAt: `${String(i + 6).padStart(2, '0')}:00`, endsAt: `${String(i + 6).padStart(2, '0')}:30`, capacity: 1 }));
    expect(rules(ask({ times: many }))).toEqual(['/times TOO_MANY']);
    expect(rules(ask({ times: [{ startsAt: '25:00', endsAt: '9:00', capacity: 8 }] }))).toEqual(['/times/0/startsAt INVALID_TIME', '/times/0/endsAt INVALID_TIME']);
    expect(rules(ask({ times: [{ startsAt: '12:00', endsAt: '12:00', capacity: 8 }] }))).toEqual(['/times/0/endsAt NOT_AFTER_START']);
    expect(rules(ask({ times: [morning, { startsAt: '11:00', endsAt: '13:00', capacity: 8 }] }))).toEqual(['/times/1 OVERLAPS']);
    expect(rules(ask({ times: [{ ...morning, capacity: 0 }, { ...afternoon, capacity: 1001 }] }))).toEqual(['/times/0/capacity OUT_OF_RANGE', '/times/1/capacity OUT_OF_RANGE']);
  });
});

describe('changing a slot capacity (FR-DEL-001)', () => {
  it('accepts a capacity at or above what is booked', () => {
    expect(judgeCapacity(10, 4)).toBeNull();
    expect(judgeCapacity(4, 4)).toBeNull();
  });

  it('refuses a capacity below what is booked, and one out of range', () => {
    expect(judgeCapacity(3, 4)).toBe('BELOW_BOOKED');
    expect(judgeCapacity(0, 0)).toBe('OUT_OF_RANGE');
    expect(judgeCapacity(1001, 0)).toBe('OUT_OF_RANGE');
  });

  it('shows what remains, never below zero', () => {
    expect(remaining({ capacity: 8, booked: 4 })).toBe(4);
    expect(remaining({ capacity: 8, booked: 9 })).toBe(0);
  });
});
