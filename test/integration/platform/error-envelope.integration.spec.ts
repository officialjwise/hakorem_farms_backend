import { Controller, Get, Module } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BusinessRuleError } from '../../../src/platform/errors/api-error';
import { Operation } from '../../../src/platform/http/operation';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { startTestApp, type TestApp } from '../../support/test-app';

/** A business refusal as a module would define one: its own code, a message key from the catalogue. */
class ProbeRefusedError extends BusinessRuleError {
  readonly code = 'STOCK_UNIT_ON_HOLD';
  readonly messageKey = 'error.validation_failed';
}

/** Routes that fail on purpose, mounted only in this test. */
@Controller('probe')
class ProbeController {
  @Get('refusal')
  @Operation({ operationId: 'probeRefusal', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  refusal(): never {
    throw new ProbeRefusedError('animal G-0142 is under a withdrawal hold');
  }

  @Get('crash')
  @Operation({ operationId: 'probeCrash', access: 'PUBLIC', realms: [], permission: null, idempotent: false, csrf: false, rateLimit: 'public' })
  crash(): never {
    throw new Error('connection to 10.0.0.7:5432 refused for user hk_app with password hunter2');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

let database: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database, { imports: [ProbeModule] });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

function expectEnvelope(body: unknown, correlationId: string, code: string): void {
  expect(body).toEqual({
    error: { code, message: expect.any(String), correlationId, details: expect.any(Array) },
  });
}

describe('the error envelope (docs/API.md section 10, SC-16)', () => {
  it('answers an unknown route with 404 NOT_FOUND', async () => {
    const response = await request(api.server).get('/v1/no-such-route');
    expect(response.status).toBe(404);
    expectEnvelope(response.body, response.headers['x-correlation-id'] as string, 'NOT_FOUND');
  });

  it('answers a route outside /v1 with the envelope too', async () => {
    const response = await request(api.server).get('/health');
    expect(response.status).toBe(404);
    expectEnvelope(response.body, response.headers['x-correlation-id'] as string, 'NOT_FOUND');
  });

  it('answers malformed JSON with 400 VALIDATION_FAILED', async () => {
    const response = await request(api.server).post('/v1/probe/refusal').set('Content-Type', 'application/json').send('{"weightKg": ');
    expect(response.status).toBe(400);
    expectEnvelope(response.body, response.headers['x-correlation-id'] as string, 'VALIDATION_FAILED');
    expect(response.body.error.message).toBe('The request body is not valid JSON.');
  });

  it('answers a body above the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const response = await request(api.server)
      .post('/v1/probe/refusal')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(300 * 1024) }));
    expect(response.status).toBe(413);
    expectEnvelope(response.body, response.headers['x-correlation-id'] as string, 'PAYLOAD_TOO_LARGE');
  });

  it('answers a business refusal with 422 and the refusal code', async () => {
    const response = await request(api.server).get('/v1/probe/refusal');
    expect(response.status).toBe(422);
    expectEnvelope(response.body, response.headers['x-correlation-id'] as string, 'STOCK_UNIT_ON_HOLD');
  });

  it('answers an unexpected error with 500 INTERNAL and no internal detail, and logs it once with its id', async () => {
    const response = await request(api.server).get('/v1/probe/crash');
    const id = response.headers['x-correlation-id'] as string;
    expect(response.status).toBe(500);
    expectEnvelope(response.body, id, 'INTERNAL');
    expect(JSON.stringify(response.body)).not.toMatch(/10\.0\.0\.7|hk_app|hunter2|stack/);

    const errors = api.logLines().filter((line) => line['level'] === 'error' && line['correlationId'] === id);
    expect(errors).toHaveLength(1);
    expect(errors[0]!['msg']).toBe('unexpected error');
  });
});
