import { createHash } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import type pg from 'pg';
import { SEED_CUSTOMERS, SEED_PRODUCTS, SEED_SPECIES, type SeedProduct } from './reference-pricing';
import type { SqlSeedUnit } from './seed-unit';

const SYSTEM = '01900000-0000-7000-8000-000000000001';
const SEED_INSTANT = new Date('2026-11-01T06:00:00Z');
const TIER: Readonly<Record<string, string>> = {
  RETAIL: '01900000-0000-7000-8000-000000000301',
  WHOLESALE: '01900000-0000-7000-8000-000000000302',
  RESELLER: '01900000-0000-7000-8000-000000000303',
};
const CATEGORY_TERMS: Readonly<Record<SeedProduct['category'], { readonly gl: string; readonly tax: string }>> = {
  LIVE: { gl: 'LIVE_ANIMALS', tax: '01900000-0000-7000-8000-000000000201' },
  MEAT: { gl: 'MEAT', tax: '01900000-0000-7000-8000-000000000204' },
  EGGS: { gl: 'PRODUCE_EGGS', tax: '01900000-0000-7000-8000-000000000203' },
  PRODUCE: { gl: 'PRODUCE_EGGS', tax: '01900000-0000-7000-8000-000000000202' },
};

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

async function idsByCode(client: pg.PoolClient, sql: string): Promise<Map<string, string>> {
  const { rows } = await client.query<{ code: string; id: string }>(sql);
  return new Map(rows.map((row) => [row.code, row.id]));
}

function required(map: ReadonlyMap<string, string>, key: string, what: string): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`the B4 seed needs ${what} ${key}, which the B3 seed unit creates; run the seed units in order`);
  }
  return value;
}

/**
 * B4's SQL slice of the seeded farm: the rest of the reference catalogue, grades and weight bands per species, and a
 * customer in each tier plus a caterer with a contract list. The price lists, the tax scheme and the promotions are
 * written through MDM's services by `farm-mdm.ts`, which runs after this unit.
 *
 * It writes SQL because the services that would write grades, bands and customers are not built yet (A-085 stays
 * open for them). Ids come from a fixed clock and random source and are drawn for every row on every run, so a
 * second run finds every row and changes nothing.
 */
export function farmSeedB4(): SqlSeedUnit {
  return {
    kind: 'SQL',
    name: 'b4-pricing',
    async run(client: pg.PoolClient) {
      const id = createUuidV7Generator(new ManualClock(SEED_INSTANT), seededRandom('hakorem-seed-b4'));
      let records = 0;
      const insert = async (text: string, values: unknown[]) => {
        const count = (await client.query(text, values)).rowCount ?? 0;
        records += count;
        return count;
      };

      const categories = await idsByCode(client, 'SELECT code, id FROM mdm.category WHERE deleted_at IS NULL');
      const speciesIds = await idsByCode(client, 'SELECT code, id FROM mdm.species WHERE deleted_at IS NULL');

      // Grades and weight bands.
      const grades = new Map<string, string>();
      const bands = new Map<string, string>();
      for (const species of SEED_SPECIES) {
        const speciesId = required(speciesIds, species.code, 'species');
        for (const [order, grade] of species.grades.entries()) {
          const gradeId = id();
          grades.set(`${species.code}:${grade.code}`, gradeId);
          await insert(
            `INSERT INTO mdm.grade (id, species_id, code, name, description, sort_order, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (id) DO NOTHING`,
            [gradeId, speciesId, grade.code, grade.name, grade.description, order, SYSTEM],
          );
        }
        for (const band of species.bands) {
          const bandId = id();
          bands.set(band.code, bandId);
          await insert(
            `INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (id) DO NOTHING`,
            [bandId, speciesId, band.code, band.minKg, band.maxKg, SYSTEM],
          );
        }
      }

      // The rest of the reference catalogue; B3's six are found by SKU.
      const existing = await idsByCode(client, 'SELECT sku AS code, id FROM mdm.product WHERE deleted_at IS NULL');
      const products = new Map<string, { readonly id: string; readonly species: string | null }>();
      for (const product of SEED_PRODUCTS) {
        const productId = id();
        if (product.fromB3) {
          products.set(product.sku, { id: required(existing, product.sku, 'product'), species: product.species });
          continue;
        }
        products.set(product.sku, { id: productId, species: product.species });
        const terms = CATEGORY_TERMS[product.category];
        const tracking = product.policy === 'SERIALISED' ? 'SERIAL' : product.policy === 'CATCH_WEIGHT' || product.category !== 'PRODUCE' ? 'LOT' : 'NONE';
        await insert(
          `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, nominal_pack_kg, tax_category_id, gl_group,
                                    shelf_life_days, storage_temp_class, description, online_mode, status, created_by, updated_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'ACTIVE', $17, $17, $18, $18) ON CONFLICT (id) DO NOTHING`,
          [
            productId,
            product.sku,
            product.name,
            required(categories, product.category, 'category'),
            product.policy,
            tracking,
            product.species === null ? null : required(speciesIds, product.species, 'species'),
            product.baseUom,
            product.saleUom,
            product.category === 'MEAT' ? '15.000' : null,
            terms.tax,
            terms.gl,
            product.category === 'MEAT' ? 90 : product.category === 'EGGS' ? 21 : null,
            product.category === 'MEAT' ? 'FROZEN' : product.category === 'EGGS' ? 'AMBIENT' : null,
            `SEED. ${product.name} from the reference catalogue.`,
            product.onlineMode,
            SYSTEM,
            SEED_INSTANT,
          ],
        );
      }

      // Customers, one per tier, and a caterer on a contract list.
      for (const customer of SEED_CUSTOMERS) {
        const customerId = id();
        await insert(
          `INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6) ON CONFLICT (id) DO NOTHING`,
          [customerId, customer.customerNo, customer.kind, customer.name, TIER[customer.tier], SYSTEM],
        );
      }

      return { records };
    },
  };
}
