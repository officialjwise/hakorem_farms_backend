import { randomUUID } from 'node:crypto';
import { Quantity, Weight } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extendPrice } from '../../../src/modules/mdm/domain/pricing-engine';
import { SEED_CUSTOMERS, SEED_PRICE_LISTS, SEED_PRODUCTS, SEED_SPECIES, type SeedChannel, type SeedEntry, type SeedPriceList } from '../../../src/seed/reference-pricing';
import { seedUnits } from '../../../src/seed/seed-units';
import { CookieJar, relaxRateLimits, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The B4 gate (docs/BUILD_PROMPT.md, B4 to B12; ADR-0004): a price resolves correctly for every band, channel and
 * customer tier in the seeded reference catalogue, and a request the engine cannot price becomes a quote rather
 * than an error. The seeded farm is loaded exactly as `pnpm db:seed` loads it, and every price is asked of the
 * running API as the seeded Sales user would ask it. The expected answer comes from walking the plain seed
 * definition in the documented order, so a wrong precedence, a wrong band or a wrong list in the engine shows here.
 */
const password = `Seed-${randomUUID()}`;
const CHANNELS: readonly SeedChannel[] = ['POS', 'ONLINE', 'WHOLESALE', 'QUOTE'];
const WALK_IN = { customerNo: null, tier: null, assignedList: null } as const;
type Buyer = { readonly customerNo: string | null; readonly tier: string | null; readonly assignedList: string | null };
const BUYERS: readonly Buyer[] = [WALK_IN, ...SEED_CUSTOMERS];

let database: TestDatabase;
let api: TestApp;
let sales: TestSession;
let branchId: string;
const productIds = new Map<string, string>();
const bandIds = new Map<string, string>();
const gradeIds = new Map<string, string>();
const customerIds = new Map<string, string>();
const listIds = new Map<string, string>();

interface Case {
  readonly sku: string;
  readonly band: string | null;
  readonly grade: string | null;
  readonly weightKg: string | null;
  readonly quantity: string;
}

/** A weight inside a band: its lower edge plus a quarter of its width, to the gram. */
function inside(minKg: string, maxKg: string): string {
  const min = Weight.parseKg(minKg).grams;
  const max = Weight.parseKg(maxKg).grams;
  return Weight.ofGrams(min + (max - min) / 4n).toKgString();
}

/** Every line the catalogue can be asked to price, including the ones that must become quotes. */
function cases(): Case[] {
  const all: Case[] = [];
  for (const product of SEED_PRODUCTS) {
    const species = SEED_SPECIES.find((s) => s.code === product.species);
    if (species === undefined) {
      const quantity = product.category === 'MEAT' ? '15.000' : '1.000';
      all.push({ sku: product.sku, band: null, grade: null, weightKg: product.category === 'MEAT' ? '15.000' : null, quantity });
      continue;
    }
    for (const band of species.bands) {
      for (const grade of [null, ...species.grades.map((g) => g.code)]) {
        all.push({ sku: product.sku, band: band.code, grade, weightKg: inside(band.minKg, band.maxKg), quantity: '1.000' });
      }
      // The lower edge belongs to this band, not the one below (half-open bands).
      all.push({ sku: product.sku, band: band.code, grade: null, weightKg: band.minKg, quantity: '1.000' });
    }
    const top = species.bands.at(-1)!;
    const bottom = species.bands[0]!;
    all.push({ sku: product.sku, band: null, grade: null, weightKg: top.maxKg, quantity: '1.000' }); // above every band
    all.push({ sku: product.sku, band: null, grade: null, weightKg: Weight.ofGrams(Weight.parseKg(bottom.minKg).grams - 1n).toKgString(), quantity: '1.000' }); // below
    all.push({ sku: product.sku, band: null, grade: null, weightKg: null, quantity: '1.000' }); // no weight at all
  }
  return all;
}

type Expected =
  | { readonly outcome: 'RESOLVED'; readonly list: string; readonly entry: SeedEntry }
  | { readonly outcome: 'QUOTE_REQUIRED'; readonly reason: 'NO_RULE' | 'QUOTE_ONLY' | 'MISSING_GRADE_OR_WEIGHT' };

/** The oracle: the seed definition walked in ADR-0004's order, written without the engine. */
function expected(channel: SeedChannel, buyer: Buyer, line: Case): Expected {
  const walk: SeedPriceList[] = [
    ...SEED_PRICE_LISTS.filter((l) => l.kind === 'CUSTOMER' && l.code === buyer.assignedList),
    ...SEED_PRICE_LISTS.filter((l) => l.kind === 'TIER' && l.channel === channel && l.tier === buyer.tier),
    ...SEED_PRICE_LISTS.filter((l) => l.kind === 'CHANNEL' && l.channel === channel),
    ...SEED_PRICE_LISTS.filter((l) => l.kind === 'BASE'),
  ];
  let lacked = false;
  for (const list of walk) {
    const forProduct = list.entries.filter((e) => e.sku === line.sku);
    // An entry "needed" a missing grade or weight only if it would match once given it.
    const fits = (e: SeedEntry) => (e.band === null || line.weightKg === null || e.band === line.band) && (e.grade === null || line.grade === null || e.grade === line.grade);
    lacked ||= forProduct.some((e) => fits(e) && ((e.band !== null && line.weightKg === null) || (e.grade !== null && line.grade === null)));
    const matching = forProduct.filter((e) => (e.band === null || (line.weightKg !== null && e.band === line.band)) && (e.grade === null || e.grade === line.grade));
    const rank = (e: SeedEntry) => (e.band === null ? 0 : 2) + (e.grade === null ? 0 : 1);
    const best = matching.sort((a, b) => rank(b) - rank(a))[0];
    if (best !== undefined) {
      return best.quoteOnly ? { outcome: 'QUOTE_REQUIRED', reason: 'QUOTE_ONLY' } : { outcome: 'RESOLVED', list: list.code, entry: best };
    }
  }
  return { outcome: 'QUOTE_REQUIRED', reason: lacked ? 'MISSING_GRADE_OR_WEIGHT' : 'NO_RULE' };
}

function resolve(channel: SeedChannel, buyer: Buyer, lines: readonly Case[]) {
  const species = (sku: string) => SEED_PRODUCTS.find((p) => p.sku === sku)!.species;
  return request(api.server)
    .post('/v1/pricing/resolve')
    .set('Cookie', sales.jar.header())
    .set('X-CSRF-Token', sales.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .send({
      channel,
      branchId,
      ...(buyer.customerNo === null ? {} : { customerId: customerIds.get(buyer.customerNo) }),
      lines: lines.map((line, index) => ({
        lineRef: String(index),
        productId: productIds.get(line.sku),
        ...(line.grade === null ? {} : { gradeId: gradeIds.get(`${species(line.sku)}:${line.grade}`) }),
        ...(line.weightKg === null ? {} : { weightKg: line.weightKg }),
        quantity: line.quantity,
      })),
    });
}

beforeAll(async () => {
  database = await createTestDatabase();
  await relaxRateLimits(database);
  for (const unit of seedUnits({ SEED_STAFF_PASSWORD: password })) {
    const client = await database.pool('app').connect();
    try {
      await client.query('BEGIN');
      await unit.run(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
  api = await startTestApp(database);
  const admin = database.pool('admin');
  const collect = async (map: Map<string, string>, sql: string) => {
    for (const row of (await admin.query<{ code: string; id: string }>(sql)).rows) map.set(row.code, row.id);
  };
  await collect(productIds, 'SELECT sku AS code, id FROM mdm.product');
  await collect(bandIds, 'SELECT code, id FROM mdm.weight_band');
  await collect(gradeIds, "SELECT s.code || ':' || g.code AS code, g.id FROM mdm.grade g JOIN mdm.species s ON s.id = g.species_id");
  await collect(customerIds, 'SELECT customer_no AS code, id FROM mdm.customer');
  await collect(listIds, 'SELECT code, id FROM mdm.price_list');
  branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const jar = new CookieJar();
  const login = await request(api.server).post('/v1/auth/staff/login').set('Origin', TEST_ORIGIN).send({ identifier: 'esi.appiah@seed.hakoremfarms.invalid', password });
  expect(login.body.status).toBe('AUTHENTICATED');
  jar.store(login.headers['set-cookie']);
  sales = { jar, csrfToken: login.body.session.csrfToken, sessionId: login.body.session.sessionId };
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B4 gate: every band, channel and customer tier in the seeded catalogue', () => {
  const lines = cases();

  it('covers the whole catalogue: every product, every band of every species, every grade, every list', () => {
    expect(new Set(lines.map((line) => line.sku))).toEqual(new Set(SEED_PRODUCTS.map((p) => p.sku)));
    expect(new Set(lines.flatMap((line) => (line.band === null ? [] : [line.band])))).toEqual(new Set(SEED_SPECIES.flatMap((s) => s.bands.map((b) => b.code))));
    expect(lines.length).toBeLessThanOrEqual(200);
  });

  for (const channel of CHANNELS) {
    for (const buyer of BUYERS) {
      it(`prices every line on ${channel} for ${buyer.customerNo === null ? 'a walk-in buyer' : `${buyer.customerNo} (${buyer.tier}${buyer.assignedList === null ? '' : `, ${buyer.assignedList}`})`}`, async () => {
        const response = await resolve(channel, buyer, lines);
        expect(response.status).toBe(200);
        expect(response.body.channel).toBe(channel);
        expect(response.body.currency).toBe('GHS');
        lines.forEach((line, index) => {
          const want = expected(channel, buyer, line);
          const got = response.body.lines[index];
          const label = `${line.sku} ${line.band ?? '-'} ${line.grade ?? '-'} ${line.weightKg ?? 'no weight'}`;
          expect(got.lineRef, label).toBe(String(index));
          expect(got.promotions, label).toEqual([]);
          if (want.outcome === 'QUOTE_REQUIRED') {
            expect({ outcome: got.outcome, reason: got.quoteRequiredReason, resolved: got.resolved }, label).toEqual({ outcome: 'QUOTE_REQUIRED', reason: want.reason, resolved: null });
            return;
          }
          expect(got.outcome, label).toBe('RESOLVED');
          expect(got.quoteRequiredReason, label).toBeNull();
          expect(got.resolved.priceList.code, label).toBe(want.list);
          expect(got.resolved.priceList.id, label).toBe(listIds.get(want.list));
          expect([got.resolved.floorPricePesewas, got.resolved.listPricePesewas, got.resolved.ceilingPricePesewas], label).toEqual([
            Number(want.entry.floor),
            Number(want.entry.list),
            Number(want.entry.ceiling),
          ]);
          expect(got.resolved.basis, label).toBe(want.entry.basis);
          expect(got.resolved.weightBand?.code ?? null, label).toBe(want.entry.band);
          expect(got.resolved.grade?.code ?? null, label).toBe(want.entry.grade);
          expect(got.resolved.listPricePesewas, label).toBeGreaterThan(0);
        });
      });
    }
  }
});

describe('B4 gate: pinned exact prices, so the oracle itself is checked', () => {
  const one = async (channel: SeedChannel, customerNo: string | null, line: Case) => {
    const buyer = customerNo === null ? WALK_IN : SEED_CUSTOMERS.find((c) => c.customerNo === customerNo)!;
    const response = await resolve(channel, buyer, [line]);
    expect(response.status).toBe(200);
    return response.body.lines[0];
  };
  const goatA = (kg: string): Case => ({ sku: 'LIV-GOAT', band: 'GOAT-M', grade: 'A', weightKg: kg, quantity: '1.000' });

  it('a 22.400 kg grade A goat at the counter is GHS 720.00 from the base list, band 450.00 to 900.00', async () => {
    const got = await one('POS', null, goatA('22.400'));
    expect(got.resolved).toMatchObject({ priceList: { code: 'BASE', kind: 'BASE' }, listPricePesewas: 72_000, floorPricePesewas: 45_000, ceilingPricePesewas: 90_000, basis: 'PER_HEAD' });
    expect(got.resolved.weightBand).toEqual({ id: bandIds.get('GOAT-M'), code: 'GOAT-M', minKg: '18.000', maxKg: '28.000' });
  });

  it('the same goat for a wholesale-tier buyer on the wholesale channel is 10 percent off the base: 648.00, floor 405.00, ceiling the counter price', async () => {
    const got = await one('WHOLESALE', 'C-00002', goatA('22.400'));
    expect(got.resolved).toMatchObject({ priceList: { code: 'WHOLESALE', kind: 'CHANNEL' }, listPricePesewas: 64_800, floorPricePesewas: 40_500, ceilingPricePesewas: 72_000 });
  });

  it("the caterer's contract price, 700.00, wins on every channel, and a grade B goat falls through their list", async () => {
    for (const channel of CHANNELS) {
      expect((await one(channel, 'C-00004', goatA('22.400'))).resolved).toMatchObject({ priceList: { code: 'CATERERS-2026', kind: 'CUSTOMER' }, listPricePesewas: 70_000 });
    }
    const gradeB = await one('WHOLESALE', 'C-00004', { ...goatA('22.400'), grade: 'B' });
    expect(gradeB.resolved).toMatchObject({ priceList: { code: 'WHOLESALE' }, listPricePesewas: 58_500 });
  });

  it('derived prices were rounded half-up once when the list was set: 1,067 x 0.85 = 906.95 is 907, 733 x 0.85 = 623.05 is 623', async () => {
    const meat = (sku: string): Case => ({ sku, band: null, grade: null, weightKg: '15.000', quantity: '15.000' });
    expect((await one('WHOLESALE', 'C-00003', meat('MEAT-CHICKEN-BACKS-15KG'))).resolved).toMatchObject({ priceList: { code: 'WHL-RESELLER-TIER' }, floorPricePesewas: 907, listPricePesewas: 1_105 });
    expect((await one('WHOLESALE', 'C-00003', meat('MEAT-CHICKEN-WINGS-15KG'))).resolved).toMatchObject({ floorPricePesewas: 623, listPricePesewas: 935 });
  });

  it('extends a resolved per-kilogram price to a line once, half-up: 0.500 kg of online wings at 1,155 is 577.5, so 578', async () => {
    const got = await one('ONLINE', null, { sku: 'MEAT-CHICKEN-WINGS-15KG', band: null, grade: null, weightKg: '0.500', quantity: '0.500' });
    expect(got.resolved).toMatchObject({ priceList: { code: 'ONLINE' }, listPricePesewas: 1_155, basis: 'PER_KG' });
    const measure = { quantity: Quantity.parse('0.500'), weight: Weight.parseKg('0.500') };
    expect(extendPrice(BigInt(got.resolved.listPricePesewas), 'PER_KG', measure)).toEqual({ ok: true, value: 578n });
    // A full 15.250 kg pack of online full chicken at 1,995 a kilogram: 30,423.75, so 30,424.
    const chicken = await one('ONLINE', null, { sku: 'MEAT-CHICKEN-FULL-15KG', band: null, grade: null, weightKg: '15.250', quantity: '15.250' });
    expect(chicken.resolved.listPricePesewas).toBe(1_995);
    expect(extendPrice(1_995n, 'PER_KG', { quantity: Quantity.parse('15.250'), weight: Weight.parseKg('15.250') })).toEqual({ ok: true, value: 30_424n });
  });
});

describe('B4 gate: an unresolvable request becomes a quote, not an error', () => {
  const one = async (line: Case, channel: SeedChannel = 'POS') => {
    const response = await resolve(channel, WALK_IN, [line]);
    expect(response.status).toBe(200);
    return response.body.lines[0];
  };

  it('a 65.000 kg goat, above every goat band, is QUOTE_REQUIRED with NO_RULE', async () => {
    expect(await one({ sku: 'LIV-GOAT', band: null, grade: null, weightKg: '65.000', quantity: '1.000' })).toEqual({
      lineRef: '0',
      outcome: 'QUOTE_REQUIRED',
      resolved: null,
      quoteRequiredReason: 'NO_RULE',
      promotions: [],
    });
  });

  it('a goat with no weight is MISSING_GRADE_OR_WEIGHT', async () => {
    expect((await one({ sku: 'LIV-GOAT', band: null, grade: null, weightKg: null, quantity: '1.000' })).quoteRequiredReason).toBe('MISSING_GRADE_OR_WEIGHT');
  });

  it('a 70.000 kg festival ram is QUOTE_ONLY even though smaller sheep have list prices', async () => {
    expect((await one({ sku: 'LIV-SHEEP', band: 'SHEEP-XL', grade: null, weightKg: '70.000', quantity: '1.000' }, 'WHOLESALE')).quoteRequiredReason).toBe('QUOTE_ONLY');
  });

  it('lettuce, unpriced this season, is NO_RULE on every channel and never a zero price', async () => {
    for (const channel of CHANNELS) {
      const got = await one({ sku: 'PRD-LETTUCE-HEAD', band: null, grade: null, weightKg: null, quantity: '1.000' }, channel);
      expect(got).toMatchObject({ outcome: 'QUOTE_REQUIRED', quoteRequiredReason: 'NO_RULE', resolved: null });
    }
  });
});
