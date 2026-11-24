import { Money } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { backorderLines, cashDueOnDelivery, feesAtDispatch, judgeExtraDeliveryFee, planSettlement, zoneFee } from './dispatch';

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

describe('a dispatch that leaves a backorder (FR-ORD-012, A-331 (b))', () => {
  it('keeps what the deposits hold beyond the invoice for the backorder instead of refunding it', () => {
    // 3 crates at 5,500 paid ahead (16,500), 2 dispatched: 11,000 allocated, 5,500 held for the backorder.
    expect(plain(planSettlement(m(11_000), [deposit('p1', 16_500)], { holdForBackorder: true }))).toEqual({ allocations: [['p1', 11_000n]], refunds: [], due: 0n });
  });

  it('still refunds what the deposits hold beyond the last dispatch of the order', () => {
    expect(plain(planSettlement(m(5_500), [deposit('p1', 6_000)], { holdForBackorder: false }))).toEqual({ allocations: [['p1', 5_500n]], refunds: [['p1', 500n]], due: 0n });
  });
});

describe('backorderLines (FR-ORD-012): the rest of each short line, at the price agreed on the order', () => {
  const line = (over: Partial<Parameters<typeof backorderLines>[0][number]> = {}) => ({ id: 'l1', lineNo: 1, qtyOrdered: '20.000', qtyFulfilled: '12.000', qtyBackordered: '8.000', agreedUnitPricePesewas: 5_500n, discountPesewas: 0n, ...over });

  it("back-orders FR-ORD-012's 8 of 20 crates at 5,500 as one line of 44,000, and leaves a line sent in full alone", () => {
    expect(backorderLines([line(), line({ id: 'l2', lineNo: 2, qtyFulfilled: '3.000', qtyOrdered: '3.000', qtyBackordered: '0.000' })])).toEqual([{ fromLineId: 'l1', qty: '8.000', estimatedLineTotalPesewas: 44_000n, status: 'PARTIAL' }]);
  });

  it('names a line sent not at all BACKORDERED, the whole of it on the backorder', () => {
    expect(backorderLines([line({ qtyFulfilled: '0.000', qtyBackordered: '20.000' })])).toEqual([{ fromLineId: 'l1', qty: '20.000', estimatedLineTotalPesewas: 110_000n, status: 'BACKORDERED' }]);
  });

  it('rounds the backorder line once, half-up: 1.500 at 333 is 499.5, so 500; 1.499 at 333 is 499.167, so 499', () => {
    expect(backorderLines([line({ qtyOrdered: '3.000', qtyFulfilled: '1.500', qtyBackordered: '1.500', agreedUnitPricePesewas: 333n })])[0]!.estimatedLineTotalPesewas).toBe(500n);
    expect(backorderLines([line({ qtyOrdered: '3.000', qtyFulfilled: '1.501', qtyBackordered: '1.499', agreedUnitPricePesewas: 333n })])[0]!.estimatedLineTotalPesewas).toBe(499n);
  });

  it('refuses a back-order that is not exactly what was not sent, or of a discounted line', () => {
    expect(() => backorderLines([line({ qtyBackordered: '7.000' })])).toThrow('BACKORDER_MISMATCH');
    expect(() => backorderLines([line({ discountPesewas: 100n })])).toThrow('BACKORDER_DISCOUNTED');
  });
});

describe('feesAtDispatch (A-331 (b), the owner 2026-11-23): the delivery fee once, an extra delivery its own line', () => {
  it("charges the order's own fee of 1,500 on its first dispatch", () => {
    expect(feesAtDispatch({ deliveryFeePesewas: 1_500n, isBackorder: false, extraFees: [] })).toEqual([{ kind: 'DELIVERY', amountPesewas: 1_500n, extraFeeId: null }]);
  });

  it('charges nothing on the dispatch of a backorder the farm makes to complete the order, whatever fee it carries', () => {
    expect(feesAtDispatch({ deliveryFeePesewas: 0n, isBackorder: true, extraFees: [] })).toEqual([]);
    expect(feesAtDispatch({ deliveryFeePesewas: 1_500n, isBackorder: true, extraFees: [] })).toEqual([]);
  });

  it('charges an extra delivery the customer asked for as its own line of exactly its amount', () => {
    expect(feesAtDispatch({ deliveryFeePesewas: 0n, isBackorder: true, extraFees: [{ id: 'x1', amountPesewas: 1_500n }] })).toEqual([{ kind: 'EXTRA_DELIVERY', amountPesewas: 1_500n, extraFeeId: 'x1' }]);
  });

  it('charges nothing for a free delivery', () => {
    expect(feesAtDispatch({ deliveryFeePesewas: 0n, isBackorder: false, extraFees: [] })).toEqual([]);
  });
});

describe('judgeExtraDeliveryFee (the owner 2026-11-23): only on a delivery backorder not yet dispatched, once', () => {
  const facts = (over: Partial<Parameters<typeof judgeExtraDeliveryFee>[0]> = {}) => ({ fulfilmentMode: 'DELIVERY' as const, isBackorder: true, status: 'CONFIRMED' as const, alreadyAdded: false, zoneFeePesewas: 1_500n, ...over });

  it('adds the zone fee to a backorder waiting to be sent', () => {
    for (const status of ['CONFIRMED', 'PICKING', 'AWAITING_CUSTOMER', 'PACKED'] as const) expect(judgeExtraDeliveryFee(facts({ status }))).toEqual({ ok: true, value: 1_500n });
  });

  it('refuses a collection order, an order that is not a backorder, one already dispatched, a second extra fee and a free zone', () => {
    expect(judgeExtraDeliveryFee(facts({ fulfilmentMode: 'COLLECTION' }))).toEqual({ ok: false, error: 'NOT_A_DELIVERY' });
    expect(judgeExtraDeliveryFee(facts({ isBackorder: false }))).toEqual({ ok: false, error: 'NOT_A_BACKORDER' });
    for (const status of ['PLACED', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED'] as const) expect(judgeExtraDeliveryFee(facts({ status }))).toEqual({ ok: false, error: 'NOT_BEFORE_DISPATCH' });
    expect(judgeExtraDeliveryFee(facts({ alreadyAdded: true }))).toEqual({ ok: false, error: 'EXTRA_FEE_ALREADY_ADDED' });
    expect(judgeExtraDeliveryFee(facts({ zoneFeePesewas: 0n }))).toEqual({ ok: false, error: 'ZONE_HAS_NO_FEE' });
  });
});

describe("a staff delivery order's fee from the customer's address zone (B11 continued 8, FR-SHP-008)", () => {
  const zone = { feePesewas: 1_500n, freeOverPesewas: 50_000n };
  it("charges the zone's exact fee on goods at the threshold, and waives it one pesewa above", () => {
    expect([zoneFee(zone, m(50_000)).pesewas, zoneFee(zone, m(50_001)).pesewas]).toEqual([1_500n, 0n]);
  });
  it('never waives the fee of a zone without a threshold', () => {
    expect(zoneFee({ feePesewas: 2_000n, freeOverPesewas: null }, m(9_000_000)).pesewas).toBe(2_000n);
  });
});

describe('what the driver collects on an order on account (B11 continued 8, ADR-0092)', () => {
  it('is nothing: the balance is the invoice, due on the terms', () => {
    expect(cashDueOnDelivery('CREDIT', m(86_240)).pesewas).toBe(0n);
  });
  it('is what the deposits do not cover on cash on delivery or a prepaid order', () => {
    expect([cashDueOnDelivery('COD', m(2_240)).pesewas, cashDueOnDelivery('PREPAID', m(0)).pesewas]).toEqual([2_240n, 0n]);
  });
});
