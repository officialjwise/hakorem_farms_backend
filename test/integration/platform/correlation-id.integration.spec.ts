import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { NodeSDK } from '@opentelemetry/sdk-node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTracing } from '../../../src/platform/tracing/tracing';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import type { TestApp } from '../../support/test-app';

/**
 * NFR-019: every request carries a correlation id that appears in logs, traces and any error shown to a user.
 * Tracing starts before the application is loaded, exactly as the entry point does it.
 */
const exporter = new InMemorySpanExporter();
let sdk: NodeSDK;
let database: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  sdk = startTracing({
    serviceName: 'hakorem-api-test',
    serviceVersion: '0.1.0',
    samplingRatio: 1,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const { startTestApp } = await import('../../support/test-app.js');
  database = await createTestDatabase();
  api = await startTestApp(database);
});

afterAll(async () => {
  await api.close();
  await database.drop();
  await sdk.shutdown();
});

describe('correlation id (NFR-019)', () => {
  it('one id appears in the response the log and the trace', async () => {
    const response = await request(api.server).get('/v1/no-such-route');
    const id = response.headers['x-correlation-id'] as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // The error body repeats it.
    expect(response.status).toBe(404);
    expect(response.body.error.correlationId).toBe(id);

    // The request log line carries it, with the trace it belongs to.
    const line = api.logLines().find((entry) => entry['msg'] === 'request completed' && entry['correlationId'] === id);
    expect(line).toBeDefined();

    // The server span carries it as an attribute, in the same trace as the log line.
    const span = exporter.getFinishedSpans().find((s) => s.attributes['hk.correlation_id'] === id);
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(line!['traceId']);
  });

  it('keeps a valid incoming correlation id', async () => {
    const incoming = '019a7b1d-3b44-79c8-8f00-a553bc391e31';
    const response = await request(api.server).get('/v1/no-such-route').set('X-Correlation-Id', incoming);
    expect(response.headers['x-correlation-id']).toBe(incoming);
    expect(response.body.error.correlationId).toBe(incoming);
  });

  it('replaces an incoming value that is not a UUID', async () => {
    const response = await request(api.server).get('/v1/no-such-route').set('X-Correlation-Id', 'drop table; --');
    expect(response.headers['x-correlation-id']).not.toBe('drop table; --');
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
