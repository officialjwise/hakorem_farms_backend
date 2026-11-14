import { applyDecorators, createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Realm } from '../context/request-context';
import { IdempotencyKeyRequiredError } from '../errors/api-error';
import { translate } from '../i18n/messages';
import type { RateLimitGroup } from './rate-limiter';

export const OPERATION_METADATA = 'hk:operation';

/**
 * What a route is, declared once on the controller method and read by the authentication guard, the contract
 * generator and the handler-walk test. A route without it is refused (deny by default, ADR-0017).
 *
 * - `access: 'PUBLIC'` needs no session; `'SESSION'` needs a live session in one of `realms`.
 * - `permission` is the code the handler checks through the IAM policy engine, null for an operation on the
 *   caller's own account (ownership instead), and must equal the contract's `x-permission`.
 * - `idempotent` requires the Idempotency-Key header; `csrf` requires X-CSRF-Token and an allowed Origin.
 */
export interface OperationSpec {
  readonly operationId: string;
  readonly access: 'PUBLIC' | 'SESSION';
  readonly realms: readonly Realm[];
  readonly permission: string | null;
  readonly idempotent: boolean;
  readonly csrf: boolean;
  readonly rateLimit: RateLimitGroup;
  /** Reachable while the account still has a temporary password (change it, read the session, log out). */
  readonly allowedWithTemporaryPassword?: boolean;
  /**
   * Also reachable with no session, by a login challenge in the body: the steps between password and session
   * (change a temporary password, enrol TOTP). The handler then requires a valid challenge.
   */
  readonly acceptsLoginChallenge?: boolean;
  /** A public route that a browser calls with a cookie (refresh): its Origin must be on the allow-list. */
  readonly originRequired?: boolean;
}

const OPERATION_ID = /^[a-z][A-Za-z]+$/;
const PERMISSION = /^[a-z]+\.[a-z_]+\.[a-z_.]+$/;

export function Operation(spec: OperationSpec): MethodDecorator {
  if (!OPERATION_ID.test(spec.operationId)) {
    throw new Error(`"${spec.operationId}" is not an operationId`);
  }
  if (spec.permission !== null && !PERMISSION.test(spec.permission)) {
    throw new Error(`${spec.operationId}: "${spec.permission}" is not a permission code`);
  }
  if (spec.access === 'SESSION' && spec.realms.length === 0) {
    throw new Error(`${spec.operationId}: a session operation names at least one realm`);
  }
  if (spec.access === 'PUBLIC' && (spec.permission !== null || spec.csrf)) {
    throw new Error(`${spec.operationId}: a public operation has no permission and no CSRF token`);
  }
  return applyDecorators(SetMetadata(OPERATION_METADATA, spec), ApiOperation({ operationId: spec.operationId }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The validated `Idempotency-Key` header (ADR-0014): a UUID, lower-cased. 400 when absent or malformed. */
export const IdempotencyKeyHeader = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const value = context.switchToHttp().getRequest<Request>().header('Idempotency-Key');
  if (value === undefined || !UUID.test(value)) {
    throw new IdempotencyKeyRequiredError(value === undefined ? 'Idempotency-Key is missing' : 'Idempotency-Key is not a UUID', [
      { field: null, code: value === undefined ? 'REQUIRED' : 'FORMAT', message: translate('error.idempotency_key_required') },
    ]);
  }
  return value.toLowerCase();
});
