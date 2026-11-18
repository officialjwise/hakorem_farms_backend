import { describe, expect, it } from 'vitest';
import { isUuidV7, secondsAhead, withinTolerance } from './client-time';

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
