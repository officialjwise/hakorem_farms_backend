import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isInTheFuture, ordinal, pageProbe } from './counting';

describe('counting that is not money', () => {
  it('probes one row past the page and numbers lines from one', () => {
    expect(pageProbe(25)).toBe(26);
    expect(ordinal(0)).toBe(1);
  });
  it('allows a receipt five minutes ahead of the server clock and no more', () => {
    const now = new Date('2026-11-15T08:00:00Z');
    expect(isInTheFuture(new Date('2026-11-15T08:05:00Z'), now)).toBe(false);
    expect(isInTheFuture(new Date('2026-11-15T08:05:01Z'), now)).toBe(true);
  });
  it('counts calendar days across a month end and adds days to a date', () => {
    expect(daysBetween('2026-11-28', '2026-12-01')).toBe(3);
    expect(addDays('2026-11-30', 3)).toBe('2026-12-03');
    expect(addDays('2026-11-13', 0)).toBe('2026-11-13');
  });
});
