import { describe, expect, it } from 'vitest';
import { addMs, backoffAt, elapsedMs, pageProbe } from './time';

describe('PAY’s time and paging arithmetic', () => {
  const now = new Date('2026-11-16T10:00:00Z');

  it('adds and measures milliseconds exactly', () => {
    expect(addMs(now, 1)).toEqual(new Date('2026-11-16T10:00:00.001Z'));
    expect(elapsedMs(now, new Date('2026-11-16T10:00:30Z'))).toBe(30_000);
  });

  it('doubles the backoff for each failure after the first', () => {
    expect(backoffAt(now, 300_000, 1)).toEqual(new Date('2026-11-16T10:05:00Z'));
    expect(backoffAt(now, 300_000, 3)).toEqual(new Date('2026-11-16T10:20:00Z'));
  });

  it('asks for one row more than a page', () => {
    expect(pageProbe(25)).toBe(26);
  });
});
