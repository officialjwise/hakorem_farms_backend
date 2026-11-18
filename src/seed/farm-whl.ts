import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { BusinessAccounts, Dunning, Statements } from '../modules/whl';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { PG_POOL } from '../platform/platform.module';
import { addDays, type SeedCalendar } from './seed-calendar';
import { SEED_BILLING } from './farm-bil';
import { SeedStaff, type SeedStaffMember } from './seed-staff';
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

/**
 * Business accounts at Dodowa (B10 continued, FR-WHL-001, CR-048), SEED, through WHL's `BusinessAccounts`: each opens
 * with a nil limit and its limit is asked by one Owner or Manager and approved by another, so the seeded farm shows the
 * second person on every credit limit (the branch's second Manager, Efua Boakye, approves the Owner's). Madina Market
 * Traders is then put on hold by the seeded Accountant. Nothing posts to the ledger. Illustrative limits and terms (A-313).
 */
export const SEED_ACCOUNTS: readonly { readonly customer: string; readonly limitPesewas: bigint; readonly termsDays: number; readonly asker: SeedStaffMember; readonly approver: SeedStaffMember; readonly hold?: string }[] = [
  { customer: 'Tema Cold Store Ltd (SEED)', limitPesewas: 2_000_000n, termsDays: 30, asker: 'owner', approver: 'manager2' },
  { customer: 'Accra Event Caterers (SEED)', limitPesewas: 1_500_000n, termsDays: 14, asker: 'manager', approver: 'owner' },
  { customer: 'Madina Market Traders (SEED)', limitPesewas: 600_000n, termsDays: 7, asker: 'manager2', approver: 'manager', hold: 'Cheque returned unpaid by the bank (SEED)' },
];

export function farmSeedWhlAccounts(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'whl-accounts',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM whl.business_account LIMIT 1')).rows.length > 0) return { records: 0 };
      const one = async (sql: string, value: string): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, [value])).rows[0];
        if (row === undefined) throw new Error(`the business account seed needs ${value}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const branchId = await one('SELECT id FROM mdm.branch WHERE code = $1', SEED_BILLING.branchCode);
      const staff = await SeedStaff.load(app);
      const accounts = app.get(BusinessAccounts);
      const approvals = app.get(Approvals);
      const uow = app.get(UnitOfWork);
      const sales = staff.actor('sales').principalId;
      for (const seeded of SEED_ACCOUNTS) {
        const customerId = await one('SELECT id FROM mdm.customer WHERE name = $1', seeded.customer);
        const opened = await staff.as(seeded.asker, (asker) =>
          accounts.create(asker, { customerId, branchId, creditLimitPesewas: seeded.limitPesewas, paymentTermsDays: seeded.termsDays, accountManagerId: sales, reason: 'Opening terms (SEED)' }, `seed:whl:account:${customerId}`),
        );
        if (opened.status !== 202 || !('approvalRequestId' in opened.body)) throw new Error(`the seeded account of ${seeded.customer} should wait for its credit limit's approval`);
        const approvalId = opened.body.approvalRequestId;
        await staff.as(seeded.approver, (approver) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, approver, approvalId, 'APPROVED', 'Opening terms checked (SEED)')));
        const hold = seeded.hold;
        if (hold !== undefined) await staff.as('accountant', (accountant) => accounts.hold(accountant, customerId, { reason: hold }, `seed:whl:hold:${customerId}`));
      }
      return { records: SEED_ACCOUNTS.length };
    },
  };
}

/**
 * The reminder levels (B10 continued 2, FR-WHL-011), SEED: FR-WHL-011's 7, 14 and 30 days past due, by SMS, the third by
 * SMS then email, set by the seeded Owner through WHL's `Dunning`. The templates are NTF's (B11). A farm that is not
 * seeded has no levels and sends no reminder until the Owner or a Manager sets them (A-318 (f)).
 */
export const SEED_DUNNING_LEVELS = [
  { level: 1, daysOverdue: 7, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_1' },
  { level: 2, daysOverdue: 14, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_2' },
  { level: 3, daysOverdue: 30, channels: ['SMS', 'EMAIL'], templateCode: 'PAYMENT_REMINDER_3' },
] as const;

export function farmSeedWhlDunning(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'whl-dunning',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM whl.dunning_policy LIMIT 1')).rows.length > 0) return { records: 0 };
      const staff = await SeedStaff.load(app);
      await staff.as('owner', (owner) => app.get(Dunning).replace(owner, SEED_DUNNING_LEVELS, 'seed:whl:dunning-levels'));
      return { records: SEED_DUNNING_LEVELS.length };
    },
  };
}
