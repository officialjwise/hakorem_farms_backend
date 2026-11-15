import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * The customer realm and password reset end to end (FR-IAM-019, FR-IAM-020), against the stack Docker Compose runs
 * from the production image: nothing here tells an outsider whether an account exists. The stack captures SMS rather
 * than sending it, so the code itself is proved by the integration tests.
 */
const BASE_URL = (process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = 'http://localhost:5173';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function post(path: string, body: unknown): Promise<{ status: number; body: Json; cookies: string[] }> {
  const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text), cookies: response.headers.getSetCookie() };
}

const phone = `+23320${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
const password = `Kelewele-at-dusk-${randomInt(0, 1_000_000)}`;

describe('a storefront customer on the real stack', () => {
  it('registers, and a second registration of the same phone answers the same', async () => {
    const first = await post('/v1/auth/customer/register', { name: 'Ama Serwaa', phone, password, marketingConsent: false });
    const second = await post('/v1/auth/customer/register', { name: 'Someone Else', phone, password: `${password}-x`, marketingConsent: true });
    for (const response of [first, second]) {
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'VERIFICATION_REQUIRED', session: null });
      expect(response.body.challengeToken).toMatch(/^hk1\.ch\./);
      expect(response.cookies).toEqual([]);
    }
  });

  it('gets a new code, not a session, signing in before the phone is verified', async () => {
    const login = await post('/v1/auth/customer/login', { identifier: phone, password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ status: 'VERIFICATION_REQUIRED', session: null });
    expect(login.cookies).toEqual([]);
  });

  it('answers a reset request alike for a known and an unknown phone, and names a wrong reset code', async () => {
    const known = await post('/v1/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' });
    const unknown = await post('/v1/auth/password/reset-request', { identifier: '+233209999999', realm: 'CUSTOMER' });
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    const wrong = await post('/v1/auth/password/reset', { token: `hk1.rs.${'C'.repeat(43)}`, newPassword: `${password}-new` });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('RESET_TOKEN_INVALID');
  });
});
