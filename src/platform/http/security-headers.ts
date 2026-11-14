import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';
import { currentRequestContext } from '../context/request-context';
import { OriginNotAllowedError } from '../errors/api-error';
import { toErrorEnvelope } from '../errors/error-envelope';

/** Request headers a browser client may send (docs/API.md section 2). */
const ALLOWED_HEADERS = ['Content-Type', 'Idempotency-Key', 'X-CSRF-Token', 'X-Correlation-Id', 'X-Device-Credential'].join(', ');
/** Response headers a browser client may read. */
const EXPOSED_HEADERS = ['X-Correlation-Id', 'Retry-After'].join(', ');
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';
/** Seconds a browser may cache a preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * CORS with an allow-list of the storefront and console origins and credentials, never a wildcard (security
 * architecture section 5). A preflight from any other origin is refused with ORIGIN_NOT_ALLOWED. A simple request
 * from another origin gets no CORS headers, so the browser withholds the response; state changes from it are refused
 * by the authentication guard's origin check. Also sets `Cache-Control: no-store` and `nosniff` on every response
 * (Caddy adds the rest of the transport headers in front).
 */
export function corsAndHeaders(allowedOrigins: readonly string[], logger: Logger): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.header('Origin');
    if (origin !== undefined && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
      res.vary('Origin');
    }
    if (req.method !== 'OPTIONS' || req.header('Access-Control-Request-Method') === undefined) {
      next();
      return;
    }
    if (origin === undefined || !allowed.has(origin)) {
      const correlation = currentRequestContext()?.correlationId ?? String(res.getHeader('X-Correlation-Id'));
      const { status, envelope } = toErrorEnvelope(new OriginNotAllowedError(`preflight from ${origin ?? 'no origin'}`), correlation, logger);
      res.status(status).json(envelope);
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
    res.status(204).end();
  };
}

/** Whether a state-changing, cookie-authenticated request comes from an allowed origin (ADR-0016, CSRF). */
export function originAllowed(req: Request, allowedOrigins: readonly string[]): boolean {
  const origin = req.header('Origin');
  return origin !== undefined && allowedOrigins.includes(origin);
}
