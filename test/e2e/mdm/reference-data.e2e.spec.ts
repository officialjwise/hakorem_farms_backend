import { describe, expect, it } from 'vitest';

/**
 * Reference data end to end (B04d continued 3 gate), against the stack seeded by `pnpm run setup`: a storefront
 * visitor with no session is quoted exactly 1,500 pesewas for a Dodowa address and "delivery unavailable" for one in no
 * zone. It signs nobody in: the existing suites already use the stack's login budget (rate_limit.auth.per_address_15m).
 */
const BASE_URL = (process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = 'http://localhost:5173';

/** A public call with no session: the storefront's view. The contract tests assert the shapes. */
async function quote(body: unknown): Promise<{ status: number; body: { deliverable: boolean; zone: { code: string } | null; feePesewas: number | null; currency: string } }> {
  const response = await fetch(`${BASE_URL}/v1/shop/delivery/quote`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

describe('the seeded reference data (B04d continued 3 gate)', () => {
  const address = (area: string, city: string, region: string) => ({ recipientName: 'Ama Serwaa', recipientPhone: '+233200000201', line1: 'Near the market', area, city, region });

  it('quotes exactly 1,500 pesewas for a Dodowa address, and delivery unavailable with no fee for an address in no zone', async () => {
    const dodowa = await quote({ address: address('Dodowa', 'Dodowa', 'Greater Accra') });
    expect(dodowa.status).toBe(200);
    expect(dodowa.body).toMatchObject({ deliverable: true, zone: { code: 'DODOWA' }, feePesewas: 1500, currency: 'GHS' });
    const ho = await quote({ address: address('Ho Central', 'Ho', 'Volta') });
    expect(ho.body).toMatchObject({ deliverable: false, zone: null, feePesewas: null });
  });
});
