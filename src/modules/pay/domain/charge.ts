import { elapsedMs } from './time';

/** A charge sent to the provider has this long to appear in the provider's records before it counts as missing. */
export const PROVIDER_MISSING_GRACE_MS = 1_800_000;

/** What PAY knows of a charge it sent (`pay.provider_transaction`). */
export interface ChargeFacts {
  readonly requestedPesewas: bigint;
  readonly createdAt: Date;
  /** The end of the window the order waits for this money (the checkout's hold, or the counter's prompt). */
  readonly awaitedUntil: Date;
  /** Set when the order stopped waiting (cancelled or expired) before the money arrived. */
  readonly releasedAt: Date | null;
}

/** The provider's own record of a charge, from its server-to-server API: the only source of an amount and status. */
export interface ProviderAnswer {
  readonly status: 'SUCCESS' | 'FAILED' | 'ABANDONED' | 'PENDING' | 'REVERSED';
  readonly amountPesewas: bigint;
  readonly currency: string;
  readonly paidAt: Date | null;
}

export type ChargeDecision =
  | { readonly kind: 'CLEAR'; readonly heldAsUnmatched: boolean }
  | { readonly kind: 'AMOUNT_DIFFERS'; readonly confirmedPesewas: bigint }
  | { readonly kind: 'FAIL'; readonly status: 'FAILED' | 'ABANDONED'; readonly reason: string }
  | { readonly kind: 'WAIT' };

/**
 * What the provider's answer does to a pending charge (FR-PAY-004, FR-PAY-007, FR-PAY-008). A success clears it only
 * for exactly the amount asked in cedis; paid after the window closed, or after the order released it, it still
 * clears (the money is real and is never discarded) but is held as an unmatched deposit for a person to decide.
 */
export function judgeProviderAnswer(charge: ChargeFacts, answer: ProviderAnswer, now: Date): ChargeDecision {
  switch (answer.status) {
    case 'SUCCESS': {
      if (answer.currency !== 'GHS' || answer.amountPesewas !== charge.requestedPesewas) {
        return { kind: 'AMOUNT_DIFFERS', confirmedPesewas: answer.amountPesewas };
      }
      const paidAt = answer.paidAt ?? now;
      const late = paidAt.getTime() > charge.awaitedUntil.getTime() || (charge.releasedAt !== null && charge.releasedAt.getTime() <= paidAt.getTime());
      return { kind: 'CLEAR', heldAsUnmatched: late };
    }
    case 'FAILED':
      return { kind: 'FAIL', status: 'FAILED', reason: 'The provider reported the charge failed' };
    case 'ABANDONED':
      return { kind: 'FAIL', status: 'ABANDONED', reason: 'The customer did not approve the charge' };
    case 'REVERSED':
      return { kind: 'FAIL', status: 'FAILED', reason: 'The provider reversed the charge' };
    case 'PENDING':
      return { kind: 'WAIT' };
  }
}

/** A charge the provider has no record of: it may still arrive within the grace period, then it is missing. */
export function judgeMissingCharge(charge: ChargeFacts, now: Date): 'WAIT' | 'MISSING' {
  return elapsedMs(charge.createdAt, now) > PROVIDER_MISSING_GRACE_MS ? 'MISSING' : 'WAIT';
}

const GHANA_MOBILE = /^\+233(\d{2})\d{4}(\d{3})$/;

/** The payer's phone as it is stored and shown: the network prefix and the last three digits (DC-22). */
export function maskPhone(e164: string): string {
  const match = GHANA_MOBILE.exec(e164);
  if (match === null) throw new Error('the payer’s phone is not a Ghanaian mobile number in E.164');
  return `+233 ${match[1]} *** *${match[2]}`;
}
