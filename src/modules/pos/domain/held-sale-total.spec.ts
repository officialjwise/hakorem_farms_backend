import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { heldTotal } from './held-sale-total';

describe('a held sale total is the sum of its lines, each already rounded once (ADR-0001)', () => {
  it('adds 6,900 for three yams at 2,300 and 503 for 0.201 kg at 2,500 per kg to exactly 7,403', () => {
    expect(heldTotal([Money.ofPesewas(6_900n), Money.ofPesewas(503n)]).pesewas).toBe(7_403n);
  });

  it('is zero for no lines', () => {
    expect(heldTotal([]).pesewas).toBe(0n);
  });
});
