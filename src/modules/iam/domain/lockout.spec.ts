import { describe, expect, it } from 'vitest';
import { lockSecondsAfter, LOCKOUT_FREE_FAILURES } from './lockout';

describe('login lockout backoff (SA-01, FR-IAM-017)', () => {
  it('does not lock for the first four consecutive failures', () => {
    for (let failures = 0; failures < LOCKOUT_FREE_FAILURES; failures += 1) {
      expect(lockSecondsAfter(failures)).toBe(0);
    }
  });

  it('locks for one minute at the fifth failure and doubles for each further failure', () => {
    expect(lockSecondsAfter(5)).toBe(60);
    expect(lockSecondsAfter(6)).toBe(120);
    expect(lockSecondsAfter(7)).toBe(240);
    expect(lockSecondsAfter(8)).toBe(480);
    expect(lockSecondsAfter(9)).toBe(960);
    expect(lockSecondsAfter(10)).toBe(1_920);
  });

  it('caps the lock at sixty minutes', () => {
    expect(lockSecondsAfter(11)).toBe(3_600);
    expect(lockSecondsAfter(40)).toBe(3_600);
  });
});
