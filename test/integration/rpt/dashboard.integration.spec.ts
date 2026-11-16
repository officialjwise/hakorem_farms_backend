import { randomUUID } from 'node:crypto';
import { ManualClock, Money, Quantity, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/modules/rpt/domain/dashboard';
import { PgDashboardStore } from '../../../src/modules/rpt/infrastructure/pg-dashboard-store';
import type { Transaction } from '../../../src/platform/database/unit-of-work';
import { SEED_HAND_COUNT, SEED_RECEIPTS, SEED_REORDER_RULES, SEED_STOCK_RECEIVED_AT } from '../../../src/seed/farm-inv';
import { SEED_STORE_RECEIPT } from '../../../src/seed/farm-liv';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, type TotpSession } from '../../support/fin';
import { consoleGet, CookieJar, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B05x gate for the dashboard (FR-RPT-001, NFR-023, A-149): getOwnerDashboard answers in one request, its
 * sourceless figures null and listed with their reasons and phases; every tile whose data exists answers exactly on the
 * seeded farm, alone and inside the dashboard: stock value at cost equal to listStockOnHand's total, animals equal to a
 * hand count of serialised live stock units, low stock equal to the products at or below their reorder point, and the
 * purchases series equal to posted goods receipts at cost per day. Each operation refuses the wrong role and is
 * scoped to the reader's grants; the figures come from published views only, as the reporting role reads them.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let manager: TestSession;
let accountant: TotpSession;
let testBranchOwner: TestSession;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const SEED_DAY = toBusinessDate(SEED_STOCK_RECEIVED_AT);

/** The hand counts, written out from the seed's own receipts and rules rather than read back from the database. */
const PURCHASES_ON_SEED_DAY = Money.sum(
  [...SEED_RECEIPTS.filter((r) => r.kind === 'PURCHASE').flatMap((r) => r.lines), ...SEED_STORE_RECEIPT.lines].map((l) => Money.ofPesewas(l.valuePesewas)),
).toJsonInteger();
// The INV seed's four purchase receipts, and the LIV seed's delivery to the store (B06 continued 2).
const PURCHASE_RECEIPTS = [...SEED_RECEIPTS.filter((r) => r.kind === 'PURCHASE'), SEED_STORE_RECEIPT].length;
const TAGGED_ANIMALS = { GOAT: 4, SHEEP: 2 };

const PENDING = [
  'salesTodayPesewas',
  'salesYesterdayPesewas',
  'salesMonthToDatePesewas',
  'salesByChannel',
  'salesSeries',
  'topMovers',
  'alerts',
  'exceptionsToday',
];
const TILES = ['/dashboard/tiles/stock-value', '/dashboard/tiles/animals-on-hand', '/dashboard/tiles/low-stock', '/dashboard/tiles/purchases', '/dashboard/tiles/cash-position'];
const NO_CASH = { tillsPesewas: 0, safePesewas: 0, driversPesewas: 0, bankPesewas: 0, mobileMoneyPesewas: 0, totalPesewas: 0, negativeFigures: [] };

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (await database.pool('admin').query<{ code: string; id: string }>("SELECT 'branch:' || code AS code, id FROM mdm.branch")).rows) {
    ids.set(row.code, row.id);
  }
  const branchId = id('branch:DDW');
  const now = () => clock.now();
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), now);
  testBranchOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Asare', grants: [{ role: 'OWNER', branchId: id('branch:TST') }] }), now);
  for (const role of ['STOREKEEPER', 'CASHIER', 'SALES', 'DRIVER', 'FARM_HAND'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B05x gate: getOwnerDashboard answers in one request', () => {
  it('composes every live figure exactly on the seeded farm and leaves each sourceless figure null, listed with its reason and phase', async () => {
    const response = await get(owner, `/dashboard/owner?date=${SEED_DAY}`);
    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown> & { pendingFigures: Array<{ figure: string; source: string; reason: string; phase: string }> };
    expect(body).toMatchObject({
      date: SEED_DAY,
      branchId: null,
      branchIds: [id('branch:DDW')],
      stockValueAtCostPesewas: SEED_HAND_COUNT.totalValueAtCostPesewas,
      lowStockCount: 1,
      // The seeded billing documents on 1200 (B08 continued 2): the invoice 124,489 and the walk-in receipt 18,500,
      // less the credit note 36,000, plus the debit note 2,400; nothing is due before today.
      receivablesOutstandingPesewas: 109_389,
      receivablesOverduePesewas: 0,
      currency: 'GHS',
      animalsOnHand: { total: 6, bySpecies: [{ species: { code: 'GOAT', name: expect.any(String) }, count: 4 }, { species: { code: 'SHEEP' }, count: 2 }] },
    });
    expect(body.asOf).toBe(clock.now().toISOString());
    expect(body.pendingFigures.map((f) => f.figure)).toEqual(PENDING);
    expect(Object.fromEntries(body.pendingFigures.map((f) => [f.figure, f.phase]))).toMatchObject({ salesTodayPesewas: 'B9a', topMovers: 'B9a', exceptionsToday: 'B12' });
    // The seeded trading day moves no cash: every cash account is at nil, from the ledger (B08 continued 1c).
    expect(body.cash).toEqual(NO_CASH);
    expect(body.pendingFigures.every((f) => f.reason.length > 20 && /^[a-z]{3}$/.test(f.source))).toBe(true);
    for (const figure of PENDING) expect(body[figure], figure).toBeNull();
    for (const [figure, value] of Object.entries(body)) if (![...PENDING, 'branchId'].includes(figure)) expect(value, figure).not.toBeNull();
  });

  it('carries the week of purchases ending on its date: posted purchase receipts at cost on the day the goods came', async () => {
    const response = await get(owner, `/dashboard/owner?date=${SEED_DAY}`);
    const purchases = response.body.purchases as { from: string; to: string; points: Array<{ date: string; valueAtCostPesewas: number; receiptCount: number }>; totalPesewas: number; receiptCount: number };
    expect(purchases.to).toBe(SEED_DAY);
    expect(purchases.points).toHaveLength(7);
    expect(purchases.points.find((p) => p.date === SEED_DAY)).toEqual({ date: SEED_DAY, valueAtCostPesewas: 1_729_001, receiptCount: 5 });
    expect(purchases.points.filter((p) => p.date !== SEED_DAY).every((p) => p.valueAtCostPesewas === 0 && p.receiptCount === 0)).toBe(true);
    expect([purchases.totalPesewas, purchases.receiptCount]).toEqual([PURCHASES_ON_SEED_DAY, PURCHASE_RECEIPTS]);
  });

  it("states purchases on its date and the day before, and reaches back a month with period=MONTH (CR-013)", async () => {
    const onSeedDay = (await get(owner, `/dashboard/owner?date=${SEED_DAY}`)).body;
    expect([onSeedDay.purchasesTodayPesewas, onSeedDay.purchasesYesterdayPesewas]).toEqual([PURCHASES_ON_SEED_DAY, 0]);
    const dayAfter = (await get(owner, `/dashboard/owner?date=${addDays(SEED_DAY, 1)}&period=MONTH`)).body;
    expect([dayAfter.purchasesTodayPesewas, dayAfter.purchasesYesterdayPesewas]).toEqual([0, PURCHASES_ON_SEED_DAY]);
    expect(dayAfter.purchases.points).toHaveLength(30);
    expect(dayAfter.purchases).toMatchObject({ from: addDays(SEED_DAY, -28), to: addDays(SEED_DAY, 1), totalPesewas: PURCHASES_ON_SEED_DAY, receiptCount: 5 });
    expect((await get(owner, '/dashboard/owner?period=YEAR')).status).toBe(400);
  });

  it('refuses a date after today with REPORT_PERIOD_INVALID', async () => {
    const tomorrow = addDays(toBusinessDate(clock.now()), 1);
    const response = await get(owner, `/dashboard/owner?date=${tomorrow}`);
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({ code: 'REPORT_PERIOD_INVALID', details: [{ field: '/date', code: 'IN_THE_FUTURE' }], correlationId: expect.any(String) });
  });
});

describe('B05x gate: each tile answers alone, with the dashboard value and the module of record', () => {
  it('values stock at cost exactly as listStockOnHand totals it, GHS 17,895.01', async () => {
    const tile = await get(manager, '/dashboard/tiles/stock-value');
    expect(tile.status).toBe(200);
    const onHand = await get(manager, `/stock/on-hand?branchId=${id('branch:DDW')}&limit=1`);
    expect(tile.body).toEqual({ branchIds: [id('branch:DDW')], stockValueAtCostPesewas: onHand.body.totalValueAtCostPesewas, currency: 'GHS', asOf: clock.now().toISOString() });
    expect(tile.body.stockValueAtCostPesewas).toBe(1_789_501);
  });

  it('counts the serialised live animals on hand by species as a person counts the tags in the pens', async () => {
    const tile = await get(manager, '/dashboard/tiles/animals-on-hand');
    expect(tile.status).toBe(200);
    const bySpecies = (tile.body.animalsOnHand.bySpecies as Array<{ species: { code: string }; count: number }>).map((s) => [s.species.code, s.count]);
    expect(Object.fromEntries(bySpecies)).toEqual(TAGGED_ANIMALS);
    expect(tile.body.animalsOnHand.total).toBe(SEED_RECEIPTS.flatMap((r) => r.lines.flatMap((l) => l.tags ?? [])).length);
  });

  it('counts the products at or below their reorder point: the eggs, at 30 crates against a point of 30', async () => {
    const tile = await get(accountant, '/dashboard/tiles/low-stock');
    expect(tile.status).toBe(200);
    const atPoint = SEED_REORDER_RULES.filter((rule) => SEED_HAND_COUNT.lines.some((l) => l.sku === rule.sku && Quantity.parse(l.onHand).thousandths <= Quantity.parse(rule.reorderPointQty).thousandths));
    expect(atPoint.map((r) => r.sku)).toEqual(['EGG-CRATE-BIG']);
    expect(tile.body).toMatchObject({ branchIds: [id('branch:DDW')], lowStockCount: atPoint.length });
  });

  it('sums posted purchase receipts at cost per day, a zero for each day without one, and leaves the harvest out', async () => {
    const tile = await get(manager, `/dashboard/tiles/purchases?from=2026-11-09&to=2026-11-11`);
    expect(tile.status).toBe(200);
    expect(tile.body).toMatchObject({
      branchIds: [id('branch:DDW')],
      currency: 'GHS',
      purchases: {
        from: '2026-11-09',
        to: '2026-11-11',
        points: [
          { date: '2026-11-09', valueAtCostPesewas: 0, receiptCount: 0 },
          { date: SEED_DAY, valueAtCostPesewas: PURCHASES_ON_SEED_DAY, receiptCount: 5 },
          { date: '2026-11-11', valueAtCostPesewas: 0, receiptCount: 0 },
        ],
        totalPesewas: 1_729_001,
        receiptCount: 5,
      },
    });
  });

  it('defaults to the 30 days ending today, and refuses a period that is too long, reversed or in the future', async () => {
    const today = toBusinessDate(clock.now());
    const tile = await get(manager, '/dashboard/tiles/purchases');
    expect(tile.body.purchases.to).toBe(today);
    expect(tile.body.purchases.points).toHaveLength(30);
    for (const [query, rule] of [
      ['from=2026-01-01&to=2026-11-10', 'PERIOD_TOO_LONG'],
      ['from=2026-11-11&to=2026-11-10', 'FROM_AFTER_TO'],
      [`from=2026-11-01&to=${addDays(toBusinessDate(clock.now()), 1)}`, 'IN_THE_FUTURE'],
    ] as const) {
      const refused = await get(manager, `/dashboard/tiles/purchases?${query}`);
      expect(refused.status, query).toBe(422);
      expect(refused.body.error.code).toBe('REPORT_PERIOD_INVALID');
      expect(refused.body.error.details[0].code).toBe(rule);
    }
    expect((await get(manager, '/dashboard/tiles/purchases?from=nonsense')).status).toBe(400);
    expect((await get(manager, '/dashboard/tiles/stock-value?location=x')).status).toBe(400);
  });

  it('answers the same figures in the dashboard as in the tiles', async () => {
    const dashboard = (await get(owner, `/dashboard/owner?date=${SEED_DAY}`)).body;
    expect((await get(owner, '/dashboard/tiles/stock-value')).body.stockValueAtCostPesewas).toBe(dashboard.stockValueAtCostPesewas);
    expect((await get(owner, '/dashboard/tiles/animals-on-hand')).body.animalsOnHand).toEqual(dashboard.animalsOnHand);
    expect((await get(owner, '/dashboard/tiles/low-stock')).body.lowStockCount).toBe(dashboard.lowStockCount);
    expect((await get(owner, `/dashboard/tiles/purchases?from=${dashboard.purchases.from}&to=${dashboard.purchases.to}`)).body.purchases).toEqual(dashboard.purchases);
  });

  it('answers the receivables tile with the dashboard\'s figures (B08 continued 2)', async () => {
    const dashboard = (await get(owner, `/dashboard/owner?date=${SEED_DAY}`)).body;
    expect((await get(owner, '/dashboard/tiles/receivables')).body).toMatchObject({ outstandingPesewas: dashboard.receivablesOutstandingPesewas, overduePesewas: dashboard.receivablesOverduePesewas });
  });

  it('serves no tile for a figure without a source: today and the sales series are the mock\'s alone', async () => {
    for (const path of ['/dashboard/tiles/sales-today', '/dashboard/tiles/sales']) {
      expect((await get(owner, path)).status, path).toBe(404);
    }
  });
});

describe('B05x gate: the dashboard is scoped to the grants and refuses the wrong role', () => {
  it('covers only the branches the reader holds the permission at, and answers a branch with nothing in it with exact zeros', async () => {
    const elsewhere = await get(testBranchOwner, `/dashboard/owner?date=${SEED_DAY}`);
    expect(elsewhere.body).toMatchObject({ branchIds: [id('branch:TST')], stockValueAtCostPesewas: 0, lowStockCount: 0, animalsOnHand: { total: 0, bySpecies: [] } });
    expect(elsewhere.body.purchases.totalPesewas).toBe(0);
    const asked = await get(owner, `/dashboard/owner?date=${SEED_DAY}&branchId=${id('branch:DDW')}`);
    expect(asked.body).toMatchObject({ branchId: id('branch:DDW'), branchIds: [id('branch:DDW')], stockValueAtCostPesewas: 1_789_501 });
  });

  it('refuses a branch outside the grants, an unknown branch included', async () => {
    expect((await get(testBranchOwner, `/dashboard/owner?branchId=${id('branch:DDW')}`)).status).toBe(403);
    expect((await get(manager, `/dashboard/tiles/stock-value?branchId=${id('branch:TST')}`)).status).toBe(403);
    expect((await get(manager, `/dashboard/tiles/low-stock?branchId=${randomUUID()}`)).status).toBe(403);
  });

  it('refuses the owner dashboard to everyone but the Owner, and every tile to the Storekeeper, Cashier, Sales, Driver and Farm hand', async () => {
    for (const session of [manager, accountant, ...wrong.values()]) {
      const refused = await get(session, '/dashboard/owner');
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    for (const [role, session] of wrong) {
      for (const path of TILES) expect((await get(session, path)).status, `${role} ${path}`).toBe(403);
    }
    expect((await consoleGet(api.server, { jar: new CookieJar(), csrfToken: '', sessionId: '' }, '/v1/dashboard/owner')).status).toBe(401);
  });
});

describe('the cash figure answers from the ledger (B08 continued 1c, A-196)', () => {
  const GCB = 'GCB current account (SEED)';
  const MTN = 'MTN MoMo merchant wallet (SEED)';

  it('buckets the cash and bank accounts 1000 to 1130 exactly as journals posted them, an overdrawn wallet listed as negative', async () => {
    const ledger = await ledgerIds(database);
    const people = { maker: accountant, checker: owner };
    await postManualJournal(api.server, clock, people, {
      kind: 'OPENING',
      postingDate: SEED_DAY,
      description: 'Opening balances: safe, GCB, MTN wallet and an uncleared cheque',
      lines: [
        { accountId: ledger.account('1010'), side: 'D', amountPesewas: 900_000 },
        { accountId: ledger.account('1100'), side: 'D', amountPesewas: 625_030, subledgerPartyId: ledger.bankParty(GCB) },
        { accountId: ledger.account('1110'), side: 'D', amountPesewas: 139_440, subledgerPartyId: ledger.bankParty(MTN) },
        { accountId: ledger.account('1130'), side: 'D', amountPesewas: 50_000 },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 1_714_470 },
      ],
    });
    await postManualJournal(api.server, clock, people, {
      postingDate: SEED_DAY,
      description: 'Office rent paid from the MTN wallet',
      lines: [
        { accountId: ledger.account('6800'), side: 'D', amountPesewas: 200_000 },
        { accountId: ledger.account('1110'), side: 'C', amountPesewas: 200_000, subledgerPartyId: ledger.bankParty(MTN) },
      ],
    });
    const expected = { tillsPesewas: 0, safePesewas: 900_000, driversPesewas: 0, bankPesewas: 675_030, mobileMoneyPesewas: 60_560, totalPesewas: 1_514_470, negativeFigures: ['mobileMoneyPesewas'] };
    // Independently of the view: every line on accounts 1000 to 1130, debits less credits.
    const { rows } = await database.pool('admin').query<{ total: string }>(
      `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS total
         FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code BETWEEN '1000' AND '1130'`,
    );
    expect(BigInt(rows[0]!.total)).toBe(1_514_470n);
    for (const session of [owner, manager, accountant]) {
      const tile = await get(session, '/dashboard/tiles/cash-position');
      expect(tile.status).toBe(200);
      expect(tile.body).toEqual({ branchIds: [id('branch:DDW')], cash: expected, currency: 'GHS', asOf: clock.now().toISOString() });
    }
    expect((await get(owner, `/dashboard/owner?date=${SEED_DAY}`)).body.cash).toEqual(expected);
    expect((await get(testBranchOwner, '/dashboard/tiles/cash-position')).body.cash).toEqual(NO_CASH);
    expect((await get(owner, `/dashboard/tiles/cash-position?branchId=${id('branch:DDW')}`)).body.cash).toEqual(expected);
    expect((await get(manager, `/dashboard/tiles/cash-position?branchId=${id('branch:TST')}`)).status).toBe(403);
  });
});

describe('the dashboard reads published views only (ADR-0011, ADR-0023)', () => {
  it('answers every figure on a connection as the reporting role, which can read no module table', async () => {
    const client = await database.pool('report').connect();
    try {
      const tx = client as unknown as Transaction;
      const store = new PgDashboardStore();
      const branchIds = [id('branch:DDW')];
      expect(await store.stockValueAtCost(tx, branchIds)).toBe(1_789_501n);
      expect((await store.animalsOnHand(tx, branchIds)).map((r) => [r.code, r.count]).sort()).toEqual([['GOAT', 4], ['SHEEP', 2]]);
      expect(await store.lowStockProducts(tx, branchIds)).toBe(1);
      expect(await store.purchasesByDay(tx, branchIds, { from: SEED_DAY, to: SEED_DAY })).toEqual([{ date: SEED_DAY, valuePesewas: 1_729_001n, count: 5 }]);
      expect(await store.cashBalances(tx, branchIds)).toEqual([
        { code: '1010', balance: 900_000n },
        { code: '1100', balance: 625_030n },
        { code: '1110', balance: -60_560n },
        { code: '1130', balance: 50_000n },
      ]);
      await expect(client.query('SELECT 1 FROM fin.journal_line LIMIT 1')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT 1 FROM inv.cost_pool LIMIT 1')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT 1 FROM mdm.product LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });
});
