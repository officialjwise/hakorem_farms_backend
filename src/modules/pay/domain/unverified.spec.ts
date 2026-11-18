import { describe, expect, it } from 'vitest';
import { unverifiedUrgentFrom } from './unverified';

describe('an unverified offline mobile money tender becomes urgent after its window (OFFLINE_SYNC 9.9)', () => {
  it('is urgent exactly the window of whole days after the customer paid', () => {
    expect(unverifiedUrgentFrom(new Date('2026-11-13T11:50:00Z'), 3).toISOString()).toBe('2026-11-16T11:50:00.000Z');
    expect(unverifiedUrgentFrom(new Date('2026-12-31T23:59:59Z'), 1).toISOString()).toBe('2027-01-01T23:59:59.000Z');
  });
});
