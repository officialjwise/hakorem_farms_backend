/** SA-20: a password is at least twelve characters. The upper bound stops a hashing denial of service. */
export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_CHARACTERS = 128;

export type PasswordShapeProblem = 'TOO_SHORT' | 'TOO_LONG' | 'SAME_AS_IDENTIFIER';

/** The rules a new password must meet before the breached-password check (FR-IAM-005). */
export function checkPasswordShape(password: string, identifier: string): PasswordShapeProblem | null {
  const characters = [...password].length;
  if (characters < PASSWORD_MIN_CHARACTERS) {
    return 'TOO_SHORT';
  }
  if (characters > PASSWORD_MAX_CHARACTERS) {
    return 'TOO_LONG';
  }
  if (password.trim().toLowerCase() === identifier.trim().toLowerCase()) {
    return 'SAME_AS_IDENTIFIER';
  }
  return null;
}

export type Identifier = { readonly kind: 'EMAIL'; readonly value: string } | { readonly kind: 'PHONE'; readonly value: string };

const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** An email address (lower-cased) or a phone number in E.164 form; anything else matches no account. */
export function normaliseIdentifier(raw: string): Identifier | null {
  const value = raw.trim();
  if (E164.test(value)) {
    return { kind: 'PHONE', value };
  }
  const email = value.toLowerCase();
  return EMAIL.test(email) ? { kind: 'EMAIL', value: email } : null;
}

export interface RealmLifetimes {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
}

const MILLISECONDS_PER_SECOND = 1_000;

/**
 * When a session's refresh token stops working (ADR-0016): the idle lifetime counts from the last use, and the
 * absolute lifetime from the login, and the earlier wins.
 */
export function refreshExpiry(sessionCreatedAt: Date, lastUsedAt: Date, lifetimes: RealmLifetimes): { idleExpiresAt: Date; absoluteExpiresAt: Date } {
  const absoluteExpiresAt = new Date(sessionCreatedAt.getTime() + lifetimes.absoluteSeconds * MILLISECONDS_PER_SECOND);
  const idle = lastUsedAt.getTime() + lifetimes.idleSeconds * MILLISECONDS_PER_SECOND;
  return { idleExpiresAt: new Date(Math.min(idle, absoluteExpiresAt.getTime())), absoluteExpiresAt };
}
