import { randomUUID } from 'node:crypto';
import { Money, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BalanceReconciliation,
  InsufficientStockError,
  Lineage,
  Stock,
  StockMovementAlreadyReversedError,
  StockUnitNotAvailableError,
  StockUnitOnHoldError,
  type MovementRequest,
} from '../../../src/modules/inv';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { IsolationLevelError, UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { ForbiddenError } from '../../../src/platform/errors/api-error';
import { createUser, SYSTEM_PRINCIPAL } from '../../support/iam';
import { businessDay, createStockFixture, onHand, stockDocument, stockUnit, type StockFixture } from '../../support/inventory';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** INV's published interface over the ledger: posting, lineage and its trace, and the nightly recompute. */
let database: TestDatabase;
let api: TestApp;
let fx: StockFixture;
let uow: UnitOfWork;
let stock: Stock;
const units = (n: bigint) => Quantity.ofUnits(n);
const SYSTEM: Actor = { principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null };

beforeAll(async () => {
  database = await createTestDatabase();
  fx = await createStockFixture(database);
  api = await startTestApp(database);
  uow = api.app.get(UnitOfWork);
  stock = api.app.get(Stock);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

/** Commands run inside a request or job context, which gives their events an actor. */
function inContext<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Stock test' }, randomUUID(), fn);
}

const recompute = () => inContext(() => api.app.get(BalanceReconciliation).run(SYSTEM));

async function post(request: Omit<MovementRequest, 'branchId' | 'sourceDocumentId' | 'occurredAt'> & { sourceDocumentId?: string }) {
  const sourceDocumentId = request.sourceDocumentId ?? (await stockDocument(fx));
  return inContext(() => uow.run({ isolation: 'serializable' }, (tx) => stock.postIn(tx, fx.actor, { branchId: fx.branchId, occurredAt: new Date(), ...request, sourceDocumentId })));
}

const receipt = (productId: string, to: string, qty: bigint, value: bigint, stockUnitId: string | null = null) =>
  post({ movementType: 'RECEIPT_PURCHASE', productId, stockUnitId, fromLocationId: fx.virtual.SUPPLIER, toLocationId: to, qty: units(qty), value: Money.ofPesewas(value), costElement: 'PURCHASE' });

const sale = (productId: string, from: string, qty: bigint, stockUnitId: string | null = null) =>
  post({ movementType: 'SALE_ISSUE', productId, stockUnitId, fromLocationId: from, toLocationId: fx.virtual.CUSTOMER, qty: units(qty) });

async function staff(role: 'MANAGER' | 'CASHIER', name: string): Promise<Actor> {
  const user = await createUser(database, { name, grants: [{ role, branchId: fx.branchId }] });
  return { principalId: user.principalId, kind: 'USER', displayName: name, realm: 'STAFF', sessionId: null, steppedUpAt: null };
}

describe('Stock.postIn (ADR-0002, ADR-0005)', () => {
  it('refuses to post at read committed: a stock entry point runs serializable', async () => {
    const sourceDocumentId = await stockDocument(fx);
    await expect(
      uow.run({ isolation: 'read committed' }, (tx) =>
        stock.postIn(tx, fx.actor, { movementType: 'SALE_ISSUE', productId: fx.eggs, branchId: fx.branchId, fromLocationId: fx.store, toLocationId: fx.virtual.CUSTOMER, qty: units(1n), sourceDocumentId, occurredAt: new Date() }),
      ),
    ).rejects.toBeInstanceOf(IsolationLevelError);
  });

  it('returns the value the pool carried and publishes the ledger posting event with it, in the same transaction', async () => {
    await receipt(fx.eggs, fx.store, 3n, 100_001n);
    const posted = await sale(fx.eggs, fx.store, 1n);
    expect(posted.value.pesewas).toBe(33_334n);
    const { rows } = await database
      .pool('admin')
      .query<{ payload: { valuePesewas: number; movementType: string } }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'inv.StockIssuedForSale' AND subject_id = $1", [posted.id]);
    expect(rows[0]!.payload).toMatchObject({ valuePesewas: 33_334, movementType: 'SALE_ISSUE' });
  });

  it('answers each refusal with the error its rule names', async () => {
    await expect(sale(fx.eggs, fx.store, 5n)).rejects.toBeInstanceOf(InsufficientStockError);
    const goat = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: 'G-0200' });
    await receipt(fx.goat, fx.shop, 1n, 60_000n, goat);
    await expect(sale(fx.goat, fx.pens, 1n, goat)).rejects.toBeInstanceOf(StockUnitNotAvailableError);
    await fx.app.query('INSERT INTO inv.stock_hold (id, stock_unit_id, kind, starts_at, source_document_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      randomUUID(), goat, 'INVESTIGATION', new Date('2026-01-01T00:00:00Z'), await stockDocument(fx, 'STOCK_HOLD'), fx.actor,
    ]);
    await expect(sale(fx.goat, fx.shop, 1n, goat)).rejects.toBeInstanceOf(StockUnitOnHoldError);
    const original = await receipt(fx.eggs, fx.store, 2n, 7_000n);
    const reverse = () =>
      post({ movementType: 'RECEIPT_PURCHASE', productId: fx.eggs, fromLocationId: fx.store, toLocationId: fx.virtual.SUPPLIER, qty: units(2n), costElement: 'PURCHASE', reversesMovementId: original.id });
    expect((await reverse()).value.pesewas).toBe(7_000n);
    await expect(reverse()).rejects.toBeInstanceOf(StockMovementAlreadyReversedError);
  });
});

describe('on-hand derived from movements, and the nightly recompute (FR-INV-003)', () => {
  it('holds 3 after 10 receipts and 7 sales, from the projection and from a fresh sum of the ledger alike', async () => {
    for (const _ of Array.from({ length: 10 })) await receipt(fx.eggs, fx.shop, 1n, 3_500n);
    for (const _ of Array.from({ length: 7 })) await sale(fx.eggs, fx.shop, 1n);
    expect(await onHand(fx, fx.eggs, fx.shop)).toBe('3.000');
    const { rows } = await fx.app.query<{ qty: string }>(
      `SELECT (COALESCE(sum(qty_base) FILTER (WHERE to_location_id = $2), 0) - COALESCE(sum(qty_base) FILTER (WHERE from_location_id = $2), 0))::numeric(14,3)::text AS qty
         FROM inv.stock_movement WHERE product_id = $1`,
      [fx.eggs, fx.shop],
    );
    expect(rows[0]!.qty).toBe('3.000');
    expect(await recompute()).toEqual([]);
  });

  it('raises one BALANCE_DRIFT exception for a balance corrupted by hand, and leaves the row as it found it', async () => {
    const owner = await database.pool('migrator').connect();
    try {
      await owner.query('BEGIN');
      await owner.query('SET LOCAL ROLE hk_owner');
      await owner.query("UPDATE inv.stock_balance SET on_hand_qty = 4 WHERE product_id = $1 AND location_id = $2 AND stock_unit_id IS NULL", [fx.eggs, fx.shop]);
      await owner.query('COMMIT');
    } finally {
      owner.release();
    }
    const found = await recompute();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'BALANCE', productId: fx.eggs, locationId: fx.shop, projectedQty: '4.000', ledgerQty: '3.000' });
    expect(await onHand(fx, fx.eggs, fx.shop)).toBe('4.000');
    const { rows } = await fx.app.query<{ kind: string; qty: string; status: string }>('SELECT kind, qty, status FROM inv.stock_exception WHERE id = $1', [found[0]!.exceptionId]);
    expect(rows[0]).toEqual({ kind: 'BALANCE_DRIFT', qty: '1.000', status: 'OPEN' });
  });

  it('refuses to run as anyone but a SYSTEM principal', async () => {
    expect(() => api.app.get(BalanceReconciliation).run({ ...SYSTEM, kind: 'USER' })).toThrow();
  });
});

describe('a lot traces in both directions (FR-INV-006)', () => {
  it('traces sold lot LOT-GOAT-0001 back to G-0142, its supplier, receipt and costs, and G-0142 forward to the lot and its sale', async () => {
    const supplierId = randomUUID();
    await fx.app.query("INSERT INTO mdm.supplier (id, supplier_no, name, status, created_by, updated_by) VALUES ($1, 'S-0042', 'Nkrumah Livestock', 'ACTIVE', $2, $2)", [supplierId, SYSTEM_PRINCIPAL]);
    const goatMeat = (
      await fx.app.query<{ id: string }>(
        `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
         SELECT $1, 'MEAT-GOAT-15', 'Goat meat', category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by
           FROM mdm.product WHERE id = $2 RETURNING id`,
        [randomUUID(), fx.beef],
      )
    ).rows[0]!.id;
    const g0142 = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: 'G-0142', supplierId });
    const goodsReceipt = await stockDocument(fx, 'GOODS_RECEIPT');
    await post({ movementType: 'RECEIPT_PURCHASE', productId: fx.goat, stockUnitId: g0142, fromLocationId: fx.virtual.SUPPLIER, toLocationId: fx.pens, qty: units(1n), value: Money.ofPesewas(60_000n), costElement: 'PURCHASE', sourceDocumentId: goodsReceipt });
    for (const [value, element] of [[8_400n, 'FEED'], [3_000n, 'VETERINARY']] as const) {
      await post({ movementType: 'COST_CAPITALISE', productId: fx.goat, stockUnitId: g0142, fromLocationId: fx.virtual.CONSUMPTION, toLocationId: fx.pens, qty: Quantity.zero(), value: Money.ofPesewas(value), costElement: element });
    }
    const processing = await stockDocument(fx);
    const consumed = await post({ movementType: 'PROCESS_CONSUME', productId: fx.goat, stockUnitId: g0142, fromLocationId: fx.pens, toLocationId: fx.virtual.PROCESSING, qty: units(1n), sourceDocumentId: processing });
    expect(consumed.value.pesewas).toBe(71_400n);
    const lot = await stockUnit(fx, { productId: goatMeat, tracking: 'LOT', identifier: 'LOT-GOAT-0001', producedOn: businessDay(-2), expiresOn: businessDay(5) });
    await inContext(() => uow.run({ isolation: 'serializable' }, async (tx) => {
      await stock.postIn(tx, fx.actor, {
        movementType: 'PROCESS_OUTPUT', productId: goatMeat, stockUnitId: lot, branchId: fx.branchId, fromLocationId: fx.virtual.PROCESSING, toLocationId: fx.coldRoom,
        qty: Quantity.parse('12.000'), value: Money.ofPesewas(71_400n), costElement: 'PROCESSING', sourceDocumentId: processing, occurredAt: new Date(),
      });
      await api.app.get(Lineage).linkIn(tx, fx.actor, lot, [g0142], 'PROCESSING', processing);
    }));
    const order = await stockDocument(fx);
    await post({ movementType: 'SALE_ISSUE', productId: goatMeat, stockUnitId: lot, fromLocationId: fx.coldRoom, toLocationId: fx.virtual.CUSTOMER, qty: Quantity.parse('12.000'), sourceDocumentId: order });

    const manager = await staff('MANAGER', 'Akosua Boateng');
    const back = await api.app.get(Lineage).trace(manager, lot);
    expect(back.unit).toMatchObject({ identifier: 'LOT-GOAT-0001', status: 'DEPLETED' });
    expect(back.backward).toHaveLength(1);
    expect(back.backward[0]).toMatchObject({ identifier: 'G-0142', supplierId, sourceDocumentId: expect.any(String), via: { unitId: lot, linkType: 'PROCESSING', sourceDocumentId: processing } });
    expect(back.backward[0]!.costByElement).toEqual({ PURCHASE: 60_000, FEED: 8_400, VETERINARY: 3_000 });
    expect(back.backward[0]!.movements.find((m) => m.movementType === 'RECEIPT_PURCHASE')?.sourceDocumentId).toBe(goodsReceipt);
    expect(back.sales.map((m) => m.sourceDocumentId)).toEqual([order]);

    const forward = await api.app.get(Lineage).trace(manager, g0142);
    expect(forward.forward.map((u) => u.identifier)).toEqual(['LOT-GOAT-0001']);
    expect(forward.sales).toHaveLength(1);
    expect(forward.sales[0]).toMatchObject({ stockUnitId: lot, sourceDocumentId: order });
  });

  it('refuses the trace to a cashier, who holds no inv.trace.read', async () => {
    const cashier = await staff('CASHIER', 'Yaw Darko');
    const goat = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: 'G-0201' });
    await expect(api.app.get(Lineage).trace(cashier, goat)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
