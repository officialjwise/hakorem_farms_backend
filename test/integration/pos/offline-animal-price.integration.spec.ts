import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale, type TillLine } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Each animal's own price in the offline pack, and an animal whose weight changed between the pack and the sale (CR-052,
 * the owner's clarification on prices of 2026-11-18, B09b continued 4c, A-286). The pack prices every sellable animal
 * standing at the till by the pricing engine from its own grade and latest weight, with the weight's date and source;
 * an animal the engine cannot price is priceless and says why. At sync the price the till charged always posts, the
 * server's price from the latest weight is worked out only to compare, and the difference is raised: REVIEW within the
 * cashier's limit, URGENT beyond it or outside the band. Every figure is read by SQL over the order line, the receipt
 * and the journal lines.
 *
 * The seeded base list prices goats per head by weight band (GOAT-M 18 to 28 kg: 65,000 in 40,000 to 90,000, grade A
 * 72,000 in 45,000 to 90,000; GOAT-L 28 to 40 kg: 120,000 in 90,000 to 150,000, grade A 130,000 in 100,000 to 150,000)
 * and sheep (SHEEP-S 15 to 30 kg: 40,000 in 15,000 to 70,000; SHEEP-M 30 to 45 kg: 110,000 in 70,000 to 150,000; over
 * 65 kg a quote). The cashier's limits are set here: 30,000 a line, 10,000,000 a shift.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const as = (who: string) => sessions.get(who)!;
const admin = () => database.pool('admin');
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(clock.now().getTime() - minutes * MINUTE);
let credential: string;
let deviceId: string;
let shift: { readonly id: string; readonly seq: number };
let counter = 0;

interface PackAnimal {
  readonly id: string;
  readonly identifier: string;
  readonly gradeId: string | null;
  readonly lastWeightKg: string | null;
  readonly lastWeighedAt: string | null;
  readonly lastWeightSource: string | null;
  readonly sellable: boolean;
  readonly priceListEntryId: string | null;
  readonly priceBand: { readonly listPricePesewas: number; readonly floorPricePesewas: number; readonly ceilingPricePesewas: number; readonly basis: string } | null;
  readonly unpricedReason: string | null;
}
let packed: Map<string, PackAnimal>;

/** The base list's entry for a product in a weight band, with or without a grade, as the database holds it. */
async function entry(sku: string, band: string, grade: string | null): Promise<{ id: string; list: number; floor: number; ceiling: number }> {
  const row = await one<{ id: string; list: string; floor: string; ceiling: string }>(
    `SELECT e.id, e.list_price_pesewas::text AS list, e.floor_price_pesewas::text AS floor, e.ceiling_price_pesewas::text AS ceiling
       FROM mdm.price_list_entry e JOIN mdm.price_list_version v ON v.id = e.version_id JOIN mdm.price_list l ON l.id = v.price_list_id
       JOIN mdm.product p ON p.id = e.product_id JOIN mdm.weight_band w ON w.id = e.weight_band_id LEFT JOIN mdm.grade g ON g.id = e.grade_id
      WHERE l.kind = 'BASE' AND v.status = 'ACTIVE' AND p.sku = $1 AND w.code = $2 AND g.code IS NOT DISTINCT FROM $3`,
    [sku, band, grade],
  );
  return { id: row.id, list: Number(row.list), floor: Number(row.floor), ceiling: Number(row.ceiling) };
}

/** A weighing on the scale, as the farm hand records it. */
async function weigh(tag: string, kg: string, at: Date): Promise<void> {
  const weighed = await post('manager', '/weight-records', { records: [{ id: randomUUID(), stockUnitId: id(tag), weightKg: kg, weightSource: 'SCALE', measuredAt: at.toISOString() }] });
  expect(weighed.status, JSON.stringify(weighed.body)).toBe(200);
}

async function readPack(): Promise<Map<string, PackAnimal>> {
  const read = await consoleGet(api.server, as('ama'), `/v1/registers/${id('till:P1')}/offline-pack`).set('X-Device-Credential', credential);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return new Map((read.body.stockUnits as PackAnimal[]).map((u) => [u.identifier, u] as const));
}

/** One animal sold offline at the price the till charged, cash, synced at once. */
async function sellOffline(line: TillLine): Promise<{ saleId: string; result: Record<string, unknown> }> {
  counter += 1;
  const sale = tillSale({ till: 'P1', shiftSeq: shift.seq, counter, at: ago(5), lines: [line], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: line.agreedUnitPricePesewas }] });
  const synced = await syncBatch(api.server, as('ama'), credential, { deviceId, shiftId: shift.id, sales: [sale] });
  expect(synced.status, JSON.stringify(synced.body)).toBe(200);
  return { saleId: sale.id, result: (synced.body.results as Record<string, unknown>[])[0]! };
}

const animal = (tag: string, sku: string, agreed: number, extra: Partial<TillLine> = {}): TillLine => ({ productId: id(sku), stockUnitId: id(tag), quantity: '1.000', agreedUnitPricePesewas: agreed, ...extra });

/** The order line's pricing record, by SQL. */
const orderLine = (saleId: string) =>
  one<Record<string, string | null>>(
    `SELECT resolved_unit_price_pesewas::text AS resolved, floor_unit_price_pesewas::text AS floor, ceiling_unit_price_pesewas::text AS ceiling,
            agreed_unit_price_pesewas::text AS agreed, variance_pesewas::text AS variance, variance_direction AS direction, variance_reason_code AS reason,
            final_line_total_pesewas::text AS total, price_list_entry_id AS entry, fulfilled_weight_kg::text AS weight, weight_source AS source
       FROM ord.sales_order_line WHERE sales_order_id = $1`,
    [saleId],
  );

/** The receipt's gross and its journal by account: debits less credits on 1200 and 4210, and every credit beside. */
async function ledger(saleId: string): Promise<{ gross: number; receivable: number; variance: number; credits: number; balanced: boolean }> {
  const receipt = await one<{ id: string; gross: string }>('SELECT id, gross_pesewas::text AS gross FROM bil.billing_document WHERE order_document_id = $1', [saleId]);
  const lines = await rows<{ code: string; side: string; amount: string }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
      WHERE e.source_document_id = $1`,
    [receipt.id],
  );
  const net = (code: string) => lines.filter((l) => l.code === code).reduce((n, l) => n + (l.side === 'D' ? Number(l.amount) : -Number(l.amount)), 0);
  const debits = lines.filter((l) => l.side === 'D').reduce((n, l) => n + Number(l.amount), 0);
  const credits = lines.filter((l) => l.side === 'C').reduce((n, l) => n + Number(l.amount), 0);
  return { gross: Number(receipt.gross), receivable: net('1200'), variance: net('4210'), credits, balanced: debits === credits };
}

const overrideFlags = (saleId: string) =>
  rows<{ severity: string; amount: number; fact: Record<string, unknown> }>(
    "SELECT payload->>'severity' AS severity, (payload->>'amountPesewas')::int AS amount, payload->'fact' AS fact FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'PRICE_OVERRIDE'",
    [saleId],
  );

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'pens', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'PENS'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku IN ('LIV-0004', 'LIV-0005')
     UNION ALL SELECT identifier, id FROM inv.stock_unit WHERE identifier IN ('G-0142', 'G-0143', 'G-0144', 'G-0145', 'S-0031', 'S-0032')
     UNION ALL SELECT 'grade:A', g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id WHERE s.code = 'GOAT' AND g.code = 'A'
     UNION ALL SELECT 'kpone', id FROM mdm.supplier WHERE name = 'Kpone Livestock Traders (SEED)'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [kind, amount] of [['PRICE_OVERRIDE_PER_LINE', 30_000], ['PRICE_OVERRIDE_PER_SHIFT', 10_000_000]] as const) {
    await admin().query(
      `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by)
       SELECT id, $1, $2, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001' FROM iam.role WHERE code = 'CASHIER'`,
      [kind, amount],
    );
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const ama = await createUser(database, { name: 'Ama Asante', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('pens') }] });
  sessions.set('ama', await login(api.server, ama));
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('pens'), code: 'P1', name: 'Pens till P1' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till:P1', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${id('till:P1')}/devices`, { deviceLabel: 'Pens tablet P1' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  deviceId = enrolled.body.device.id as string;
  // The shift opens well after the seeded prices take effect.
  clock.advanceBy(7 * 60 * MINUTE);
  const shiftId = nextId();
  const opened = await post('ama', '/shifts', { id: shiftId, registerId: id('till:P1'), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
  clock.advanceBy(10 * MINUTE);

  // Before the pack: G-0144 is graded A, G-0142 weighs 29.000, S-0031 70.000 (a festival ram, sold through quotes),
  // and a goat arrives from Kpone with no weight.
  const version = (await one<{ version: number }>('SELECT version FROM liv.animal WHERE stock_unit_id = $1', [id('G-0144')])).version;
  const graded = await consolePatch(api.server, as('manager'), `/v1/animals/${id('G-0144')}`).send({ version, gradeId: id('grade:A') });
  expect(graded.status, JSON.stringify(graded.body)).toBe(200);
  await weigh('G-0142', '29.000', ago(4));
  await weigh('S-0031', '70.000', ago(4));
  const received = await post('manager', '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('kpone'),
    locationId: id('pens'),
    deliveryNoteRef: `AP-${randomUUID().slice(0, 8)}`,
    receivedAt: ago(3).toISOString(),
    lines: [{ productId: id('LIV-0004'), qtyReceived: '1.000', valuePesewas: 50_000, animals: [{ tagNo: 'G-0190', sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' }] }],
  });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  expect((await post('manager', `/goods-receipts/${received.body.id as string}/post`)).status).toBe(200);
  ids.set('G-0190', (await one<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = 'G-0190'")).id);
  clock.advanceBy(MINUTE);
  packed = await readPack();
  clock.advanceBy(10 * MINUTE);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the pack prices each animal from its own grade and latest weight (CR-052)', () => {
  it('gives each sellable animal the band and entry the engine resolves for it, with the weight, its date and its source', async () => {
    const cases = [
      ['G-0142', 'LIV-0004', 'GOAT-L', null, '29.000'],
      ['G-0143', 'LIV-0004', 'GOAT-M', null, '22.800'],
      ['G-0144', 'LIV-0004', 'GOAT-M', 'A', '26.100'],
      ['G-0145', 'LIV-0004', 'GOAT-M', null, '19.750'],
      ['S-0032', 'LIV-0005', 'SHEEP-S', null, '28.650'],
    ] as const;
    for (const [tag, sku, band, grade, kg] of cases) {
      const priced = await entry(sku, band, grade);
      const unit = await one<{ weighed: Date; grade: string | null }>('SELECT last_weighed_at AS weighed, grade_id AS grade FROM inv.stock_unit WHERE id = $1', [id(tag)]);
      const source = await one<{ source: string }>('SELECT weight_source AS source FROM liv.weight_record WHERE stock_unit_id = $1 ORDER BY measured_at DESC, id DESC LIMIT 1', [id(tag)]);
      expect(packed.get(tag), tag).toEqual({
        id: id(tag),
        identifier: tag,
        productId: id(sku),
        locationId: id('pens'),
        gradeId: unit.grade,
        lastWeightKg: kg,
        lastWeighedAt: unit.weighed.toISOString(),
        lastWeightSource: source.source,
        sellable: true,
        priceListEntryId: priced.id,
        priceBand: { listPricePesewas: priced.list, floorPricePesewas: priced.floor, ceilingPricePesewas: priced.ceiling, basis: 'PER_HEAD' },
        unpricedReason: null,
      });
    }
    expect(packed.get('G-0144')!.gradeId).toBe(id('grade:A'));
    expect(packed.get('G-0144')!.priceBand).toEqual({ listPricePesewas: 72_000, floorPricePesewas: 45_000, ceilingPricePesewas: 90_000, basis: 'PER_HEAD' });
    expect(packed.get('G-0142')!.priceBand).toEqual({ listPricePesewas: 120_000, floorPricePesewas: 90_000, ceilingPricePesewas: 150_000, basis: 'PER_HEAD' });
    expect(packed.get('G-0142')!.lastWeightSource).toBe('SCALE');
  });

  it('leaves an animal with no weight, and one the lists sell only through a quote, priceless and says why', () => {
    expect(packed.get('G-0190')).toMatchObject({ lastWeightKg: null, lastWeighedAt: null, lastWeightSource: null, sellable: true, priceListEntryId: null, priceBand: null, unpricedReason: 'MISSING_GRADE_OR_WEIGHT' });
    expect(packed.get('S-0031')).toMatchObject({ lastWeightKg: '70.000', priceListEntryId: null, priceBand: null, unpricedReason: 'QUOTE_ONLY' });
  });

  it('gives a lot no price of its own, because it sells at its product band', () => {
    const lot = packed.get('BR-2026-1110')!;
    expect(lot).toMatchObject({ priceListEntryId: null, priceBand: null, unpricedReason: null });
  });
});

describe('an animal whose weight changed between the pack and the sale posts the price charged; the difference is raised', () => {
  beforeAll(async () => {
    // After the pack: G-0144 and S-0032 put on weight, G-0142 lost some.
    await weigh('G-0144', '30.500', ago(2));
    await weigh('G-0142', '27.500', ago(2));
    await weigh('S-0032', '31.000', ago(2));
    clock.advanceBy(10 * MINUTE);
  });

  it('a goat sold at the pack price after it moved to a dearer band posts 72,000 charged, 58,000 on 4210, URGENT outside the band', async () => {
    const goatLA = await entry('LIV-0004', 'GOAT-L', 'A');
    const { saleId, result } = await sellOffline(animal('G-0144', 'LIV-0004', packed.get('G-0144')!.priceBand!.listPricePesewas));
    expect(result).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 72_000 });
    expect(await orderLine(saleId)).toEqual({
      resolved: '130000', floor: '72000', ceiling: '150000', agreed: '72000', variance: '58000', direction: 'BELOW', reason: 'OFFLINE_PACK_PRICE', total: '72000', entry: goatLA.id, weight: null, source: null,
    });
    expect(await ledger(saleId)).toEqual({ gross: 72_000, receivable: 72_000, variance: 58_000, credits: 130_000, balanced: true });
    expect(await overrideFlags(saleId)).toEqual([
      expect.objectContaining({
        severity: 'URGENT',
        amount: 58_000,
        fact: expect.objectContaining({ listUnitPricePesewas: 130_000, agreedUnitPricePesewas: 72_000, varianceReasonCode: 'OFFLINE_PACK_PRICE', beyondCashier: 'OUTSIDE_BAND', basis: 'OUTSIDE_RULES', pricedFrom: { weightKg: '30.500', gradeId: id('grade:A'), weightSource: 'SCALE' } }),
      }),
    ]);
  });

  it('a goat that lost weight, sold at a price agreed within the pack band, posts 90,000 charged, 25,000 above the server price, REVIEW', async () => {
    const goatM = await entry('LIV-0004', 'GOAT-M', null);
    const { saleId, result } = await sellOffline(animal('G-0142', 'LIV-0004', 90_000, { varianceReasonCode: 'REGULAR_CUSTOMER' }));
    expect(result).toMatchObject({ outcome: 'APPLIED', grossPesewas: 90_000 });
    expect(await orderLine(saleId)).toEqual({
      resolved: '65000', floor: '40000', ceiling: '90000', agreed: '90000', variance: '25000', direction: 'ABOVE', reason: 'REGULAR_CUSTOMER', total: '90000', entry: goatM.id, weight: null, source: null,
    });
    expect(await ledger(saleId)).toEqual({ gross: 90_000, receivable: 90_000, variance: -25_000, credits: 90_000, balanced: true });
    expect(await overrideFlags(saleId)).toEqual([
      expect.objectContaining({ severity: 'REVIEW', amount: 25_000, fact: expect.objectContaining({ direction: 'ABOVE', beyondCashier: null, basis: 'WITHIN_CASHIER_LIMIT', pricedFrom: { weightKg: '27.500', gradeId: null, weightSource: 'SCALE' } }) }),
    ]);
  });

  it('a sheep that moved to a dearer band, sold within its new band 40,000 below it, is URGENT beyond the cashier limit of 30,000', async () => {
    const { saleId, result } = await sellOffline(animal('S-0032', 'LIV-0005', 70_000, { varianceReasonCode: 'REGULAR_CUSTOMER' }));
    expect(result).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 70_000 });
    expect(await orderLine(saleId)).toMatchObject({ resolved: '110000', floor: '70000', ceiling: '150000', agreed: '70000', variance: '40000', direction: 'BELOW', reason: 'REGULAR_CUSTOMER', total: '70000' });
    expect(await ledger(saleId)).toEqual({ gross: 70_000, receivable: 70_000, variance: 40_000, credits: 110_000, balanced: true });
    expect(await overrideFlags(saleId)).toEqual([
      expect.objectContaining({ severity: 'URGENT', amount: 40_000, fact: expect.objectContaining({ beyondCashier: 'BEYOND_ROLE_LIMIT', basis: 'OUTSIDE_RULES', reason: 'NO_SUPERVISOR_PIN' }) }),
    ]);
  });

  it('a goat re-weighed on the till at the sale is priced by the server from that weight: 65,000 charged against 120,000 for GOAT-L, URGENT', async () => {
    const goatL = await entry('LIV-0004', 'GOAT-L', null);
    const { saleId, result } = await sellOffline(animal('G-0143', 'LIV-0004', packed.get('G-0143')!.priceBand!.listPricePesewas, { weightKg: '28.400', weightSource: 'SCALE' }));
    expect(result).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 65_000 });
    expect(await orderLine(saleId)).toEqual({
      resolved: '120000', floor: '65000', ceiling: '150000', agreed: '65000', variance: '55000', direction: 'BELOW', reason: 'OFFLINE_PACK_PRICE', total: '65000', entry: goatL.id, weight: '28.400', source: 'SCALE',
    });
    expect(await ledger(saleId)).toEqual({ gross: 65_000, receivable: 65_000, variance: 55_000, credits: 120_000, balanced: true });
    expect(await overrideFlags(saleId)).toEqual([
      expect.objectContaining({ severity: 'URGENT', amount: 55_000, fact: expect.objectContaining({ beyondCashier: 'OUTSIDE_BAND', pricedFrom: { weightKg: '28.400', gradeId: null, weightSource: 'SCALE' } }) }),
    ]);
  });

  it('a goat whose weight did not change, sold at the pack price, posts 65,000 and raises nothing', async () => {
    const { saleId, result } = await sellOffline(animal('G-0145', 'LIV-0004', packed.get('G-0145')!.priceBand!.listPricePesewas));
    expect(result).toMatchObject({ outcome: 'APPLIED', grossPesewas: 65_000, exceptions: [] });
    expect(await orderLine(saleId)).toMatchObject({ resolved: '65000', agreed: '65000', variance: '0', direction: null, reason: null });
    expect(await ledger(saleId)).toEqual({ gross: 65_000, receivable: 65_000, variance: 0, credits: 65_000, balanced: true });
    expect(await overrideFlags(saleId)).toEqual([]);
  });
});
