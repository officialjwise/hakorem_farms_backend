import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { Approvals } from '../modules/iam';
import { SupplierInvoices } from '../modules/pur';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { SEED_TRANSPORT_INVOICE } from './farm-pur';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's first supplier credit note (B07 continued 1b, FR-PUR-011, A-172), SEED: Kpone Livestock Traders
 * credits GHS 15.00 of its GHS 150.00 transport invoice because the trip carried one goat fewer than invoiced. The
 * seeded Accountant enters and submits it and the seeded Owner approves it, so Kpone is owed 13,500 pesewas. No goods
 * go back, so no stock moves and the B5 hand count is unchanged.
 */
export const SEED_CREDIT_NOTE = { supplierInvoiceNo: 'KLT-CN-0031', amountPesewas: 1_500, description: 'Transport refund: one goat fewer than invoiced (SEED)' } as const;

const key = (...parts: string[]): string => `seed:pur-credit:${parts.join(':')}`;

/** Writes the credit note through PUR's `SupplierInvoices` and its approval through IAM's `Approvals`. A second run writes nothing. */
export function farmSeedPurCredit(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'pur-credit-notes',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const one = async (sql: string, ...values: string[]): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, values)).rows[0];
        if (row === undefined) throw new Error(`the credit note seed needs ${values.join(', ')}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const kpone = await one('SELECT id FROM mdm.supplier WHERE name = $1', SEED_TRANSPORT_INVOICE.supplier);
      const seeded = await pool.query('SELECT 1 FROM pur.supplier_invoice WHERE supplier_id = $1 AND supplier_invoice_no = $2', [kpone, SEED_CREDIT_NOTE.supplierInvoiceNo]);
      if (seeded.rows.length > 0) return { records: 0 };
      const invoice = await one('SELECT id FROM pur.supplier_invoice WHERE supplier_id = $1 AND supplier_invoice_no = $2', kpone, SEED_TRANSPORT_INVOICE.supplierInvoiceNo);
      const taxCategory = await one('SELECT id FROM mdm.tax_category WHERE code = $1', SEED_TRANSPORT_INVOICE.taxCategory);
      const invoices = app.get(SupplierInvoices);
      const asked = await staff.as('accountant', async (accountant) => {
        const credit = await invoices.create(
          accountant,
          {
            kind: 'CREDIT_NOTE',
            supplierId: kpone,
            supplierInvoiceNo: SEED_CREDIT_NOTE.supplierInvoiceNo,
            invoiceDate: toBusinessDate(app.get<Clock>(CLOCK).now()),
            originalInvoiceId: invoice,
            lines: [{ description: SEED_CREDIT_NOTE.description, qty: '1.000', unitPricePesewas: SEED_CREDIT_NOTE.amountPesewas, taxCategoryId: taxCategory }],
          },
          key('kpone-transport'),
        );
        return invoices.submitCreditNote(accountant, credit.body.id, key('kpone-transport', 'submit'));
      });
      const approvals = app.get(Approvals);
      const uow = app.get(UnitOfWork);
      await staff.as('owner', (owner) => uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, owner, asked.body.approvalRequestId, 'APPROVED', 'Checked against the delivery count (SEED)')));
      return { records: 1 };
    },
  };
}
