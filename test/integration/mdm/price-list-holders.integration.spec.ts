import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * CR-041 (owner, 2026-11-17, F10f): who holds a buyer's price list. getCustomerPriceList answers the buyer's assignments
 * in force now or later and listPriceListAssignments the buyers who hold a list, each asserted against the rows of
 * `mdm.customer_price_list` straight from SQL; every price list entry names the unit `minQtyBase` is in.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const sessions = new Map<string, TestSession>();
const admin = () => database.pool('admin');
const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);
const one = async (sql: string, values: unknown[] = []) => (await admin().query(sql, values)).rows[0]!;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await one("SELECT id FROM mdm.branch WHERE code = 'DDW'"))['id'] as string;
  for (const [who, role, privileged] of [['owner', 'OWNER', true], ['sales', 'SALES', false], ['farmhand', 'FARM_HAND', false]] as const) {
    const user = await createUser(database, { name: `${who} (TEST)`, grants: [{ role, branchId }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('who holds a price list (CR-041)', () => {
  it("answers the caterers' contract list, and a later window beside the current one once it is assigned", async () => {
    const caterers = (await one("SELECT id FROM mdm.customer WHERE customer_no = 'C-00004'"))['id'] as string;
    const list = (await one("SELECT id FROM mdm.price_list WHERE code = 'CATERERS-2026'"))['id'] as string;
    const first = await get('sales', `/customers/${caterers}/price-list`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const rows = await admin().query<{ valid_from: Date; valid_to: Date | null }>('SELECT valid_from, valid_to FROM mdm.customer_price_list WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY valid_from', [caterers]);
    expect(first.body.data.map((a: Record<string, unknown>) => [a['customerId'], (a['priceList'] as Record<string, unknown>)['code'], a['validFrom'], a['validTo']])).toEqual(
      rows.rows.map((r) => [caterers, 'CATERERS-2026', r.valid_from.toISOString(), r.valid_to?.toISOString() ?? null]),
    );

    const later = new Date(clock.now().getTime() + 10 * 86_400_000);
    const assigned = await consolePut(api.server, sessions.get('owner')!, `/v1/customers/${caterers}/price-list`).send({ priceListId: list, validFrom: later.toISOString() });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const both = await get('sales', `/customers/${caterers}/price-list`);
    expect(both.body.data.map((a: Record<string, unknown>) => [a['validFrom'], a['validTo']])).toEqual([
      [rows.rows[0]!.valid_from.toISOString(), later.toISOString()],
      [later.toISOString(), null],
    ]);

    const holders = await get('owner', `/price-lists/${list}/assignments`);
    expect(holders.status, JSON.stringify(holders.body)).toBe(200);
    const truth = await admin().query<{ id: string }>('SELECT a.id FROM mdm.customer_price_list a WHERE a.price_list_id = $1 AND a.deleted_at IS NULL AND (a.valid_to IS NULL OR a.valid_to > $2) ORDER BY a.id', [list, clock.now()]);
    expect(holders.body.data.map((h: Record<string, unknown>) => h['id'])).toEqual(truth.rows.map((r) => r.id));
    expect(holders.body.data.map((h: Record<string, Record<string, unknown>>) => h['customer']!['name'])).toEqual(['Accra Event Caterers (SEED)', 'Accra Event Caterers (SEED)']);
  });

  it('answers a buyer with no list of its own with no rows, and an unknown customer or list 404', async () => {
    const tema = (await one("SELECT id FROM mdm.customer WHERE customer_no = 'C-00002'"))['id'] as string;
    expect((await get('sales', `/customers/${tema}/price-list`)).body).toEqual({ data: [] });
    expect((await get('sales', `/customers/${randomUUID()}/price-list`)).status).toBe(404);
    expect((await get('owner', `/price-lists/${randomUUID()}/assignments`)).status).toBe(404);
  });

  it('refuses the wrong role', async () => {
    const caterers = (await one("SELECT id FROM mdm.customer WHERE customer_no = 'C-00004'"))['id'] as string;
    const list = (await one("SELECT id FROM mdm.price_list WHERE code = 'CATERERS-2026'"))['id'] as string;
    expect((await get('farmhand', `/customers/${caterers}/price-list`)).status).toBe(403);
    expect((await get('farmhand', `/price-lists/${list}/assignments`)).status).toBe(403);
  });

  it("names the base unit of every entry: a crate of eggs breaks in EGG, a goat's in HEAD", async () => {
    const version = (await one("SELECT v.id FROM mdm.price_list_version v JOIN mdm.price_list l ON l.id = v.price_list_id WHERE l.code = 'BASE' AND v.status = 'ACTIVE' ORDER BY v.valid_from DESC LIMIT 1"))['id'] as string;
    const entries = await get('owner', `/price-list-versions/${version}/entries?limit=100`);
    expect(entries.status, JSON.stringify(entries.body)).toBe(200);
    const pick = (sku: string, uom: string) => entries.body.data.find((e: Record<string, Record<string, unknown> & string>) => (e['product'] as unknown as Record<string, unknown>)['sku'] === sku && e['uom'] === uom);
    expect([pick('EGG-0003', 'CRATE')?.baseUom, pick('EGG-0003', 'EGG')?.baseUom, pick('LIV-0004', 'HEAD')?.baseUom]).toEqual(['EGG', 'EGG', 'HEAD']);
  });
});
