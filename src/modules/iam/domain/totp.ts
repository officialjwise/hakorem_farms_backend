import { createHmac, timingSafeEqual } from 'node:crypto';

/** RFC 6238 defaults that every common authenticator app uses. */
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
const MODULUS = 10 ** DIGITS;
/** Steps accepted either side of the current one, for clock drift between phone and server. */
const DRIFT_STEPS = 1;
const SIX_DIGITS = /^\d{6}$/;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4226 HOTP: HMAC-SHA-1 of the counter, dynamically truncated to six digits. */
function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % MODULUS).padStart(DIGITS, '0');
}

export function stepAt(unixSeconds: number): number {
  return Math.floor(unixSeconds / TOTP_PERIOD_SECONDS);
}

/** The code an authenticator shows at this instant (unix seconds). */
export function totpAt(secret: Buffer, unixSeconds: number): string {
  return hotp(secret, stepAt(unixSeconds));
}

/**
 * Checks a six-digit code against the current step and one either side, in constant time per comparison. Returns
 * the step it matched, or null. A step at or before `lastUsedStep` is refused, so a code cannot be replayed.
 */
export function verifyTotp(secret: Buffer, code: string, unixSeconds: number, lastUsedStep: number | null): number | null {
  if (!SIX_DIGITS.test(code)) {
    return null;
  }
  const current = stepAt(unixSeconds);
  const given = Buffer.from(code, 'ascii');
  let matched: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    const expected = Buffer.from(hotp(secret, step), 'ascii');
    if (timingSafeEqual(expected, given) && matched === null && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** RFC 4648 base32 without padding, as authenticator apps take a secret. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(text: string): Buffer {
  const cleaned = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) {
      throw new RangeError('not a base32 string');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** The `otpauth://` URI a client renders as a QR code (Key Uri Format). */
export function otpauthUri(issuer: string, accountLabel: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
