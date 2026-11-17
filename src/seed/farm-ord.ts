import type { INestApplicationContext } from '@nestjs/common';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { SalePosting, type SaleRequest } from '../modules/ord';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import type { SeedCalendar } from './seed-calendar';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded trading day of sales (B09a continued 2g, FR-ORD-006, FR-RPT-001, A-234), SEED: posted at Dodowa by the
 * seeded cashier through ORD's `SalePosting.postIn`, each sale in one serializable transaction with its series locks,
 * so every sale issues its stock, its receipt, its cash and its journals together, priced by the engine at list:
 * - a wholesale counter sale: goat G-0142 by its tag, 2 crates of big eggs from their lot, 3 cabbages and 3.500 kg of
 *   goat meat weighed at the scale, 80,430 in cash;
 * - an online order collected and paid in cash on collection: 1 crate of big eggs, 6,000;
 * - a wholesale counter sale of 4 yam tubers at their list of 2,000, 8,000 in cash.
 * The day is the seed calendar's `today`: the sales post at the seed's clock, which reads that business day. The cash
 * goes to till T1, a till of the seed's own until B9b's registers exist.
 *
 * Its own unit, run after the farm (`seedUnits(env, { tradingDay: true })`, as `pnpm db:seed` does): the farm every
 * other test loads keeps the B5 hand count and its exact amounts, and the tests that read the trading day load it.
 */
export const SEED_TRADING_DAY = {
  branchCode: 'DDW',
  till: { id: '019a8000-0000-7000-8000-00000000a7a1', code: 'T1' },
  online: { contactName: 'Efua Asante (SEED)', contactPhone: '+233200000301' },
  /** What the day takes off the farm's hand count, by location and SKU. */
  sold: [
    { location: 'PENS', sku: 'LIV-0004', qty: '1.000' },
    { location: 'SHOP', sku: 'EGG-0003', qty: '3.000' },
    { location: 'SHOP', sku: 'PRD-0002', qty: '3.000' },
    { location: 'COLD', sku: 'MEAT-0007', qty: '3.500' },
    { location: 'SHOP', sku: 'PRD-0005', qty: '4.000' },
  ],
} as const;

export function farmSeedOrd(calendar: (app: INestApplicationContext) => SeedCalendar): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'ord-trading-day',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM ord.sales_order LIMIT 1')).rows.length > 0) return { records: 0 };
      const clock = app.get<Clock>(CLOCK);
      const { today } = calendar(app);
      if (toBusinessDate(clock.now()) !== today) throw new Error(`the trading day is the seed calendar's ${today}, and the seed's clock has left it`);
      const staff = await SeedStaff.load(app);
      const one = async (sql: string, ...values: string[]): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, values)).rows[0];
        if (row === undefined) throw new Error(`the trading day needs ${values.join(' ')}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const branchId = await one('SELECT id FROM mdm.branch WHERE code = $1', SEED_TRADING_DAY.branchCode);
      const location = (code: string) => one('SELECT id FROM mdm.location WHERE branch_id = $1 AND code = $2', branchId, code);
      const product = (sku: string) => one('SELECT id FROM mdm.product WHERE sku = $1', sku);
      const unit = (identifier: string) => one('SELECT id FROM inv.stock_unit WHERE identifier = $1', identifier);
      const [pens, shop, cold] = [await location('PENS'), await location('SHOP'), await location('COLD')];
      const [goat, eggs, cabbage, meat, yam] = [await product('LIV-0004'), await product('EGG-0003'), await product('PRD-0002'), await product('MEAT-0007'), await product('PRD-0005')];
      const [g0142, eggLot, meatLot] = [await unit('G-0142'), await unit('EGG-BIG-2026-1110'), await unit('LOT-GOAT-0001')];
      const till = SEED_TRADING_DAY.till;
      const nextId = createUuidV7Generator(clock);
      const cash = (amount: bigint) => [{ methodCode: 'CASH', amountPesewas: amount, register: till }] as const;
      const sales: SaleRequest[] = [
        {
          orderId: nextId(),
          channel: 'WHOLESALE',
          branchId,
          fulfilmentMode: 'COUNTER',
          taxInclusive: true,
          notes: 'Seeded trading day (SEED)',
          lines: [
            { productId: goat, stockUnitId: g0142, fromLocationId: pens, quantity: '1.000' },
            { productId: eggs, stockUnitId: eggLot, fromLocationId: shop, quantity: '2.000' },
            { productId: cabbage, fromLocationId: shop, quantity: '3.000' },
            { productId: meat, stockUnitId: meatLot, fromLocationId: cold, quantity: '3.500', weightKg: '3.500', weightSource: 'SCALE' },
          ],
          tenders: cash(80_430n),
        },
        {
          orderId: nextId(),
          channel: 'ONLINE',
          branchId,
          fulfilmentMode: 'COLLECTION',
          taxInclusive: true,
          contactName: SEED_TRADING_DAY.online.contactName,
          contactPhone: SEED_TRADING_DAY.online.contactPhone,
          notes: 'Seeded trading day, collected (SEED)',
          lines: [{ productId: eggs, stockUnitId: eggLot, fromLocationId: shop, quantity: '1.000' }],
          tenders: [{ methodCode: 'COD', amountPesewas: 6_000n, register: till }],
        },
        {
          orderId: nextId(),
          channel: 'WHOLESALE',
          branchId,
          fulfilmentMode: 'COUNTER',
          taxInclusive: true,
          notes: 'Seeded trading day (SEED)',
          lines: [{ productId: yam, fromLocationId: shop, quantity: '4.000' }],
          tenders: cash(8_000n),
        },
      ];
      const posting = app.get(SalePosting);
      const uow = app.get(UnitOfWork);
      for (const sale of sales) {
        await staff.as('cashier', (cashier) => uow.run({ isolation: 'serializable', seriesLocks: posting.locksFor(branchId) }, (tx) => posting.postIn(tx, cashier, sale)));
      }
      return { records: sales.length };
    },
  };
}
