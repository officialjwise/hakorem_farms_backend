import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { ColdChain, GoodsReceipts, StockAlerts, type ReceiptLineInput } from '../modules/inv';
import { ReferenceDataAdmin } from '../modules/mdm';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { SeedCalendar } from './seed-calendar';
import type { ServiceSeedUnit } from './seed-unit';

/** The suppliers the seeded farm buys from (FR-MDM-007), written by the Manager. */
export const SEED_SUPPLIERS = [
  { name: 'Kpone Livestock Traders (SEED)', contactName: 'Nii Armah Tetteh', phone: '+233200000201' },
  { name: 'Awutu Poultry Farm (SEED)', contactName: 'Efua Mensah', phone: '+233200000202' },
  { name: 'Ashaiman Cold Store Ltd (SEED)', contactName: 'Kojo Asante', phone: '+233200000203' },
] as const;

type SeedSupplier = (typeof SEED_SUPPLIERS)[number]['name'];

interface SeedLine {
  readonly sku: string;
  readonly qty: string;
  readonly valuePesewas: bigint;
  readonly weightKg?: string;
  readonly batchNo?: string;
  /** Which of the seed calendar's expiries the lot carries (B09t2: never a fixed date). */
  readonly expires?: 'eggsExpireOn' | 'meatExpiresOn';
  readonly tags?: readonly string[];
}

interface SeedReceipt {
  /** The supplier's delivery note number: also how a second run knows the receipt is there. */
  readonly deliveryNoteRef: string;
  readonly kind: 'PURCHASE' | 'HARVEST';
  readonly supplier: SeedSupplier | null;
  readonly location: 'PENS' | 'COLD' | 'SHOP';
  readonly lines: readonly SeedLine[];
}

/**
 * The seeded farm's stock (B05 continued), every figure chosen so a person can count it by hand. The hand count the
 * B5 gate checks against is SEED_HAND_COUNT below, written out separately rather than derived from these receipts.
 */
export const SEED_RECEIPTS: readonly SeedReceipt[] = [
  {
    deliveryNoteRef: 'SEED-KLT-0457',
    kind: 'PURCHASE',
    supplier: 'Kpone Livestock Traders (SEED)',
    location: 'PENS',
    lines: [
      { sku: 'LIV-GOAT', qty: '4.000', valuePesewas: 240_000n, tags: ['G-0142', 'G-0143', 'G-0144', 'G-0145'] },
      // GHS 1,500.01 for two sheep: largest remainder gives the first 75,001 and the second 75,000.
      { sku: 'LIV-SHEEP', qty: '2.000', valuePesewas: 150_001n, tags: ['S-0031', 'S-0032'] },
    ],
  },
  {
    deliveryNoteRef: 'SEED-APF-1182',
    kind: 'PURCHASE',
    supplier: 'Awutu Poultry Farm (SEED)',
    location: 'PENS',
    lines: [{ sku: 'LIV-BROILER', qty: '20.000', valuePesewas: 110_000n, batchNo: 'BR-2026-1110' }],
  },
  {
    deliveryNoteRef: 'SEED-ACS-0093',
    kind: 'PURCHASE',
    supplier: 'Ashaiman Cold Store Ltd (SEED)',
    location: 'COLD',
    lines: [
      { sku: 'MEAT-BEEF-15KG', qty: '45.000', valuePesewas: 540_000n, weightKg: '45.000', batchNo: 'LOT-BEEF-2026-1110', expires: 'meatExpiresOn' },
      { sku: 'MEAT-GOAT-15KG', qty: '30.000', valuePesewas: 390_000n, weightKg: '30.000', batchNo: 'LOT-GOAT-0001', expires: 'meatExpiresOn' },
    ],
  },
  {
    deliveryNoteRef: 'SEED-APF-1183',
    kind: 'PURCHASE',
    supplier: 'Awutu Poultry Farm (SEED)',
    location: 'SHOP',
    lines: [{ sku: 'EGG-CRATE-BIG', qty: '30.000', valuePesewas: 105_000n, batchNo: 'EGG-BIG-2026-1110', expires: 'eggsExpireOn' }],
  },
  {
    deliveryNoteRef: 'SEED-HARVEST-1110',
    kind: 'HARVEST',
    supplier: null,
    location: 'SHOP',
    lines: [
      { sku: 'PRD-YAM-TUBER', qty: '40.000', valuePesewas: 48_000n },
      { sku: 'PRD-CABBAGE-HEAD', qty: '25.000', valuePesewas: 12_500n },
    ],
  },
];

/**
 * The seeded farm counted by hand: what stands at each Dodowa location after the seed, and the value at cost of all
 * of it. GHS 2,400.00 of goats, 1,500.01 of sheep, 1,100.00 of broilers, 5,400.00 of beef, 3,900.00 of goat meat,
 * 1,050.00 of eggs, 480.00 of yam and 125.00 of cabbage, and in the store (the LIV seed, B06 continued 2) 1,100.00 of
 * broiler grower, 600.00 of concentrate and 240.00 of albendazole: GHS 17,895.01.
 */
export const SEED_HAND_COUNT = {
  lines: [
    { location: 'PENS', sku: 'LIV-GOAT', onHand: '4.000' },
    { location: 'PENS', sku: 'LIV-SHEEP', onHand: '2.000' },
    { location: 'PENS', sku: 'LIV-BROILER', onHand: '20.000' },
    { location: 'COLD', sku: 'MEAT-BEEF-15KG', onHand: '45.000' },
    { location: 'COLD', sku: 'MEAT-GOAT-15KG', onHand: '30.000' },
    { location: 'SHOP', sku: 'EGG-CRATE-BIG', onHand: '30.000' },
    { location: 'SHOP', sku: 'PRD-YAM-TUBER', onHand: '40.000' },
    { location: 'SHOP', sku: 'PRD-CABBAGE-HEAD', onHand: '25.000' },
    { location: 'STORE', sku: 'FEED-BRL-GROWER', onHand: '200.000' },
    { location: 'STORE', sku: 'FEED-GOAT-CONC', onHand: '150.000' },
    { location: 'STORE', sku: 'MED-ALBENDAZOLE', onHand: '2.000' },
  ],
  totalValueAtCostPesewas: 1_789_501,
} as const;

/**
 * Reorder rules at Dodowa (FR-INV-015), whole branch. The eggs' reorder point is the 30 crates the seed receives, so
 * the seeded farm opens with one low-stock alert, suggesting 50 crates to reach the maximum; yam and beef are above.
 */
export const SEED_REORDER_RULES = [
  { sku: 'EGG-CRATE-BIG', minQty: '20.000', reorderPointQty: '30.000', maxQty: '80.000', expiryAlertDays: 5 },
  { sku: 'PRD-YAM-TUBER', minQty: '15.000', reorderPointQty: '25.000', maxQty: '80.000' },
  { sku: 'MEAT-BEEF-15KG', minQty: '10.000', reorderPointQty: '20.000', maxQty: '90.000', expiryAlertDays: 5 },
] as const;

/**
 * Two readings of the frozen cold room after the delivery, both in its -25.0 to -18.0 range, with fixed client ids;
 * measured at the seed calendar's `coldRoomReadings`, in this order.
 */
export const SEED_TEMPERATURE_READINGS = [
  { id: '019a6c5a-6dc0-7000-8000-00000000c001', readingC: '-19.5' },
  { id: '019a6c5a-6dc0-7000-8000-00000000c002', readingC: '-18.5' },
] as const;

const key = (...parts: string[]): string => `seed:inv:${parts.join(':')}`;

async function idsByCode(pool: pg.Pool, sql: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ code: string; id: string }>(sql);
  return new Map(rows.map((row) => [row.code, row.id]));
}

function required(map: ReadonlyMap<string, string>, code: string, what: string): string {
  const value = map.get(code);
  if (value === undefined) {
    throw new Error(`the INV seed needs ${what} ${code}, which an earlier seed unit creates; run the seed units in order`);
  }
  return value;
}

/**
 * The INV slice of the seeded farm, written through the services as the seeded Manager (A-085): the three
 * suppliers through `ReferenceDataAdmin`, then each goods receipt drafted and posted through `GoodsReceipts`, so
 * every stock unit, movement, cost pool, audit event and outbox message is the one production writes. A receipt
 * already there (found by its delivery note) is left alone, and every call carries a fixed idempotency key.
 */
export function farmSeedInv(calendarOf: (app: INestApplicationContext) => SeedCalendar): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'inv-services',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const calendar = calendarOf(app);
      let records = 0;

      const reference = app.get(ReferenceDataAdmin);
      const suppliers = await idsByCode(pool, 'SELECT name AS code, id FROM mdm.supplier WHERE deleted_at IS NULL');
      records += await staff.as('manager', async (manager) => {
        let written = 0;
        for (const supplier of SEED_SUPPLIERS) {
          if (suppliers.has(supplier.name)) continue;
          suppliers.set(supplier.name, (await reference.createSupplier(manager, supplier, key('supplier', supplier.phone))).body.id);
          written += 1;
        }
        return written;
      });

      const locations = await idsByCode(pool, "SELECT l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.deleted_at IS NULL");
      const products = await idsByCode(pool, 'SELECT sku AS code, id FROM mdm.product WHERE deleted_at IS NULL');
      const done = new Set((await pool.query<{ ref: string }>('SELECT delivery_note_ref AS ref FROM inv.goods_receipt WHERE delivery_note_ref IS NOT NULL')).rows.map((r) => r.ref));
      const receipts = app.get(GoodsReceipts);
      for (const receipt of SEED_RECEIPTS) {
        if (done.has(receipt.deliveryNoteRef)) continue;
        await staff.as('manager', async (manager) => {
          const lines: ReceiptLineInput[] = receipt.lines.map((line) => ({
            productId: required(products, line.sku, 'product'),
            qtyReceived: line.qty,
            valuePesewas: line.valuePesewas,
            weightKg: line.weightKg,
            weightSource: line.weightKg === undefined ? undefined : 'SCALE',
            batchNo: line.batchNo,
            expiresOn: line.expires === undefined ? undefined : calendar[line.expires],
            animals: line.tags?.map((tagNo) => ({ tagNo, sex: 'MALE' as const, breed: line.sku === 'LIV-SHEEP' ? 'Djallonke' : 'West African Dwarf', purpose: 'GROWING' as const })),
          }));
          const draft = await receipts.create(
            manager,
            {
              kind: receipt.kind,
              supplierId: receipt.supplier === null ? undefined : required(suppliers, receipt.supplier, 'supplier'),
              locationId: required(locations, receipt.location, 'location'),
              deliveryNoteRef: receipt.deliveryNoteRef,
              receivedAt: calendar.stockReceivedAt,
              notes: 'SEED stock',
              lines,
            },
            key('receipt', receipt.deliveryNoteRef),
          );
          await receipts.post(manager, draft.body.id, key('receipt', receipt.deliveryNoteRef, 'post'));
        });
        records += 1 + receipt.lines.length;
      }

      // Reorder rules and the cold room log (B05 continued 4), through their services as the Manager.
      const branchId = required(await idsByCode(pool, "SELECT code, id FROM mdm.branch WHERE code = 'DDW'"), 'DDW', 'branch');
      const ruled = new Set((await pool.query<{ product_id: string }>('SELECT product_id FROM inv.reorder_rule WHERE branch_id = $1 AND location_id IS NULL AND deleted_at IS NULL', [branchId])).rows.map((r) => r.product_id));
      const logged = new Set((await pool.query<{ id: string }>('SELECT id FROM inv.temperature_reading WHERE id = ANY($1::uuid[])', [SEED_TEMPERATURE_READINGS.map((r) => r.id)])).rows.map((r) => r.id));
      const alerts = app.get(StockAlerts);
      const coldChain = app.get(ColdChain);
      records += await staff.as('manager', async (manager) => {
        let written = 0;
        for (const rule of SEED_REORDER_RULES) {
          const productId = required(products, rule.sku, 'product');
          if (ruled.has(productId)) continue;
          await alerts.createRule(manager, { ...rule, productId, branchId }, key('reorder-rule', rule.sku));
          written += 1;
        }
        for (const [index, reading] of SEED_TEMPERATURE_READINGS.entries()) {
          if (logged.has(reading.id)) continue;
          await coldChain.record(manager, { ...reading, measuredAt: calendar.coldRoomReadings[index]!, locationId: required(locations, 'COLD', 'location'), source: 'MANUAL' }, key('temperature', reading.id));
          written += 1;
        }
        return written;
      });
      return { records };
    },
  };
}
