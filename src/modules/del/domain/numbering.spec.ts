import { describe, expect, it } from 'vitest';
import { endOfBusinessDate, nextAttemptNo, pageProbe, stopNo } from './numbering';

describe('numbering and paging', () => {
  it('numbers the first attempt 1 and each next one more, and probes one row past a page', () => {
    expect([nextAttemptNo(0), nextAttemptNo(1), pageProbe(25)]).toEqual([1, 2, 26]);
    expect([stopNo(0), stopNo(5)]).toEqual([1, 6]);
  });
});

describe('the end of a business date', () => {
  it('is the last millisecond of the Africa/Accra calendar day', () => {
    expect(endOfBusinessDate('2026-11-23').toISOString()).toBe('2026-11-23T23:59:59.999Z');
    expect(endOfBusinessDate('2028-02-29').toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });
});
