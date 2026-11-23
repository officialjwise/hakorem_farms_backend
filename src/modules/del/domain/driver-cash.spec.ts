import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { handInFigures, judgeHandIn } from './driver-cash';

const m = (pesewas: number) => Money.ofPesewas(BigInt(pesewas));
const figures = (held: number[], declared: number) => {
  const f = handInFigures(held.map(m), m(declared));
  return { expected: f.expected.pesewas, received: f.received.pesewas, short: f.short.pesewas, over: f.over.pesewas, direction: f.direction };
};

describe('a driver hand-in at a till shift (FR-DEL-010, CR-057, ADR-0092)', () => {
  it('expects exactly the sum of the collections still held, and an exact count is EXACT', () => {
    expect(figures([24_000, 130_000], 154_000)).toEqual({ expected: 154_000n, received: 154_000n, short: 0n, over: 0n, direction: 'EXACT' });
  });

  it('shows a short hand-in as short, never as loose cash: what came in is what was counted', () => {
    expect(figures([24_000, 130_000], 144_000)).toEqual({ expected: 154_000n, received: 144_000n, short: 10_000n, over: 0n, direction: 'SHORT' });
    expect(figures([5_500], 0)).toEqual({ expected: 5_500n, received: 0n, short: 5_500n, over: 0n, direction: 'SHORT' });
    expect(figures([5_500], 5_499)).toEqual({ expected: 5_500n, received: 5_499n, short: 1n, over: 0n, direction: 'SHORT' });
  });

  it('shows more cash than was collected as over', () => {
    expect(figures([5_500, 2_570], 8_071)).toEqual({ expected: 8_070n, received: 8_071n, short: 0n, over: 1n, direction: 'OVER' });
  });

  it('balances by construction: received and short equal expected and over', () => {
    for (const [held, declared] of [[[1, 2, 3], 0], [[999_999], 1_000_000], [[154_000], 154_000], [[3, 4], 6]] as const) {
      const f = handInFigures(held.map(m), m(declared));
      expect(f.received.plus(f.short).equals(f.expected.plus(f.over))).toBe(true);
    }
  });

  it('refuses a hand-in received by the driver themselves, or with nothing held', () => {
    expect(judgeHandIn({ driverId: 'd', receiverId: 'd', heldCount: 1 })).toEqual([{ field: '/driverId', rule: 'RECEIVER_IS_DRIVER' }]);
    expect(judgeHandIn({ driverId: 'd', receiverId: 'd', heldCount: 0 })).toEqual([{ field: '/driverId', rule: 'RECEIVER_IS_DRIVER' }, { field: '/driverId', rule: 'NOTHING_HELD' }]);
    expect(judgeHandIn({ driverId: 'd', receiverId: 'c', heldCount: 0 })).toEqual([{ field: '/driverId', rule: 'NOTHING_HELD' }]);
    expect(judgeHandIn({ driverId: 'd', receiverId: 'c', heldCount: 2 })).toEqual([]);
  });
});
