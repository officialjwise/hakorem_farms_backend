import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { BankAccounts } from '../modules/fin';
import { PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's own accounts (B08 continued 1b2, A-194), SEED: one bank current account and one mobile money
 * merchant wallet, the brief's default ("one mobile money account and one bank account"). The numbers are examples
 * only: all zeros but their last digits, and `+2332000001..` is the seed's own number range. Added by the seeded Owner
 * through FIN's `BankAccounts`, so each is sealed and gets its own subledger party. Nothing posts, so the seeded trading
 * day's trial balance is unchanged.
 */
export const SEED_BANK_ACCOUNTS = [
  { kind: 'BANK', name: 'GCB current account (SEED)', institution: 'GCB Bank', accountNo: '0000000000101' },
  { kind: 'MOBILE_MONEY', name: 'MTN MoMo merchant wallet (SEED)', institution: 'MTN Mobile Money', accountNo: '+233200000101' },
] as const;

/** Adds each account the farm does not have yet, by name; a second run writes nothing. */
export function farmSeedFin(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'fin-bank-accounts',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const accounts = app.get(BankAccounts);
      let records = 0;
      for (const account of SEED_BANK_ACCOUNTS) {
        if ((await pool.query('SELECT 1 FROM fin.bank_account WHERE name = $1', [account.name])).rows.length > 0) continue;
        await staff.as('owner', (owner) => accounts.create(owner, account, `seed:fin-bank-account:${account.name}`));
        records += 1;
      }
      return { records };
    },
  };
}
