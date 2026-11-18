import { describe, expect, it } from 'vitest';
import { isUuidV7, packValidUntil, secondsAhead, withinTolerance } from './client-time';

describe('a time and an id a till sends (ADR-0013, ADR-0067)', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  it('is within tolerance up to 300 seconds either way, and not one millisecond beyond', () => {
    expect(withinTolerance(at(300_000), now)).toBe(true);
    expect(withinTolerance(at(-300_000), now)).toBe(true);
    expect(withinTolerance(at(300_001), now)).toBe(false);
    expect(withinTolerance(at(-300_001), now)).toBe(false);
  });

  it('counts how far ahead or behind the till is, in rounded seconds', () => {
    expect(secondsAhead(at(-3_600_000), now)).toBe(-3_600);
    expect(secondsAhead(at(1_499), now)).toBe(1);
    expect(secondsAhead(at(0), now)).toBe(0);
  });

  it('knows a version 7 id', () => {
    expect(isUuidV7('019a7aac-216c-721a-8753-2a7ecd11a35c')).toBe(true);
    expect(isUuidV7('019a7aac-216c-421a-8753-2a7ecd11a35c')).toBe(false);
  });
});

describe('the tolerance the owner sets, and the offline pack age (OFFLINE_SYNC 4.1, 5.1)', () => {
  const now = new Date('2026-11-18T09:00:00.000Z');

  it('judges a till time by the tolerance given, 300 seconds when none is', () => {
    expect(withinTolerance(new Date(now.getTime() + 300_000), now)).toBe(true);
    expect(withinTolerance(new Date(now.getTime() + 301_000), now)).toBe(false);
    expect(withinTolerance(new Date(now.getTime() - 60_000), now, 60)).toBe(true);
    expect(withinTolerance(new Date(now.getTime() - 61_000), now, 60)).toBe(false);
  });

  it('keeps a pack valid for exactly the offline hours', () => {
    expect(packValidUntil(now, 8).toISOString()).toBe('2026-11-18T17:00:00.000Z');
    expect(packValidUntil(now, 4).toISOString()).toBe('2026-11-18T13:00:00.000Z');
  });
});

