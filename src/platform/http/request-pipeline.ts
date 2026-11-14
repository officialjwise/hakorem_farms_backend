import { trace } from '@opentelemetry/api';
import { createUuidV7Generator, systemClock } from '@hakorem/kernel';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { runWithRequestContext, currentRequestContext } from '../context/request-context';
import { MalformedJsonError, PayloadTooLargeError, UnsupportedMediaTypeError, type ApiError } from '../errors/api-error';
import { toErrorEnvelope } from '../errors/error-envelope';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';
/** Largest JSON body the API reads; endpoints that need more (sync batches, imports) raise it per route. */
export const JSON_BODY_LIMIT = '256kb';
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
/** Longest user agent kept for the audit trail (platform.audit_event.user_agent). */
const MAX_USER_AGENT = 512;

const nextCorrelationId = createUuidV7Generator(systemClock);

/**
 * First in the pipeline: takes a valid incoming correlation id or assigns a UUIDv7, returns it on every
 * response, records it on the active span and makes it ambient for the rest of the request (NFR-019).
 */
export function correlationId(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header(CORRELATION_ID_HEADER);
    const id = incoming !== undefined && ANY_UUID.test(incoming) ? incoming.toLowerCase() : nextCorrelationId();
    res.setHeader(CORRELATION_ID_HEADER, id);
    trace.getActiveSpan()?.setAttribute('hk.correlation_id', id);
    const userAgent = req.header('User-Agent');
    runWithRequestContext({ correlationId: id, ip: req.ip ?? null, userAgent: userAgent === undefined ? null : userAgent.slice(0, MAX_USER_AGENT) }, () =>
      next(),
    );
  };
}

/** One line per request when the response is sent: method, path without the query string, status, duration. */
export function requestLog(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    const context = currentRequestContext();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND);
      const fields = { method: req.method, path: req.path, status: res.statusCode, durationMs };
      const write = () => logger.info(fields, 'request completed');
      if (context === undefined) {
        write();
      } else {
        runWithRequestContext(context, write);
      }
    });
    next();
  };
}

function bodyParserError(error: unknown): ApiError | undefined {
  const type = typeof error === 'object' && error !== null ? (error as { type?: unknown }).type : undefined;
  switch (type) {
    case 'entity.parse.failed':
      return new MalformedJsonError('request body is not valid JSON', [], { cause: error });
    case 'entity.too.large':
      return new PayloadTooLargeError('request body exceeds the limit', [], { cause: error });
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return new UnsupportedMediaTypeError('request encoding is not supported', [], { cause: error });
    default:
      return undefined;
  }
}

/**
 * Reads JSON bodies up to the limit. A body the parser refuses is answered here with the error envelope,
 * through the same mapping as every other error, because it happens before any route is chosen.
 */
export function jsonBody(logger: Logger): RequestHandler {
  const parse = express.json({ limit: JSON_BODY_LIMIT });
  return (req: Request, res: Response, next: NextFunction) => {
    parse(req, res, (error?: unknown) => {
      if (error === undefined || error === null) {
        next();
        return;
      }
      const correlation = currentRequestContext()?.correlationId ?? String(res.getHeader(CORRELATION_ID_HEADER));
      const { status, envelope } = toErrorEnvelope(bodyParserError(error) ?? error, correlation, logger);
      res.status(status).json(envelope);
    });
  };
}
