import { describe, expect, it } from 'vitest';
import { lineNumber, reservedUntil } from './checkout-clock';

describe('the checkout clock (FR-SHP-005, A-045)', () => {
  it('holds stock exactly fifteen minutes from the start', () => {
    expect(reservedUntil(new Date('2026-11-15T07:41:00.000Z'), 15).toISOString()).toBe('2026-11-15T07:56:00.000Z');
  });

  it('numbers lines from one', () => {
    expect([0, 1, 2].map(lineNumber)).toEqual([1, 2, 3]);
  });
});
