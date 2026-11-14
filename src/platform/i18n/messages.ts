/**
 * The translation layer (NFR-022). Every user-facing string the API returns is looked up here by key;
 * none is written inline in a handler. English ships first; another locale is another catalogue.
 */
const ENGLISH = {
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
} as const;

export type MessageKey = keyof typeof ENGLISH;

export type Locale = 'en';

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = { en: ENGLISH };

export function translate(key: MessageKey, locale: Locale = 'en'): string {
  return CATALOGUES[locale][key];
}
