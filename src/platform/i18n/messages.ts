/**
 * The translation layer (NFR-022). Every user-facing string the API returns is looked up here by key;
 * none is written inline in a handler. English ships first; another locale is another catalogue.
 * Platform holds the generic messages; each module registers its own catalogue for its business codes
 * (ADR-0009: no business rules in platform), from its `interface/messages.ts`.
 */
const PLATFORM_ENGLISH = {
  'error.validation_failed': 'Some fields are not valid.',
  'error.malformed_json': 'The request body is not valid JSON.',
  'error.unauthenticated': 'Please sign in again.',
  'error.forbidden': 'You do not have permission to do that.',
  'error.not_found': 'We could not find that record.',
  'error.route_not_found': 'There is no such address in this API.',
  'error.version_conflict': 'This record was changed by someone else. Reload it and try again.',
  'error.payload_too_large': 'The request is too large.',
  'error.unsupported_media_type': 'That content type is not accepted.',
  'error.rate_limited': 'Too many requests. Please wait a moment and try again.',
  'error.internal': 'Something went wrong on our side. Quote the reference when you contact support.',
  'error.service_unavailable': 'The service is temporarily unavailable. Please try again shortly.',
  'error.dependency_down': 'A service this system depends on is not responding.',
  'error.idempotency_key_required': 'This request needs an Idempotency-Key header with a UUID.',
  'error.idempotency_key_reused': 'This Idempotency-Key was already used for a different request. Use a new key for a new action.',
  'error.origin_not_allowed': 'Requests from this site are not accepted.',
  'error.invalid_state_transition': 'This record is not in a state that allows that action.',
  'error.field_invalid': 'This value is not valid.',
  'error.field_required': 'This field is required.',
  'error.field_unknown': 'This field is not accepted.',
} as const;

export type MessageKey = keyof typeof PLATFORM_ENGLISH;

export type Locale = 'en';

const catalogue = new Map<string, string>(Object.entries(PLATFORM_ENGLISH));

/** Adds a module's English messages. A key may be registered once; a clash is a programming error. */
export function registerMessages(messages: Readonly<Record<string, string>>): void {
  for (const [key, text] of Object.entries(messages)) {
    const existing = catalogue.get(key);
    if (existing !== undefined && existing !== text) {
      throw new Error(`message ${key} is registered twice with different text`);
    }
    catalogue.set(key, text);
  }
}

/** Whether a key has a message, so tests can prove every error's message exists. */
export function hasMessage(key: string): boolean {
  return catalogue.has(key);
}

export function translate(key: string, _locale: Locale = 'en'): string {
  const text = catalogue.get(key);
  if (text === undefined) {
    throw new Error(`no message is registered for ${key}`);
  }
  return text;
}
