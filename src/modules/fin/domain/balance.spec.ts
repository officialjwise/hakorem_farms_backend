import { describe, expect, it } from 'vitest';
import { jsonPesewas, sidedBalance, signedLine } from './balance';

describe('a balance shown with its side (ADR-0001)', () => {
  it('reads a debit balance as D and a credit balance as C, never negative', () => {
    expect(sidedBalance(94_000n, 'D')).toEqual({ pesewas: 94_000n, side: 'D' });
    expect(sidedBalance(-960_000n, 'D')).toEqual({ pesewas: 960_000n, side: 'C' });
    expect(sidedBalance(1n, 'C')).toEqual({ pesewas: 1n, side: 'D' });
  });

  it('reads a nil balance on the account normal side', () => {
    expect(sidedBalance(0n, 'C')).toEqual({ pesewas: 0n, side: 'C' });
    expect(sidedBalance(0n, 'D')).toEqual({ pesewas: 0n, side: 'D' });
  });

  it('adds a debit and takes away a credit, exactly', () => {
    expect(signedLine('D', 333_334n) + signedLine('C', 333_333n)).toBe(1n);
  });
});

describe('a pesewa amount as a JSON integer', () => {
  it('is exact within the safe range and refused beyond it, never rounded', () => {
    expect(jsonPesewas(3_700_001n)).toBe(3_700_001);
    expect(() => jsonPesewas(9_007_199_254_740_993n)).toThrow();
  });
});
