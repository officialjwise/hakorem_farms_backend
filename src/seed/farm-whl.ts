import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Statements } from '../modules/whl';
import { PG_POOL } from '../platform/platform.module';
import { addDays, type SeedCalendar } from './seed-calendar';
import { SEED_BILLING } from './farm-bil';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * One issued customer statement (B08 continued 2d, FR-WHL-009), SEED: Tema Cold Store Ltd's account at Dodowa for the
 * thirty days to the seed's today, produced by the seeded Accountant through WHL's `Statements`, so it is read from the
 * ledger's 1200 for the customer, numbered from Dodowa's STATEMENT series and asks DOC to render and archive it after
 * commit. It shows the billing seed's invoice on terms, its credit note and its debit note, from an opening of zero.
 */
export const SEED_STATEMENT = { customer: SEED_BILLING.invoiceCustomer, days: 30 } as const;

export function farmSeedWhl(calendar: (app: INestApplicationContext) => SeedCalendar): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'whl-statement',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM whl.statement LIMIT 1')).rows.length > 0) return { records: 0 };
      const one = async (sql: string, value: string): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, [value])).rows[0];
        if (row === undefined) throw new Error(`the statement seed needs ${value}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const branchId = await one('SELECT id FROM mdm.branch WHERE code = $1', SEED_BILLING.branchCode);
      const customerId = await one('SELECT id FROM mdm.customer WHERE name = $1', SEED_STATEMENT.customer);
      const { today } = calendar(app);
      const staff = await SeedStaff.load(app);
      await staff.as('accountant', (accountant) =>
        app.get(Statements).create(accountant, { customerId, branchId, periodStart: addDays(today, 1 - SEED_STATEMENT.days), periodEnd: today, issue: true }, 'seed:whl:statement:tema'),
      );
      return { records: 1 };
    },
  };
}
