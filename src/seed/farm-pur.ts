import type { INestApplicationContext } from '@nestjs/common';
import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { PurchaseOrders, SupplierInvoices } from '../modules/pur';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's purchase to pay (B7, A-164), SEED: four 50 kg bags of broiler grower pellets ordered from Awutu
 * Poultry Farm at GHS 450.00 a bag (180,000 pesewas, within the 200,000 limit, so approved on submit) and sent, still
 * awaiting delivery; and Kpone Livestock Traders' transport invoice for the goats, GHS 150.00, an expense with no order
 * that needs no match, entered by the Accountant and approved for payment by the Owner (CR-043). No stock moves, so the B5 hand count is unchanged.
 */
export const SEED_FEED_ORDER = { sku: 'FEED-0001', uom: 'BAG', qtyOrdered: '4.000', unitPricePesewas: 45_000, supplier: 'Awutu Poultry Farm (SEED)', location: 'STORE' } as const;
export const SEED_TRANSPORT_INVOICE = { supplier: 'Kpone Livestock Traders (SEED)', supplierInvoiceNo: 'KLT-T-0457', amountPesewas: 15_000, taxCategory: 'LIVE_ANIMALS' } as const;

const key = (...parts: string[]): string => `seed:pur:${parts.join(':')}`;

/**
 * Writes the order through PUR's `PurchaseOrders` as the seeded Manager and the invoice through `SupplierInvoices` as
 * the seeded Accountant, after the unit conversions exist, dated the day the seed runs (the seeded tax scheme is in
 * force from its activation). A second run finds the transport invoice and writes nothing.
 */
export function farmSeedPur(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'pur-purchase-to-pay',
    async run(app: INestApplicationContext) {
      const staff = await SeedStaff.load(app);
      const pool = app.get<pg.Pool>(PG_POOL);
      const one = async (sql: string, value: string): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, [value])).rows[0];
        if (row === undefined) throw new Error(`the purchasing seed needs ${value}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      const feedId = await one('SELECT id FROM mdm.product WHERE sku = $1', SEED_FEED_ORDER.sku);
      const awutu = await one('SELECT id FROM mdm.supplier WHERE name = $1', SEED_FEED_ORDER.supplier);
      const kpone = await one('SELECT id FROM mdm.supplier WHERE name = $1', SEED_TRANSPORT_INVOICE.supplier);
      const store = await one("SELECT l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = $1", SEED_FEED_ORDER.location);
      const branch = await one('SELECT id FROM mdm.branch WHERE code = $1', 'DDW');
      const taxCategory = await one('SELECT id FROM mdm.tax_category WHERE code = $1', SEED_TRANSPORT_INVOICE.taxCategory);
      const seeded = await pool.query('SELECT 1 FROM pur.supplier_invoice WHERE supplier_id = $1 AND supplier_invoice_no = $2', [kpone, SEED_TRANSPORT_INVOICE.supplierInvoiceNo]);
      if (seeded.rows.length > 0) return { records: 0 };
      const today = toBusinessDate(app.get<Clock>(CLOCK).now());
      const orders = app.get(PurchaseOrders);
      const invoices = app.get(SupplierInvoices);
      await staff.as('manager', async (manager) => {
        const order = await orders.create(
          manager,
          {
            supplierId: awutu,
            deliverToLocationId: store,
            orderDate: today,
            lines: [{ productId: feedId, uom: SEED_FEED_ORDER.uom, qtyOrdered: SEED_FEED_ORDER.qtyOrdered, unitPricePesewas: SEED_FEED_ORDER.unitPricePesewas }],
          },
          key('feed-order'),
        );
        await orders.submit(manager, order.body.id, key('feed-order', 'submit'));
        await orders.send(manager, order.body.id, { channels: ['WHATSAPP'] }, key('feed-order', 'send'));
      });
      const entered = await staff.as('accountant', async (accountant) => {
        const invoice = await invoices.create(
          accountant,
          {
            kind: 'INVOICE',
            supplierId: kpone,
            supplierInvoiceNo: SEED_TRANSPORT_INVOICE.supplierInvoiceNo,
            invoiceDate: today,
            branchId: branch,
            lines: [{ description: 'Transport of four goats and two sheep from Kpone (SEED)', qty: '1.000', unitPricePesewas: SEED_TRANSPORT_INVOICE.amountPesewas, taxCategoryId: taxCategory }],
          },
          key('transport-invoice'),
        );
        await invoices.match(accountant, invoice.body.id, key('transport-invoice', 'match'));
        return invoice.body.id;
      });
      // Approved for payment by the Owner, never by the Accountant who entered it (CR-043).
      await staff.as('owner', (owner) => invoices.approve(owner, entered, key('transport-invoice', 'approve')));
      return { records: 2 };
    },
  };
}
