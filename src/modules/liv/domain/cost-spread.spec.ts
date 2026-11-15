import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { headOf, spreadByHeadDays, treatmentOf } from './cost-spread';

const pesewas = (parts: readonly { readonly amount: Money }[]) => parts.map((p) => p.amount.pesewas);

describe('spreading a cost across a pen by head-days (FR-LIV-009, FR-LIV-015, ADR-0018)', () => {
  it('gives three animals of one head-day each 3,000 of a 9,000 pesewa treatment', () => {
    const spread = spreadByHeadDays(Money.ofPesewas(9_000n), [
      { stockUnitId: 'a', identifier: 'G-0142', headDays: 1n },
      { stockUnitId: 'b', identifier: 'G-0143', headDays: 1n },
      { stockUnitId: 'c', identifier: 'G-0144', headDays: 1n },
    ]);
    expect(spread.ok && pesewas(spread.value)).toEqual([3_000n, 3_000n, 3_000n]);
  });

  it('gives the one leftover pesewa of 9,001 to the lowest key: 3,001, 3,000, 3,000', () => {
    const spread = spreadByHeadDays(Money.ofPesewas(9_001n), [
      { stockUnitId: 'c', identifier: 'G-0144', headDays: 1n },
      { stockUnitId: 'a', identifier: 'G-0142', headDays: 1n },
      { stockUnitId: 'b', identifier: 'G-0143', headDays: 1n },
    ]);
    expect(spread.ok && spread.value.map((p) => [p.stockUnitId, p.amount.pesewas])).toEqual([
      ['a', 3_001n],
      ['b', 3_000n],
      ['c', 3_000n],
    ]);
  });

  it('spreads feed valued 10,001 over head-days 10, 10 and 5 as 4,001, 4,000 and 2,000, summing exactly', () => {
    const spread = spreadByHeadDays(Money.ofPesewas(10_001n), [
      { stockUnitId: 'x', identifier: 'BR-A', headDays: 10n },
      { stockUnitId: 'y', identifier: 'BR-B', headDays: 10n },
      { stockUnitId: 'z', identifier: 'BR-C', headDays: 5n },
    ]);
    expect(spread.ok && pesewas(spread.value)).toEqual([4_001n, 4_000n, 2_000n]);
    expect(spread.ok && Money.sum(spread.value.map((p) => p.amount)).pesewas).toBe(10_001n);
    expect(spread.ok && spread.value.map((p) => p.headDays)).toEqual([10n, 10n, 5n]);
  });

  it('gives a zero cost nothing to anyone, and a single animal the whole cost', () => {
    const zero = spreadByHeadDays(Money.zero(), [{ stockUnitId: 'a', identifier: 'G-0142', headDays: 1n }, { stockUnitId: 'b', identifier: 'G-0143', headDays: 1n }]);
    expect(zero.ok && pesewas(zero.value)).toEqual([0n, 0n]);
    const one = spreadByHeadDays(Money.ofPesewas(62_501n), [{ stockUnitId: 'a', identifier: 'D-017', headDays: 1n }]);
    expect(one.ok && pesewas(one.value)).toEqual([62_501n]);
  });

  it('spreads the largest amount without losing a pesewa', () => {
    const spread = spreadByHeadDays(Money.ofPesewas(Money.MAX_PESEWAS), [
      { stockUnitId: 'a', identifier: 'A', headDays: 1n },
      { stockUnitId: 'b', identifier: 'B', headDays: 2n },
    ]);
    expect(spread.ok && pesewas(spread.value)).toEqual([3_002_399_751_580_330n, 6_004_799_503_160_661n]);
  });

  it('refuses an empty pen and a share without a head-day', () => {
    expect(spreadByHeadDays(Money.ofPesewas(100n), [])).toEqual({ ok: false, error: 'NO_ANIMALS_HERE' });
    expect(spreadByHeadDays(Money.ofPesewas(100n), [{ stockUnitId: 'a', identifier: 'A', headDays: 0n }])).toEqual({ ok: false, error: 'NO_ANIMALS_HERE' });
    expect(spreadByHeadDays(Money.ofPesewas(100n), [{ stockUnitId: 'a', identifier: 'A', headDays: -1n }])).toEqual({ ok: false, error: 'NO_ANIMALS_HERE' });
  });

  it('orders two flocks with one batch number by their ids, whichever comes first', () => {
    const shares = [
      { stockUnitId: 'q', identifier: 'BR-1', headDays: 1n },
      { stockUnitId: 'p', identifier: 'BR-1', headDays: 1n },
    ];
    const spread = spreadByHeadDays(Money.ofPesewas(3n), shares);
    expect(spread.ok && spread.value.map((p) => [p.stockUnitId, p.amount.pesewas])).toEqual([
      ['p', 2n],
      ['q', 1n],
    ]);
    const reversed = spreadByHeadDays(Money.ofPesewas(3n), [...shares].reverse());
    expect(reversed.ok && reversed.value.map((p) => p.stockUnitId)).toEqual(['p', 'q']);
  });

  it('refuses the same unit twice', () => {
    expect(
      spreadByHeadDays(Money.ofPesewas(100n), [
        { stockUnitId: 'a', identifier: 'A', headDays: 1n },
        { stockUnitId: 'a', identifier: 'A', headDays: 1n },
      ]),
    ).toEqual({ ok: false, error: 'UNIT_REPEATED' });
  });
});

describe('the head a unit has on hand for one day (head-days)', () => {
  it('counts an animal as one head and a flock by its whole head on hand', () => {
    expect(headOf('SERIAL', '1.000')).toBe(1n);
    expect(headOf('LOT', '18.000')).toBe(18n);
  });

  it('counts a part head down and nothing for an empty balance', () => {
    expect(headOf('LOT', '18.500')).toBe(18n);
    expect(headOf('LOT', '0.000')).toBe(0n);
    expect(headOf('LOT', '-2.000')).toBe(0n);
  });
});

describe('whether a cost is capitalised or expensed (ADR-0018, A-025)', () => {
  it('capitalises onto growing stock and expenses breeding stock', () => {
    expect(treatmentOf('GROWING')).toBe('CAPITALISED');
    expect(treatmentOf('BREEDING')).toBe('EXPENSED');
  });
});
