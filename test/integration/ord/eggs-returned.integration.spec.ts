import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SalePosting, type SaleRequest } from '../../../src/modules/ord';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { trialBalanceSum } from '../../support/pay';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { openTestShift, tillOf } from '../../support/till';

/**
 * Part of a crate returned as single eggs (the owner, 2026-11-18, FR-ORD-015, ADR-0075, A-372): refunded at the price
 * actually paid on the sale line, pro rata per egg of the crate, never the single-egg price, by the running total
 * round(paid x cumulative / 30) less round(paid x previous / 30), half-up, so the pieces always add up to what was paid
 * and never more; through BIL's credit note and PAY's refund under the return's approval by someone other than its
 * maker; the eggs into the returns hold, not sellable until inspected; never refunded twice, nor above what was sold,
 * under concurrency. Every figure is read back by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let shop: string;
let hold: string;
let eggs: string;
let eggLot: string;
const sessions = new Map<string, TestSession>();
const principals = new Map<string, string>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const till = { id: '019a8000-0000-7000-8000-0000000e9901', code: 'E1' };
/** The owner's GH₵55.00 crate (5,500 pesewas), on a new version of the base prices. */
const CRATE = 5_500n;

/** One crate of the seeded big eggs sold for cash at 5,500 at the counter: the sale's id and its crate line's id. */
async function sellCrate(crates = 1, lines = 1): Promise<{ orderId: string; lineId: string; lineIds: string[] }> {
  const uow = api.app.get(UnitOfWork);
  const sales = api.app.get(SalePosting);
  const actor: Actor = { principalId: principals.get('cashier')!, kind: 'USER', displayName: 'Adwoa Darko', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  const request: SaleRequest = {
    orderId: createUuidV7Generator(clock)(),
    channel: 'WHOLESALE',
    branchId,
    fulfilmentMode: 'COUNTER',
    taxInclusive: true,
    lines: Array.from({ length: lines }, () => ({ productId: eggs, stockUnitId: eggLot, fromLocationId: shop, quantity: `${crates}.000`, uom: 'CRATE'})),
    tenders: [{ methodCode: 'CASH', amountPesewas: CRATE * BigInt(crates * lines), register: till }],
  };
  const sold = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'eggs returned test', actor }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: sales.locksFor(branchId) }, async (tx) => sales.postIn(tx, actor, { shiftDocumentId: await openTestShift(tx, actor.principalId, request.branchId, tillOf(request)), ...request })),
  );
  const rows = (await admin().query<{ id: string }>('SELECT id FROM ord.sales_order_line WHERE sales_order_id = $1 ORDER BY line_no', [sold.id])).rows;
  return { orderId: sold.id, lineId: rows[0]!.id, lineIds: rows.map((r) => r.id) };
}

const body = (sale: { orderId: string; lineId: string }, qty: string, over: Record<string, unknown> = {}) => ({
  orderId: sale.orderId,
  kind: 'RETURN',
  reasonCode: 'RETURN_UNWANTED',
  refundDestination: 'ORIGINAL_METHOD',
  lines: [{ orderLineId: sale.lineId, qty, uom: 'EGG', disposition: 'RETURNS_HOLD', ...over }],
});

/** A return of eggs made by the cashier, submitted, and approved by the Owner. */
async function returnEggs(sale: { orderId: string; lineId: string }, qty: string): Promise<string> {
  const made = await post('cashier', '/returns', body(sale, qty));
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const submitted = await post('cashier', `/returns/${made.body.id}/submit`);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  await stepUp(api.server, as('owner') as TotpSession, clock);
  const approved = await post('owner', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Seen the eggs come back' });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return made.body.id;
}

/** What the completed returns of a sale left, by SQL: each return line's refund, the credit notes and the refunds. */
async function refundedOf(orderId: string): Promise<{ lines: string[]; credits: string; refunds: string; held: string }> {
  const lines = await admin().query<{ refund: string }>(
    `SELECT l.refund_pesewas::text AS refund FROM ord.order_return_line l JOIN ord.order_return r ON r.id = l.order_return_id
      WHERE r.sales_order_id = $1 AND r.status = 'COMPLETED' ORDER BY r.return_no`,
    [orderId],
  );
  const sums = await admin().query<{ credits: string; refunds: string; held: string }>(
    `SELECT (SELECT COALESCE(sum(b.gross_pesewas), 0)::text FROM bil.billing_document b JOIN ord.order_return r ON r.credit_note_id = b.id WHERE r.sales_order_id = $1) AS credits,
            (SELECT COALESCE(sum(f.amount_pesewas), 0)::text FROM pay.refund f JOIN ord.order_return r ON r.refund_id = f.id WHERE r.sales_order_id = $1) AS refunds,
            (SELECT COALESCE(sum(m.qty_base), 0)::numeric(14,3)::text FROM inv.stock_movement m JOIN ord.order_return r ON r.id = m.source_document_id
              WHERE r.sales_order_id = $1 AND m.to_location_id = $2) AS held`,
    [orderId, hold],
  );
  return { lines: lines.rows.map((r) => r.refund), ...sums.rows[0]! };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  shop = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).rows[0]!.id;
  hold = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND kind = 'RETURNS_HOLD'", [branchId])).rows[0]!.id;
  eggs = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'EGG-0003'")).rows[0]!.id;
  eggLot = (await admin().query<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'EGG-BIG-2026-1110'")).rows[0]!.id;
  const people: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Ama Owusu', 'MANAGER', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['storekeeper', 'Yaw Asante', 'STOREKEEPER', false],
    ['investor', 'Nana Ofori', 'INVESTOR', false],
  ];
  for (const [key, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    principals.set(key, user.principalId);
    sessions.set(key, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  // The owner's GH₵55.00 crate: a new version of the seeded base prices, made by the Manager and approved by the Owner.
  const base = (await admin().query<{ id: string }>("SELECT id FROM mdm.price_list WHERE code = 'BASE'")).rows[0]!.id;
  const version = await post('manager', `/price-lists/${base}/versions`, { validFrom: clock.now().toISOString() });
  expect(version.status, JSON.stringify(version.body)).toBe(201);
  const entries = await consolePut(api.server, as('manager'), `/v1/price-list-versions/${version.body.id}/entries`).send({
    version: version.body.version,
    entries: [
      { productId: eggs, uom: 'CRATE', basis: 'PER_UNIT', listPricePesewas: Number(CRATE), floorPricePesewas: 5_000, ceilingPricePesewas: 6_000 },
      { productId: eggs, basis: 'PER_UNIT', listPricePesewas: 220, floorPricePesewas: 200, ceilingPricePesewas: 240 },
    ],
  });
  expect(entries.status, JSON.stringify(entries.body)).toBe(200);
  const submitted = await post('manager', `/price-list-versions/${version.body.id}/submit`);
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
  await stepUp(api.server, as('owner') as TotpSession, clock);
  expect((await post('owner', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'The crate at GHS 55.00' })).status).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('part of a crate returned as single eggs is refunded pro rata at the price paid (A-372)', () => {
  it('refuses the wrong role, and a part of an egg, an egg back onto the shelf, a unit the line was not sold in, with nothing written', async () => {
    const sale = await sellCrate();
    for (const who of ['storekeeper', 'investor']) expect((await post(who, '/returns', body(sale, '5.000'))).status, who).toBe(403);
    const refused = await Promise.all([post('cashier', '/returns', body(sale, '2.500')), post('cashier', '/returns', body(sale, '5.000', { disposition: 'RESTOCK' })), post('cashier', '/returns', body(sale, '5.000', { uom: 'KG' }))]);
    expect(refused.map((r) => [r.status, r.body.error?.details?.map((d: { code: string }) => d.code)])).toEqual([
      [422, ['INEXACT_QUANTITY']],
      [422, ['PART_RETURN_TO_HOLD']],
      [422, ['UNIT_NOT_SOLD']],
    ]);
    expect((await admin().query('SELECT 1 FROM ord.order_return WHERE sales_order_id = $1', [sale.orderId])).rowCount).toBe(0);
  });

  it('refunds five eggs of a GH₵55.00 crate exactly 917 (5,500 x 5 / 30 = 916.67, half-up): the credit note, the refund and the line, into the returns hold', async () => {
    const sale = await sellCrate();
    const before = (await admin().query<{ qty: string | null }>('SELECT sum(on_hand_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [eggs, hold])).rows[0]!.qty ?? '0.000';
    const made = await post('cashier', '/returns', body(sale, '5.000'));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ status: 'REQUESTED', totalRefundPesewas: 917, lines: [{ qty: '5.000', uom: 'EGG', disposition: 'RETURNS_HOLD', refundPesewas: 917 }] });
    expect((await admin().query('SELECT uom, pieces_per_unit, refund_pesewas::text AS refund FROM ord.order_return_line WHERE order_return_id = $1', [made.body.id])).rows).toEqual([{ uom: 'EGG', pieces_per_unit: 30, refund: '917' }]);
    const submitted = await post('cashier', `/returns/${made.body.id}/submit`);
    expect(submitted.status).toBe(202);
    expect(submitted.body.summary).toContain('GHS 9.17');
    // The maker never approves their own return.
    expect((await post('cashier', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'mine' })).status).toBe(403);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    expect((await post('owner', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Seen the eggs come back' })).status).toBe(200);
    expect(await refundedOf(sale.orderId)).toEqual({ lines: ['917'], credits: '917', refunds: '917', held: '5.000' });
    const refund = (await admin().query<{ amount: string; created_by: string }>('SELECT f.amount_pesewas::text AS amount, f.created_by FROM pay.refund f JOIN ord.order_return r ON r.refund_id = f.id WHERE r.id = $1', [made.body.id])).rows;
    expect(refund).toEqual([{ amount: '917', created_by: principals.get('cashier') }]);
    const after = (await admin().query<{ qty: string }>('SELECT sum(on_hand_qty)::numeric(14,3)::text AS qty FROM inv.stock_balance WHERE product_id = $1 AND location_id = $2', [eggs, hold])).rows[0]!.qty;
    expect(Number(after) - Number(before)).toBe(5);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('refunds a crate returned one egg at a time, all 30, exactly 5,500 in total, and never a 31st egg or a crate more', async () => {
    const sale = await sellCrate();
    for (let i = 0; i < 30; i += 1) await returnEggs(sale, '1.000');
    const left = await refundedOf(sale.orderId);
    expect(left.lines.slice(0, 6)).toEqual(['183', '184', '183', '183', '184', '183']);
    expect(left.lines.reduce((a, b) => a + BigInt(b), 0n)).toBe(5_500n);
    expect(left).toMatchObject({ credits: '5500', refunds: '5500', held: '30.000' });
    const more = await post('cashier', '/returns', body(sale, '1.000'));
    expect([more.status, more.body.error.details]).toEqual([422, [expect.objectContaining({ code: 'RETURN_EXCEEDS_SOLD' })]]);
    const crate = await post('cashier', '/returns', body(sale, '1.000', { uom: 'CRATE' }));
    expect([crate.status, crate.body.error.details]).toEqual([422, [expect.objectContaining({ code: 'RETURN_EXCEEDS_SOLD' })]]);
    expect(await trialBalanceSum(database)).toBe('0');
  });

  it('takes two returns of eggs of one crate at once as one, and the database refuses a second open return of the line and eggs past the crate', async () => {
    const sale = await sellCrate(1, 2);
    const both = await Promise.all([post('cashier', '/returns', body(sale, '20.000')), post('cashier', '/returns', body(sale, '20.000'))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(both.find((r) => r.status === 422)!.body.error.details).toEqual([expect.objectContaining({ code: 'RETURN_OPEN_ON_LINE' })]);
    const first = both.find((r) => r.status === 201)!.body;
    // A second return, of the sale's other crate, still REQUESTED: straight into its lines as the application, on the first crate.
    const other = await post('cashier', '/returns', body({ orderId: sale.orderId, lineId: sale.lineIds[1]! }, '1.000'));
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const insert = async (qty: string): Promise<string | null> => {
      const client = await database.pool('app').connect();
      try {
        await client.query('BEGIN');
        await client.query("INSERT INTO ord.order_return_line (id, order_return_id, sales_order_line_id, line_no, qty, uom, pieces_per_unit, disposition) VALUES ($1, $2, $3, 2, $4, 'EGG', 30, 'RETURNS_HOLD')", [
          randomUUID(),
          other.body.id,
          sale.lineId,
          qty,
        ]);
        return null;
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? String(error);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    expect(await insert('5.000')).toBe('ck_order_return_line_open');
    const submitted = await post('cashier', `/returns/${first.id}/submit`);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    expect((await post('owner', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Seen the eggs come back' })).status).toBe(200);
    expect(await insert('11.000')).toBe('ck_order_return_line_cap');
    expect(await insert('2.500')).toBe('ck_order_return_line_pieces');
    expect(await insert('10.000')).toBeNull();
  });

  it('refunds an approved return once: two approvals of it at once leave one credit note and one refund', async () => {
    const sale = await sellCrate();
    const made = await post('cashier', '/returns', body(sale, '5.000'));
    const submitted = await post('cashier', `/returns/${made.body.id}/submit`);
    await stepUp(api.server, as('owner') as TotpSession, clock);
    const approvals = await Promise.all([1, 2].map(() => post('owner', `/iam/approvals/${submitted.body.approvalRequestId}/approve`, { reason: 'Seen the eggs come back' })));
    expect(approvals.filter((r) => r.status === 200)).toHaveLength(1);
    expect(approvals.find((r) => r.status !== 200)!.status, JSON.stringify(approvals.map((r) => r.body))).toBeGreaterThanOrEqual(409);
    expect(await refundedOf(sale.orderId)).toEqual({ lines: ['917'], credits: '917', refunds: '917', held: '5.000' });
    expect((await admin().query('SELECT 1 FROM bil.billing_document b JOIN ord.order_return r ON r.original_billing_document_id = b.original_document_id WHERE r.id = $1 AND b.kind = $2', [made.body.id, 'CREDIT_NOTE'])).rowCount).toBe(1);
  });
});
