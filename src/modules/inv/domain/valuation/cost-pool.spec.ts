import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { capitalise, CostPoolError, emptyPool, issue, receive, type CostPool } from './cost-pool';

const units = (n: bigint) => Quantity.ofUnits(n);
const pesewas = (n: bigint) => Money.ofPesewas(n);

function pool(qty: string, value: bigint): CostPool {
  return { qty: Quantity.parse(qty), value: pesewas(value) };
}

function show(p: CostPool): [string, bigint] {
  return [p.qty.toDecimalString(), p.value.pesewas];
}

describe('weighted average cost (FR-INV-017, ADR-0018)', () => {
  it('issues with half-up and empties the pool exactly: 100,001 over 3 units carries 33,334, 33,334, then 33,333', () => {
    let p = receive(emptyPool(), units(3n), pesewas(100_001n));
    const first = issue(p, units(1n));
    expect(first.carried.pesewas).toBe(33_334n);
    expect(show(first.pool)).toEqual(['2.000', 66_667n]);
    p = first.pool;
    const second = issue(p, units(1n));
    expect(second.carried.pesewas).toBe(33_334n);
    expect(show(second.pool)).toEqual(['1.000', 33_333n]);
    const last = issue(second.pool, units(1n));
    expect(last.carried.pesewas).toBe(33_333n);
    expect(show(last.pool)).toEqual(['0.000', 0n]);
    expect(first.carried.pesewas + second.carried.pesewas + last.carried.pesewas).toBe(100_001n);
  });

  it('rounds an exact half pesewa up: 3 pesewas over 2.000 kg, issuing 1.000 kg carries 2', () => {
    expect(issue(pool('2.000', 3n), Quantity.parse('1.000')).carried.pesewas).toBe(2n);
  });

  it('rounds just below a half down: 10 pesewas over 3.000 kg, issuing 1.000 kg carries 3', () => {
    expect(issue(pool('3.000', 10n), Quantity.parse('1.000')).carried.pesewas).toBe(3n);
  });

  it('values by weight to the gram: 12,345 pesewas over 15.000 kg, issuing 0.001 kg carries 1', () => {
    expect(issue(pool('15.000', 12_345n), Quantity.parse('0.001')).carried.pesewas).toBe(1n);
  });

  it('carries zero and leaves the pool unchanged for a zero issue', () => {
    const result = issue(pool('4.000', 900n), Quantity.zero());
    expect(result.carried.pesewas).toBe(0n);
    expect(show(result.pool)).toEqual(['4.000', 900n]);
    expect(result.uncovered.toDecimalString()).toBe('0.000');
  });

  it('adds a receipt to the pool: 20 broilers at 110,000 onto 5 at 27,500', () => {
    expect(show(receive(pool('5.000', 27_500n), units(20n), pesewas(110_000n)))).toEqual(['25.000', 137_500n]);
  });

  it('refuses a receipt of no quantity', () => {
    expect(() => receive(emptyPool(), Quantity.zero(), pesewas(1n))).toThrow(CostPoolError);
  });
});

describe('specific identification (FR-INV-018)', () => {
  it("issues a serial animal's whole accumulated cost: 60,000 plus 8,400 feed plus 3,000 veterinary is 71,400", () => {
    let goat = receive(emptyPool(), units(1n), pesewas(60_000n));
    goat = capitalise(goat, pesewas(8_400n));
    goat = capitalise(goat, pesewas(3_000n));
    const sale = issue(goat, units(1n));
    expect(sale.carried.pesewas).toBe(71_400n);
    expect(show(sale.pool)).toEqual(['0.000', 0n]);
  });

  it('refuses to capitalise cost onto a pool that holds no stock', () => {
    expect(() => capitalise(emptyPool(), pesewas(500n))).toThrow(CostPoolError);
    expect(() => capitalise(pool('-2.000', 0n), pesewas(500n))).toThrow(CostPoolError);
  });
});

describe('an allowed-negative issue (FR-INV-019, ADR-0018)', () => {
  it('carries the whole pool for the covered part and zero for the uncovered part: 5 from 3 valued 10,500', () => {
    const result = issue(pool('3.000', 10_500n), units(5n));
    expect(result.carried.pesewas).toBe(10_500n);
    expect(result.uncovered.toDecimalString()).toBe('2.000');
    expect(show(result.pool)).toEqual(['-2.000', 0n]);
  });

  it('carries zero from a pool already at or below zero', () => {
    const fromEmpty = issue(emptyPool(), units(1n));
    expect(fromEmpty.carried.pesewas).toBe(0n);
    expect(fromEmpty.uncovered.toDecimalString()).toBe('1.000');
    const fromNegative = issue(pool('-2.000', 0n), units(1n));
    expect(show(fromNegative.pool)).toEqual(['-3.000', 0n]);
    expect(fromNegative.uncovered.toDecimalString()).toBe('1.000');
  });

  it('values a receipt into a negative pool at its own value', () => {
    expect(show(receive(pool('-2.000', 0n), units(5n), pesewas(17_500n)))).toEqual(['3.000', 17_500n]);
  });

  it('refuses a negative issue quantity', () => {
    expect(() => issue(pool('3.000', 9n), Quantity.parse('-1.000'))).toThrow(CostPoolError);
  });
});
