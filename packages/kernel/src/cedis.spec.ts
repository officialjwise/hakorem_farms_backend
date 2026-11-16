import { describe, expect, it } from 'vitest';
import { formatCedis } from './cedis';

describe('formatCedis prints the stored integer, never a float (ADR-0001)', () => {
  it.each([
    [0n, 'GHS 0.00'],
    [5n, 'GHS 0.05'],
    [99n, 'GHS 0.99'],
    [100n, 'GHS 1.00'],
    [124_489n, 'GHS 1,244.89'],
    [100_000_000n, 'GHS 1,000,000.00'],
    [9_007_199_254_740_993n, 'GHS 90,071,992,547,409.93'],
    [-36_000n, '-GHS 360.00'],
    [-1n, '-GHS 0.01'],
  ])('%s pesewas print as %s', (pesewas, printed) => {
    expect(formatCedis(pesewas)).toBe(printed);
  });
});
