import { createHash } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import type pg from 'pg';
import { canonicalJson } from '../platform/crypto/canonical-json';
import { SEED_CUSTOMERS, SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_SPECIES, type SeedProduct } from './reference-pricing';
import type { SeedUnit } from './seed-unit';

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
 * B4's slice of the seeded farm: the rest of the reference catalogue, grades and weight bands per species, a
 * customer in each tier plus a caterer with a contract list, and every price list of `reference-pricing.ts`,
 * each version drafted by the seeded Manager and approved by the seeded Owner (maker-checker, as the application
 * does it), ACTIVE from the seed instant.
 *
 * Like B3's slice it writes SQL: the services that would write grades, bands and customers are B04 continued
 * (A-085 stays open). Ids come from a fixed clock and random source and are drawn for every row on every run, so a
 * second run finds every row and changes nothing.
 */
export function farmSeedB4(): SeedUnit {
  return {
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
      const branches = await idsByCode(client, 'SELECT code, id FROM mdm.branch WHERE deleted_at IS NULL');
      const people = await idsByCode(client, 'SELECT email AS code, principal_id AS id FROM iam.user_account');
      const dodowa = required(branches, 'DDW', 'branch');
      const maker = required(people, 'akosua.boateng@seed.hakoremfarms.invalid', 'the seeded Manager');
      const checker = required(people, 'kwabena.owusu@seed.hakoremfarms.invalid', 'the seeded Owner');

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
      const customers = new Map<string, string>();
      for (const customer of SEED_CUSTOMERS) {
        const customerId = id();
        customers.set(customer.customerNo, customerId);
        await insert(
          `INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6) ON CONFLICT (id) DO NOTHING`,
          [customerId, customer.customerNo, customer.kind, customer.name, TIER[customer.tier], SYSTEM],
        );
      }

      // Price lists, each with one version taken through draft, approval by a second person, and activation.
      const lists = new Map<string, string>();
      for (const list of SEED_PRICE_LISTS) {
        const listId = id();
        const versionId = id();
        const approvalId = id();
        const entryIds = list.entries.map(() => id());
        lists.set(list.code, listId);
        await insert(
          `INSERT INTO mdm.price_list (id, code, name, kind, channel, customer_tier_id, tax_inclusive, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $7) ON CONFLICT (id) DO NOTHING`,
          [listId, list.code, list.name, list.kind, list.channel, list.tier === null ? null : TIER[list.tier], maker],
        );
        if ((await client.query('SELECT 1 FROM mdm.price_list_version WHERE id = $1', [versionId])).rows.length > 0) {
          continue;
        }
        await insert("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id, created_at) VALUES ($1, 'PRICE_LIST_VERSION', 'mdm', $2, $3, $4)", [
          versionId,
          dodowa,
          maker,
          SEED_INSTANT,
        ]);
        await insert(
          `INSERT INTO mdm.price_list_version (id, price_list_id, version_no, status, valid_from, notes, branch_id, created_by, updated_by, created_at)
           VALUES ($1, $2, 1, 'DRAFT', $3, 'SEED opening prices', $4, $5, $5, $3)`,
          [versionId, listId, SEED_INSTANT, dodowa, maker],
        );
        const snapshot = list.entries.map((entry, index) => {
          const product = products.get(entry.sku)!;
          return {
            id: entryIds[index]!,
            productId: product.id,
            gradeId: entry.grade === null ? null : grades.get(`${product.species}:${entry.grade}`)!,
            weightBandId: entry.band === null ? null : bands.get(entry.band)!,
            basis: entry.basis,
            listPricePesewas: entry.list,
            floorPricePesewas: entry.floor,
            ceilingPricePesewas: entry.ceiling,
            quoteOnly: entry.quoteOnly,
            minQty: '0.000',
          };
        });
        for (const e of snapshot) {
          await insert(
            `INSERT INTO mdm.price_list_entry (id, version_id, product_id, grade_id, weight_band_id, basis, list_price_pesewas, floor_price_pesewas, ceiling_price_pesewas,
                                               quote_only, min_qty, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
            [e.id, versionId, e.productId, e.gradeId, e.weightBandId, e.basis, e.listPricePesewas.toString(), e.floorPricePesewas.toString(), e.ceilingPricePesewas.toString(), e.quoteOnly, e.minQty, maker],
          );
        }
        // The same payload hash PriceListAdmin takes at submission (ADR-0017).
        const payload = { priceListId: listId, versionNo: 1, validFrom: SEED_INSTANT.toISOString(), validTo: null, notes: 'SEED opening prices', entries: [...snapshot].sort((a, b) => (a.id < b.id ? -1 : 1)) };
        await insert(
          `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, requested_at, status)
           VALUES ($1, 'PRICE_LIST_ACTIVATION', $2, $3, $4, $5, $6, $7, 'PENDING')`,
          [approvalId, dodowa, versionId, createHash('sha256').update(canonicalJson(payload)).digest(), `Activate ${list.code} version 1 (${snapshot.length} entries) (SEED)`, maker, SEED_INSTANT],
        );
        await client.query("UPDATE mdm.price_list_version SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1 WHERE id = $1", [versionId, approvalId]);
        await client.query("UPDATE iam.approval_request SET status = 'APPROVED', decided_by = $2, decided_at = $3, version = version + 1 WHERE id = $1", [approvalId, checker, SEED_INSTANT]);
        await client.query("UPDATE mdm.price_list_version SET status = 'ACTIVE', activated_at = $2, activated_by = $3, version = version + 1, updated_by = $3 WHERE id = $1", [
          versionId,
          SEED_INSTANT,
          checker,
        ]);
      }

      for (const customer of SEED_CUSTOMERS) {
        const assignmentId = id();
        if (customer.assignedList !== null) {
          await insert(
            `INSERT INTO mdm.customer_price_list (id, customer_id, price_list_id, valid_from, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING`,
            [assignmentId, customers.get(customer.customerNo), lists.get(customer.assignedList), SEED_INSTANT, maker],
          );
        }
      }
      return { records };
    },
  };
}
