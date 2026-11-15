import { createHash } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import type pg from 'pg';
import { SEED_CUSTOMERS, SEED_PRODUCTS, SEED_SPECIES } from './reference-pricing';
import type { SqlSeedUnit } from './seed-unit';

const SYSTEM = '01900000-0000-7000-8000-000000000001';
const SEED_INSTANT = new Date('2026-11-01T06:00:00Z');
const TIER: Readonly<Record<string, string>> = {
  RETAIL: '01900000-0000-7000-8000-000000000301',
  WHOLESALE: '01900000-0000-7000-8000-000000000302',
  RESELLER: '01900000-0000-7000-8000-000000000303',
};
/** Ids this unit drew for grades, bands and products before they moved to farm-mdm.ts. */
const MOVED_CATALOGUE_IDS = SEED_SPECIES.reduce((sum, species) => sum + species.grades.length + species.bands.length, 0) + SEED_PRODUCTS.length;

function seededRandom(seed: string): (length: number) => Uint8Array {
  let counter = 0;
  return (length) => {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const block = createHash('sha256').update(`${seed}:${counter++}`).digest();
      const take = Math.min(block.length, length - filled);
      out.set(block.subarray(0, take), filled);
      filled += take;
    }
    return out;
  };
}

/**
 * B4's SQL slice of the seeded farm: a customer in each tier plus a caterer with a contract list. The grades, bands
 * and products it once wrote, the price lists, the tax scheme and the promotions are written through MDM's services by
 * farm-mdm.ts, which runs after this unit.
 *
 * It writes SQL because the customer services are not built yet (B04d continued 2; A-085 stays open for them). Ids
 * come from a fixed clock and random source and are drawn for every row on every run, so a second run finds every
 * row and changes nothing; the ids of the rows that moved are still drawn, so the customers keep theirs.
 */
export function farmSeedB4(): SqlSeedUnit {
  return {
    kind: 'SQL',
    name: 'b4-customers',
    async run(client: pg.PoolClient) {
      const id = createUuidV7Generator(new ManualClock(SEED_INSTANT), seededRandom('hakorem-seed-b4'));
      for (let moved = 0; moved < MOVED_CATALOGUE_IDS; moved += 1) {
        id();
      }
      let records = 0;
      for (const customer of SEED_CUSTOMERS) {
        const created = await client.query(
          `INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6) ON CONFLICT (id) DO NOTHING`,
          [id(), customer.customerNo, customer.kind, customer.name, TIER[customer.tier], SYSTEM],
        );
        records += created.rowCount ?? 0;
      }
      return { records };
    },
  };
}
