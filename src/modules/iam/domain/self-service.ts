/**
 * The rules of the customer realm and of password reset (FR-IAM-019, FR-IAM-020, A-123). Pure: the handler reads the
 * facts and hands them in.
 */

/** A Ghana mobile number in E.164 form: +233 and nine digits. */
const GHANA_PHONE = /^\+233[0-9]{9}$/;
const CODE_DIGITS = 6;
const CODE_LIMIT = 1_000_000;

/** A phone verification code lasts ten minutes and takes at most five attempts (FR-IAM-019). */
export const PHONE_CODE_TTL_SECONDS = 600;
export const PHONE_CODE_MAX_ATTEMPTS = 5;
/** A reset token lasts thirty minutes and is used once (FR-IAM-020). */
export const RESET_TOKEN_TTL_SECONDS = 1_800;

export function isGhanaPhone(phone: string): boolean {
  return GHANA_PHONE.test(phone);
}

/** A uniformly drawn number below one million, as the six digits the customer types. */
export function formatPhoneCode(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= CODE_LIMIT) {
    throw new Error('a phone code is drawn from 0 to 999999');
  }
  return String(value).padStart(CODE_DIGITS, '0');
}

export type PhoneCodeRefusal = 'TOO_MANY_ATTEMPTS' | 'SPENT' | 'EXPIRED';

/**
 * Whether a code may be compared at all. `attempts` already counts this one, so the sixth try is refused before its
 * code is looked at, even if it is right.
 */
export function phoneCodeRefusal(state: { readonly attempts: number; readonly expiresAt: Date; readonly consumedAt: Date | null; readonly now: Date }): PhoneCodeRefusal | null {
  if (state.consumedAt !== null) return 'SPENT';
  if (state.now.getTime() >= state.expiresAt.getTime()) return 'EXPIRED';
  return state.attempts > PHONE_CODE_MAX_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : null;
}

export type ResetTokenRefusal = 'RESET_TOKEN_USED' | 'RESET_TOKEN_EXPIRED';

/** A known reset token that cannot be used, and why (CR-004 point 3). An unknown one is `RESET_TOKEN_INVALID`. */
export function resetTokenRefusal(state: { readonly expiresAt: Date; readonly consumedAt: Date | null; readonly now: Date }): ResetTokenRefusal | null {
  if (state.consumedAt !== null) return 'RESET_TOKEN_USED';
  return state.now.getTime() >= state.expiresAt.getTime() ? 'RESET_TOKEN_EXPIRED' : null;
}
