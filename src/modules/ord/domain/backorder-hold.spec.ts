import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { inWeightBand, keptForBackorder, type HeldPiece } from './backorder-hold';

const q = (s: string) => Quantity.parse(s);
const goat = (n: number, location = 'PEN-G3'): HeldPiece => ({ reservationId: `r${n}`, productId: 'goat', stockUnitId: `G-${n}`, locationId: location, qty: q('1.000'), serial: true });
const kept = (k: ReturnType<typeof keptForBackorder>) => k.map((x) => `${x.reservationId}:${x.lineIndex}:${x.qty.toDecimalString()}`);

describe('a backorder keeps the stock its first order held (the owner, 2026-11-24, BL-123)', () => {
  it('keeps 8 of 18 held goats when the 10 picked were others, oldest held first, one a line', () => {
    const held = Array.from({ length: 18 }, (_, i) => goat(i + 1));
    const picked = Array.from({ length: 10 }, (_, i) => ({ productId: 'goat', stockUnitId: `G-${201 + i}`, locationId: 'PEN-G3', qty: q('1.000') }));
    const needs = Array.from({ length: 8 }, () => ({ productId: 'goat', qty: q('1.000') }));
    expect(kept(keptForBackorder(held, picked, needs))).toEqual(['r1:0:1.000', 'r2:1:1.000', 'r3:2:1.000', 'r4:3:1.000', 'r5:4:1.000', 'r6:5:1.000', 'r7:6:1.000', 'r8:7:1.000']);
  });

  it('never keeps an animal that is picked, wherever it was picked, and keeps the held animals not picked', () => {
    const held = [goat(1), goat(2, 'PEN-G1'), goat(3)];
    const picked = [{ productId: 'goat', stockUnitId: 'G-2', locationId: 'PEN-G3', qty: q('1.000') }, { productId: 'goat', stockUnitId: 'G-1', locationId: 'PEN-G3', qty: q('1.000') }];
    expect(kept(keptForBackorder(held, picked, [{ productId: 'goat', qty: q('2.000') }]))).toEqual(['r3:0:1.000']);
  });

  it('keeps of a lot what its reservation holds less the picks from that lot at that location, across two lines', () => {
    const lot: HeldPiece = { reservationId: 'e1', productId: 'eggs', stockUnitId: 'L1', locationId: 'SHOP', qty: q('120.000'), serial: false };
    const other: HeldPiece = { reservationId: 'e2', productId: 'eggs', stockUnitId: 'L2', locationId: 'SHOP', qty: q('30.000'), serial: false };
    const picked = [
      { productId: 'eggs', stockUnitId: 'L1', locationId: 'SHOP', qty: q('60.000') },
      // The same lot at another location takes nothing of this reservation.
      { productId: 'eggs', stockUnitId: 'L1', locationId: 'STORE-1', qty: q('30.000') },
      { productId: 'yam', stockUnitId: null, locationId: 'SHOP', qty: q('3.000') },
    ];
    expect(kept(keptForBackorder([lot, other], picked, [{ productId: 'eggs', qty: q('50.000') }, { productId: 'eggs', qty: q('30.000') }]))).toEqual(['e1:0:50.000', 'e1:1:10.000', 'e2:1:20.000']);
  });

  it('keeps nothing of another product, nothing beyond what is held, and nothing for a backorder with no lines', () => {
    expect(kept(keptForBackorder([goat(1)], [], [{ productId: 'eggs', qty: q('30.000') }, { productId: 'goat', qty: q('3.000') }]))).toEqual(['r1:1:1.000']);
    expect(keptForBackorder([goat(1)], [], [])).toEqual([]);
    expect(keptForBackorder([], [], [{ productId: 'goat', qty: q('1.000') }])).toEqual([]);
  });
});

describe("an order line keeps its quote line's band (the owner, 2026-11-24, BL-124)", () => {
  const band = { minKg: '18.000', maxKg: '28.000' };
  it('takes an animal weighed in the band, half-open, and none never weighed or outside', () => {
    expect([inWeightBand('18.000', band), inWeightBand('27.999', band), inWeightBand('28.000', band), inWeightBand('17.999', band), inWeightBand(null, band)]).toEqual([true, true, false, false, false]);
  });
  it('takes any animal for a line with no band', () => {
    expect([inWeightBand(null, null), inWeightBand('40.000', null)]).toEqual([true, true]);
  });
});
