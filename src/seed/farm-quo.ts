import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Quotes, Rfqs } from '../modules/quo';
import { PG_POOL } from '../platform/platform.module';
import { addDays, type SeedCalendar } from './seed-calendar';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * A request for quote and its draft quote (B10, FR-QUO-002, FR-QUO-003), SEED: Madina Market Traders asks on WhatsApp
 * for ten crates of big eggs a week; the seeded salesperson logs it, linked to the customer by the number, and drafts a
 * quote of ten crates at the base list's 6,000 a crate (60,000), valid for fourteen days. The quote stays a draft, so
 * nothing is reserved and every stock figure of the seeded farm is unchanged.
 */
export const SEED_QUOTE = { customer: 'Madina Market Traders (SEED)', phone: '+233200000203', product: 'EGG-0003', crates: '10.000', cratePricePesewas: 6_000n, validDays: 14 } as const;

export function farmSeedQuo(calendar: (app: INestApplicationContext) => SeedCalendar): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'quo-request-and-quote',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM quo.rfq LIMIT 1')).rows.length > 0) return { records: 0 };
      const productId = (await pool.query<{ id: string }>('SELECT id FROM mdm.product WHERE sku = $1', [SEED_QUOTE.product])).rows[0]?.id;
      if (productId === undefined) throw new Error(`the quote seed needs ${SEED_QUOTE.product}, which an earlier seed unit creates; run the seed units in order`);
      const { today } = calendar(app);
      const staff = await SeedStaff.load(app);
      const rfq = await staff.as('sales', (sales) =>
        app.get(Rfqs).create(
          sales,
          { source: 'WHATSAPP', contactName: SEED_QUOTE.customer, contactPhone: SEED_QUOTE.phone, requirements: 'Ten crates of big eggs every Friday for the market stall (SEED)', productId, quantity: SEED_QUOTE.crates, uom: 'CRATE' },
          'seed:quo:rfq:madina',
        ),
      );
      await staff.as('sales', (sales) =>
        app.get(Quotes).create(
          sales,
          {
            rfqId: rfq.body.id,
            contactName: SEED_QUOTE.customer,
            contactPhone: SEED_QUOTE.phone,
            validUntil: new Date(`${addDays(today, SEED_QUOTE.validDays)}T23:59:00Z`),
            terms: 'Payment on collection every Friday (SEED)',
            taxInclusive: true,
            lines: [{ productId, description: 'Big eggs, crate of 30', quantity: SEED_QUOTE.crates, uom: 'CRATE', priceBasis: 'PER_UNIT', unitPricePesewas: SEED_QUOTE.cratePricePesewas }],
          },
          'seed:quo:quote:madina',
        ),
      );
      return { records: 2 };
    },
  };
}
