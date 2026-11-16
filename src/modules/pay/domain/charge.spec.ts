import { describe, expect, it } from 'vitest';
import { addMs } from './time';
import { judgeMissingCharge, judgeProviderAnswer, maskPhone, PROVIDER_MISSING_GRACE_MS, type ChargeFacts } from './charge';

const at = (iso: string) => new Date(iso);
const charge: ChargeFacts = {
  requestedPesewas: 50_000n,
  createdAt: at('2026-11-16T09:00:00Z'),
  awaitedUntil: at('2026-11-16T09:15:00Z'),
  releasedAt: null,
};
const now = at('2026-11-16T09:05:00Z');

describe('what a provider’s own answer does to a pending charge (FR-PAY-004, FR-PAY-007, FR-PAY-008)', () => {
  it('clears a success for exactly the amount asked, inside the charge’s window, as a deposit the order still awaits', () => {
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'GHS', paidAt: at('2026-11-16T09:04:00Z') }, now)).toEqual({ kind: 'CLEAR', heldAsUnmatched: false });
  });

  it('clears a success paid after the window closed, but holds it as unmatched: the money is never discarded', () => {
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'GHS', paidAt: at('2026-11-16T09:15:01Z') }, now)).toEqual({ kind: 'CLEAR', heldAsUnmatched: true });
  });

  it('judges a success with no paid time by the time it is confirmed', () => {
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'GHS', paidAt: null }, at('2026-11-16T09:15:00Z'))).toEqual({ kind: 'CLEAR', heldAsUnmatched: false });
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'GHS', paidAt: null }, at('2026-11-16T09:15:00.001Z'))).toEqual({ kind: 'CLEAR', heldAsUnmatched: true });
  });

  it('holds a success as unmatched when the order released the charge before it was paid', () => {
    const released = { ...charge, releasedAt: at('2026-11-16T09:03:00Z') };
    expect(judgeProviderAnswer(released, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'GHS', paidAt: at('2026-11-16T09:04:00Z') }, now)).toEqual({ kind: 'CLEAR', heldAsUnmatched: true });
  });

  it('never clears a success one pesewa short or over, or in another currency: the amount differs', () => {
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 49_999n, currency: 'GHS', paidAt: null }, now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 49_999n });
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_001n, currency: 'GHS', paidAt: null }, now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 50_001n });
    expect(judgeProviderAnswer(charge, { status: 'SUCCESS', amountPesewas: 50_000n, currency: 'NGN', paidAt: null }, now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 50_000n });
  });

  it('fails a charge the provider failed, abandoned or reversed, and waits on one still pending', () => {
    const answer = (status: 'FAILED' | 'ABANDONED' | 'REVERSED' | 'PENDING') => judgeProviderAnswer(charge, { status, amountPesewas: 50_000n, currency: 'GHS', paidAt: null }, now);
    expect(answer('FAILED')).toEqual({ kind: 'FAIL', status: 'FAILED', reason: 'The provider reported the charge failed' });
    expect(answer('ABANDONED')).toEqual({ kind: 'FAIL', status: 'ABANDONED', reason: 'The customer did not approve the charge' });
    expect(answer('REVERSED')).toEqual({ kind: 'FAIL', status: 'FAILED', reason: 'The provider reversed the charge' });
    expect(answer('PENDING')).toEqual({ kind: 'WAIT' });
  });
});

describe('a charge the provider has no record of (FR-PAY-007, the owner’s sweep, 2026-11-16)', () => {
  it('waits through the grace period, because a charge sent at a timeout may still arrive', () => {
    expect(judgeMissingCharge(charge, addMs(charge.createdAt, PROVIDER_MISSING_GRACE_MS))).toBe('WAIT');
  });

  it('fails it one millisecond after the grace period, as missing at the provider', () => {
    expect(judgeMissingCharge(charge, addMs(addMs(charge.createdAt, PROVIDER_MISSING_GRACE_MS), 1))).toBe('MISSING');
  });
});

describe('the payer’s phone, as it is stored and shown', () => {
  it('keeps the network prefix and the last three digits only', () => {
    expect(maskPhone('+233244512876')).toBe('+233 24 *** *876');
  });

  it('refuses a number that is not a Ghanaian mobile number in E.164', () => {
    expect(() => maskPhone('0244512876')).toThrow(/E.164/);
  });
});
