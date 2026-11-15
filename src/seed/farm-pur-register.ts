import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { Requisitions, Suppliers } from '../modules/pur';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's supplier register and a requisition (B07 continued, A-166), SEED. Kpone Livestock Traders sells on
 * 14-day terms with a 3-day lead time and is paid by MTN mobile money; Awutu Poultry Farm is paid by bank transfer.
 * Each set of payout details is made by the seeded Owner and approved by the seeded Manager, the smallest team the
 * owner's cross-approval allows (A-171). The Manager raises and submits a requisition for 100 kg of broiler grower feed,
 * which waits for conversion. The wallet and the account are examples only: `+2332000002..` is the seed's own number
 * range and the account number is all zeros but its last digits. No stock and no money moves, so the B5 hand count is
 * unchanged.
 */
export const SEED_KPONE_TERMS = { supplier: 'Kpone Livestock Traders (SEED)', paymentTermsDays: 14, leadTimeDays: 3 } as const;
export const SEED_PAYOUTS = [
  { supplier: 'Kpone Livestock Traders (SEED)', details: { method: 'MOBILE_MONEY', momoNetwork: 'MTN', momoNumber: '+233200000211' } },
  { supplier: 'Awutu Poultry Farm (SEED)', details: { method: 'BANK', bankName: 'Ecobank Ghana', accountName: 'Awutu Poultry Farm (SEED)', accountNumber: '0000000000202', bankBranch: 'Kasoa' } },
] as const;
export const SEED_REQUISITION = { sku: 'FEED-BRL-GROWER', qty: '100.000', location: 'STORE', justification: 'Grower feed for the next brooder batch (SEED)' } as const;

const key = (...parts: string[]): string => `seed:pur-register:${parts.join(':')}`;

/**
 * Writes Kpone's terms through PUR's `Suppliers` as the Manager, each payout change as the Owner with the Manager's
 * approval through IAM's `Approvals`, and the requisition through `Requisitions` as the Manager. A second run finds the
 * requisition and writes nothing.
 */
export function farmSeedPurRegister(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'pur-supplier-register',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const one = async (sql: string, value: string): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, [value])).rows[0];
        if (row === undefined) throw new Error(`the supplier register seed needs ${value}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const kpone = await one('SELECT id FROM mdm.supplier WHERE name = $1', SEED_KPONE_TERMS.supplier);
      const seeded = await pool.query('SELECT 1 FROM pur.purchase_requisition WHERE justification = $1', [SEED_REQUISITION.justification]);
      if (seeded.rows.length > 0) return { records: 0 };
      const suppliers = app.get(Suppliers);
      await staff.as('manager', async (manager) => {
        const profile = await suppliers.getProfile(manager, kpone);
        await suppliers.updateProfile(manager, kpone, { version: profile.version, paymentTermsDays: SEED_KPONE_TERMS.paymentTermsDays, leadTimeDays: SEED_KPONE_TERMS.leadTimeDays }, key('kpone-terms'));
      });
      const approvals = app.get(Approvals);
      const uow = app.get(UnitOfWork);
      for (const payout of SEED_PAYOUTS) {
        const supplierId = await one('SELECT id FROM mdm.supplier WHERE name = $1', payout.supplier);
        const asked = await staff.as('owner', async (owner) => {
          const profile = await suppliers.getProfile(owner, supplierId);
          return suppliers.updateProfile(owner, supplierId, { version: profile.version, payoutDetails: payout.details }, key('payout', payout.supplier));
        });
        const approvalRequestId = (asked.body as { readonly approvalRequestId: string }).approvalRequestId;
        await staff.as('manager', (manager) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, manager, approvalRequestId, 'APPROVED', 'Confirmed with the supplier by phone (SEED)')));
      }
      const feed = await one('SELECT id FROM mdm.product WHERE sku = $1', SEED_REQUISITION.sku);
      const store = await one("SELECT l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = $1", SEED_REQUISITION.location);
      const requisitions = app.get(Requisitions);
      await staff.as('manager', async (manager) => {
        const raised = await requisitions.create(
          manager,
          { locationId: store, neededBy: toBusinessDate(app.get<Clock>(CLOCK).now()), justification: SEED_REQUISITION.justification, lines: [{ productId: feed, qty: SEED_REQUISITION.qty }] },
          key('requisition'),
        );
        await requisitions.submit(manager, raised.body.id, key('requisition', 'submit'));
      });
      return { records: 2 + SEED_PAYOUTS.length };
    },
  };
}
