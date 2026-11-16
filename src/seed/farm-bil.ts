import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { Billing } from '../modules/bil';
import { Approvals } from '../modules/iam';
import { UnitOfWork } from '../platform/database/unit-of-work';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded trading day's billing documents (B08 continued 2, FR-BIL-004, FR-BIL-006, FR-BIL-007), SEED, issued at
 * Dodowa through BIL's `Billing` by the seeded staff, each posted by the ledger in its own transaction:
 * - an invoice to Tema Cold Store Ltd on 30 days' terms, tax-exclusive: 30.800 kg of goat meat at 2,800 a kilogram
 *   (86,240, standard-rated), 3 crates of big eggs at 6,000 (zero-rated) and delivery at 2,500 (standard-rated);
 * - a walk-in receipt, tax-inclusive: 4 cabbages at 1,500 and 2 crates of big eggs at 6,500 agreed against 6,000
 *   resolved (zero-rated), 500 off the eggs as a promotion;
 * - a credit note of 30,000 (net) against the meat line, raised by the Accountant and approved by the Manager;
 * - a debit note of 2,000 (net) for cold-chain packaging left off the invoice (OTHER_GOODS);
 * - a proforma to Accra Event Caterers, which posts nothing.
 * No stock moves: the sale posting that issues stock with its document is B9a's, so the B5 hand count is unchanged.
 */
export const SEED_BILLING = {
  branchCode: 'DDW',
  invoiceCustomer: 'Tema Cold Store Ltd (SEED)',
  proformaCustomer: 'Accra Event Caterers (SEED)',
  termsDays: 30,
} as const;

const key = (...parts: string[]): string => `seed:bil:${parts.join(':')}`;

/** Adds `days` to a business date (Africa/Accra keeps UTC all year). */
function plusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function farmSeedBil(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'bil-documents',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query('SELECT 1 FROM bil.billing_document LIMIT 1')).rows.length > 0) return { records: 0 };
      const staff = await SeedStaff.load(app);
      const one = async (sql: string, value: string): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, [value])).rows[0];
        if (row === undefined) throw new Error(`the billing seed needs ${value}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const branchId = await one('SELECT id FROM mdm.branch WHERE code = $1', SEED_BILLING.branchCode);
      const tema = await one('SELECT id FROM mdm.customer WHERE name = $1', SEED_BILLING.invoiceCustomer);
      const caterers = await one('SELECT id FROM mdm.customer WHERE name = $1', SEED_BILLING.proformaCustomer);
      const product = (sku: string) => one('SELECT id FROM mdm.product WHERE sku = $1', sku);
      const category = (code: string) => one('SELECT id FROM mdm.tax_category WHERE code = $1', code);
      const [meat, eggs, cabbage, delivery, otherGoods] = [
        await product('MEAT-GOAT-15KG'),
        await product('EGG-CRATE-BIG'),
        await product('PRD-CABBAGE-HEAD'),
        await category('DELIVERY_SERVICE'),
        await category('OTHER_GOODS'),
      ];
      const billing = app.get(Billing);
      const uow = app.get(UnitOfWork);
      const today = toBusinessDate(app.get<Clock>(CLOCK).now());

      const invoice = await staff.as('accountant', (accountant) =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('INVOICE', branchId) }, (tx) =>
          billing.issueIn(tx, accountant, {
            kind: 'INVOICE',
            branchId,
            customerId: tema,
            dueDate: plusDays(today, SEED_BILLING.termsDays),
            taxInclusive: false,
            lines: [
              { lineKind: 'PRODUCT', productId: meat, description: 'Goat meat, weighed at dispatch (SEED)', quantity: '30.800', uom: 'KG', weightKg: '30.800', unitPricePesewas: 2_800n },
              { lineKind: 'PRODUCT', productId: eggs, quantity: '3.000', unitPricePesewas: 6_000n },
              { lineKind: 'DELIVERY_FEE', description: 'Delivery to Tema (SEED)', quantity: '1.000', uom: 'UNIT', unitPricePesewas: 2_500n, taxCategoryId: delivery },
            ],
          }),
        ),
      );
      await staff.as('manager', (manager) =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('RECEIPT', branchId) }, (tx) =>
          billing.issueIn(tx, manager, {
            kind: 'RECEIPT',
            branchId,
            taxInclusive: true,
            lines: [
              { lineKind: 'PRODUCT', productId: cabbage, quantity: '4.000', unitPricePesewas: 1_500n },
              { lineKind: 'PRODUCT', productId: eggs, quantity: '2.000', unitPricePesewas: 6_500n, resolvedUnitPricePesewas: 6_000n, discountPesewas: 500n },
            ],
          }),
        ),
      );
      const meatLine = invoice.lines.find((l) => l.lineNo === 1)!;
      const credit = await staff.as('accountant', (accountant) =>
        billing.issueCreditNote(accountant, invoice.id, { reasonCode: 'QUALITY_COMPLAINT', note: 'Part of the goat meat thawed in transit (SEED)', lines: [{ lineId: meatLine.id, amountPesewas: 30_000 }] }, key('credit', 'tema')),
      );
      const pending = credit.body as { readonly approvalRequestId?: string };
      if (pending.approvalRequestId !== undefined) {
        const approvals = app.get(Approvals);
        await staff.as('manager', (manager) =>
          uow.run({ isolation: 'serializable' }, (tx) => approvals.decide(tx, manager, pending.approvalRequestId!, 'APPROVED', 'Checked against the driver photographs (SEED)')),
        );
      }
      await staff.as('accountant', (accountant) =>
        billing.issueDebitNote(
          accountant,
          invoice.id,
          { reasonCode: 'CHARGE_OMITTED', note: 'Insulated packaging was left off the invoice (SEED)', lines: [{ description: 'Cold-chain packaging (SEED)', amountPesewas: 2_000, taxCategoryId: otherGoods }] },
          key('debit', 'tema'),
        ),
      );
      await staff.as('manager', (manager) =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('PROFORMA', branchId) }, (tx) =>
          billing.issueIn(tx, manager, {
            kind: 'PROFORMA',
            branchId,
            customerId: caterers,
            taxInclusive: false,
            lines: [{ lineKind: 'PRODUCT', productId: meat, description: 'Goat meat for a funeral, estimate (SEED)', quantity: '45.000', uom: 'KG', unitPricePesewas: 2_800n }],
          }),
        ),
      );
      return { records: 5 };
    },
  };
}
