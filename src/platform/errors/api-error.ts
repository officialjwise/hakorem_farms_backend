import type { MessageKey } from '../i18n/messages';

/** One offending input, as in the contract's `ErrorDetail`. `field` is a JSON pointer, or null. */
export interface ErrorDetail {
  readonly field: string | null;
  readonly code: string;
  readonly message: string;
}

/**
 * An error the API answers with a specific status and stable code (docs/API.md section 10).
 * The message shown to the user is looked up from the translation layer by `messageKey`.
 */
export abstract class ApiError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  abstract readonly messageKey: MessageKey;

  constructor(
    internalMessage: string,
    readonly details: readonly ErrorDetail[] = [],
    options?: ErrorOptions,
  ) {
    super(internalMessage, options);
    this.name = new.target.name;
  }
}

/**
 * A business refusal: a valid request a domain rule refuses (422). Each module defines its own subclasses
 * with a stable code from the catalogue in docs/API.md; the platform holds no business codes (ADR-0009).
 */
export abstract class BusinessRuleError extends ApiError {
  readonly status = 422;
}

export class ValidationFailedError extends ApiError {
  readonly status = 400;
  readonly code = 'VALIDATION_FAILED';
  readonly messageKey = 'error.validation_failed';
}

export class MalformedJsonError extends ApiError {
  readonly status = 400;
  readonly code = 'VALIDATION_FAILED';
  readonly messageKey = 'error.malformed_json';
}

export class PayloadTooLargeError extends ApiError {
  readonly status = 413;
  readonly code = 'PAYLOAD_TOO_LARGE';
  readonly messageKey = 'error.payload_too_large';
}

export class UnsupportedMediaTypeError extends ApiError {
  readonly status = 415;
  readonly code = 'UNSUPPORTED_MEDIA_TYPE';
  readonly messageKey = 'error.unsupported_media_type';
}

export class RouteNotFoundError extends ApiError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  readonly messageKey = 'error.route_not_found';
}

export class ServiceUnavailableError extends ApiError {
  readonly status = 503;
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly messageKey = 'error.service_unavailable';
}
