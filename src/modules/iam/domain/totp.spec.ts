import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, otpauthUri, totpAt, verifyTotp } from './totp';

// RFC 6238 appendix B, SHA-1, with the shared secret "12345678901234567890". The RFC lists 8-digit codes;
// a 6-digit code is the last six digits of the same value.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP (RFC 6238, ADR-0016)', () => {
  it('produces the RFC 6238 test vector codes', () => {
    expect(totpAt(RFC_SECRET, 59)).toBe('287082');
    expect(totpAt(RFC_SECRET, 1_111_111_109)).toBe('081804');
    expect(totpAt(RFC_SECRET, 1_111_111_111)).toBe('050471');
    expect(totpAt(RFC_SECRET, 1_234_567_890)).toBe('005924');
    expect(totpAt(RFC_SECRET, 2_000_000_000)).toBe('279037');
  });

  it('round-trips a secret through base32 as authenticator apps expect', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').equals(RFC_SECRET)).toBe(true);
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(RFC_SECRET)).toBe(true);
  });

  it('accepts the current code and one step either side, and returns the step it matched', () => {
    const now = 1_111_111_111;
    const step = Math.floor(now / 30);
    expect(verifyTotp(RFC_SECRET, '050471', now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30), now, null)).toBe(step + 1);
  });

  it('refuses a code two steps away, a malformed code and a wrong code', () => {
    const now = 1_111_111_111;
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 60), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '05047', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '000000', now, null)).toBeNull();
  });

  it('refuses a code from a step already used, so a code cannot be replayed', () => {
    const now = 1_111_111_111;
    const step = Math.floor(now / 30);
    expect(verifyTotp(RFC_SECRET, '050471', now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30), now, step)).toBe(step + 1);
  });

  it('writes the otpauth URI an authenticator app reads, with issuer and label escaped', () => {
    expect(otpauthUri('HaKorem Farms', 'kwabena.owusu@hakoremfarms.com', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/HaKorem%20Farms:kwabena.owusu%40hakoremfarms.com?secret=JBSWY3DPEHPK3PXP&issuer=HaKorem%20Farms&algorithm=SHA1&digits=6&period=30',
    );
  });
});
