import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The offline pack (FR-POS-010, OFFLINE_SYNC 5.1 and 5.2, B09b continued 2, CR-031, CR-032 point 6, CR-038): what a till
 * needs to sell for a shift with no network, read by the cashier from an enrolled device of the till. Each figure is
 * derived independently by SQL over MDM's entries, versions and cells, INV's stock and the seeded settings: each unit
 * priced by its own entry (a crate of the seeded eggs at 6,000 and a single egg at 220, never 220 x 30), whether its
 * prices include tax from its list, the CASH_MOVEMENT reasons the till's movements take, and the policy from
 * `platform.setting`. No cost reaches the device. Every wrong caller is refused.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const credentials = new Map<string, string>();
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;

/** The pack as the till reads it: the cashier's session and the device's credential. */
function pack(who: string, till: string, device: string | null = till) {
  const call = consoleGet(api.server, as(who), `/v1/registers/${id(`till:${till}`)}/offline-pack`);
  if (device !== null) call.set('X-Device-Credential', credentials.get(device) ?? device);
  return call;
}

interface PackUnit {
  readonly uom: string;
  readonly priceListEntryId: string | null;
  readonly priceBand: { readonly listPricePesewas: number; readonly floorPricePesewas: number; readonly ceilingPricePesewas: number; readonly basis: string } | null;
  readonly quoteOnly: boolean;
}
interface PackProduct {
  readonly product: { readonly id: string; readonly sku: string };
  readonly saleUom: string;
  readonly priceBasis: string;
  readonly priceBand: PackUnit['priceBand'];
  readonly priceListEntryId: string | null;
  readonly quoteOnly: boolean;
  readonly taxInclusive: boolean;
  readonly taxCategoryId: string;
  readonly tileCategory: string | null;
  readonly sellingUnits: readonly PackUnit[];
}

async function setSetting(key: string, value: number | boolean, branchId?: string) {
  await step('owner');
  const current = await rows<{ version: number }>('SELECT version FROM platform.setting WHERE key = $1 AND branch_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL ORDER BY valid_from DESC LIMIT 1', [key, branchId ?? null]);
  const put = await consolePut(api.server, as('owner'), `/v1/admin/settings/${key}`).send({ value, version: current[0]?.version ?? 0, ...(branchId === undefined ? {} : { branchId }) });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'tst', id FROM mdm.branch WHERE code = 'TST'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, totp] of [
    ['owner', 'Akosua Owner', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['ama', 'Ama Asante', 'CASHIER', false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['P1', 'P2']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Pack till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await step('manager');
    const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: `Pack tablet ${code}` });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credentials.set(code, enrolled.body.deviceCredential as string);
  }
  await step('manager');
  const lost = await post('manager', `/registers/${id('till:P1')}/devices`, { deviceLabel: 'Lost pack tablet' });
  credentials.set('lost', lost.body.deviceCredential as string);
  await step('manager');
  expect((await post('manager', `/devices/${lost.body.device.id as string}/revoke`, { reason: 'Left at the lorry station' })).status).toBe(200);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the offline pack a cashier reads from the till (FR-POS-010, OFFLINE_SYNC 5.1)', () => {
  it('prices a crate and a single egg of the seeded eggs each by its own entry, never one from the other (CR-038)', async () => {
    const read = await pack('ama', 'P1');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const eggs = (read.body.products as PackProduct[]).find((p) => p.product.sku === 'EGG-0003')!;
    const entry = async (uom: string | null) =>
      one<{ id: string; list: number; floor: number; ceiling: number; tax_inclusive: boolean }>(
        `SELECT e.id, e.list_price_pesewas::int AS list, e.floor_price_pesewas::int AS floor, e.ceiling_price_pesewas::int AS ceiling, l.tax_inclusive
           FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
          WHERE e.product_id = $1 AND e.uom IS NOT DISTINCT FROM $2 AND l.kind = 'BASE' AND v.status = 'ACTIVE' AND v.valid_from <= $3 AND (v.valid_to IS NULL OR v.valid_to > $3)
          ORDER BY e.min_qty LIMIT 1`,
        [id('EGG-0003'), uom, clock.now()],
      );
    const [crate, egg] = [await entry('CRATE'), await entry(null)];
    expect([crate.list, egg.list]).toEqual([6_000, 220]);
    expect(eggs.saleUom).toBe('CRATE');
    expect(eggs.sellingUnits).toEqual([
      { uom: 'CRATE', priceListEntryId: crate.id, priceBand: { listPricePesewas: 6_000, floorPricePesewas: crate.floor, ceilingPricePesewas: crate.ceiling, basis: 'PER_UNIT' }, quoteOnly: false },
      { uom: 'EGG', priceListEntryId: egg.id, priceBand: { listPricePesewas: 220, floorPricePesewas: egg.floor, ceilingPricePesewas: egg.ceiling, basis: 'PER_UNIT' }, quoteOnly: false },
    ]);
    // The product's own band and entry are its first unit's, and its tax flag is its list's (CR-031).
    expect(eggs).toMatchObject({ priceBand: eggs.sellingUnits[0]!.priceBand, priceListEntryId: crate.id, priceBasis: 'PER_UNIT', quoteOnly: false, taxInclusive: crate.tax_inclusive });
    expect(eggs.sellingUnits[1]!.priceBand!.listPricePesewas).not.toBe(Math.round(6_000 / 30));
  });

  it('prices every unit of every product by the entry it names, the first unit being the product sale unit when that is priced', async () => {
    const products = (await pack('ama', 'P1')).body.products as PackProduct[];
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.sellingUnits.length, p.product.sku).toBeGreaterThan(0);
      const facts = await one<{ sale_uom: string; base_uom: string; tax_category_id: string; category: string }>(
        'SELECT p.sale_uom, p.base_uom, p.tax_category_id, c.name AS category FROM mdm.product p JOIN mdm.category c ON c.id = p.category_id WHERE p.id = $1',
        [p.product.id],
      );
      expect([p.saleUom, p.taxCategoryId, p.tileCategory]).toEqual([facts.sale_uom, facts.tax_category_id, facts.category]);
      if (p.sellingUnits.some((u) => u.uom === facts.sale_uom)) expect(p.sellingUnits[0]!.uom).toBe(facts.sale_uom);
      for (const unit of p.sellingUnits) {
        if (unit.priceListEntryId === null) {
          expect(unit.priceBand, p.product.sku).toBeNull();
          continue;
        }
        const e = await one<{ product_id: string; uom: string | null; list: number; floor: number; ceiling: number; basis: string }>(
          'SELECT product_id, uom, list_price_pesewas::int AS list, floor_price_pesewas::int AS floor, ceiling_price_pesewas::int AS ceiling, basis FROM mdm.price_list_entry WHERE id = $1',
          [unit.priceListEntryId],
        );
        expect([e.product_id, e.uom ?? facts.base_uom], p.product.sku).toEqual([p.product.id, unit.uom]);
        expect(unit.priceBand).toEqual({ listPricePesewas: e.list, floorPricePesewas: e.floor, ceilingPricePesewas: e.ceiling, basis: e.basis });
      }
    }
    // A goat is priced by grade and weight, so the pack holds no one band for it; a cabbage, priced by the head only, has no crate.
    expect(products.find((p) => p.product.sku === 'LIV-0004')).toMatchObject({ priceBand: null, priceListEntryId: null, quoteOnly: false, priceBasis: 'PER_HEAD' });
    expect(products.find((p) => p.product.sku === 'PRD-0002')!.sellingUnits.map((u) => u.uom)).toEqual(['UNIT']);
    // Products a counter may not sell are left out.
    const unsellable = await rows<{ id: string }>("SELECT id FROM mdm.product WHERE status <> 'ACTIVE' OR deleted_at IS NOT NULL OR stock_policy = 'NON_STOCK'");
    expect(products.filter((p) => unsellable.some((u) => u.id === p.product.id))).toEqual([]);
  });

  it('names the versions, the tax cells, the stock at the till, the methods, the reasons and the policy, as the database holds them', async () => {
    const read = await pack('ama', 'P1');
    const now = clock.now();
    expect(read.body).toMatchObject({ register: { id: id('till:P1'), code: 'P1', name: 'Pack till P1' }, generatedAt: now.toISOString(), currency: 'GHS' });
    // Valid for the seeded maximum of offline hours (OFFLINE_SYNC 5.2: `pos.offline.max_hours`).
    const hours = (await one<{ value: number }>("SELECT value FROM platform.setting WHERE key = 'pos.offline.max_hours' AND branch_id IS NULL AND deleted_at IS NULL")).value;
    expect(hours).toBe(8);
    expect(read.body.validUntil).toBe(new Date(now.getTime() + hours * 3_600_000).toISOString());
    const versions = await rows<{ id: string }>(
      `SELECT v.id FROM mdm.price_list l JOIN mdm.price_list_version v ON v.price_list_id = l.id
        WHERE l.deleted_at IS NULL AND v.status = 'ACTIVE' AND v.valid_from <= $1 AND (v.valid_to IS NULL OR v.valid_to > $1)
          AND (l.branch_id IS NULL OR l.branch_id = $2) AND (l.kind = 'BASE' OR (l.kind = 'CHANNEL' AND l.channel = 'POS')) ORDER BY v.id`,
      [now, id('branch')],
    );
    expect(read.body.priceListVersionIds).toEqual(versions.map((v) => v.id));
    const scheme = await one<{ id: string; cells: number }>(
      `SELECT v.id, (SELECT count(*)::int FROM mdm.tax_category_levy c WHERE c.version_id = v.id) AS cells FROM mdm.tax_scheme_version v
        WHERE v.status = 'ACTIVE' AND v.valid_from <= $1 AND (v.valid_to IS NULL OR v.valid_to > $1)`,
      [toBusinessDate(now)],
    );
    expect([read.body.taxSchemeVersionId, read.body.taxCells.length]).toEqual([scheme.id, scheme.cells]);
    // Every animal and lot standing at the till's location with stock, by identifier, and nothing about its cost.
    const standing = await rows<{ identifier: string }>(
      `SELECT u.identifier FROM inv.stock_balance b JOIN inv.stock_unit u ON u.id = b.stock_unit_id WHERE b.location_id = $1 AND b.on_hand_qty > 0 ORDER BY u.identifier`,
      [id('shop')],
    );
    expect((read.body.stockUnits as { identifier: string }[]).map((u) => u.identifier)).toEqual(standing.map((s) => s.identifier));
    for (const unit of read.body.stockUnits as Record<string, unknown>[]) expect(Object.keys(unit).sort()).toEqual(['gradeId', 'id', 'identifier', 'lastWeightKg', 'locationId', 'productId', 'sellable']);
    expect(JSON.stringify(read.body)).not.toMatch(/cost|pool|value_?pesewas/i);
    const methods = await rows<{ id: string }>("SELECT id FROM mdm.payment_method WHERE is_enabled AND deleted_at IS NULL AND 'POS' = ANY(channels) ORDER BY code");
    expect((read.body.paymentMethods as { id: string }[]).map((m) => m.id)).toEqual(methods.map((m) => m.id));
    // The price override reasons, and the cash movement reasons the till's movements take (CR-032 point 6, A-273 (c)).
    const overrides = await rows<{ code: string }>("SELECT code FROM mdm.reason_code WHERE domain = 'PRICE_OVERRIDE' ORDER BY code");
    const reasons = read.body.reasonCodes as { code: string; domain: string; description: string }[];
    expect(reasons.filter((r) => r.domain === 'PRICE_OVERRIDE').map((r) => r.code)).toEqual(overrides.map((r) => r.code));
    expect(reasons.filter((r) => r.domain === 'CASH_MOVEMENT').map((r) => r.code)).toEqual(['FLOAT_TOP_UP', 'FUEL_PAYOUT', 'OTHER_PAYOUT', 'SAFE_DROP', 'SUPPLIER_PAYOUT']);
    expect(reasons.map((r) => r.domain).filter((d) => d !== 'PRICE_OVERRIDE' && d !== 'CASH_MOVEMENT')).toEqual([]);
    const drop = await one<{ description: string }>("SELECT description FROM mdm.reason_code WHERE code = 'SAFE_DROP'");
    expect(reasons.find((r) => r.code === 'SAFE_DROP')).toMatchObject({ description: drop.description, requiresNote: false });
    // Cash only offline by default: the methods allowed offline, without mobile money while the setting is off.
    const offline = await rows<{ id: string }>("SELECT id FROM mdm.payment_method WHERE is_enabled AND deleted_at IS NULL AND allowed_offline AND 'POS' = ANY(channels) ORDER BY code");
    expect(read.body.policy).toEqual({ maxOfflineHours: 8, maxQueuedSales: 500, offlineTenderMethodIds: offline.map((m) => m.id), priceOverrideLimitPerLinePesewas: 0, priceOverrideLimitPerShiftPesewas: 0 });
    expect(read.body.policy.offlineTenderMethodIds).toEqual([id('CASH')]);
    expect(await one('SELECT count(*)::int AS n FROM iam.role_limit', [])).toEqual({ n: 0 });
  });

  it('audits each issue with the device and the versions it was given', async () => {
    const before = (await one<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'ISSUE_OFFLINE_PACK'")).n;
    const read = await pack('ama', 'P2');
    expect(read.status).toBe(200);
    const audited = await rows<{ actor_id: string; entity_id: string; after: { deviceId: string; priceListVersionIds: string[]; taxSchemeVersionId: string } }>(
      "SELECT actor_id, entity_id, convert_from(after, 'UTF8')::jsonb AS after FROM platform.audit_event WHERE action = 'ISSUE_OFFLINE_PACK' ORDER BY occurred_at DESC, id DESC LIMIT 1",
    );
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'ISSUE_OFFLINE_PACK'")).n).toBe(before + 1);
    const device = await one<{ id: string }>("SELECT id FROM pos.device_enrolment WHERE device_label = 'Pack tablet P2'");
    expect(audited[0]).toMatchObject({ entity_id: id('till:P2'), after: { deviceId: device.id, priceListVersionIds: read.body.priceListVersionIds, taxSchemeVersionId: read.body.taxSchemeVersionId } });
  });
});

describe('the policy follows the settings the owner changes (OFFLINE_SYNC 5.2)', () => {
  it('shortens the window and the queue for the branch, and offers mobile money only when the branch allows it', async () => {
    await setSetting('pos.offline.max_hours', 4, id('branch'));
    await setSetting('pos.offline.max_queued_sales', 200, id('branch'));
    await setSetting('pos.offline.allow_unverified_mobile_money', true, id('branch'));
    clock.advanceBy(31_000);
    const read = await pack('ama', 'P1');
    expect(read.body.validUntil).toBe(new Date(clock.now().getTime() + 4 * 3_600_000).toISOString());
    expect(read.body.policy).toMatchObject({ maxOfflineHours: 4, maxQueuedSales: 200 });
    expect(read.body.policy.offlineTenderMethodIds).toEqual([id('CASH'), id('MOMO')]);
    await setSetting('pos.offline.allow_unverified_mobile_money', false, id('branch'));
    clock.advanceBy(31_000);
    expect((await pack('ama', 'P1')).body.policy.offlineTenderMethodIds).toEqual([id('CASH')]);
  });

  it('refuses a setting looser than the documented bound', async () => {
    await step('owner');
    const looser = await consolePut(api.server, as('owner'), '/v1/admin/settings/pos.offline.max_hours').send({ value: 9, version: 0 + 1 });
    expect([looser.status, looser.body.error?.code]).toEqual([422, 'SETTING_INVALID']);
  });

  it('judges a till time by the tolerance the owner set, read from the setting', async () => {
    await setSetting('sync.clock_tolerance_seconds', 60);
    clock.advanceBy(31_000);
    const shift = nextId();
    const opened = await post('ama', '/shifts', { id: shift, registerId: id('till:P1'), openingFloatPesewas: 0, openedAt: new Date(clock.now().getTime() - 120_000).toISOString() }, shift);
    expect([opened.status, opened.body.error?.details?.[0]?.code]).toEqual([422, 'OPENED_AT_OUT_OF_WINDOW']);
    const again = nextId();
    expect((await post('ama', '/shifts', { id: again, registerId: id('till:P1'), openingFloatPesewas: 0, openedAt: new Date(clock.now().getTime() - 59_000).toISOString() }, again)).status).toBe(201);
  });
});

describe('who may read the pack', () => {
  it('refuses a wrong role, no device, an unknown or revoked device, another till device and an anonymous caller', async () => {
    expect((await pack('storekeeper', 'P1')).status).toBe(403);
    expect((await pack('accountant', 'P1')).status).toBe(403);
    expect([(await pack('ama', 'P1', null)).body.error.code]).toEqual(['DEVICE_CREDENTIAL_INVALID']);
    expect((await pack('ama', 'P1', null)).status).toBe(401);
    expect((await pack('ama', 'P1', 'hkdev_P1.not-a-real-credential')).status).toBe(401);
    const revoked = await pack('ama', 'P1', 'lost');
    expect([revoked.status, revoked.body.error.code]).toEqual([403, 'DEVICE_REVOKED']);
    expect((await pack('ama', 'P1', 'P2')).status).toBe(403);
    const anonymous = await request(api.server).get(`/v1/registers/${id('till:P1')}/offline-pack`).set('X-Device-Credential', credentials.get('P1')!);
    expect(anonymous.status).toBe(401);
  });

  it('answers a till that names nothing 404, with nothing but the error (another branch is the identifier walk)', async () => {
    const unknown = await consoleGet(api.server, as('ama'), `/v1/registers/${randomUUID()}/offline-pack`).set('X-Device-Credential', credentials.get('P1')!);
    expect([unknown.status, unknown.body.error.code, Object.keys(unknown.body)]).toEqual([404, 'NOT_FOUND', ['error']]);
  });
});
