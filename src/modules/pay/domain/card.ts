import { judgeProviderAnswer, type ChargeDecision, type ChargeFacts, type ProviderAnswer } from './charge';
import { addMs } from './time';

/**
 * How long after its order's window a card page is still waited for (B09c, A-287 (c)): the customer may still be on
 * Paystack's hosted page, where a declined card can be retried. Until then an abandoned or failed answer only waits,
 * so money paid late clears as an unmatched deposit for a person to refund, never lost.
 */
export const CARD_PAGE_GRACE_MS = 1_800_000;

/** Paystack's hosted checkout: the only host a card page's address may name (A-287 (b)). */
export const CARD_CHECKOUT_HOST = 'checkout.paystack.com';

const ACCESS_CODE = /^\/[A-Za-z0-9]{6,64}$/;

/**
 * What the provider's own answer does to a card charge (FR-PAY-005, FR-PAY-007). Paystack answers a page nobody has
 * paid yet as `abandoned` (the sandbox, 2026-11-23) and a declined card as `failed` while the page still takes another
 * card, so both wait until the page's grace has ended; everything else is judged as any provider charge is.
 */
export function judgeCardAnswer(charge: ChargeFacts, answer: ProviderAnswer, now: Date): ChargeDecision {
  const pageOpen = now.getTime() <= addMs(charge.awaitedUntil, CARD_PAGE_GRACE_MS).getTime();
  if (answer.status === 'ABANDONED') return pageOpen ? { kind: 'WAIT' } : { kind: 'FAIL', status: 'ABANDONED', reason: 'The customer did not pay on the card page' };
  if (answer.status === 'FAILED') return pageOpen ? { kind: 'WAIT' } : { kind: 'FAIL', status: 'FAILED', reason: 'The provider reported the card payment failed' };
  return judgeProviderAnswer(charge, answer, now);
}

/** A card payment already failed whose card the provider says was paid after all: raised for a person (abuse case 45). */
export function paidAfterFailure(paymentStatus: string, answer: ProviderAnswer): boolean {
  return paymentStatus === 'FAILED' && answer.status === 'SUCCESS';
}

/**
 * The hosted page's address as the provider answered it, or null when it is anything but Paystack's checkout for one
 * access code over https: the address is handed to a browser, so it must never be an open redirect.
 */
export function cardPageUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const plain = url.protocol === 'https:' && url.hostname === CARD_CHECKOUT_HOST && url.port === '' && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  return plain && ACCESS_CODE.test(url.pathname) && candidate === `https://${CARD_CHECKOUT_HOST}${url.pathname}` ? candidate : null;
}
