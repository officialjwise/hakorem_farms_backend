import { createHash } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { createUuidV7Generator, toBusinessDate, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import { Capital } from '../modules/cap';
import { OverheadAllocations } from '../modules/cst';
import { MdmImports } from '../modules/mdm';
import { PurchaseOrders } from '../modules/pur';
import { ExceptionProjector, ExceptionSweep } from '../modules/rpt';
import type { EventEnvelope } from '../platform/events/domain-events';
import { CLOCK, PG_POOL } from '../platform/platform.module';
import { exceptionSources } from './exception-day-sources';
import { SEED_FEED_ORDER } from './farm-pur';
import { SeedStaff } from './seed-staff';
import type { ServiceSeedUnit } from './seed-unit';

/**
 * The seeded farm's reporting slice (B12 continued 4, A-392), SEED. Run by `pnpm db:seed` after the investors and the
 * trading day, so the investor portal, costing and the daily exception report each have something to show:
 * - **The investor portal:** the Accountant gives two seeded investors a portal login through CAP (`createPortalLogin`).
 *   IAM creates each login with a random password it never keeps, so neither can sign in until the investor sets a
 *   password through the reset; the seed holds no password, token or key.
 * - **A CST allocation run:** the Accountant spreads a week's pen labour over the animals in the goat and sheep pens by
 *   head-days, and the Manager posts it (a second person, ADR-0102), capitalised through inventory with its journal.
 * - **The daily exception report for the seed's day:** a second feed order to Awutu by the same Manager just under the
 *   approval limit (with the purchasing seed's, a split order, case 27) and a product export (case 9), both real and
 *   swept from their records; and one invented source event of each event type the projector reads, with the
 *   variants that raise the remaining kinds (a reused receipt token, tenders that differ, a payment within a day of a
 *   payout change, an address letting three checkouts lapse), so at least one item of every kind is on the report.
 *   The invented events are classified as the projector classifies the outbox's and kept in RPT's projection only,
 *   marked SEED (`ExceptionProjector.seedDay`): they never enter the outbox, so no ledger, stock or message consumer
 *   acts on them, and a rebuild of the projection, which replays the outbox, drops them.
 * A second run finds the seeded items and writes nothing.
 */
export const SEED_PORTAL_INVESTORS = ['Ama Owusu-Ansah', 'Kofi Ampofo'] as const;
/** A week of pen labour, GHS 350.00, spread by head-days over the pens' animals (illustrative, A-043). */
export const SEED_LABOUR_RUN = { totalPesewas: 35_000n, days: 7, location: 'PENS' } as const;
/** The second feed order: the same 4 bags at GHS 450.00, so each order is just under the GHS 2,000.00 limit. */
export const SEED_SPLIT_ORDER = { qtyOrdered: '4.000', unitPricePesewas: 45_000 } as const;

const key = (...parts: string[]): string => `seed:rpt:${parts.join(':')}`;
const DAY_MS = 86_400_000;
/** An invented client address hash: an HMAC as SHP publishes it, never an address. */
const SEED_ADDRESS_HASH = createHash('sha256').update('seed:rpt:checkout-address').digest('hex');

export function farmSeedRpt(): ServiceSeedUnit {
  return {
    kind: 'SERVICE',
    name: 'rpt-reporting-day',
    async run(app: INestApplicationContext) {
      const pool = app.get<pg.Pool>(PG_POOL);
      if ((await pool.query("SELECT 1 FROM rpt.exception_item WHERE source_key LIKE 'seed:%' LIMIT 1")).rows.length > 0) return { records: 0 };
      const staff = await SeedStaff.load(app);
      const clock = app.get<Clock>(CLOCK);
      const today = toBusinessDate(clock.now());
      const one = async (sql: string, ...values: unknown[]): Promise<string> => {
        const row = (await pool.query<{ id: string }>(sql, values)).rows[0];
        if (row === undefined) throw new Error(`the reporting seed needs ${String(values[0])}, which an earlier seed unit creates; run the seed units in order`);
        return row.id;
      };
      let records = 0;

      // The investor portal: two logins, each without a usable password until the investor sets one.
      const capital = app.get(Capital);
      for (const name of SEED_PORTAL_INVESTORS) {
        const investor = (await pool.query<{ id: string; version: number }>('SELECT id, version FROM cap.investor WHERE legal_name = $1', [name])).rows[0];
        if (investor === undefined) throw new Error(`the reporting seed needs the seeded investor ${name}, which the cap-investors seed unit creates`);
        await staff.as('accountant', (accountant) => capital.updateInvestor(accountant, investor.id, { version: investor.version, createPortalLogin: true }, key('portal-login', name)));
        records += 1;
      }

      // A CST labour run over the pens, made by the Accountant and posted by the Manager.
      const pens = await one("SELECT l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = $1", SEED_LABOUR_RUN.location);
      const allocations = app.get(OverheadAllocations);
      const periodStart = toBusinessDate(new Date(clock.now().getTime() - (SEED_LABOUR_RUN.days - 1) * DAY_MS));
      const run = await staff.as('accountant', (accountant) =>
        allocations.create(accountant, { periodStart, periodEnd: today, costElement: 'LABOUR', basis: 'HEAD_DAYS', scopeLocationId: pens, totalPesewas: SEED_LABOUR_RUN.totalPesewas }, key('labour-run')),
      );
      await staff.as('manager', (manager) => allocations.post(manager, run.body.id, key('labour-run', 'post')));
      records += 1;

      // Two records the sweep reads: a second feed order just under the limit, and an export of the products.
      const feedId = await one('SELECT id FROM mdm.product WHERE sku = $1', SEED_FEED_ORDER.sku);
      const awutu = await one('SELECT id FROM mdm.supplier WHERE name = $1', SEED_FEED_ORDER.supplier);
      const store = await one("SELECT l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = $1", SEED_FEED_ORDER.location);
      const orders = app.get(PurchaseOrders);
      await staff.as('manager', async (manager) => {
        const order = await orders.create(
          manager,
          { supplierId: awutu, deliverToLocationId: store, orderDate: today, lines: [{ productId: feedId, uom: SEED_FEED_ORDER.uom, qtyOrdered: SEED_SPLIT_ORDER.qtyOrdered, unitPricePesewas: SEED_SPLIT_ORDER.unitPricePesewas }] },
          key('split-order'),
        );
        await orders.submit(manager, order.body.id, key('split-order', 'submit'));
      });
      await staff.as('manager', (manager) => app.get(MdmImports).export(manager, { entity: 'PRODUCT', format: 'XLSX' }, key('products-export')));
      records += 2;

      // The invented source events, one of each type the projector reads, and the variants for the remaining kinds.
      const branch = await one('SELECT id FROM mdm.branch WHERE code = $1', 'DDW');
      const actor = staff.actor('cashier').principalId;
      const other = staff.actor('manager').principalId;
      const nextId = createUuidV7Generator(clock);
      const doc = nextId();
      const at = clock.now();
      const sources = exceptionSources({ branch, actor, other, doc, at: at.toISOString() });
      const envelope = (type: string, payload: Record<string, unknown>, by: string, branchId: string | null): EventEnvelope => ({
        id: nextId(),
        type,
        version: 1,
        occurredAt: at,
        recordedAt: at,
        actorId: by,
        branchId,
        correlationId: key('exception-day'),
        causationId: null,
        subjectType: 'SeedExceptionSource',
        subjectId: doc,
        payload,
      });
      const events: EventEnvelope[] = Object.entries(sources).map(([type, payload]) =>
        envelope(type, payload, type.startsWith('iam.') || type.startsWith('pur.') ? other : actor, type.startsWith('pur.') || type === 'pay.WebhookRejected' ? null : branch),
      );
      const flagged = sources['pos.OfflineSaleFlagged']!;
      events.push(envelope('pos.OfflineSaleFlagged', { ...flagged, exceptionKind: 'RECEIPT_TOKEN_REFUSED', severity: 'URGENT', summary: 'A receipt token the till printed was already bound to another sale', fact: {}, abuseCases: [37] }, actor, branch));
      events.push(envelope('pos.OfflineSaleFlagged', { ...flagged, exceptionKind: 'TENDERS_DIFFER', severity: 'REVIEW', summary: 'The tenders the till sent differ from the sale it sent', fact: {}, abuseCases: [] }, actor, branch));
      events.push(envelope('pur.SupplierPayoutChanged', { ...sources['pur.SupplierPayoutChanged'], supplierId: awutu }, other, null));
      events.push(envelope('pur.SupplierPaymentMade', { supplierPaymentId: nextId(), supplierId: awutu, method: 'BANK', amountPesewas: 180_000, paidAt: at.toISOString(), approvalRequestId: nextId(), allocations: [] }, other, null));
      for (let i = 0; i < 3; i += 1) {
        const checkoutId = nextId();
        events.push(envelope('shp.CheckoutStarted', { checkoutId, cartId: nextId(), reservedUntil: at.toISOString(), estimatedTotalPesewas: 22_000, lineCount: 1, clientAddressHash: SEED_ADDRESS_HASH }, other, branch));
        events.push(envelope('shp.CheckoutExpired', { checkoutId, cartId: nextId(), reservedUntil: at.toISOString(), reason: 'EXPIRED' }, other, branch));
      }
      records += await app.get(ExceptionProjector).seedDay(events);
      records += (await app.get(ExceptionSweep).sweepDay(today)).raised;
      return { records };
    },
  };
}
