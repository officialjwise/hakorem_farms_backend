import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDay, createStockFixture, move, movementValue, onHand, pool, receive, refusal, sell, stockUnit, type StockFixture } from '../../support/inventory';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The append-only ledger and the shape of a movement, enforced by the database for any writer (ADR-0002). */
let database: TestDatabase;
let fx: StockFixture;

beforeAll(async () => {
  database = await createTestDatabase();
  fx = await createStockFixture(database);
});

afterAll(async () => {
  await database.drop();
});

describe('the ledger is append-only (FR-INV-001)', () => {
  it('refuses UPDATE, DELETE and TRUNCATE of a movement, and leaves it as it was', async () => {
    const id = await receive(fx, fx.eggs, fx.store, '10.000', 35_000);
    // hk_app holds no UPDATE, DELETE or TRUNCATE at all; the owner role is refused by the trigger.
    for (const statement of ['UPDATE inv.stock_movement SET qty_base = 1 WHERE id = $1', 'DELETE FROM inv.stock_movement WHERE id = $1']) {
      expect(await sqlStateOf(fx.app.query(statement, [id]))).toBe(SQLSTATE.insufficientPrivilege);
    }
    expect(await sqlStateOf(fx.app.query('TRUNCATE inv.stock_movement'))).toBe(SQLSTATE.insufficientPrivilege);
    const owner = await database.pool('migrator').connect();
    try {
      await owner.query('BEGIN');
      await owner.query('SET LOCAL ROLE hk_owner');
      for (const statement of ['UPDATE inv.stock_movement SET qty_base = 1 WHERE id = $1', 'DELETE FROM inv.stock_movement WHERE id = $1']) {
        await owner.query('SAVEPOINT attempt');
        expect(await sqlStateOf(owner.query(statement, [id]))).toBe(SQLSTATE.ledgerImmutable);
        await owner.query('ROLLBACK TO SAVEPOINT attempt');
      }
      expect(await sqlStateOf(owner.query('TRUNCATE inv.stock_movement CASCADE'))).toBe(SQLSTATE.ledgerImmutable);
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    const { rows } = await fx.app.query<{ qty_base: string }>('SELECT qty_base FROM inv.stock_movement WHERE id = $1', [id]);
    expect(rows[0]!.qty_base).toBe('10.000');
  });

  it('gives the application no way to write a balance or a cost pool', async () => {
    expect(await sqlStateOf(fx.app.query("UPDATE inv.stock_balance SET on_hand_qty = 99 WHERE product_id = $1", [fx.eggs]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(fx.app.query('DELETE FROM inv.cost_pool'))).toBe(SQLSTATE.insufficientPrivilege);
    expect(
      await sqlStateOf(
        fx.app.query("INSERT INTO inv.stock_balance (product_id, location_id, branch_id, on_hand_qty, updated_at) VALUES ($1, $2, $3, 5, now())", [fx.eggs, fx.shop, fx.branchId]),
      ),
    ).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('the shape of a movement (FR-INV-002, FR-INV-024)', () => {
  it('refuses a movement whose source and destination are the same', async () => {
    expect(await sqlStateOf(move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.eggs, from: fx.store, to: fx.store, qty: '1.000' }))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses quantity 0 on SALE_ISSUE and accepts it on COST_CAPITALISE', async () => {
    await receive(fx, fx.eggs, fx.shop, '5.000', 17_500);
    expect(await refusal(sell(fx, fx.eggs, fx.shop, '0.000'))).toBe('ck_stock_movement_type');
    const { goat } = await receivedGoat('G-0101', 60_000);
    await move(fx, { type: 'COST_CAPITALISE', productId: fx.goat, unitId: goat, from: fx.virtual.CONSUMPTION, to: fx.pens, qty: '0.000', value: 8_400, costElement: 'FEED' });
    expect(await pool(fx, fx.goat, goat)).toEqual({ qty: '1.000', value: '68400' });
  });

  it('refuses a weight of 12.500 kg without its source', async () => {
    expect(
      await sqlStateOf(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.store, qty: '1.000', value: 3_500, weightKg: '12.500' })),
    ).toBe(SQLSTATE.checkViolation);
  });

  it('refuses a negative quantity by its check constraint', async () => {
    expect(await sqlStateOf(receive(fx, fx.eggs, fx.store, '-1.000', 0))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses a weight beyond NUMERIC(10,3), a negative value and a product that does not exist', async () => {
    expect(
      await sqlStateOf(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.store, qty: '1.000', value: 1, weightKg: '10000000.000', weightSource: 'SCALE' })),
    ).toBe('22003');
    expect(await sqlStateOf(receive(fx, fx.eggs, fx.store, '1.000', -1))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(receive(fx, randomUUID(), fx.store, '1.000', 1))).toBe(SQLSTATE.foreignKeyViolation);
  });

  it('refuses a movement between two virtual locations', async () => {
    expect(await refusal(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.virtual.CUSTOMER, qty: '1.000', value: 1 }))).toBe('ck_stock_movement_type');
  });

  it('refuses a mortality without its reason, and a tracked product moved without its unit', async () => {
    const { goat } = await receivedGoat('G-0102', 55_000);
    expect(await refusal(move(fx, { type: 'MORTALITY', productId: fx.goat, unitId: goat, from: fx.pens, to: fx.virtual.LOSS, qty: '1.000' }))).toBe('ck_stock_movement_type');
    expect(await refusal(move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.goat, from: fx.pens, to: fx.shop, qty: '1.000' }))).toBe('ck_stock_movement_type');
    await move(fx, { type: 'MORTALITY', productId: fx.goat, unitId: goat, from: fx.pens, to: fx.virtual.LOSS, qty: '1.000', reason: 'HEAT_STRESS' });
    const { rows } = await fx.app.query<{ status: string }>('SELECT status FROM inv.stock_unit WHERE id = $1', [goat]);
    expect(rows[0]!.status).toBe('WRITTEN_OFF');
  });

  it('refuses a receipt that carries value but names no cost element', async () => {
    expect(await refusal(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.store, qty: '1.000', value: 3_500, costElement: null }))).toBe(
      'ck_stock_movement_type',
    );
  });

  it('takes the value of an issue from the cost pool, whatever the caller sends', async () => {
    const beefLot = await lot('LOT-BEEF-2026-1113');
    await receive(fx, fx.beef, fx.coldRoom, '15.000', 495_000, beefLot);
    const issued = await sell(fx, fx.beef, fx.coldRoom, '1.500', beefLot, { value: 1, weightKg: '1.500', weightSource: 'SCALE' });
    expect(await movementValue(fx, issued)).toBe('49500');
    expect(await pool(fx, fx.beef, beefLot)).toEqual({ qty: '13.500', value: '445500' });
  });
});

describe('reversal as correction (FR-INV-004)', () => {
  it('reverses a 10.000 kg receipt once, with the same value, and returns on-hand to its prior figure', async () => {
    const beefLot = await lot('LOT-BEEF-REV');
    await receive(fx, fx.beef, fx.coldRoom, '5.000', 150_000, beefLot);
    const original = await move(fx, {
      type: 'RECEIPT_PURCHASE', productId: fx.beef, unitId: beefLot, from: fx.virtual.SUPPLIER, to: fx.coldRoom, qty: '10.000', value: 330_000, weightKg: '10.000', weightSource: 'SCALE',
    });
    const reversal = await move(fx, {
      type: 'RECEIPT_PURCHASE', productId: fx.beef, unitId: beefLot, from: fx.coldRoom, to: fx.virtual.SUPPLIER, qty: '10.000', weightKg: '10.000', weightSource: 'SCALE', reverses: original, costElement: 'PURCHASE',
    });
    expect(await movementValue(fx, reversal)).toBe('330000');
    expect(await onHand(fx, fx.beef, fx.coldRoom, beefLot)).toBe('5.000');
    expect(await pool(fx, fx.beef, beefLot)).toEqual({ qty: '5.000', value: '150000' });
    expect(
      await sqlStateOf(
        move(fx, {
          type: 'RECEIPT_PURCHASE', productId: fx.beef, unitId: beefLot, from: fx.coldRoom, to: fx.virtual.SUPPLIER, qty: '10.000', weightKg: '10.000', weightSource: 'SCALE', reverses: original, costElement: 'PURCHASE',
        }),
      ),
    ).toBe(SQLSTATE.uniqueViolation);
  });

  it('refuses a reversal that is not the exact opposite of its original, and the reversal of a reversal', async () => {
    const original = await receive(fx, fx.eggs, fx.store, '4.000', 14_000);
    expect(await refusal(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.store, to: fx.virtual.SUPPLIER, qty: '3.000', reverses: original }))).toBe('ck_stock_reversal');
    const reversal = await move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.store, to: fx.virtual.SUPPLIER, qty: '4.000', reverses: original, costElement: 'PURCHASE' });
    expect(await refusal(move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.store, qty: '4.000', reverses: reversal, costElement: 'PURCHASE' }))).toBe(
      'ck_stock_reversal',
    );
  });
});

async function lot(identifier: string): Promise<string> {
  return stockUnit(fx, { productId: fx.beef, tracking: 'LOT', identifier, producedOn: businessDay(-3), expiresOn: businessDay(4) });
}

async function receivedGoat(tag: string, value: number): Promise<{ goat: string }> {
  const goat = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: tag });
  await receive(fx, fx.goat, fx.pens, '1.000', value, goat);
  return { goat };
}
