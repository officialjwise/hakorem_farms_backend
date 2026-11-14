import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type LevelWithSilentOrString, type Logger, type LoggerOptions } from 'pino';
import { currentRequestContext } from '../context/request-context';
import { scrub, scrubString } from './log-scrubber';

export interface LoggerSettings {
  readonly level: LevelWithSilentOrString;
  readonly service: string;
  readonly version: string;
}

/**
 * The one shared Pino logger (ENGINEERING_STANDARDS section 4). Every line is JSON and carries the
 * correlation id of the request or job that caused it and the active trace and span ids, and is scrubbed
 * before it leaves the process.
 */
export function createLogger(settings: LoggerSettings, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: settings.level,
    base: { service: settings.service, version: settings.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => scrub(object) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((arg: unknown) => (typeof arg === 'string' ? scrubString(arg) : arg));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      return {
        correlationId: currentRequestContext()?.correlationId,
        traceId: spanContext?.traceId,
        spanId: spanContext?.spanId,
      };
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
