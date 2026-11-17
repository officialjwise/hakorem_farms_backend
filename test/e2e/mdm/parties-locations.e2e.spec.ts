import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Parties and locations end to end (B04d continued 2 gate), against the stack seeded by `pnpm run setup`: the seeded
 * Sales person finds a seeded customer by the phone number typed the local way, sees the caterer on their contract
 * list, and reads Dodowa's locations, every one written by the seed through MDM's services.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let cookie = '';
let csrf = '';

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
  const login = await call('POST', '/v1/auth/staff/login', { identifier: 'esi.appiah@seed.hakoremfarms.invalid', password: seededPassword(), deviceLabel: 'Sales tablet' });
  expect(login.status).toBe(200);
  expect(login.body.status).toBe('AUTHENTICATED');
  csrf = login.body.session.csrfToken;
});

describe('the seeded parties and locations (B04d continued 2 gate)', () => {
  it('finds Ama Serwaa by 020 000 0201 typed locally, stored as +233200000201, with her default address area', async () => {
    const found = await call('GET', '/v1/customers?q=0200000201');
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual([expect.objectContaining({ publicId: expect.stringMatching(/^cus_[0-9A-HJKMNP-TV-Z]{16}$/), name: 'Ama Serwaa (SEED)', phone: '+233200000201', tier: expect.objectContaining({ code: 'RETAIL' }), defaultArea: 'Dodowa' })]);
  });

  it('shows the caterer on the CATERERS-2026 contract list', async () => {
    const caterer = await call('GET', '/v1/customers?q=Caterers');
    expect(caterer.body.data[0].priceList).toEqual(expect.objectContaining({ code: 'CATERERS-2026' }));
  });

  it("lists Dodowa's eight physical locations in the order they were made, the LIV seed's store last, and, when asked, its eight virtual ones", async () => {
    const branches = await call('GET', '/v1/branches');
    const dodowa = branches.body.data.find((branch: Json) => branch.code === 'DDW');
    const physical = await call('GET', `/v1/locations?branchId=${dodowa.id}`);
    expect(physical.body.data.map((location: Json) => location.code)).toEqual(['SITE', 'PENS', 'COLD', 'SHOP', 'VAN1', 'RETURNS', 'TRANSIT', 'STORE']);
    const all = await call('GET', `/v1/locations?branchId=${dodowa.id}&includeVirtual=true&limit=100`);
    expect(all.body.data.filter((location: Json) => location.isVirtual)).toHaveLength(8);
  });
});
