import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The Storekeeper's order read (the owner, 2026-11-23, decision 6; A-335 decided, A-344; ADR-0035): an order as the
 * store reads it, at the Storekeeper's own branch: its lines, quantities and delivery details, never a payment, credit,
 * price or total, under its own permission and authorised in the application layer, never `getOrder` with fields
 * dropped. Another branch's order answers 404 as an unknown one does; the Storekeeper still cannot call `getOrder`.
 */
let database: TestDatabase;
let api: TestApp;
const sessions = new Map<string, TestSession>();
const admin = () => database.pool('admin');
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;
const view = (who: string, orderId: string) => consoleGet(api.server, sessions.get(who)!, `/v1/orders/${orderId}/fulfilment-view`);
let orderId: string;

const ORDER_KEYS = ['branchId', 'channel', 'contactName', 'contactPhone', 'customer', 'delivery', 'deliveryAddress', 'fulfilmentMode', 'fulfilments', 'id', 'lines', 'notes', 'orderNo', 'placedAt', 'status'];
const LINE_KEYS = ['estimatedWeightKg', 'fulfilledWeightKg', 'id', 'lineNo', 'lineStatus', 'product', 'qtyBackordered', 'qtyFulfilled', 'qtyOrdered', 'stockUnit', 'tolerancePercent', 'uom', 'weightSource'];
/** Every key anywhere in an answer, nested, so a money or credit field cannot hide inside an object. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : [];

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  const branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  const tema = await createBranch(database, 'TMA');
  // The seeded order with the most to hide: money paid or owed, lines, and delivery details where the seed has them.
  orderId = (
    await one(
      `SELECT o.id FROM ord.sales_order o WHERE o.branch_id = $1 AND EXISTS (SELECT 1 FROM ord.sales_order_line l WHERE l.sales_order_id = o.id)
        ORDER BY (o.delivery_address_snapshot IS NOT NULL) DESC, o.estimated_total_pesewas DESC, o.id LIMIT 1`,
      [branchId],
    )
  )['id'] as string;
  const people: [string, string, string, boolean, string?][] = [
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
    ['temaStorekeeper', 'Efua Quaye', 'STOREKEEPER', false, tema.branchId],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Esi Appiah', 'SALES', false],
    ['driver', 'Kwabena Asare', 'DRIVER', false],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
  ];
  for (const [who, name, role, privileged, at] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: at ?? branchId }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("the Storekeeper reads an order as the store does, at their own branch, with no money (the owner, 2026-11-23, A-335)", () => {
  it('answers the lines, quantities and delivery details, and nothing of payment, credit, price or total', async () => {
    const answer = await view('storekeeper', orderId);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(ORDER_KEYS);
    expect(answer.body.lines.length).toBeGreaterThan(0);
    for (const line of answer.body.lines) expect(Object.keys(line).sort()).toEqual(LINE_KEYS);
    expect(keysOf(answer.body).filter((k) => /pesewas|payment|paid|outstanding|credit|price|total|tax|currency|terms|billing|variance|discount|deposit/i.test(k))).toEqual([]);
    // The same order, as the full read gives it, does carry money: the narrower read is what hides it.
    const full = await consoleGet(api.server, sessions.get('manager')!, `/v1/orders/${orderId}`);
    expect(full.status).toBe(200);
    expect(keysOf(full.body)).toEqual(expect.arrayContaining(['paymentStatus', 'estimatedTotalPesewas', 'creditCheck', 'agreedUnitPricePesewas']));
    const stored = (await admin().query('SELECT id, line_no, qty_ordered::text AS qty, uom FROM ord.sales_order_line WHERE sales_order_id = $1 ORDER BY line_no', [orderId])).rows;
    expect(answer.body.lines.map((l: Record<string, unknown>) => [l['id'], l['lineNo'], l['qtyOrdered'], l['uom']])).toEqual(stored.map((r) => [r['id'], r['line_no'], r['qty'], r['uom']]));
    expect([answer.body.id, answer.body.orderNo, answer.body.status, answer.body.fulfilmentMode]).toEqual([full.body.id, full.body.orderNo, full.body.status, full.body.fulfilmentMode]);
    expect([answer.body.contactName, answer.body.contactPhone, answer.body.deliveryAddress, answer.body.delivery]).toEqual([full.body.contactName, full.body.contactPhone, full.body.deliveryAddress, full.body.delivery]);
  });

  it("answers 404 for another branch's order, exactly as for an id that is no order", async () => {
    const elsewhere = await view('temaStorekeeper', orderId);
    const unknown = await view('storekeeper', randomUUID());
    expect([elsewhere.status, unknown.status]).toEqual([404, 404]);
    expect(elsewhere.body.error.code).toBe(unknown.body.error.code);
  });

  it('still refuses the Storekeeper the full order read and the credit check', async () => {
    expect((await consoleGet(api.server, sessions.get('storekeeper')!, `/v1/orders/${orderId}`)).status).toBe(403);
    expect((await consoleGet(api.server, sessions.get('storekeeper')!, '/v1/orders')).status).toBe(403);
    expect((await consoleGet(api.server, sessions.get('storekeeper')!, `/v1/orders/${orderId}/credit-check`)).status).toBe(403);
  });

  it('refuses every role that does not hold it, deny by default, and answers the Manager', async () => {
    for (const who of ['cashier', 'sales', 'driver', 'accountant']) expect((await view(who, orderId)).status, who).toBe(403);
    expect((await view('manager', orderId)).status).toBe(200);
  });
});
