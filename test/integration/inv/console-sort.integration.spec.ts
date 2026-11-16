import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleGet, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { createStockFixture, move, receive, stockUnit, type StockFixture } from '../../support/inventory';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The console's stock lists sorted on the server (CR-019, ADR-0054): `listStockOnHand` by `onHandQty`,
 * `listStockUnits` by `identifier` and `expiresOn`, `listStockMovements` by `occurredAt` and `valuePesewas`, each
 * through the shared keyset with its row's unique key as the tie-breaker. Each list is walked two rows a page through
 * long runs of tied quantities, identifiers, expiry dates, times and values, while stock arrives between pages, and
 * sees every original row exactly once, in the asked order. Without `sort` each answers exactly as before. A product's
 * or a location's name (MDM's) and a value at cost (computed from the cost pools) are not sortable fields; a role
 * without the list's read permission, which is also the permission that shows its cost, is refused any sort.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fx: StockFixture;
let storekeeper: TestSession;
let coldStorekeeper: TestSession;
let accountant: TestSession;
const refused: Array<[string, TestSession]> = [];
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');

const DAY_MS = 86_400_000;
/** A business date this many days from the test clock's today (Accra is UTC). */
const day = (offset: number) => new Date(clock.now().getTime() + offset * DAY_MS).toISOString().slice(0, 10);
const T1 = new Date('2026-11-13T07:00:00Z');
const T2 = new Date('2026-11-13T09:30:00Z');

/** A lot or an animal received into a physical location: its unit, its receipt movement and its balance line. */
async function arrive(productId: string, tracking: 'SERIAL' | 'LOT', identifier: string, to: string, qty: string, value: number, expiresOn: string | null, occurredAt: Date): Promise<string> {
  const unitId = await stockUnit(fx, { productId, tracking, identifier, expiresOn });
  await move(fx, { type: 'RECEIPT_PURCHASE', productId, from: fx.virtual.SUPPLIER, to, qty, value, unitId, occurredAt });
  return unitId;
}

let arrivals = 0;
/** Stock arriving between pages, tied with the originals on quantity, value, time, expiry and (case aside) identifier. */
async function between(pageNo: number): Promise<void> {
  if (pageNo >= 3) return;
  arrivals += 1;
  await arrive(fx.beef, 'LOT', `G-02${arrivals}`, fx.coldRoom, '15.000', 48_000, day(4), T1);
  await arrive(fx.goat, 'SERIAL', `g-02${arrivals}`, fx.pens, '1.000', 120_000, null, T2);
  await receive(fx, fx.eggs, fx.store, '15.000', 48_000);
}

/** Every row a list answers, `limit` at a time, keyed by `keyOf`, calling `after` between pages. */
async function walk(session: TestSession, path: string, keyOf: (row: never) => string, after: (pageNo: number) => Promise<void> = async () => undefined, limit = 2): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  const join = path.includes('?') ? '&' : '?';
  for (let pageNo = 0; pageNo < 300; pageNo += 1) {
    const response = await get(session, `${path}${join}limit=${limit}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(response.status).toBe(200);
    seen.push(...(response.body.data as never[]).map(keyOf));
    cursor = response.body.page.nextCursor as string | null;
    if (cursor === null) return seen;
    await after(pageNo);
  }
  throw new Error('the walk did not end');
}

interface OnHandLine {
  readonly location: { readonly id: string };
  readonly product: { readonly id: string };
  readonly stockUnit: { readonly id: string } | null;
  readonly onHandQty: string;
  readonly valueAtCostPesewas: number;
}
const lineKey = (row: OnHandLine) => `${row.location.id}|${row.product.id}|${row.stockUnit?.id ?? ''}`;
const idOf = (row: { readonly id: string }) => row.id;

async function sqlOrder(sql: string, among: readonly string[]): Promise<string[]> {
  const { rows } = await admin().query<{ k: string }>(sql, [among]);
  return rows.map((row) => row.k);
}

const ON_HAND_KEY = `(b.location_id::text || '|' || b.product_id::text || '|' || COALESCE(b.stock_unit_id::text, '')) COLLATE "C"`;
const onHandKeys = () => sqlOrder(`SELECT ${ON_HAND_KEY} AS k FROM inv.pub_stock_on_hand b WHERE b.on_hand_qty <> 0 AND $1::text[] IS NOT NULL`, []);
const unitIds = () => sqlOrder('SELECT id::text AS k FROM inv.stock_unit WHERE $1::text[] IS NOT NULL', []);
const movementIds = () => sqlOrder('SELECT id::text AS k FROM inv.stock_movement WHERE $1::text[] IS NOT NULL', []);

function expectWalk(seen: readonly string[], original: readonly string[], expected: readonly string[]): void {
  const before = new Set(original);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.filter((key) => before.has(key))).toEqual(expected);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  fx = await createStockFixture(database);
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId: fx.branchId }] }));
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Esi Asante', grants: [{ role: 'STOREKEEPER', branchId: fx.branchId, locationId: fx.coldRoom }] }));
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId: fx.branchId }] }), () => clock.now());
  for (const [role, name] of [
    ['CASHIER', 'Adwoa Darko'],
    ['SALES', 'Kwesi Appiah'],
    ['FARM_HAND', 'Yaw Boateng'],
    ['DRIVER', 'Kojo Annan'],
  ] as const) {
    refused.push([role, await login(api.server, await createUser(database, { name, grants: [{ role, branchId: fx.branchId }] }))]);
  }
  // Goats in the pens and beef lots in the cold room: tags and batch numbers tie case aside, quantities, values,
  // expiry dates and times tie in runs, one lot has no expiry; eggs on the shop floor and in the store.
  await arrive(fx.goat, 'SERIAL', 'G-0142', fx.pens, '1.000', 120_000, null, T2);
  await arrive(fx.goat, 'SERIAL', 'G-0157', fx.pens, '1.000', 120_000, null, T1);
  await arrive(fx.goat, 'SERIAL', 'G-0163', fx.pens, '1.000', 145_000, null, T2);
  await arrive(fx.beef, 'LOT', 'g-0142', fx.coldRoom, '15.000', 48_000, day(4), T1);
  await arrive(fx.beef, 'LOT', 'g-0157', fx.coldRoom, '15.000', 48_000, day(4), T1);
  await arrive(fx.beef, 'LOT', 'MEAT-BEEF-01', fx.coldRoom, '12.500', 40_000, day(9), T2);
  await arrive(fx.beef, 'LOT', 'MEAT-BEEF-02', fx.coldRoom, '15.000', 48_000, day(4), T2);
  await arrive(fx.beef, 'LOT', 'MEAT-BEEF-03', fx.coldRoom, '15.000', 48_000, null, T1);
  await move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.store, qty: '15.000', value: 48_000, occurredAt: T1 });
  await move(fx, { type: 'RECEIPT_PURCHASE', productId: fx.eggs, from: fx.virtual.SUPPLIER, to: fx.shop, qty: '15.000', value: 48_000, occurredAt: T1 });
  await move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.eggs, from: fx.store, to: fx.shop, qty: '3.000', occurredAt: T2 });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('listStockOnHand sorted by onHandQty (CR-019)', () => {
  it('answers in location, product and unit order without a sort, exactly as before', async () => {
    const seen = await walk(storekeeper, '/stock/on-hand', lineKey);
    expect(seen).toEqual([...(await onHandKeys())].sort());
  });

  for (const direction of ['asc', 'desc'] as const) {
    it(`pages ${direction} without skipping or repeating a line through tied quantities and stock arriving between pages`, async () => {
      const original = await onHandKeys();
      const seen = await walk(storekeeper, `/stock/on-hand?sort=onHandQty&direction=${direction}`, lineKey, between);
      const dir = direction.toUpperCase();
      const expected = await sqlOrder(
        `SELECT ${ON_HAND_KEY} AS k FROM inv.stock_balance b WHERE ${ON_HAND_KEY} = ANY($1::text[]) ORDER BY b.on_hand_qty ${dir}, ${ON_HAND_KEY} ${dir}`,
        original,
      );
      expectWalk(seen, original, expected);
    });
  }

  it('answers the same lines, values at cost and total as the unsorted list, only in another order', async () => {
    const plain = await get(storekeeper, '/stock/on-hand?limit=100');
    const sorted = await get(storekeeper, '/stock/on-hand?sort=onHandQty&direction=desc&limit=100');
    expect(sorted.status).toBe(200);
    const values = (body: { data: OnHandLine[] }) => Object.fromEntries(body.data.map((row) => [lineKey(row), [row.onHandQty, row.valueAtCostPesewas]]));
    expect(values(sorted.body)).toEqual(values(plain.body));
    expect(sorted.body.totalValueAtCostPesewas).toBe(plain.body.totalValueAtCostPesewas);
    const quantities = (sorted.body.data as OnHandLine[]).map((row) => Number(row.onHandQty));
    expect(quantities).toEqual([...quantities].sort((a, b) => b - a));
  });

  it('keeps the filters and the reader\'s scope with a sort', async () => {
    const meat = await get(storekeeper, `/stock/on-hand?sort=onHandQty&categoryId=${await categoryOf(fx.beef)}&limit=100`);
    expect(meat.status).toBe(200);
    expect(new Set((meat.body.data as OnHandLine[]).map((row) => row.product.id))).toEqual(new Set([fx.beef]));
    expect((meat.body.data as OnHandLine[])[0]!.onHandQty).toBe('12.500');
    const soon = await get(storekeeper, '/stock/on-hand?sort=onHandQty&expiringWithinDays=5&limit=100');
    expect((soon.body.data as OnHandLine[]).every((row) => row.product.id === fx.beef && row.onHandQty === '15.000')).toBe(true);
    const cold = await walk(coldStorekeeper, '/stock/on-hand?sort=onHandQty', (row: OnHandLine) => row.location.id);
    expect(cold.length).toBeGreaterThan(0);
    expect(new Set(cold)).toEqual(new Set([fx.coldRoom]));
  });
});

async function categoryOf(productId: string): Promise<string> {
  const { rows } = await admin().query<{ category_id: string }>('SELECT category_id FROM mdm.product WHERE id = $1', [productId]);
  return rows[0]!.category_id;
}

describe('listStockUnits sorted by identifier and expiresOn (CR-019)', () => {
  it('answers in id order without a sort, exactly as before', async () => {
    expect(await walk(storekeeper, '/stock-units', idOf)).toEqual([...(await unitIds())].sort());
  });

  const ORDER: Readonly<Record<string, (dir: string) => string>> = {
    identifier: (dir) => `lower(u.identifier) ${dir}, u.id ${dir}`,
    expiresOn: (dir) => `(u.expires_on IS NULL) ASC, u.expires_on ${dir}, u.id ${dir}`,
  };
  for (const field of ['identifier', 'expiresOn'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`pages by ${field} ${direction} without skipping or repeating a unit through ties and units arriving between pages`, async () => {
        const original = await unitIds();
        const seen = await walk(storekeeper, `/stock-units?sort=${field}&direction=${direction}`, idOf, between);
        const expected = await sqlOrder(`SELECT u.id::text AS k FROM inv.stock_unit u WHERE u.id::text = ANY($1::text[]) ORDER BY ${ORDER[field]!(direction.toUpperCase())}`, original);
        expectWalk(seen, original, expected);
      });
    }
  }

  it('puts the units with no expiry last in both directions', async () => {
    for (const direction of ['asc', 'desc']) {
      const response = await get(storekeeper, `/stock-units?sort=expiresOn&direction=${direction}&limit=100`);
      const dates = (response.body.data as Array<{ expiresOn: string | null }>).map((unit) => unit.expiresOn);
      const firstNull = dates.indexOf(null);
      expect(firstNull).toBeGreaterThan(0);
      expect(dates.slice(firstNull).every((date) => date === null)).toBe(true);
      expect(dates[0]).toBe(direction === 'asc' ? day(4) : day(9));
    }
  });

  it('keeps the filters and the reader\'s scope with a sort', async () => {
    const lots = await walk(storekeeper, `/stock-units?sort=identifier&tracking=LOT&productId=${fx.beef}`, (row: { tracking: string }) => row.tracking);
    expect(new Set(lots)).toEqual(new Set(['LOT']));
    const cold = await walk(coldStorekeeper, '/stock-units?sort=identifier', (row: { tracking: string }) => row.tracking);
    expect(cold.length).toBeGreaterThan(0);
    expect(new Set(cold)).toEqual(new Set(['LOT']));
  });
});

describe('listStockMovements sorted by occurredAt and valuePesewas (CR-019)', () => {
  it('answers newest first without a sort, exactly as before', async () => {
    expect(await walk(storekeeper, '/stock/movements', idOf, async () => undefined, 5)).toEqual([...(await movementIds())].sort().reverse());
  });

  const ORDER: Readonly<Record<string, string>> = { occurredAt: 'm.occurred_at', valuePesewas: 'm.value_pesewas' };
  for (const field of ['occurredAt', 'valuePesewas'] as const) {
    for (const direction of ['asc', 'desc'] as const) {
      it(`pages by ${field} ${direction} without skipping or repeating a movement through ties and movements arriving between pages`, async () => {
        const original = await movementIds();
        const seen = await walk(storekeeper, `/stock/movements?sort=${field}&direction=${direction}`, idOf, between);
        const dir = direction.toUpperCase();
        const expected = await sqlOrder(`SELECT m.id::text AS k FROM inv.stock_movement m WHERE m.id::text = ANY($1::text[]) ORDER BY ${ORDER[field]} ${dir}, m.id ${dir}`, original);
        expectWalk(seen, original, expected);
      });
    }
  }

  it('lets the Accountant, who reads movement values, sort by value, largest first', async () => {
    const response = await get(accountant, '/stock/movements?sort=valuePesewas&direction=desc&limit=3');
    expect(response.status).toBe(200);
    expect((response.body.data as Array<{ valuePesewas: number }>).map((m) => m.valuePesewas)).toEqual([145_000, 120_000, 120_000]);
  });

  it('keeps the reader\'s scope with a sort: a cold-room grant sees only movements into or out of the cold room', async () => {
    const touched = await walk(coldStorekeeper, '/stock/movements?sort=occurredAt', (row: { to: { id: string }; from: { id: string } }) =>
      [row.from.id, row.to.id].includes(fx.coldRoom) ? 'cold' : 'elsewhere',
    );
    expect(touched.length).toBeGreaterThan(0);
    expect(new Set(touched)).toEqual(new Set(['cold']));
  });
});

describe('fields that are not sortable and roles that are refused (CR-019, ADR-0052, ADR-0035)', () => {
  it('refuses a product or location name and a value at cost: another module\'s name, or a value computed from the cost pools', async () => {
    for (const path of [
      '/stock/on-hand?sort=productName',
      '/stock/on-hand?sort=locationName',
      '/stock/on-hand?sort=valueAtCostPesewas',
      '/stock-units?sort=productName',
      '/stock-units?sort=valueAtCostPesewas',
      '/stock/movements?sort=productName',
      '/stock/movements?sort=qtyBase',
      '/stock/movements?sort=occurredAt&direction=sideways',
      '/stock-units?direction=asc',
    ]) {
      const response = await get(storekeeper, path);
      expect(response.status, path).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details[0].code).toBe('SORT_NOT_ALLOWED');
    }
  });

  it('refuses a cursor from another sort or from the default order', async () => {
    const byQty = await get(storekeeper, '/stock/on-hand?sort=onHandQty&limit=2');
    const plain = await get(storekeeper, `/stock/on-hand?limit=2&cursor=${encodeURIComponent(byQty.body.page.nextCursor as string)}`);
    expect(plain.status).toBe(400);
    expect(plain.body.error.details[0].code).toBe('INVALID_CURSOR');
    const byTime = await get(storekeeper, '/stock/movements?sort=occurredAt&limit=2');
    const byValue = await get(storekeeper, `/stock/movements?sort=valuePesewas&limit=2&cursor=${encodeURIComponent(byTime.body.page.nextCursor as string)}`);
    expect(byValue.status).toBe(400);
    const unitsPlain = await get(storekeeper, '/stock-units?limit=2');
    const unitsSorted = await get(storekeeper, `/stock-units?sort=identifier&limit=2&cursor=${encodeURIComponent(unitsPlain.body.page.nextCursor as string)}`);
    expect(unitsSorted.status).toBe(400);
  });

  it('refuses every sorted read, the cost field first, to the Cashier, Sales, Farm hand and Driver (403 in the handler)', async () => {
    for (const [role, session] of refused) {
      for (const path of ['/stock/movements?sort=valuePesewas&direction=desc', '/stock/on-hand?sort=valueAtCostPesewas', '/stock/on-hand?sort=onHandQty', '/stock-units?sort=expiresOn']) {
        const response = await get(session, path);
        expect(response.status, `${role} ${path}`).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      }
    }
  });
});

/** The plan of a query with sorting and sequential scans priced out: which indexes it reads, and whether it still sorts. */
async function plan(sql: string): Promise<{ indexes: string[]; sorts: boolean }> {
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_sort = off');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`);
    await client.query('ROLLBACK');
    const text = JSON.stringify(rows[0]!['QUERY PLAN']);
    return { indexes: [...text.matchAll(/"Index Name":"([a-z_]+)"/g)].map((m) => m[1]!), sorts: /"Node Type":"(Incremental )?Sort"/.test(text) };
  } finally {
    client.release();
  }
}

describe('each stock sort field is backed by an index of migration 0121 (CR-019)', () => {
  for (const [field, from, order, index] of [
    ['onHandQty', 'inv.stock_balance b', `b.on_hand_qty {d}, ${ON_HAND_KEY} {d}`, 'ix_stock_balance_sort_on_hand'],
    ['identifier', 'inv.stock_unit u', 'lower(u.identifier) {d}, u.id {d}', 'ix_stock_unit_sort_identifier'],
    ['expiresOn', 'inv.stock_unit u', "((u.expires_on) IS NULL) ASC, COALESCE(u.expires_on, 'epoch'::date) {d}, u.id {d}", 'ix_stock_unit_sort_expiry'],
    ['occurredAt', 'inv.stock_movement m', 'm.occurred_at {d}, m.id {d}', 'ix_stock_movement_sort_occurred'],
    ['valuePesewas', 'inv.stock_movement m', 'm.value_pesewas {d}, m.id {d}', 'ix_stock_movement_sort_value'],
  ] as const) {
    it(`reads ${field} in order from ${index} within a branch, without sorting`, async () => {
      const alias = from.split(' ')[1]!;
      const live = alias === 'u' ? ' AND u.deleted_at IS NULL' : '';
      for (const dir of ['ASC', 'DESC']) {
        const found = await plan(`SELECT 1 FROM ${from} WHERE ${alias}.branch_id = '${fx.branchId}'${live} ORDER BY ${order.replaceAll('{d}', dir)} LIMIT 26`);
        // The expiry's leading "is null" key runs ascending in both directions, so descending has its own index.
        expect(found).toEqual({ indexes: [field === 'expiresOn' && dir === 'DESC' ? `${index}_desc` : index], sorts: false });
      }
    });
  }
});
