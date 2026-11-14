import { HttpException, HttpStatus } from '@nestjs/common';
import type { Logger } from 'pino';
import { hasMessage, translate } from '../i18n/messages';
import { ApiError, type ErrorDetail } from './api-error';

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly details: readonly ErrorDetail[];
  };
}

export interface MappedError {
  readonly status: number;
  readonly envelope: ErrorEnvelope;
  readonly headers: Readonly<Record<string, string>>;
}

/** Generic codes for statuses raised by the framework rather than by our own errors (docs/API.md 10.3). */
const GENERIC_BY_STATUS: Readonly<Record<number, { code: string; messageKey: string }>> = {
  [HttpStatus.BAD_REQUEST]: { code: 'VALIDATION_FAILED', messageKey: 'error.validation_failed' },
  [HttpStatus.UNAUTHORIZED]: { code: 'UNAUTHENTICATED', messageKey: 'error.unauthenticated' },
  [HttpStatus.FORBIDDEN]: { code: 'FORBIDDEN', messageKey: 'error.forbidden' },
  [HttpStatus.NOT_FOUND]: { code: 'NOT_FOUND', messageKey: 'error.route_not_found' },
  [HttpStatus.CONFLICT]: { code: 'VERSION_CONFLICT', messageKey: 'error.version_conflict' },
  [HttpStatus.PAYLOAD_TOO_LARGE]: { code: 'PAYLOAD_TOO_LARGE', messageKey: 'error.payload_too_large' },
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: { code: 'UNSUPPORTED_MEDIA_TYPE', messageKey: 'error.unsupported_media_type' },
  [HttpStatus.TOO_MANY_REQUESTS]: { code: 'RATE_LIMITED', messageKey: 'error.rate_limited' },
  [HttpStatus.SERVICE_UNAVAILABLE]: { code: 'SERVICE_UNAVAILABLE', messageKey: 'error.service_unavailable' },
};

const INTERNAL = { code: 'INTERNAL', messageKey: 'error.internal' } as const;

/**
 * The one mapping from an error to the envelope (ENGINEERING_STANDARDS section 3, SC-16). Nothing else writes
 * an error response. An unexpected error becomes a 500 with the correlation id and no internal detail, and is
 * logged here, once, with the error attached.
 */
export function toErrorEnvelope(error: unknown, correlationId: string, logger: Logger): MappedError {
  if (error instanceof ApiError) {
    if (error.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      logger.error({ err: error, status: error.status, code: error.code }, 'request failed');
    }
    if (!hasMessage(error.messageKey)) {
      logger.error({ code: error.code, messageKey: error.messageKey }, 'error has no registered message');
      return build(error.status, error.code, 'error.internal', error.details, correlationId, error.headers);
    }
    return build(error.status, error.code, error.messageKey, error.details, correlationId, error.headers);
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const generic = GENERIC_BY_STATUS[status];
    if (generic !== undefined) {
      return build(status, generic.code, generic.messageKey, [], correlationId);
    }
  }
  logger.error({ err: error }, 'unexpected error');
  return build(HttpStatus.INTERNAL_SERVER_ERROR, INTERNAL.code, INTERNAL.messageKey, [], correlationId);
}

function build(
  status: number,
  code: string,
  messageKey: string,
  details: readonly ErrorDetail[],
  correlationId: string,
  headers: Readonly<Record<string, string>> = {},
): MappedError {
  return { status, headers, envelope: { error: { code, message: translate(messageKey), correlationId, details } } };
}
