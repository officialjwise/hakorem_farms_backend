import { describe, expect, it } from 'vitest';
import { BUSINESS_TIME_ZONE, ManualClock, systemClock, toBusinessDate } from './clock';

describe('Clock', () => {
  it('reads the system time from the system clock', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('holds a manual clock still until it is moved', () => {
    const clock = new ManualClock(new Date('2027-03-31T23:59:59.000Z'));
    expect(clock.now().toISOString()).toBe('2027-03-31T23:59:59.000Z');
    expect(clock.now().toISOString()).toBe('2027-03-31T23:59:59.000Z');
  });

  it('advances a manual clock by milliseconds', () => {
    const clock = new ManualClock(new Date('2027-03-31T23:59:59.000Z'));
    clock.advanceBy(1_000);
    expect(clock.now().toISOString()).toBe('2027-04-01T00:00:00.000Z');
  });

  it('sets a manual clock to an instant', () => {
    const clock = new ManualClock(new Date('2027-01-01T00:00:00.000Z'));
    clock.set(new Date('2027-06-30T12:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2027-06-30T12:00:00.000Z');
  });

  it('cannot be moved by changing a date it returned or was given', () => {
    const start = new Date('2027-01-01T00:00:00.000Z');
    const clock = new ManualClock(start);
    start.setUTCFullYear(2030);
    clock.now().setUTCFullYear(2031);
    expect(clock.now().toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('business dates', () => {
  it('are calendar dates in Africa/Accra', () => {
    expect(BUSINESS_TIME_ZONE).toBe('Africa/Accra');
  });

  it('give the Accra calendar date of an instant', () => {
    expect(toBusinessDate(new Date('2026-11-13T09:30:00Z'))).toBe('2026-11-13');
  });

  it('change at Accra midnight', () => {
    // Accra keeps UTC+0 all year, so the date changes at 00:00 UTC.
    expect(toBusinessDate(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
    expect(toBusinessDate(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });
});
