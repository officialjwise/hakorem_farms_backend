/**
 * Removes what must never leave the process in a log line (ENGINEERING_STANDARDS section 4, SC-08):
 * secrets by key name, and phone numbers inside any string, keeping only the last three digits.
 * A new sensitive field is added here and to log-scrubber.spec.ts in the same change.
 */
const SENSITIVE_KEY = /pass(word)?|secret|token|authori[sz]ation|cookie|otp|totp|api[-_]?key|private[-_]?key|signature|card|cvv|pin$/i;

/** Ghana numbers in E.164 (+233 and nine digits) or national form (0 and nine digits), with optional spaces or dashes. */
const PHONE_NUMBER = /(?:\+233|\b0)(?:[\s-]?\d){9}\b/g;

export const REDACTED = '[redacted]';

/** Whether a field of this name holds a secret that is never logged, audited or published (ADR-0022). */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
const MAX_DEPTH = 8;

function maskPhone(match: string): string {
  return `***${match.replace(/\D/g, '').slice(-3)}`;
}

export function scrubString(value: string): string {
  return value.replace(PHONE_NUMBER, maskPhone);
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) {
    return value;
  }
  if (value instanceof Error) {
    return { type: value.name, message: scrubString(value.message), stack: scrubString(value.stack ?? '') };
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => scrub(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : scrub(item, depth + 1);
  }
  return out;
}
