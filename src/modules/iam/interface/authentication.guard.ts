import { createHash } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../../../platform/config/app-config';
import { bindActor, type Realm } from '../../../platform/context/request-context';
import { ForbiddenError, OriginNotAllowedError, RateLimitedError, ServiceUnavailableError, UnauthenticatedError, ValidationFailedError } from '../../../platform/errors/api-error';
import { translate } from '../../../platform/i18n/messages';
import { OPERATION_METADATA, type OperationSpec } from '../../../platform/http/operation';
import { RATE_LIMIT_RULES, RateLimiter, type RateLimitGroup } from '../../../platform/http/rate-limiter';
import { originAllowed } from '../../../platform/http/security-headers';
import { Settings } from '../../../platform/settings/settings';
import { AuthenticationService, type AuthenticatedRequest } from '../application/authentication.service';
import { CsrfTokenInvalidError, PasswordChangeRequiredError } from '../application/errors';
import { accessCookieName, readCookies } from './cookies';

/** What the guard leaves on the request for the controller: the authenticated session, if any. */
export interface GuardedRequest extends Request {
  hkAuth?: AuthenticatedRequest;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The `realm` query parameter, when a browser holds sessions in more than one realm. */
export function requestedRealm(req: Request, allowed: readonly Realm[]): Realm | undefined {
  const value = req.query['realm'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationFailedError('realm is not one of the operation realms', [{ field: '/realm', code: 'ENUM', message: translate('error.field_invalid') }]);
  }
  return value as Realm;
}

function addressKey(req: Request): string {
  return createHash('sha256').update(req.ip ?? 'unknown').digest('hex').slice(0, 32);
}

/**
 * The one door every route passes (ADR-0016, ADR-0017). It refuses a route that declares no operation (deny by
 * default), applies the route's rate-limit group, authenticates the session cookie of the operation's realm,
 * checks Origin and X-CSRF-Token on state changes, holds back accounts with a temporary password, and binds the
 * actor to the request context. Permissions are checked by the handler, through the policy engine, not here.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(Settings) private readonly settings: Settings,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const spec = this.reflector.get<OperationSpec | undefined>(OPERATION_METADATA, context.getHandler());
    if (spec === undefined) {
      throw new ForbiddenError(`${context.getClass().name}.${context.getHandler().name} declares no operation`);
    }
    const req = context.switchToHttp().getRequest<GuardedRequest>();
    const allowedOrigins = this.config.CORS_ALLOWED_ORIGINS ?? [];
    if (spec.rateLimit !== 'console') {
      await this.limit(spec.rateLimit, addressKey(req));
    }
    if (spec.access === 'PUBLIC') {
      if (spec.originRequired === true && !originAllowed(req, allowedOrigins)) {
        throw new OriginNotAllowedError(`${spec.operationId} from ${req.header('Origin') ?? 'no origin'}`);
      }
      return true;
    }
    if (/^Bearer\s/i.test(req.header('Authorization') ?? '')) {
      // API keys are a principal like any other (ADR-0016); their administration and authentication arrive with the
      // integrations work, so a key is not accepted yet (A-084).
      throw new UnauthenticatedError('API keys are not accepted yet');
    }
    const cookies = readCookies(req);
    const realms = spec.realms.filter((realm) => cookies.has(accessCookieName(realm)));
    const realm = requestedRealm(req, spec.realms) ?? (realms.length === 1 ? realms[0] : undefined);
    if (realm === undefined) {
      if (realms.length > 1) {
        throw new ValidationFailedError('sessions in more than one realm; say which', [
          { field: '/realm', code: 'REQUIRED', message: translate('error.field_required') },
        ]);
      }
      if (spec.acceptsLoginChallenge === true) {
        return true;
      }
      throw new UnauthenticatedError('no session cookie');
    }
    const token = cookies.get(accessCookieName(realm));
    const authenticated = token === undefined ? null : await this.authentication.authenticate(realm, token);
    if (authenticated === null) {
      throw new UnauthenticatedError('no valid session');
    }
    if (spec.csrf && !SAFE_METHODS.has(req.method)) {
      if (!originAllowed(req, allowedOrigins)) {
        throw new OriginNotAllowedError(`${spec.operationId} from ${req.header('Origin') ?? 'no origin'}`);
      }
      if (!this.authentication.csrfMatches(authenticated.session, req.header('X-CSRF-Token'))) {
        throw new CsrfTokenInvalidError(`${spec.operationId}: missing or wrong CSRF token`);
      }
    }
    if (authenticated.session.mustChangePassword && spec.allowedWithTemporaryPassword !== true) {
      throw new PasswordChangeRequiredError(`${spec.operationId}: temporary password`);
    }
    bindActor(authenticated.actor);
    req.hkAuth = authenticated;
    if (spec.rateLimit === 'console') {
      await this.limit('console', authenticated.actor.principalId);
    }
    return true;
  }

  private async limit(group: RateLimitGroup, subject: string): Promise<void> {
    const rule = RATE_LIMIT_RULES[group];
    const limit = await this.settings.integer(rule.settingKey, rule.defaultLimit);
    const decision = await this.limiter.consume(group, subject, limit, rule.windowSeconds, rule.failClosed);
    if (!decision.allowed) {
      if (decision.reason === 'UNAVAILABLE') {
        throw new ServiceUnavailableError(`${group} rate limiter unavailable; failing closed`);
      }
      throw new RateLimitedError(decision.retryAfterSeconds, `${group} limit reached`);
    }
  }
}
