import { describe, expect, it } from 'vitest';

/**
 * The stack Docker Compose runs, built from the production image (ADR-0025: the same topology runs locally from one
 * command). Results are read through the API only (docs/TEST_STRATEGY.md section 3.4).
 */
const BASE_URL = (process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

describe('the full stack in Docker Compose', () => {
  it('answers health from the built image with the database and Redis up', async () => {
    const response = await fetch(`${BASE_URL}/v1/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await response.json()) as { status: string; checks: Array<{ name: string; status: string }> };
    expect(body.status).toBe('OK');
    expect(body.checks.map((check) => [check.name, check.status])).toEqual([
      ['database', 'OK'],
      ['redis', 'OK'],
    ]);
  });

  it('answers an unknown route with the error envelope and the same correlation id it was sent', async () => {
    const correlationId = '019a7b1d-3b44-79c8-8f00-a553bc391e31';
    const response = await fetch(`${BASE_URL}/v1/no-such-route`, { headers: { 'X-Correlation-Id': correlationId } });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'There is no such address in this API.', correlationId, details: [] },
    });
  });

  it('does not reveal the framework in its headers', async () => {
    const response = await fetch(`${BASE_URL}/v1/health`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});
