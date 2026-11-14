import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  NoopSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TracingSettings {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly samplingRatio: number;
  readonly otlpEndpoint?: string | undefined;
  readonly otlpHeaders?: string | undefined;
  /** Replaces the exporter, for tests that read finished spans. */
  readonly spanProcessors?: readonly SpanProcessor[];
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (raw === undefined) {
    return {};
  }
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split('='))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
}

/**
 * Starts OpenTelemetry tracing for HTTP, Express, PostgreSQL and Redis. Must run before those modules are
 * loaded, so the entry point starts it first and imports the application afterwards. Without an OTLP endpoint
 * spans are still created, so trace ids reach logs and error reports, but nothing is exported.
 */
export function startTracing(settings: TracingSettings): NodeSDK {
  const processors: SpanProcessor[] = [...(settings.spanProcessors ?? [])];
  if (settings.spanProcessors === undefined && settings.otlpEndpoint !== undefined) {
    const exporter = new OTLPTraceExporter({
      url: `${settings.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
      headers: parseHeaders(settings.otlpHeaders),
    });
    processors.push(new BatchSpanProcessor(exporter));
  }
  if (processors.length === 0) {
    // Without any processor the SDK registers no tracer provider and every span is a no-op with an all-zero
    // trace id. A no-op processor keeps real spans and ids while exporting nothing.
    processors.push(new NoopSpanProcessor());
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: settings.serviceName,
      [ATTR_SERVICE_VERSION]: settings.serviceVersion,
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(settings.samplingRatio) }),
    spanProcessors: processors,
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/v1/health' }),
      new ExpressInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
