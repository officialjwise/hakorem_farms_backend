import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Pricing end to end (B4 gate), against the stack Docker Compose runs from the production image, seeded by
 * `pnpm run setup`: the seeded cashier at the shop counter prices goats from the seeded price lists through the API
 * only, and a goat no band covers comes back as a quote, not an error.
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

/** A response body read by path; the contract tests assert the shapes. */
type Json = any;
let cookie = '';
let csrf = '';
let branchId = '';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(csrf === '' || method === 'GET' ? {} : { 'X-CSRF-Token': csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const set = response.headers.getSetCookie().map((c) => c.split(';')[0]!);
  if (set.length > 0) cookie = set.join('; ');
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

beforeAll(async () => {
  const login = await call('POST', '/v1/auth/staff/login', { identifier: 'adwoa.darko@seed.hakoremfarms.invalid', password: seededPassword(), deviceLabel: 'Shop till tablet' });
  expect(login.status).toBe(200);
  expect(login.body.status).toBe('AUTHENTICATED');
  csrf = login.body.session.csrfToken;
  branchId = login.body.session.grants[0].branchId;
});

describe('the counter prices seeded goats (B4 gate)', () => {
  it('prices a 22.400 kg goat at GHS 650.00 from the base list, and a 65.000 kg goat as a quote', async () => {
    const goats = await call('GET', '/v1/products?q=Goat');
    expect(goats.status).toBe(200);
    const goat = goats.body.data.find((p: Json) => p.sku === 'LIV-GOAT');
    expect(goat).toBeDefined();
    const priced = await call('POST', '/v1/pricing/resolve', {
      channel: 'POS',
      branchId,
      lines: [
        { lineRef: 'medium', productId: goat.id, weightKg: '22.400', quantity: '1.000' },
        { lineRef: 'huge', productId: goat.id, weightKg: '65.000', quantity: '1.000' },
      ],
    });
    expect(priced.status).toBe(200);
    expect(priced.body.lines[0]).toMatchObject({
      outcome: 'RESOLVED',
      resolved: { priceList: { code: 'BASE' }, basis: 'PER_HEAD', listPricePesewas: 65_000, floorPricePesewas: 40_000, ceilingPricePesewas: 90_000, weightBand: { code: 'GOAT-M' } },
    });
    expect(priced.body.lines[1]).toEqual({ lineRef: 'huge', outcome: 'QUOTE_REQUIRED', resolved: null, quoteRequiredReason: 'NO_RULE', promotions: [] });
  });
});
