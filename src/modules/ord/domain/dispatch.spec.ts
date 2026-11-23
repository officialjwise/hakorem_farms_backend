import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { planSettlement } from './dispatch';

const m = (pesewas: number) => Money.ofPesewas(BigInt(pesewas));
const deposit = (id: string, pesewas: number) => ({ paymentId: id, unallocated: m(pesewas) });
const plain = (plan: ReturnType<typeof planSettlement>) => ({
  allocations: plan.allocations.map((a) => [a.paymentId, a.amount.pesewas]),
  refunds: plan.refunds.map((r) => [r.paymentId, r.amount.pesewas]),
  due: plan.due.pesewas,
});

describe('settling an order at dispatch against the invoice on the weighed quantity (FR-ORD-011, ADR-0021)', () => {
  it("allocates FR-ORD-011's deposit of 84,000 to the invoice of 86,240 and leaves 2,240 due on delivery", () => {
    expect(plain(planSettlement(m(86_240), [deposit('p1', 84_000)]))).toEqual({ allocations: [['p1', 84_000n]], refunds: [], due: 2_240n });
  });

  it('refunds what was paid above a lighter weighed total and leaves nothing due', () => {
    expect(plain(planSettlement(m(80_000), [deposit('p1', 84_000)]))).toEqual({ allocations: [['p1', 80_000n]], refunds: [['p1', 4_000n]], due: 0n });
  });

  it('allocates a deposit equal to the invoice whole, with nothing refunded and nothing due', () => {
    expect(plain(planSettlement(m(86_240), [deposit('p1', 86_240)]))).toEqual({ allocations: [['p1', 86_240n]], refunds: [], due: 0n });
  });

  it('collects the whole invoice on delivery when nothing was paid ahead (cash on delivery)', () => {
    expect(plain(planSettlement(m(98_960), []))).toEqual({ allocations: [], refunds: [], due: 98_960n });
  });

  it('takes the deposits oldest first and refunds only what the last one holds beyond the invoice', () => {
    expect(plain(planSettlement(m(50_000), [deposit('p1', 30_000), deposit('p2', 30_000)]))).toEqual({
      allocations: [
        ['p1', 30_000n],
        ['p2', 20_000n],
      ],
      refunds: [['p2', 10_000n]],
      due: 0n,
    });
  });

  it('refunds a later deposit whole when an earlier one already covers the invoice', () => {
    expect(plain(planSettlement(m(30_000), [deposit('p1', 30_000), deposit('p2', 5_000)]))).toEqual({ allocations: [['p1', 30_000n]], refunds: [['p2', 5_000n]], due: 0n });
  });

  it('skips a deposit with nothing left unallocated', () => {
    expect(plain(planSettlement(m(1_000), [deposit('p1', 0), deposit('p2', 400)]))).toEqual({ allocations: [['p2', 400n]], refunds: [], due: 600n });
  });

  it('keeps every pesewa: allocated plus due is the invoice, allocated plus refunded is what was paid', () => {
    const deposits = [deposit('p1', 12_345), deposit('p2', 67_891)];
    for (const gross of [1, 12_344, 12_345, 12_346, 80_236, 80_237, 99_999]) {
      const plan = planSettlement(m(gross), deposits);
      expect(Money.sum(plan.allocations.map((a) => a.amount)).plus(plan.due).pesewas).toBe(BigInt(gross));
      expect(Money.sum([...plan.allocations, ...plan.refunds].map((a) => a.amount)).pesewas).toBe(80_236n);
    }
  });

  it('settles the largest amount a pesewa field holds without losing one', () => {
    const plan = planSettlement(Money.ofPesewas(Money.MAX_PESEWAS), [deposit('p1', 1)]);
    expect(plan.due.pesewas).toBe(Money.MAX_PESEWAS - 1n);
  });
});
