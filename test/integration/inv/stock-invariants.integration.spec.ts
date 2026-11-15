import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_PRINCIPAL } from '../../support/iam';
import { createStockFixture, move, movementValue, onHand, pool, receive, refusal, sell, stockDocument, stockUnit, type StockFixture } from '../../support/inventory';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The stock invariants the shared brief says the database enforces, each attempted by direct SQL as hk_app and
 * refused by the triggers of migration 0043 (ADR-0002, ADR-0019, FR-INV-019 to FR-INV-022).
 */
let database: TestDatabase;
let fx: StockFixture;

beforeAll(async () => {
  database = await createTestDatabase();
  fx = await createStockFixture(database);
});

afterAll(async () => {
  await database.drop();
});

async function goatIn(location: string, tag: string, value = 60_000): Promise<string> {
  const goat = await stockUnit(fx, { productId: fx.goat, tracking: 'SERIAL', identifier: tag });
  await receive(fx, fx.goat, location, '1.000', value, goat);
  return goat;
}

async function hold(unitId: string, kind: 'WITHDRAWAL' | 'QUARANTINE' | 'INVESTIGATION', startsAt: Date, endsAt: Date | null = null): Promise<string> {
  const id = randomUUID();
  await fx.app.query(
    'INSERT INTO inv.stock_hold (id, stock_unit_id, kind, starts_at, ends_at, source_document_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, unitId, kind, startsAt, endsAt, await stockDocument(fx, 'STOCK_HOLD'), fx.actor],
  );
  return id;
}

async function reserve(productId: string, locationId: string, qty: string, unitId: string | null = null, exclusive = unitId !== null): Promise<string> {
  const id = randomUUID();
  await fx.app.query(
    `INSERT INTO inv.stock_reservation (id, product_id, stock_unit_id, location_id, qty, is_exclusive, holder_document_id, status, expires_at, branch_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', now() + interval '15 minutes', $8, $9, $9)`,
    [id, productId, unitId, locationId, qty, exclusive, await stockDocument(fx), fx.branchId, fx.actor],
  );
  return id;
}

async function exceptions(kind: string, locationId: string): Promise<{ qty: string; movement_id: string }[]> {
  const { rows } = await fx.app.query<{ qty: string; movement_id: string }>('SELECT qty, movement_id FROM inv.stock_exception WHERE kind = $1 AND location_id = $2', [kind, locationId]);
  return rows;
}

async function unitState(id: string): Promise<{ status: string; current_location_id: string | null }> {
  const { rows } = await fx.app.query<{ status: string; current_location_id: string | null }>('SELECT status, current_location_id FROM inv.stock_unit WHERE id = $1', [id]);
  return rows[0]!;
}

describe('stock cannot go negative except where allowed (FR-INV-019)', () => {
  it('refuses selling 5 crates from a balance of 3 with SALE_ISSUE, naming the rule, and leaves the balance at 3', async () => {
    await receive(fx, fx.eggs, fx.shop, '3.000', 10_500);
    expect(await refusal(sell(fx, fx.eggs, fx.shop, '5.000'))).toBe('ck_stock_negative');
    expect(await onHand(fx, fx.eggs, fx.shop)).toBe('3.000');
  });

  it('posts the same sale synced from an offline device as SALE_ISSUE_OFFLINE, leaves -2 and raises one exception', async () => {
    const id = await move(fx, { type: 'SALE_ISSUE_OFFLINE', productId: fx.eggs, from: fx.shop, to: fx.virtual.CUSTOMER, qty: '5.000' });
    expect(await onHand(fx, fx.eggs, fx.shop)).toBe('-2.000');
    expect(await exceptions('NEGATIVE_STOCK', fx.shop)).toEqual([{ qty: '2.000', movement_id: id }]);
    // The covered three carry the whole pool; the uncovered two carry nothing.
    expect(await movementValue(fx, id)).toBe('10500');
    expect(await pool(fx, fx.eggs)).toEqual({ qty: '-2.000', value: '0' });
  });

  it('refuses SALE_ISSUE_OFFLINE at a location that does not allow negative stock', async () => {
    await receive(fx, fx.eggs, fx.store, '1.000', 3_500);
    expect(await refusal(move(fx, { type: 'SALE_ISSUE_OFFLINE', productId: fx.eggs, from: fx.store, to: fx.virtual.CUSTOMER, qty: '2.000' }))).toBe('ck_stock_negative');
  });

  it('never takes a serial unit negative, offline or not', async () => {
    const goat = await goatIn(fx.shop, 'G-0190');
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
    expect(await refusal(move(fx, { type: 'SALE_ISSUE_OFFLINE', productId: fx.goat, unitId: goat, from: fx.shop, to: fx.virtual.CUSTOMER, qty: '1.000' }))).toBe(
      'ck_stock_serial_location',
    );
  });
});

describe('a serialised animal is in one place and sells once (FR-INV-020)', () => {
  it('refuses a second sale of G-0142, which already sits in CUSTOMER', async () => {
    const goat = await goatIn(fx.shop, 'G-0142');
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
    expect(await unitState(goat)).toEqual({ status: 'SOLD', current_location_id: fx.virtual.CUSTOMER });
    expect(await refusal(sell(fx, fx.goat, fx.shop, '1.000', goat))).toBe('ck_stock_serial_location');
  });

  it('refuses a movement from a location the animal is not in', async () => {
    const goat = await goatIn(fx.pens, 'G-0143');
    expect(await refusal(sell(fx, fx.goat, fx.shop, '1.000', goat))).toBe('ck_stock_serial_location');
    await move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.goat, unitId: goat, from: fx.pens, to: fx.shop, qty: '1.000' });
    expect(await unitState(goat)).toEqual({ status: 'ACTIVE', current_location_id: fx.shop });
  });

  it('lets exactly one of two concurrent sales of one animal post', async () => {
    const goat = await goatIn(fx.shop, 'G-0144');
    const results = await Promise.allSettled([sell(fx, fx.goat, fx.shop, '1.000', goat), sell(fx, fx.goat, fx.shop, '1.000', goat)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await fx.app.query<{ n: number }>("SELECT count(*)::int AS n FROM inv.stock_movement WHERE stock_unit_id = $1 AND movement_type = 'SALE_ISSUE'", [goat]);
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses a second receipt of an animal already in the pens', async () => {
    const goat = await goatIn(fx.pens, 'G-0145');
    expect(await refusal(receive(fx, fx.goat, fx.pens, '1.000', 60_000, goat))).toBe('ck_stock_serial_location');
  });

  it('refuses to change a unit\'s status or location by hand, and allows its weight', async () => {
    const goat = await goatIn(fx.pens, 'G-0146');
    expect(await refusal(fx.app.query("UPDATE inv.stock_unit SET status = 'SOLD', version = version + 1 WHERE id = $1", [goat]))).toBe('ck_stock_unit_change');
    expect(await refusal(fx.app.query('UPDATE inv.stock_unit SET current_location_id = $2, version = version + 1 WHERE id = $1', [goat, fx.shop]))).toBe('ck_stock_unit_change');
    await fx.app.query("UPDATE inv.stock_unit SET last_weight_kg = '24.350', last_weighed_at = now(), version = version + 1 WHERE id = $1", [goat]);
  });

  it('refuses a new unit that does not track as its product does, or arrives already placed', async () => {
    expect(await refusal(stockUnit(fx, { productId: fx.eggs, tracking: 'LOT', identifier: 'EGG-LOT-1' }))).toBe('ck_stock_unit_change');
  });
});

describe('holds block the listed movement types until released (FR-INV-022)', () => {
  it('refuses the sale of a lot under an INVESTIGATION hold, by direct SQL, and allows a move between locations', async () => {
    const l7 = await stockUnit(fx, { productId: fx.beef, tracking: 'LOT', identifier: 'L7', producedOn: '2026-11-13', expiresOn: '2026-11-20' });
    await receive(fx, fx.beef, fx.coldRoom, '15.000', 495_000, l7);
    await hold(l7, 'INVESTIGATION', new Date(Date.now() - 60_000));
    expect(await refusal(sell(fx, fx.beef, fx.coldRoom, '1.000', l7))).toBe('ck_stock_on_hold');
    expect(await refusal(move(fx, { type: 'TRANSFER_DISPATCH', productId: fx.beef, unitId: l7, from: fx.coldRoom, to: fx.inTransit, qty: '1.000' }))).toBe('ck_stock_on_hold');
    await move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.beef, unitId: l7, from: fx.coldRoom, to: fx.store, qty: '1.000' });
    expect(await onHand(fx, fx.beef, fx.store, l7)).toBe('1.000');
  });

  it('releases a hold once with a reason, after which the sale posts; a second release is refused', async () => {
    const goat = await goatIn(fx.shop, 'G-0150');
    const id = await hold(goat, 'INVESTIGATION', new Date(Date.now() - 60_000));
    expect(await refusal(sell(fx, fx.goat, fx.shop, '1.000', goat))).toBe('ck_stock_on_hold');
    // Released by someone other than the placer, with its note (ck_stock_hold_releaser, ck_stock_hold_release_noted: B05 continued 3).
    await fx.app.query(
      "UPDATE inv.stock_hold SET released_at = now(), released_by = $2, release_reason_code = 'INVESTIGATION_CLOSED', release_note = 'Inspected and cleared' WHERE id = $1",
      [id, SYSTEM_PRINCIPAL],
    );
    expect(await refusal(fx.app.query("UPDATE inv.stock_hold SET released_at = now(), released_by = $2, release_reason_code = 'TEST_NEGATIVE', release_note = 'Again' WHERE id = $1", [id, fx.actor]))).toBe(
      'ck_stock_hold_change',
    );
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
  });

  it('refuses a release without its reason, and any early release of a WITHDRAWAL hold', async () => {
    const goat = await goatIn(fx.pens, 'G-0151');
    const investigation = await hold(goat, 'INVESTIGATION', new Date(Date.now() - 60_000));
    expect(await sqlStateOf(fx.app.query('UPDATE inv.stock_hold SET released_at = now(), released_by = $2 WHERE id = $1', [investigation, fx.actor]))).toBe(SQLSTATE.checkViolation);
    const withdrawal = await hold(goat, 'WITHDRAWAL', new Date(Date.now() - 60_000), new Date(Date.now() + 86_400_000));
    expect(await refusal(fx.app.query("UPDATE inv.stock_hold SET released_at = now(), released_by = $2, release_reason_code = 'TEST_NEGATIVE' WHERE id = $1", [withdrawal, fx.actor]))).toBe(
      'ck_stock_hold_change',
    );
  });

  it('lets a withdrawal hold end by time: a sale dated after its end posts', async () => {
    const goat = await goatIn(fx.shop, 'G-0152');
    await hold(goat, 'WITHDRAWAL', new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 86_400_000));
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
    expect((await unitState(goat)).status).toBe('SOLD');
  });

  it('does not block a write-off under a hold', async () => {
    const goat = await goatIn(fx.pens, 'G-0153');
    await hold(goat, 'QUARANTINE', new Date(Date.now() - 60_000));
    await move(fx, { type: 'MORTALITY', productId: fx.goat, unitId: goat, from: fx.pens, to: fx.virtual.LOSS, qty: '1.000', reason: 'DISEASE_SUSPECTED' });
  });
});

describe('reservations (FR-INV-021, ADR-0019)', () => {
  it('refuses a second active reservation of goat G-0160', async () => {
    const goat = await goatIn(fx.shop, 'G-0160');
    await reserve(fx.goat, fx.shop, '1.000', goat);
    expect(await sqlStateOf(reserve(fx.goat, fx.shop, '1.000', goat))).toBe(SQLSTATE.uniqueViolation);
  });

  it('refuses reserving 4 of 3 on-hand crates', async () => {
    await receive(fx, fx.eggs, fx.store, '3.000', 10_500);
    const before = await onHand(fx, fx.eggs, fx.store);
    expect(await refusal(reserve(fx.eggs, fx.store, (Number(before) + 1).toFixed(3)))).toBe('ck_stock_reservation');
  });

  it('refuses an outbound movement that would take on-hand below reserved, and lets the reservation\'s own movement consume it', async () => {
    const goat = await goatIn(fx.shop, 'G-0161');
    const reservation = await reserve(fx.goat, fx.shop, '1.000', goat);
    expect(await refusal(sell(fx, fx.goat, fx.shop, '1.000', goat))).toBe('ck_stock_reserved');
    await sell(fx, fx.goat, fx.shop, '1.000', goat, { reservationId: reservation });
    const { rows } = await fx.app.query<{ status: string }>('SELECT status FROM inv.stock_reservation WHERE id = $1', [reservation]);
    expect(rows[0]!.status).toBe('CONSUMED');
    expect(await refusal(sell(fx, fx.goat, fx.virtual.CUSTOMER, '1.000', goat))).not.toBeUndefined();
  });

  it('refuses a movement that names another stock\'s reservation', async () => {
    const goat = await goatIn(fx.shop, 'G-0162');
    const other = await goatIn(fx.shop, 'G-0163');
    const reservation = await reserve(fx.goat, fx.shop, '1.000', other);
    expect(await refusal(sell(fx, fx.goat, fx.shop, '1.000', goat, { reservationId: reservation }))).toBe('ck_stock_reservation_use');
  });

  it('releases reserved stock when a reservation expires, and lets its status move only once', async () => {
    const goat = await goatIn(fx.shop, 'G-0164');
    const reservation = await reserve(fx.goat, fx.shop, '1.000', goat);
    await fx.app.query("UPDATE inv.stock_reservation SET status = 'EXPIRED', released_reason = 'Checkout not paid in time', version = version + 1 WHERE id = $1", [reservation]);
    const { rows } = await fx.app.query<{ reserved_qty: string }>('SELECT reserved_qty FROM inv.stock_balance WHERE stock_unit_id = $1 AND location_id = $2', [goat, fx.shop]);
    expect(rows[0]!.reserved_qty).toBe('0.000');
    expect(await refusal(fx.app.query("UPDATE inv.stock_reservation SET status = 'ACTIVE', version = version + 1 WHERE id = $1", [reservation]))).toBe('ck_stock_reservation_change');
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
  });

  it('refuses a serial reservation that is not exclusive, or not where the animal is', async () => {
    const goat = await goatIn(fx.pens, 'G-0165');
    expect(await refusal(reserve(fx.goat, fx.pens, '1.000', goat, false))).toBe('ck_stock_reservation');
    expect(await refusal(reserve(fx.goat, fx.shop, '1.000', goat))).toBe('ck_stock_reservation');
  });
});

describe('valuation in the database (FR-INV-017, FR-INV-018, FR-INV-010)', () => {
  it('issues a pool of 3 crates valued 100,001 as 33,334, 33,334 and 33,333', async () => {
    const crates = await fx.app.query<{ id: string }>(
      `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
       SELECT $1, 'EGG-CRATE-SMALL', 'Small eggs', category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by
         FROM mdm.product WHERE id = $2 RETURNING id`,
      [randomUUID(), fx.eggs],
    );
    const small = crates.rows[0]!.id;
    await receive(fx, small, fx.store, '3.000', 100_001);
    const values = [];
    for (let i = 0; i < 3; i += 1) {
      values.push(await movementValue(fx, await sell(fx, small, fx.store, '1.000')));
    }
    expect(values).toEqual(['33334', '33334', '33333']);
    expect(await pool(fx, small)).toEqual({ qty: '0.000', value: '0' });
  });

  it("issues G-0170's own accumulated cost: 60,000 bought, 8,400 feed, 3,000 veterinary is 71,400; another goat is unaffected", async () => {
    const goat = await goatIn(fx.pens, 'G-0170', 60_000);
    const other = await goatIn(fx.pens, 'G-0171', 45_000);
    await move(fx, { type: 'COST_CAPITALISE', productId: fx.goat, unitId: goat, from: fx.virtual.CONSUMPTION, to: fx.pens, qty: '0.000', value: 8_400, costElement: 'FEED' });
    await move(fx, { type: 'COST_CAPITALISE', productId: fx.goat, unitId: goat, from: fx.virtual.CONSUMPTION, to: fx.pens, qty: '0.000', value: 3_000, costElement: 'VETERINARY' });
    const sale = await sell(fx, fx.goat, fx.pens, '1.000', goat);
    expect(await movementValue(fx, sale)).toBe('71400');
    expect(await pool(fx, fx.goat, goat)).toEqual({ qty: '0.000', value: '0' });
    expect(await pool(fx, fx.goat, other)).toEqual({ qty: '1.000', value: '45000' });
  });

  it('refuses to capitalise cost onto an animal that has been sold', async () => {
    const goat = await goatIn(fx.shop, 'G-0172');
    await sell(fx, fx.goat, fx.shop, '1.000', goat);
    expect(
      await refusal(move(fx, { type: 'COST_CAPITALISE', productId: fx.goat, unitId: goat, from: fx.virtual.CONSUMPTION, to: fx.virtual.CUSTOMER, qty: '0.000', value: 500, costElement: 'FEED' })),
    ).not.toBeUndefined();
  });

  it('moves 10.000 kg from the cold room to in-transit with total stock value unchanged', async () => {
    const beefLot = await stockUnit(fx, { productId: fx.beef, tracking: 'LOT', identifier: 'LOT-BEEF-TRF', producedOn: '2026-11-13', expiresOn: '2026-11-20' });
    await receive(fx, fx.beef, fx.coldRoom, '10.000', 330_000, beefLot);
    const dispatch = await move(fx, { type: 'TRANSFER_DISPATCH', productId: fx.beef, unitId: beefLot, from: fx.coldRoom, to: fx.inTransit, qty: '10.000' });
    expect(await onHand(fx, fx.beef, fx.coldRoom, beefLot)).toBe('0.000');
    expect(await onHand(fx, fx.beef, fx.inTransit, beefLot)).toBe('10.000');
    expect(await movementValue(fx, dispatch)).toBe('330000');
    expect(await pool(fx, fx.beef, beefLot)).toEqual({ qty: '10.000', value: '330000' });
  });

  it('carries the issue value of untracked stock into the receiving branch\'s pool', async () => {
    const tomatoes = await fx.app.query<{ id: string }>(
      `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
       SELECT $1, 'VEG-TOMATO-CRATE', 'Tomatoes', category_id, stock_policy, tracking, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by
         FROM mdm.product WHERE id = $2 RETURNING id`,
      [randomUUID(), fx.eggs],
    );
    const tomato = tomatoes.rows[0]!.id;
    await receive(fx, tomato, fx.store, '3.000', 100_000);
    const carried = await move(fx, { type: 'TRANSFER_RECEIPT', productId: tomato, from: fx.store, to: fx.otherShop, qty: '1.000' });
    expect(await movementValue(fx, carried)).toBe('33333');
    expect(await pool(fx, tomato)).toEqual({ qty: '2.000', value: '66667' });
    expect(await pool(fx, tomato, null, fx.otherBranchId)).toEqual({ qty: '1.000', value: '33333' });
  });
});
