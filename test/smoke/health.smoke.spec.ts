import { describe, expect, it } from 'vitest';

/**
 * Smoke step 1 (docs/TEST_STRATEGY.md section 3.5): the deployed environment reports every health check OK. Read-only.
 * Steps 2 to 7 (logins, catalogue, the test-branch sale and void, the webhook, a document, the trial balance) are added
 * by the sessions that build those paths.
 */
const BASE_URL = process.env['SMOKE_BASE_URL'];

describe('smoke: health', () => {
  it('every health check is OK on the deployed environment', async () => {
    expect(BASE_URL, 'run through pnpm test:smoke -- --base-url=...').toBeDefined();
    const response = await fetch(`${BASE_URL}/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string; checks: Array<{ name: string; status: string }> };
    expect(body.status).toBe('OK');
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.checks.filter((check) => check.status !== 'OK')).toEqual([]);
  });
});
