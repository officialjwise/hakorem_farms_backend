
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
  /** A key in the translation layer: platform's catalogue or the raising module's own. */
  abstract readonly messageKey: string;
  /** Response headers the error needs, such as Retry-After on 429. */
  readonly headers: Readonly<Record<string, string>> = {};

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

export class UnauthenticatedError extends ApiError {
  readonly status = 401;
  readonly code = 'UNAUTHENTICATED';
  readonly messageKey = 'error.unauthenticated';
}

/** 403. Also answers a record that exists but belongs to someone else, so existence is not revealed. */
export class ForbiddenError extends ApiError {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  readonly messageKey = 'error.forbidden';
}

export class NotFoundError extends ApiError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
  readonly messageKey = 'error.not_found';
}

export class VersionConflictError extends ApiError {
  readonly status = 409;
  readonly code = 'VERSION_CONFLICT';
  readonly messageKey = 'error.version_conflict';
}

export class IdempotencyKeyRequiredError extends ApiError {
  readonly status = 400;
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED';
  readonly messageKey = 'error.idempotency_key_required';
}

export class OriginNotAllowedError extends ApiError {
  readonly status = 403;
  readonly code = 'ORIGIN_NOT_ALLOWED';
  readonly messageKey = 'error.origin_not_allowed';
}

export class InvalidStateTransitionError extends BusinessRuleError {
  readonly code = 'INVALID_STATE_TRANSITION';
  readonly messageKey = 'error.invalid_state_transition';
}

/** 429 with Retry-After in whole seconds (docs/API.md section 12). */
export class RateLimitedError extends ApiError {
  readonly status = 429;
  readonly code = 'RATE_LIMITED';
  readonly messageKey = 'error.rate_limited';
  override readonly headers: Readonly<Record<string, string>>;

  constructor(
    readonly retryAfterSeconds: number,
    internalMessage = 'rate limit reached',
  ) {
    super(internalMessage);
    this.headers = { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) };
  }
}
