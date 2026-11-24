import type { INestApplicationContext } from '@nestjs/common';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { Capital } from '../modules/cap';
import { ManualJournals } from '../modules/fin';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { PG_POOL } from '../platform/platform.module';
import { SEED_BANK_ACCOUNTS } from './farm-fin';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded investors and their capital (B12, docs/UAT.md section 3.5, A-055), SEED: invented people and an invented
 * fund, in the seed's own number range. One unit costs GHS 100.00; each contribution is paid into the seeded GCB current
 * account on its value date and recorded by the seeded Accountant through CAP, so it issues its units from that date
 * and posts Dr 1100 Cr 3000 against the investor. A value date before the books begin (1 January 2026) posts on the
 * ledger's first day, its units still counting from the value date (A-380). Total 4,200 units, GHS 420,000.00 paid in.
 */
export const SEED_INVESTORS = [
  { name: 'Ama Owusu-Ansah', kind: 'INDIVIDUAL', phone: '+233200000301', joinedOn: '2025-06-01', contributions: [{ units: 1_000, valueDate: '2025-06-01' }] },
  { name: 'Kofi Ampofo', kind: 'INDIVIDUAL', phone: '+233200000302', joinedOn: '2026-08-15', contributions: [{ units: 500, valueDate: '2026-08-15' }] },
  {
    name: 'Esi Bonsu',
    kind: 'INDIVIDUAL',
    phone: '+233200000303',
    joinedOn: '2025-06-01',
    contributions: [
      { units: 250, valueDate: '2025-06-01' },
      { units: 250, valueDate: '2026-09-01' },
    ],
  },
  { name: 'Yaw Frimpong', kind: 'INDIVIDUAL', phone: '+233200000304', joinedOn: '2025-11-01', contributions: [{ units: 200, valueDate: '2025-11-01' }] },
  { name: 'Akwaaba Diaspora Agro Fund', kind: 'ENTITY', phone: '+233200000305', joinedOn: '2026-07-15', contributions: [{ units: 2_000, valueDate: '2026-07-15' }] },
] as const;
export const SEED_UNIT_PRICE_PESEWAS = 10_000n;

/**
 * The trading summary of July, August and September 2026, SEED (UAT section 3.5): one manual journal a month, drafted by
 * the Accountant and approved by the Owner, the takings banked (Dr 1100 the net), the goods bought (Dr 5000) and the
 * running costs (Dr 6000 wages) paid from the bank, against sales of live animals (Cr 4000). Income less cost of sales
 * less expenses over the quarter is exactly GHS 41,666.70: the figure scenario 4 distributes.
 */
export const SEED_Q3_TRADING = [
  { postingDate: '2026-07-31', month: 'July 2026', incomePesewas: 3_000_000, costOfSalesPesewas: 1_400_000, expensesPesewas: 300_000 },
  { postingDate: '2026-08-31', month: 'August 2026', incomePesewas: 3_200_000, costOfSalesPesewas: 1_500_000, expensesPesewas: 310_000 },
  { postingDate: '2026-09-30', month: 'September 2026', incomePesewas: 3_400_000, costOfSalesPesewas: 1_600_000, expensesPesewas: 323_330 },
] as const;
const tradingJournal = (month: string) => `Trading summary for ${month} (SEED)`;

/** Registers each investor the farm does not have yet and records their contributions; a second run writes nothing. */
export function farmSeedCap(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'cap-investors',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const capital = app.get(Capital);
      const bankAccountId = (await pool.query<{ id: string }>('SELECT id FROM fin.bank_account WHERE name = $1', [SEED_BANK_ACCOUNTS[0].name])).rows[0]!.id;
      let records = 0;
      for (const investor of SEED_INVESTORS) {
        if ((await pool.query('SELECT 1 FROM cap.investor WHERE legal_name = $1', [investor.name])).rows.length > 0) continue;
        const created = await staff.as('accountant', (accountant) =>
          capital.createInvestor(accountant, { kind: investor.kind, legalName: investor.name, phone: investor.phone, joinedOn: investor.joinedOn }, `seed:cap-investor:${investor.name}`),
        );
        records += 1;
        for (const c of investor.contributions) {
          await staff.as('accountant', (accountant) =>
            capital.record(
              accountant,
              {
                kind: 'CONTRIBUTION',
                investorId: created.body.id,
                amountPesewas: BigInt(c.units) * SEED_UNIT_PRICE_PESEWAS,
                valueDate: c.valueDate,
                unitPricePesewas: SEED_UNIT_PRICE_PESEWAS,
                bankAccountId,
                externalReference: `SEED-CAP-${investor.phone.slice(-3)}-${c.valueDate}`,
              },
              `seed:cap-contribution:${investor.name}:${c.valueDate}`,
            ),
          );
          records += 1;
        }
      }
      return { records: records + (await seedQ3Trading(app, staff, pool, bankAccountId)) };
    },
  };
}

async function seedQ3Trading(app: INestApplicationContext, staff: SeedStaff, pool: pg.Pool, bankAccountId: string): Promise<number> {
  const accounts = new Map((await pool.query<{ code: string; id: string }>('SELECT code, id FROM fin.account')).rows.map((r) => [r.code, r.id] as const));
  const bankParty = (await pool.query<{ id: string }>("SELECT id FROM fin.subledger_party WHERE kind = 'BANK_ACCOUNT' AND ref_id = $1", [bankAccountId])).rows[0]!.id;
  const journals = app.get(ManualJournals);
  const uow = app.get(UnitOfWork);
  const approvals = app.get(Approvals);
  let records = 0;
  for (const month of SEED_Q3_TRADING) {
    const description = tradingJournal(month.month);
    if ((await pool.query('SELECT 1 FROM fin.manual_journal WHERE description = $1', [description])).rows.length > 0) continue;
    const banked = month.incomePesewas - month.costOfSalesPesewas - month.expensesPesewas;
    const created = await staff.as('accountant', (accountant) =>
      journals.create(
        accountant,
        {
          kind: 'MANUAL',
          postingDate: month.postingDate,
          description,
          lines: [
            { accountId: accounts.get('1100')!, side: 'D' as const, amountPesewas: banked, subledgerPartyId: bankParty, memo: 'Takings banked less goods and wages paid' },
            { accountId: accounts.get('5000')!, side: 'D' as const, amountPesewas: month.costOfSalesPesewas, memo: 'Animals bought for resale' },
            { accountId: accounts.get('6000')!, side: 'D' as const, amountPesewas: month.expensesPesewas, memo: 'Wages' },
            { accountId: accounts.get('4000')!, side: 'C' as const, amountPesewas: month.incomePesewas, memo: 'Sales of live animals' },
          ],
        },
        `seed:cap-q3-trading:${month.month}`,
      ),
    );
    const pending = await staff.as('accountant', (accountant) => journals.submit(accountant, created.body.id, `seed:cap-q3-trading-submit:${month.month}`));
    await staff.as('owner', (owner) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, owner, pending.body.approvalRequestId, 'APPROVED', 'Monthly takings checked against the bank (SEED)')));
    records += 1;
  }
  return records;
}
