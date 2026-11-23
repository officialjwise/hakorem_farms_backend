import { describe, expect, it } from 'vitest';
import { CARD_PAGE_GRACE_MS, cardPageUrl, judgeCardAnswer, paidAfterFailure } from './card';
import type { ChargeFacts, ProviderAnswer } from './charge';
import { addMs } from './time';

const at = (iso: string) => new Date(iso);
const charge: ChargeFacts = {
  requestedPesewas: 5_500n,
  createdAt: at('2026-11-23T09:00:00Z'),
  awaitedUntil: at('2026-11-23T09:15:00Z'),
  releasedAt: null,
};
const answer = (status: ProviderAnswer['status'], amountPesewas = 5_500n, currency = 'GHS', paidAt: Date | null = null): ProviderAnswer => ({ status, amountPesewas, currency, paidAt });
const lastWait = addMs(charge.awaitedUntil, CARD_PAGE_GRACE_MS);

describe('what the provider’s answer does to a card charge on its hosted page (FR-PAY-003, FR-PAY-005, FR-PAY-007)', () => {
  it('clears GH₵55.00 confirmed as exactly 5,500 pesewas in cedis, inside the window', () => {
    expect(judgeCardAnswer(charge, answer('SUCCESS', 5_500n, 'GHS', at('2026-11-23T09:04:00Z')), at('2026-11-23T09:05:00Z'))).toEqual({ kind: 'CLEAR', heldAsUnmatched: false });
  });

  it('never clears one pesewa short or over, or in another currency', () => {
    const now = at('2026-11-23T09:05:00Z');
    expect(judgeCardAnswer(charge, answer('SUCCESS', 5_499n), now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 5_499n });
    expect(judgeCardAnswer(charge, answer('SUCCESS', 5_501n), now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 5_501n });
    expect(judgeCardAnswer(charge, answer('SUCCESS', 5_500n, 'USD'), now)).toEqual({ kind: 'AMOUNT_DIFFERS', confirmedPesewas: 5_500n });
  });

  it('holds a card paid after the window as unmatched: the money is never discarded', () => {
    expect(judgeCardAnswer(charge, answer('SUCCESS', 5_500n, 'GHS', at('2026-11-23T09:20:00Z')), at('2026-11-23T09:20:00Z'))).toEqual({ kind: 'CLEAR', heldAsUnmatched: true });
  });

  it('waits on a page the customer has not paid yet: Paystack answers an open page as abandoned', () => {
    expect(judgeCardAnswer(charge, answer('ABANDONED'), at('2026-11-23T09:00:31Z'))).toEqual({ kind: 'WAIT' });
  });

  it('waits after a declined card, because the customer may try another card on the same page', () => {
    expect(judgeCardAnswer(charge, answer('FAILED'), at('2026-11-23T09:05:00Z'))).toEqual({ kind: 'WAIT' });
  });

  it('keeps waiting after the order stopped waiting, up to the last moment of the page’s grace, so late money clears as a deposit', () => {
    const released = { ...charge, releasedAt: at('2026-11-23T09:10:00Z') };
    expect(judgeCardAnswer(released, answer('ABANDONED'), lastWait)).toEqual({ kind: 'WAIT' });
    expect(judgeCardAnswer(released, answer('FAILED'), lastWait)).toEqual({ kind: 'WAIT' });
  });

  it('fails an abandoned or declined page one millisecond after its grace ends', () => {
    const after = addMs(lastWait, 1);
    expect(judgeCardAnswer(charge, answer('ABANDONED'), after)).toEqual({ kind: 'FAIL', status: 'ABANDONED', reason: 'The customer did not pay on the card page' });
    expect(judgeCardAnswer(charge, answer('FAILED'), after)).toEqual({ kind: 'FAIL', status: 'FAILED', reason: 'The provider reported the card payment failed' });
  });

  it('fails a reversed card payment at once and waits on one still pending', () => {
    expect(judgeCardAnswer(charge, answer('REVERSED'), at('2026-11-23T09:01:00Z'))).toEqual({ kind: 'FAIL', status: 'FAILED', reason: 'The provider reversed the charge' });
    expect(judgeCardAnswer(charge, answer('PENDING'), addMs(lastWait, 60_000))).toEqual({ kind: 'WAIT' });
  });
});

describe('money for a card payment already failed (abuse case 45)', () => {
  it('is raised when the provider says a failed payment’s card was paid after all', () => {
    expect(paidAfterFailure('FAILED', answer('SUCCESS'))).toBe(true);
  });

  it('is not raised for a payment still pending, cleared or reversed, or an answer that is not a success', () => {
    expect(paidAfterFailure('PENDING', answer('SUCCESS'))).toBe(false);
    expect(paidAfterFailure('CLEARED', answer('SUCCESS'))).toBe(false);
    expect(paidAfterFailure('REVERSED', answer('SUCCESS'))).toBe(false);
    expect(paidAfterFailure('FAILED', answer('ABANDONED'))).toBe(false);
  });
});

describe('the hosted page’s address is Paystack’s checkout, never an open redirect', () => {
  it('accepts Paystack’s checkout page for one access code', () => {
    expect(cardPageUrl('https://checkout.paystack.com/meo0f37t27zawbj')).toBe('https://checkout.paystack.com/meo0f37t27zawbj');
  });

  it('refuses another host, a look-alike, plain http, a port, a user, a query, a fragment or a deeper path', () => {
    for (const url of [
      'https://evil.example/meo0f37t27zawbj',
      'https://checkout.paystack.com.evil.example/meo0f37t27zawbj',
      'https://evilcheckout.paystack.com/meo0f37t27zawbj',
      'http://checkout.paystack.com/meo0f37t27zawbj',
      'https://checkout.paystack.com:8443/meo0f37t27zawbj',
      'https://user@checkout.paystack.com/meo0f37t27zawbj',
      'https://checkout.paystack.com/meo0f37t27zawbj?next=https://evil.example',
      'https://checkout.paystack.com/meo0f37t27zawbj#x',
      'https://checkout.paystack.com/a/b',
      'https://checkout.paystack.com/',
      'https://checkout.paystack.com/abc',
      'not a url',
    ]) {
      expect(cardPageUrl(url), url).toBeNull();
    }
  });
});
