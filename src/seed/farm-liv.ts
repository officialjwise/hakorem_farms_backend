import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { GoodsReceipts } from '../modules/inv';
import { Feeding, Weighing } from '../modules/liv';
import { CatalogueAdmin, LocationsAdmin, ProductCatalogue } from '../modules/mdm';
import { PG_POOL } from '../platform/platform.module';
import type { SeedCalendar } from './seed-calendar';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The first weighing of the seeded animals at Dodowa's pens (FR-LIV-004), SEED: West African Dwarf goats of 19 to 27
 * kg and Djallonke sheep near 30 kg on the scale, and a sample of ten of the twenty broilers, averaging 1.850 kg a
 * bird, at the seed calendar's `weighedAt`. Fixed client ids, so a second run counts each as a duplicate and records nothing. The register itself needs
 * no seed: receiving the animals opened them (inv.StockUnitRegistered). Weights change neither stock nor cost.
 */
export const SEED_WEIGHINGS = [
  { id: '019a6c5a-6dc0-7000-8000-00000000a001', tag: 'G-0142', weightKg: '24.350', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a002', tag: 'G-0143', weightKg: '22.800', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a003', tag: 'G-0144', weightKg: '26.100', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a004', tag: 'G-0145', weightKg: '19.750', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a005', tag: 'S-0031', weightKg: '31.200', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a006', tag: 'S-0032', weightKg: '28.650', headWeighed: 1 },
  { id: '019a6c5a-6dc0-7000-8000-00000000a007', tag: 'BR-2026-1110', weightKg: '1.850', headWeighed: 10 },
] as const;

/** The category feed and medicine sit in: bought for the farm, not for sale. */
export const SEED_FEED_CATEGORY = { code: 'FEED-MED', name: 'Feed and medicine (SEED)', productLine: 'FEED', glGroup: 'FEED_MEDICATION', taxCategory: 'RAW_PRODUCE' } as const;

/** Feed and medicine (FR-LIV-014, FR-LIV-007), SEED: untracked, held in the store, never sold. */
export const SEED_FEED_PRODUCTS = [
  { sku: 'FEED-BRL-GROWER', name: 'Broiler grower pellets, per kg (SEED)', baseUom: 'KG' },
  { sku: 'FEED-GOAT-CONC', name: 'Goat and sheep concentrate, per kg (SEED)', baseUom: 'KG' },
  { sku: 'MED-ALBENDAZOLE', name: 'Albendazole 10% oral suspension, per litre (SEED)', baseUom: 'LITRE', withdrawalDays: 14 },
] as const;

/** Dodowa's feed and medicine store (FR-LIV-015): where feed is issued from unless a record names another place. */
export const SEED_STORE = { code: 'STORE', name: 'Feed and medicine store', kind: 'STORE' } as const;

/**
 * The store's first delivery, from the poultry farm's agro shop, on the morning the animals came: 200 kg of broiler
 * grower at GHS 5.50 a kg (GHS 1,100.00), 150 kg of concentrate at GHS 4.00 (GHS 600.00) and 2 litres of albendazole at
 * GHS 120.00 (GHS 240.00): GHS 1,940.00 in all, which the B5 and B05x hand counts include.
 */
export const SEED_STORE_RECEIPT = {
  deliveryNoteRef: 'SEED-APF-1184',
  supplier: 'Awutu Poultry Farm (SEED)',
  lines: [
    { sku: 'FEED-BRL-GROWER', qty: '200.000', valuePesewas: 110_000n },
    { sku: 'FEED-GOAT-CONC', qty: '150.000', valuePesewas: 60_000n },
    { sku: 'MED-ALBENDAZOLE', qty: '2.000', valuePesewas: 24_000n },
  ],
} as const;

/** Feeding standards (FR-LIV-014), SEED: 0.120 kg a broiler a day is the requirement's own example. */
export const SEED_RATIONS = [
  { name: 'Broiler grower (SEED)', species: 'BROILER', feed: 'FEED-BRL-GROWER', qtyPerHeadPerDay: '0.120', stage: 'Grower' },
  { name: 'Goat finisher (SEED)', species: 'GOAT', feed: 'FEED-GOAT-CONC', qtyPerHeadPerDay: '0.400', stage: 'Finisher' },
  { name: 'Sheep finisher (SEED)', species: 'SHEEP', feed: 'FEED-GOAT-CONC', qtyPerHeadPerDay: '0.500', stage: 'Finisher' },
] as const;

const key = (...parts: string[]): string => `seed:liv:${parts.join(':')}`;

async function idsByCode(pool: pg.Pool, sql: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ code: string; id: string }>(sql);
  return new Map(rows.map((row) => [row.code, row.id]));
}

function required(map: ReadonlyMap<string, string>, code: string, what: string): string {
  const value = map.get(code);
  if (value === undefined) throw new Error(`the LIV seed needs ${what} ${code}, which an earlier seed unit creates; run the seed units in order`);
  return value;
}

/**
 * The store, its feed and medicine, their first delivery and the rations (B06 continued 2, A-159), each written through
 * its own module's service as the seeded Manager, and each skipped when it is already there.
 */
async function seedStore(app: INestApplicationContext, staff: SeedStaff, pool: pg.Pool, calendar: SeedCalendar): Promise<number> {
  const branchId = required(await idsByCode(pool, "SELECT code, id FROM mdm.branch WHERE code = 'DDW'"), 'DDW', 'branch');
  const locations = await idsByCode(pool, "SELECT l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.deleted_at IS NULL");
  const categories = await idsByCode(pool, 'SELECT code, id FROM mdm.category WHERE deleted_at IS NULL');
  const products = await idsByCode(pool, 'SELECT sku AS code, id FROM mdm.product WHERE deleted_at IS NULL');
  const species = await idsByCode(pool, 'SELECT code, id FROM mdm.species WHERE deleted_at IS NULL');
  const taxCategories = await idsByCode(pool, 'SELECT code, id FROM mdm.tax_category');
  const suppliers = await idsByCode(pool, 'SELECT name AS code, id FROM mdm.supplier WHERE deleted_at IS NULL');
  const received = (await pool.query('SELECT 1 FROM inv.goods_receipt WHERE delivery_note_ref = $1', [SEED_STORE_RECEIPT.deliveryNoteRef])).rowCount === 1;
  const rationed = new Set((await pool.query<{ name: string }>('SELECT name FROM liv.ration WHERE deleted_at IS NULL')).rows.map((r) => r.name));
  return staff.as('manager', async (manager) => {
    let written = 0;
    if (!locations.has(SEED_STORE.code)) {
      const created = await app.get(LocationsAdmin).createLocation(manager, { branchId, parentId: required(locations, 'SITE', 'location'), ...SEED_STORE }, key('location', SEED_STORE.code));
      locations.set(SEED_STORE.code, created.body.id);
      written += 1;
    }
    if (!categories.has(SEED_FEED_CATEGORY.code)) {
      const { taxCategory, ...category } = SEED_FEED_CATEGORY;
      const created = await app.get(CatalogueAdmin).createCategory(manager, { ...category, taxCategoryId: required(taxCategories, taxCategory, 'tax category') }, key('category', category.code));
      categories.set(category.code, created.body.id);
      written += 1;
    }
    for (const product of SEED_FEED_PRODUCTS) {
      if (products.has(product.sku)) continue;
      const created = await app.get(ProductCatalogue).create(
        manager,
        {
          ...product,
          categoryId: required(categories, SEED_FEED_CATEGORY.code, 'category'),
          stockPolicy: 'COUNTABLE',
          saleUom: product.baseUom,
          onlineMode: 'HIDDEN',
          isSellable: false,
          description: `SEED. ${product.name}, for the farm's own use.`,
        },
        key('product', product.sku),
      );
      products.set(product.sku, created.body.id);
      written += 1;
    }
    if (!received) {
      const receipts = app.get(GoodsReceipts);
      const draft = await receipts.create(
        manager,
        {
          kind: 'PURCHASE',
          supplierId: required(suppliers, SEED_STORE_RECEIPT.supplier, 'supplier'),
          locationId: required(locations, SEED_STORE.code, 'location'),
          deliveryNoteRef: SEED_STORE_RECEIPT.deliveryNoteRef,
          receivedAt: calendar.stockReceivedAt,
          notes: 'SEED stock',
          lines: SEED_STORE_RECEIPT.lines.map((line) => ({ productId: required(products, line.sku, 'product'), qtyReceived: line.qty, valuePesewas: line.valuePesewas })),
        },
        key('receipt', SEED_STORE_RECEIPT.deliveryNoteRef),
      );
      await receipts.post(manager, draft.body.id, key('receipt', SEED_STORE_RECEIPT.deliveryNoteRef, 'post'));
      written += 1 + SEED_STORE_RECEIPT.lines.length;
    }
    const feeding = app.get(Feeding);
    for (const ration of SEED_RATIONS) {
      if (rationed.has(ration.name)) continue;
      await feeding.createRation(
        manager,
        { name: ration.name, speciesId: required(species, ration.species, 'species'), feedProductId: required(products, ration.feed, 'product'), qtyPerHeadPerDay: ration.qtyPerHeadPerDay, stage: ration.stage },
        key('ration', ration.name),
      );
      written += 1;
    }
    return written;
  });
}

/**
 * The LIV slice of the seeded farm, written through the services as the seeded Manager (A-085): the store with its
 * feed, medicine, first delivery and rations (B06 continued 2), then the first weighing of the animals the receipts
 * opened in the register. The broiler flock's batch needs no seed either: its receipt opened it.
 */
export function farmSeedLiv(calendarOf: (app: INestApplicationContext) => SeedCalendar): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'liv-services',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const units = new Map((await pool.query<{ identifier: string; id: string }>('SELECT identifier, id FROM inv.stock_unit')).rows.map((r) => [r.identifier, r.id]));
      const recorded = new Set((await pool.query<{ id: string }>('SELECT id FROM liv.weight_record WHERE id = ANY($1::uuid[])', [SEED_WEIGHINGS.map((w) => w.id)])).rows.map((r) => r.id));
      const calendar = calendarOf(app);
      const stored = await seedStore(app, staff, pool, calendar);
      const fresh = SEED_WEIGHINGS.filter((w) => !recorded.has(w.id));
      if (fresh.length === 0) return { records: stored };
      const records = fresh.map((w) => {
        const stockUnitId = units.get(w.tag);
        if (stockUnitId === undefined) throw new Error(`the LIV seed needs ${w.tag}, which the INV seed receives; run the seed units in order`);
        return { id: w.id, stockUnitId, weightKg: w.weightKg, weightSource: 'SCALE' as const, headWeighed: w.headWeighed, measuredAt: calendar.weighedAt };
      });
      return staff.as('manager', async (manager) => {
        const result = await app.get(Weighing).record(manager, records, `seed:liv:first-weighing:${fresh.map((w) => w.id.slice(-4)).join('-')}`);
        return { records: stored + result.body.accepted };
      });
    },
  };
}
