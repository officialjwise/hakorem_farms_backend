import { ManualClock } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { CircuitBreaker, jitteredDelayMs, withRetry } from './resilient-provider';
import { PaymentProviderError } from './payment-provider';

const unavailable = () => new PaymentProviderError('down', true);
const refused = () => new PaymentProviderError('refused', false);

describe('the circuit breaker in front of the payment provider (SHARED_BRIEF failure handling)', () => {
  it('opens after five failures in a row, refuses at once while open, and lets one call try after the cooldown', () => {
    const clock = new ManualClock(new Date('2026-11-16T09:00:00Z'));
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }, clock);
    for (let i = 0; i < 4; i += 1) breaker.recordFailure();
    expect(breaker.allows()).toBe(true);
    breaker.recordFailure();
    expect(breaker.allows()).toBe(false);
    clock.advanceBy(29_999);
    expect(breaker.allows()).toBe(false);
    clock.advanceBy(1);
    expect(breaker.allows()).toBe(true);
    breaker.recordFailure();
    expect(breaker.allows()).toBe(false);
  });

  it('closes again after a success, and a success resets the count', () => {
    const clock = new ManualClock(new Date('2026-11-16T09:00:00Z'));
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000 }, clock);
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.allows()).toBe(true);
  });
});

describe('the bounded retry with jitter', () => {
  it('waits a random share of a doubling base, never more than the cap', () => {
    expect(jitteredDelayMs(1, { baseMs: 200, capMs: 2_000 }, () => 0.5)).toBe(100);
    expect(jitteredDelayMs(3, { baseMs: 200, capMs: 2_000 }, () => 0.999)).toBe(799);
    expect(jitteredDelayMs(10, { baseMs: 200, capMs: 2_000 }, () => 0.5)).toBe(1_000);
  });

  it('retries a retryable failure up to the bound and then gives up with the last error', async () => {
    const waits: number[] = [];
    let calls = 0;
    const work = async () => {
      calls += 1;
      throw unavailable();
    };
    await expect(withRetry(work, { attempts: 3, baseMs: 200, capMs: 2_000 }, { random: () => 0.5, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow('down');
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('never retries a refusal, and answers the first success', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls += 1; throw refused(); }, { attempts: 3, baseMs: 1, capMs: 1 }, { random: () => 0, sleep: async () => undefined })).rejects.toThrow('refused');
    expect(calls).toBe(1);
    let tries = 0;
    expect(await withRetry(async () => { tries += 1; if (tries < 2) throw unavailable(); return 'ok'; }, { attempts: 3, baseMs: 1, capMs: 1 }, { random: () => 0, sleep: async () => undefined })).toBe('ok');
    expect(await withRetry(async () => { throw new Error('a bug'); }, { attempts: 3, baseMs: 1, capMs: 1 }, { random: () => 0, sleep: async () => undefined }).catch((e: Error) => e.message)).toBe('a bug');
  });
});
