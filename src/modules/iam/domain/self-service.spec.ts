import { describe, expect, it } from 'vitest';
import { formatPhoneCode, isGhanaPhone, PHONE_CODE_MAX_ATTEMPTS, phoneCodeRefusal, resetTokenRefusal } from './self-service';

const now = new Date('2026-11-15T10:00:00Z');
const later = new Date('2026-11-15T10:10:00Z');

describe('Ghana phone numbers (FR-IAM-019)', () => {
  it('takes +233 and nine digits only', () => {
    expect(isGhanaPhone('+233249903118')).toBe(true);
    expect(isGhanaPhone('+23324990311')).toBe(false);
    expect(isGhanaPhone('+2332499031189')).toBe(false);
    expect(isGhanaPhone('+447700900123')).toBe(false);
    expect(isGhanaPhone('0249903118')).toBe(false);
  });
});

describe('phone verification codes (FR-IAM-019)', () => {
  it('writes six digits, keeping leading zeros', () => {
    expect(formatPhoneCode(0)).toBe('000000');
    expect(formatPhoneCode(730194)).toBe('730194');
    expect(formatPhoneCode(999_999)).toBe('999999');
  });

  it('refuses a number outside six digits', () => {
    expect(() => formatPhoneCode(1_000_000)).toThrow();
    expect(() => formatPhoneCode(-1)).toThrow();
    expect(() => formatPhoneCode(1.5)).toThrow();
  });

  it('allows five attempts and refuses the sixth whatever it holds', () => {
    expect(PHONE_CODE_MAX_ATTEMPTS).toBe(5);
    expect(phoneCodeRefusal({ attempts: 5, expiresAt: later, consumedAt: null, now })).toBeNull();
    expect(phoneCodeRefusal({ attempts: 6, expiresAt: later, consumedAt: null, now })).toBe('TOO_MANY_ATTEMPTS');
  });

  it('refuses a spent or an expired challenge', () => {
    expect(phoneCodeRefusal({ attempts: 1, expiresAt: later, consumedAt: now, now })).toBe('SPENT');
    expect(phoneCodeRefusal({ attempts: 1, expiresAt: now, consumedAt: null, now })).toBe('EXPIRED');
  });
});

describe('password reset tokens (FR-IAM-020, CR-004 point 3)', () => {
  it('names a used token before an expired one, and passes a live one', () => {
    expect(resetTokenRefusal({ expiresAt: later, consumedAt: null, now })).toBeNull();
    expect(resetTokenRefusal({ expiresAt: now, consumedAt: now, now })).toBe('RESET_TOKEN_USED');
    expect(resetTokenRefusal({ expiresAt: now, consumedAt: null, now })).toBe('RESET_TOKEN_EXPIRED');
  });
});
