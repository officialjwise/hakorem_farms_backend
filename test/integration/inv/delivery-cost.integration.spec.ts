import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { move, movementValue, pool, receive, sell, stockUnit, type StockFixture, createStockFixture } from '../../support/inventory';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Cost without drift for a bought lot (B09e, the owner's decision 2 and option B, ADR-0075). A lot received from a
 * supplier keeps its delivery's quantity Q0 and value V0, and each issue is valued by its place in the delivery:
 * half_up(V0 x (p + q) / Q0) - half_up(V0 x p / Q0), with p the eggs already issued, so a whole crate bought at
 * GHS 47.50 always posts exactly 4,750 pesewas, whatever was sold from the delivery before it, and the delivery sums
 * exactly. Every value is set by the database, never by the caller.
 */
let database: TestDatabase;
let fx: StockFixture;
let seq = 0;

/** Price of one crate of 30, in pesewas. */
const CRATE = 4_750;
const PER_CRATE = '30.000';

beforeAll(async () => {
  database = await createTestDatabase();
  fx = await createStockFixture(database);
});

afterAll(async () => {
  await database.drop();
});

/** A lot of `crates` crates of eggs bought at `price` a crate (4,750 unless named), received at the shop: the delivery is the lot. */
async function delivery(crates: number, price = CRATE): Promise<string> {
  seq += 1;
  const lot = await stockUnit(fx, { productId: fx.eggLots, tracking: 'LOT', identifier: `EGG-DLV-${seq}` });
  await receive(fx, fx.eggLots, fx.shop, `${crates * 30}.000`, crates * price, lot);
  return lot;
}

async function sellEggs(lot: string, qty: string): Promise<number> {
  return Number(await movementValue(fx, await sell(fx, fx.eggLots, fx.shop, qty, lot)));
}

/** A small deterministic generator (mulberry32), so the mixed sequence is the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('a whole crate always posts exactly 4,750 pesewas (ADR-0075)', () => {
  it('after 3 single eggs from a delivery of 2 crates: 158, 159 and 158, then the crate at 4,750', async () => {
    const lot = await delivery(2);
    expect([await sellEggs(lot, '1.000'), await sellEggs(lot, '1.000'), await sellEggs(lot, '1.000')]).toEqual([158, 159, 158]);
    expect(await sellEggs(lot, PER_CRATE)).toBe(4_750);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '27.000', value: '4275' });
    expect(await sellEggs(lot, '27.000')).toBe(4_275);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });

  it('after 1 single egg from a delivery of 10 crates: the egg at 158, then each of 3 crates at 4,750', async () => {
    const lot = await delivery(10);
    expect(await sellEggs(lot, '1.000')).toBe(158);
    for (let i = 0; i < 3; i += 1) {
      expect(await sellEggs(lot, PER_CRATE)).toBe(4_750);
    }
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '209.000', value: `${47_500 - 158 - 3 * 4_750}` });
  });

  it('in a random mix of 120 sales of crates and singles from a delivery of 10 crates, posts every crate at 4,750 and the delivery at 47,500', async () => {
    const lot = await delivery(10);
    const next = generator(20_261_117);
    let left = 300;
    let total = 0;
    const crates: number[] = [];
    while (left > 0) {
      if (left >= 30 && next() < 0.25) {
        const value = await sellEggs(lot, PER_CRATE);
        crates.push(value);
        total += value;
        left -= 30;
      } else {
        total += await sellEggs(lot, '1.000');
        left -= 1;
      }
    }
    expect(crates.length).toBeGreaterThan(0);
    expect(crates.every((value) => value === 4_750)).toBe(true);
    expect(total).toBe(47_500);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });
});

describe('the rounding is half-up, never half-to-even: an odd crate cost on exact halves (owner, 2026-11-17)', () => {
  // 2 crates at 4,751 are 9,502 over 60 eggs. After 15 singles the running total is 9,502 x 15 / 60 = 2,375.5 and after
  // the next crate 9,502 x 45 / 60 = 7,126.5: both exact halves. Half-up takes 2,376 and 7,127, so the crate is 4,751;
  // half-to-even would take 2,376 and 7,126 and post the crate at 4,750.
  it('posts the whole crate at exactly 4,751 after 15 singles land the running total on an exact half', async () => {
    const lot = await delivery(2, 4_751);
    let singles = 0;
    for (let i = 0; i < 15; i += 1) {
      singles += await sellEggs(lot, '1.000');
    }
    expect(singles).toBe(2_376);
    expect(await sellEggs(lot, PER_CRATE)).toBe(4_751);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '15.000', value: `${9_502 - 2_376 - 4_751}` });
    expect(await sellEggs(lot, '15.000')).toBe(2_375);
  });

  it('posts each of 7 whole crates of 10 at 4,751 in a mix of singles and crates that passes through exact halves, and the delivery at 47,510', async () => {
    const lot = await delivery(10, 4_751);
    // 15 singles put p on an odd multiple of 15, where 4,751 x p / 30 is an exact half; crates keep it there.
    const plan = ['15', 'C', 'C', '30', 'C', '15', 'C', '15', 'C', 'C', 'C', '15'];
    let total = 0;
    const crates: number[] = [];
    for (const step of plan) {
      if (step === 'C') {
        const value = await sellEggs(lot, PER_CRATE);
        crates.push(value);
        total += value;
      } else {
        for (let i = 0; i < Number(step); i += 1) total += await sellEggs(lot, '1.000');
      }
    }
    expect(crates).toEqual(Array(7).fill(4_751));
    expect(total).toBe(47_510);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });
});

describe('cost added to a delivery that no longer divides by its crates (owner, 2026-11-17)', () => {
  it('3 crates at 4,750 plus 100 of transport, 14,350 over 90 eggs: crates of 4,783, 4,784 and 4,783, summing to 14,350, none more than 1 from the even share', async () => {
    const lot = await delivery(3);
    await move(fx, { type: 'COST_CAPITALISE', productId: fx.eggLots, unitId: lot, from: fx.virtual.CONSUMPTION, to: fx.shop, qty: '0.000', value: 100, costElement: 'OVERHEAD' });
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '90.000', value: '14350' });
    const crates = [await sellEggs(lot, PER_CRATE), await sellEggs(lot, PER_CRATE), await sellEggs(lot, PER_CRATE)];
    expect(crates).toEqual([4_783, 4_784, 4_783]);
    expect(crates.reduce((a, b) => a + b, 0)).toBe(14_350);
    // The even share is 14,350 / 3 = 4,783.33: every crate is within one pesewa of it (3 x |crate - share| <= 3).
    expect(crates.every((value) => Math.abs(3 * value - 14_350) <= 3)).toBe(true);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });
});

describe('a crate broken into singles sums exactly to 4,750 pesewas (ADR-0075)', () => {
  it('30 singles in a row from a 10-crate delivery, after one single was sold, sum to 4,750', async () => {
    const lot = await delivery(10);
    await sellEggs(lot, '1.000');
    let sum = 0;
    for (let i = 0; i < 30; i += 1) {
      sum += await sellEggs(lot, '1.000');
    }
    expect(sum).toBe(4_750);
  });

  it('a delivery of one crate sold as 30 singles posts exactly 4,750, its last egg taking what is left', async () => {
    const lot = await delivery(1);
    const values: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      values.push(await sellEggs(lot, '1.000'));
    }
    expect(values.reduce((a, b) => a + b, 0)).toBe(4_750);
    expect(new Set(values)).toEqual(new Set([158, 159]));
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });
});

describe('reversals, value-only additions, gains and transfers (ADR-0075 rules)', () => {
  it('a reversal carries its original value, and reversing the latest issue keeps the delivery schedule', async () => {
    const lot = await delivery(2);
    await sellEggs(lot, '1.000');
    const issue = await sell(fx, fx.eggLots, fx.shop, '1.000', lot);
    expect(await movementValue(fx, issue)).toBe('159');
    const reversal = await move(fx, { type: 'SALE_ISSUE', productId: fx.eggLots, unitId: lot, from: fx.virtual.CUSTOMER, to: fx.shop, qty: '1.000', reverses: issue });
    expect(await movementValue(fx, reversal)).toBe('159');
    // Back on the schedule at p = 1: the next crate takes eggs 2 to 31 of the delivery.
    expect(await sellEggs(lot, PER_CRATE)).toBe(4_750);
  });

  it('a value-only addition re-anchors the lot at what it then holds, and its issues still sum exactly', async () => {
    const lot = await delivery(2);
    expect(await sellEggs(lot, PER_CRATE)).toBe(4_750);
    await move(fx, { type: 'COST_CAPITALISE', productId: fx.eggLots, unitId: lot, from: fx.virtual.CONSUMPTION, to: fx.shop, qty: '0.000', value: 300, costElement: 'OVERHEAD' });
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '30.000', value: '5050' });
    // Re-anchored at 30 eggs and 5,050: half_up(5,050 / 30) = 168, then the 29 left carry 4,882.
    expect(await sellEggs(lot, '1.000')).toBe(168);
    expect(await sellEggs(lot, '29.000')).toBe(4_882);
  });

  it('a gain re-anchors the lot, and the lot still empties to zero value', async () => {
    const lot = await delivery(2);
    await sellEggs(lot, '3.000');
    await move(fx, { type: 'ADJUST_GAIN', productId: fx.eggLots, unitId: lot, from: fx.virtual.ADJUSTMENT, to: fx.shop, qty: '2.000', value: 0, costElement: null, reason: 'COUNT_ERROR' });
    // 59 eggs holding 9,025: re-anchored there, one egg is half_up(9,025 / 59) = 153.
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '59.000', value: '9025' });
    expect(await sellEggs(lot, '1.000')).toBe(153);
    expect(await sellEggs(lot, '58.000')).toBe(8_872);
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '0.000', value: '0' });
  });

  it('a transfer within the branch shows the schedule value of the eggs it moves and leaves the pool and the schedule alone', async () => {
    const lot = await delivery(3);
    await sellEggs(lot, '1.000');
    const transfer = await move(fx, { type: 'TRANSFER_INTERNAL', productId: fx.eggLots, unitId: lot, from: fx.shop, to: fx.store, qty: PER_CRATE });
    expect(await movementValue(fx, transfer)).toBe('4750');
    expect(await pool(fx, fx.eggLots, lot)).toEqual({ qty: '89.000', value: `${3 * CRATE - 158}` });
    expect(Number(await movementValue(fx, await sell(fx, fx.eggLots, fx.store, PER_CRATE, lot)))).toBe(4_750);
  });
});

describe('ADR-0018 holds unchanged for everything that is not a bought lot', () => {
  it('values an untracked weighted-average pool on what it holds: after 3 singles of 60 eggs at 9,500, the next 30 carry 4,751', async () => {
    const before = await pool(fx, fx.eggs);
    expect(before).toBeNull();
    await receive(fx, fx.eggs, fx.shop, '60.000', 2 * CRATE);
    const singles = [];
    for (let i = 0; i < 3; i += 1) {
      singles.push(Number(await movementValue(fx, await sell(fx, fx.eggs, fx.shop, '1.000'))));
    }
    expect(singles).toEqual([158, 158, 158]);
    expect(Number(await movementValue(fx, await sell(fx, fx.eggs, fx.shop, PER_CRATE)))).toBe(4_751);
  });

  it('values a lot that was not bought (opening stock) on its pool, as before', async () => {
    seq += 1;
    const lot = await stockUnit(fx, { productId: fx.eggLots, tracking: 'LOT', identifier: `EGG-OPEN-${seq}` });
    await move(fx, { type: 'OPENING_BALANCE', productId: fx.eggLots, unitId: lot, from: fx.virtual.OPENING, to: fx.shop, qty: '60.000', value: 2 * CRATE });
    for (let i = 0; i < 3; i += 1) {
      await sellEggs(lot, '1.000');
    }
    expect(await sellEggs(lot, PER_CRATE)).toBe(4_751);
  });
});
