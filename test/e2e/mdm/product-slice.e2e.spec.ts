import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, totpAt } from '../../../src/modules/iam/domain/totp';

/**
 * The Product slice end to end, against the stack Docker Compose runs from the production image (API, worker,
 * PostgreSQL, Redis, object store), through the API only: the seeded Manager's first login with TOTP enrolment,
 * creating, reading and listing a product, a cashier refused, logout, and the worker sealing the audit trail.
 */
const BASE_URL = (process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = 'http://localhost:5173';

function seededPassword(): string {
  if (process.env['SEED_STAFF_PASSWORD'] !== undefined) {
    return process.env['SEED_STAFF_PASSWORD'];
  }
  const line = readFileSync(resolve(__dirname, '../../../.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('SEED_STAFF_PASSWORD='));
  if (line === undefined) {
    throw new Error('SEED_STAFF_PASSWORD is not in the environment or .env; run pnpm run setup');
  }
  return line.slice('SEED_STAFF_PASSWORD='.length);
}

/** A response body read by path; the contract tests assert the shapes, so the e2e test does not repeat them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

class Browser {
  private readonly cookies = new Map<string, string>();
  csrf = '';

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(this.csrf === '' || method === 'GET' ? {} : { 'X-CSRF-Token': this.csrf }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
  }
}

const password = seededPassword();
const manager = new Browser();
const cashier = new Browser();

beforeAll(async () => {
  const first = await manager.call('POST', '/v1/auth/staff/login', { identifier: 'akosua.boateng@seed.hakoremfarms.invalid', password, deviceLabel: 'Office laptop' });
  expect(first.status).toBe(200);
  if (first.body.status === 'TOTP_ENROLMENT_REQUIRED') {
    const challengeToken = first.body.challengeToken as string;
    const started = await manager.call('POST', '/v1/auth/totp/enrol', { challengeToken });
    const secret = base32Decode(started.body.secretBase32 as string);
    const confirmed = await manager.call('POST', '/v1/auth/totp/confirm', { challengeToken, code: totpAt(secret, Math.floor(Date.now() / 1000)) });
    expect(confirmed.status).toBe(200);
  } else {
    // The stack was seeded and enrolled by an earlier run: this suite needs a fresh setup to log the Manager in.
    throw new Error(`the seeded Manager is already enrolled (${first.body.status}); run the suite on a freshly set-up stack`);
  }
  const session = await manager.call('GET', '/v1/auth/session');
  expect(session.status).toBe(200);
  manager.csrf = session.body.csrfToken as string;

  const cashierLogin = await cashier.call('POST', '/v1/auth/staff/login', { identifier: 'adwoa.darko@seed.hakoremfarms.invalid', password, deviceLabel: 'Shop till tablet' });
  expect(cashierLogin.body.status).toBe('AUTHENTICATED');
  cashier.csrf = cashierLogin.body.session.csrfToken as string;
});

describe('the Product slice on the running stack', () => {
  it('lets the Manager create a product, then reads it back by id and in the list', async () => {
    const sku = `PRD-CABBAGE-${randomUUID().slice(0, 6).toUpperCase()}`;
    const categories = await manager.call('GET', '/v1/products?q=yam');
    const categoryId = categories.body.data[0].category.id as string;
    const created = await manager.call(
      'POST',
      '/v1/products',
      { sku, name: 'Cabbage, per head', categoryId, stockPolicy: 'COUNTABLE', baseUom: 'UNIT', saleUom: 'UNIT', onlineMode: 'LISTED' },
      { 'Idempotency-Key': randomUUID() },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sku, tracking: 'NONE', status: 'ACTIVE', category: { code: 'PRODUCE' } });
    const read = await cashier.call('GET', `/v1/products/${created.body.id}`);
    expect(read.body).toEqual(created.body);
    const list = await cashier.call('GET', `/v1/products?q=cabbage`);
    expect(list.body.data.map((p: { sku: string }) => p.sku)).toContain(sku);
  });

  it('refuses the cashier, who may read but not create', async () => {
    const refused = await cashier.call('POST', '/v1/products', { sku: 'LIV-TURKEY', name: 'Turkey', categoryId: randomUUID(), stockPolicy: 'NON_STOCK', baseUom: 'UNIT', saleUom: 'UNIT', onlineMode: 'HIDDEN' }, { 'Idempotency-Key': randomUUID() });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });

  it('keeps the audit trail sealed by the worker', async () => {
    let lag = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const health = await fetch(`${BASE_URL}/v1/health`);
      const body = (await health.json()) as { checks: Array<{ name: string; status: string; detail: string | null }> };
      const check = body.checks.find((c) => c.name === 'audit_sealing_lag')!;
      lag = `${check.status} ${String(check.detail)}`;
      if (check.detail === null) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(lag).toBe('OK null');
  });

  it('ends the session at logout', async () => {
    expect((await cashier.call('POST', '/v1/auth/logout')).status).toBe(204);
    expect((await cashier.call('GET', '/v1/products')).status).toBe(401);
  });
});
