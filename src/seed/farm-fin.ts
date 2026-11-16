import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import type { Clock } from '@hakorem/kernel';
import { toBusinessDate } from '@hakorem/kernel';
import { Approvals } from '../modules/iam';
import { BankAccounts, FixedAssets, ManualJournals } from '../modules/fin';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { CLOCK, PG_POOL } from '../platform/platform.module';
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

/**
 * The seeded farm's fixed assets (B08 continued 1c2, ADR-0059, A-199), SEED: a delivery vehicle, the cold room, pen
 * housing and equipment, as the brief's register lists them, at prices a small Ghanaian farm pays. The cold room is the
 * case whose depreciable amount does not divide evenly (4,500,000 less 500,000 over 36 months: 111,112 for four months,
 * then 111,111). Registered by the seeded Accountant through FIN's `FixedAssets`; registering posts nothing, so their
 * cost is brought into the books by one manual journal (Dr 1510 to 1540, Cr 3900 opening balance equity) drafted by
 * the Accountant and approved by the Owner, dated the earliest acquisition. No depreciation run is seeded: the first
 * one is the accountant's. The register then equals 1510 to 1540, and the seeded trading day's statements still tie.
 */
export const SEED_FIXED_ASSETS = [
  { name: 'Delivery van GT-4521-24 (SEED)', category: 'VEHICLE', acquiredOn: '2026-02-10', costPesewas: 18_500_000, residualPesewas: 2_500_000, usefulLifeMonths: 60, account: '1510' },
  { name: 'Cold room, 12 m³ (SEED)', category: 'COLD_ROOM', acquiredOn: '2026-03-02', costPesewas: 4_500_000, residualPesewas: 500_000, usefulLifeMonths: 36, account: '1520' },
  { name: 'Goat and sheep pen house (SEED)', category: 'HOUSING', acquiredOn: '2026-01-15', costPesewas: 12_000_000, residualPesewas: 0, usefulLifeMonths: 120, account: '1530' },
  { name: 'Platform scale, 300 kg (SEED)', category: 'EQUIPMENT', acquiredOn: '2026-01-20', costPesewas: 420_000, residualPesewas: 0, usefulLifeMonths: 36, account: '1540' },
] as const;
export const SEED_ASSET_JOURNAL = 'Fixed assets brought into the books at cost (SEED)';

/** Registers each asset the farm does not have yet, by name, and journals their cost once; a second run writes nothing. */
export function farmSeedFinAssets(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'fin-fixed-assets',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const clock = app.get<Clock>(CLOCK);
      const assets = app.get(FixedAssets);
      const branchId = (await pool.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
      let records = 0;
      for (const { account: _account, ...asset } of SEED_FIXED_ASSETS) {
        if ((await pool.query('SELECT 1 FROM fin.fixed_asset WHERE name = $1', [asset.name])).rows.length > 0) continue;
        await staff.as('accountant', (accountant) => assets.create(accountant, { ...asset, branchId }, `seed:fin-fixed-asset:${asset.name}`));
        records += 1;
      }
      if ((await pool.query('SELECT 1 FROM fin.manual_journal WHERE description = $1', [SEED_ASSET_JOURNAL])).rows.length > 0) return { records };
      const accounts = new Map((await pool.query<{ code: string; id: string }>('SELECT code, id FROM fin.account')).rows.map((r) => [r.code, r.id] as const));
      const total = SEED_FIXED_ASSETS.reduce((sum, a) => sum + BigInt(a.costPesewas), 0n);
      const postingDate = [...SEED_FIXED_ASSETS].map((a) => a.acquiredOn).sort()[0]!;
      if (postingDate > toBusinessDate(clock.now())) return { records };
      const journals = app.get(ManualJournals);
      const created = await staff.as('accountant', (accountant) =>
        journals.create(
          accountant,
          {
            kind: 'MANUAL',
            postingDate,
            description: SEED_ASSET_JOURNAL,
            lines: [
              ...SEED_FIXED_ASSETS.map((a) => ({ accountId: accounts.get(a.account)!, side: 'D' as const, amountPesewas: a.costPesewas, memo: a.name })),
              { accountId: accounts.get('3900')!, side: 'C' as const, amountPesewas: Number(total) },
            ],
          },
          'seed:fin-asset-journal:create',
        ),
      );
      const pending = await staff.as('accountant', (accountant) => journals.submit(accountant, created.body.id, 'seed:fin-asset-journal:submit'));
      const uow = app.get(UnitOfWork);
      const approvals = app.get(Approvals);
      await staff.as('owner', (owner) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, owner, pending.body.approvalRequestId, 'APPROVED', 'Asset invoices checked (SEED)')));
      return { records: records + 1 };
    },
  };
}
