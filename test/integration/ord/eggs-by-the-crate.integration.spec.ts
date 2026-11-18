import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { SalePosting, type SaleLineRequest, type SaleView } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { createUser, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift, tillOf } from '../../support/till';

/**
 * B09e's gate on the seeded farm (the owner's decisions 1 and 2, A-259, A-261): the big eggs are held in eggs and sold
 * by the crate or singly, each at its own price (6,000 a crate, 220 an egg, never one derived from the other); the 30
 * crates bought at 3,500 (105,000 over 900 eggs) post their cost by place in the delivery, so a crate always costs
 * exactly 3,500 whatever was sold before it; and the trial balance stays at zero with the inventory accounts equal to
 * the cost pools.
 */
let database: TestDatabase;
let api: TestApp;
let sales: SalePosting;
let uow: UnitOfWork;
let cashier: Actor;
let branchId: string;
let shop: string;
let eggs: string;
let eggLot: string;
let nextOrderId: () => string;
const till = { id: '019a8000-0000-7000-8000-00000000a7a1', code: 'T1' };
const admin = () => database.pool('admin');

function sell(lines: readonly Omit<SaleLineRequest, 'productId' | 'stockUnitId' | 'fromLocationId'>[], cashPesewas: bigint): Promise<SaleView> {
  const request = {
    orderId: nextOrderId(),
    channel: 'WHOLESALE' as const,
    branchId,
    fulfilmentMode: 'COUNTER' as const,
    taxInclusive: true,
    notes: 'Eggs by the crate (test)',
    lines: lines.map((l) => ({ productId: eggs, stockUnitId: eggLot, fromLocationId: shop, ...l })),
    tenders: [{ methodCode: 'CASH', amountPesewas: cashPesewas, register: till }],
  };
  return runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'eggs test', actor: cashier }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, async (tx) => sales.postIn(tx, cashier, { shiftDocumentId: await openTestShift(tx, cashier.principalId, request.branchId, tillOf(request)), ...request })),
  );
}

async function issueOf(sale: SaleView, lineNo = 1): Promise<{ qty: string; value: number }> {
  const { rows } = await admin().query<{ qty_base: string; value_pesewas: string }>('SELECT qty_base::text, value_pesewas::text FROM inv.stock_movement WHERE id = $1', [
    sale.lines.find((l) => l.lineNo === lineNo)!.stockMovementId,
  ]);
  return { qty: rows[0]!.qty_base, value: Number(rows[0]!.value_pesewas) };
}

async function lotPool(): Promise<{ qty: string; value: string; anchorQty: string | null; anchorValue: string | null }> {
  const { rows } = await admin().query<{ qty: string; value: string; anchor_qty: string | null; anchor_value: string | null }>(
    'SELECT qty::text, value_pesewas::text AS value, anchor_qty::text, anchor_value_pesewas::text AS anchor_value FROM inv.cost_pool WHERE stock_unit_id = $1',
    [eggLot],
  );
  return { qty: rows[0]!.qty, value: rows[0]!.value, anchorQty: rows[0]!.anchor_qty, anchorValue: rows[0]!.anchor_value };
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  nextOrderId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  sales = api.app.get(SalePosting);
  uow = api.app.get(UnitOfWork);
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  shop = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).rows[0]!.id;
  eggs = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
  eggLot = (await admin().query<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'EGG-BIG-2026-1110'")).rows[0]!.id;
  const user = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] });
  cashier = { principalId: user.principalId, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the seeded eggs are held in eggs and sold by the crate (A-261)', () => {
  it('holds the 30 crates bought as 900 eggs at 105,000, the lot anchored at its delivery, with a crate of 30 as the selling unit', async () => {
    const product = (await admin().query<{ base_uom: string; sale_uom: string }>('SELECT base_uom, sale_uom FROM mdm.product WHERE id = $1', [eggs])).rows[0]!;
    expect(product).toEqual({ base_uom: 'UNIT', sale_uom: 'CRATE' });
    const conversion = (await admin().query('SELECT numerator::int, denominator::int FROM mdm.product_uom_conversion WHERE product_id = $1 AND from_uom = $2 AND deleted_at IS NULL', [eggs, 'CRATE'])).rows;
    expect(conversion).toEqual([{ numerator: 30, denominator: 1 }]);
    expect(await lotPool()).toEqual({ qty: '900.000', value: '105000', anchorQty: '900.000', anchorValue: '105000' });
  });
});

describe('a crate and a single egg each at its own price, cost by place in the delivery (decisions 1 and 2)', () => {
  it('sells one crate at 6,000: the line is 1 CRATE, the stock issue 30 eggs at exactly 3,500', async () => {
    const sale = await sell([{ quantity: '1.000', uom: 'CRATE' }], 6_000n);
    expect(sale.lines[0]).toMatchObject({ qtyOrdered: '1.000', uom: 'CRATE', qtyFulfilled: '1.000', priceBasis: 'PER_UNIT', resolvedUnitPricePesewas: 6_000, agreedUnitPricePesewas: 6_000, finalLineTotalPesewas: 6_000 });
    expect(await issueOf(sale)).toEqual({ qty: '30.000', value: 3_500 });
    const receipt = (await admin().query<{ quantity: string; uom: string; line_net: string }>(
      'SELECT l.qty::text AS quantity, l.uom, l.line_gross_pesewas::text AS line_net FROM bil.billing_document_line l WHERE l.billing_document_id = $1',
      [sale.billingDocument!.id],
    )).rows;
    expect(receipt).toEqual([{ quantity: '1.000', uom: 'CRATE', line_net: '6000' }]);
  });

  it('sells 3 single eggs at 220 each, 660, costing 350, never a crate price divided by 30', async () => {
    const sale = await sell([{ quantity: '3.000' }], 660n);
    expect(sale.lines[0]).toMatchObject({ qtyOrdered: '3.000', uom: 'UNIT', resolvedUnitPricePesewas: 220, finalLineTotalPesewas: 660 });
    // Eggs 31 to 33 of the delivery: half_up(105,000 x 33 / 900) - half_up(105,000 x 30 / 900) = 3,850 - 3,500.
    expect(await issueOf(sale)).toEqual({ qty: '3.000', value: 350 });
  });

  it('after the singles, a crate still costs exactly 3,500, and 2 crates in one line 7,000', async () => {
    expect(await issueOf(await sell([{ quantity: '1.000', uom: 'CRATE' }], 6_000n))).toEqual({ qty: '30.000', value: 3_500 });
    expect(await issueOf(await sell([{ quantity: '2.000', uom: 'CRATE' }], 12_000n))).toEqual({ qty: '60.000', value: 7_000 });
    expect(await lotPool()).toMatchObject({ qty: `${900 - 123}.000`, value: `${105_000 - 3_500 - 350 - 3_500 - 7_000}` });
  });

  it('keeps the trial balance at zero and every inventory account equal to the cost pools', async () => {
    const report = await api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
    expect(report.signedSumPesewas).toBe(0n);
    expect(report.sources.find((s) => s.source === 'inv.stock-value')).toEqual({ source: 'inv.stock-value', breaks: [], unmapped: [] });
    const { rows } = await admin().query<{ ledger: string; pools: string }>(
      `SELECT (SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END) FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
                WHERE a.code IN ('1300', '1310', '1320', '1325', '1330', '1340', '1360')) AS ledger,
              (SELECT sum(value_pesewas) FROM inv.cost_pool) AS pools`,
    );
    expect(BigInt(rows[0]!.ledger)).toBe(BigInt(rows[0]!.pools));
  });
});
