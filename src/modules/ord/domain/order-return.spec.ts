import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { judgeReturn, judgeReturnApprover, pieceRefund, planReturnRefund, type ReturnFacts, type SoldLine } from './order-return';

const sold = (over: Partial<SoldLine> = {}): SoldLine => ({
  id: 'line-1',
  priceBasis: 'PER_UNIT',
  serial: false,
  qtySold: Quantity.parse('3.000'),
  qtyReturned: Quantity.parse('0.000'),
  ...over,
});
const facts = (over: Partial<ReturnFacts> = {}): ReturnFacts => ({
  orderStatus: 'COMPLETED',
  kind: 'RETURN',
  sold: [sold()],
  asked: [{ orderLineId: 'line-1', qty: Quantity.parse('2.000') }],
  ...over,
});

describe('a return against the original sale (FR-ORD-015, abuse case 12)', () => {
  it('takes back part of what was sold on a completed sale', () => {
    expect(judgeReturn(facts())).toEqual({ ok: true, value: null });
  });

  it('takes back exactly what is left, and never one thousandth more', () => {
    expect(judgeReturn(facts({ sold: [sold({ qtyReturned: Quantity.parse('1.000') })] }))).toEqual({ ok: true, value: null });
    expect(judgeReturn(facts({ sold: [sold({ qtyReturned: Quantity.parse('1.001') })] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
    expect(judgeReturn(facts({ asked: [{ orderLineId: 'line-1', qty: Quantity.parse('3.001') }] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
  });

  it('refuses a return of an order that is not a completed sale: a voided sale is not a sale', () => {
    for (const orderStatus of ['PLACED', 'CONFIRMED', 'CANCELLED', 'VOIDED'] as const) {
      expect(judgeReturn(facts({ orderStatus })), orderStatus).toEqual({ ok: false, error: [{ field: '', rule: 'INVALID_STATE_TRANSITION' }] });
    }
  });

  it('refuses an exchange until the counter that makes the replacement sale exists, and a return with no lines', () => {
    expect(judgeReturn(facts({ kind: 'EXCHANGE' }))).toEqual({ ok: false, error: [{ field: '/kind', rule: 'EXCHANGE_NOT_AVAILABLE' }] });
    expect(judgeReturn(facts({ asked: [] }))).toEqual({ ok: false, error: [{ field: '/lines', rule: 'NO_LINES' }] });
  });

  it('names every broken line at once: not on the order, repeated, nothing returned, part of an animal, a weighed line', () => {
    const verdict = judgeReturn(
      facts({
        sold: [sold(), sold({ id: 'goat', serial: true, qtySold: Quantity.parse('1.000') }), sold({ id: 'beef', priceBasis: 'PER_KG', qtySold: Quantity.parse('14.850') }), sold({ id: 'cabbage' })],
        asked: [
          { orderLineId: 'elsewhere', qty: Quantity.parse('1.000') },
          { orderLineId: 'line-1', qty: Quantity.parse('1.000') },
          { orderLineId: 'line-1', qty: Quantity.parse('1.000') },
          { orderLineId: 'goat', qty: Quantity.parse('0.500') },
          { orderLineId: 'beef', qty: Quantity.parse('1.000') },
          { orderLineId: 'cabbage', qty: Quantity.parse('0.000') },
        ],
      }),
    );
    expect(verdict).toEqual({
      ok: false,
      error: [
        { field: '/lines/0/orderLineId', rule: 'LINE_NOT_ON_ORDER' },
        { field: '/lines/2/orderLineId', rule: 'LINE_REPEATED' },
        { field: '/lines/3/qty', rule: 'SERIAL_RETURNS_WHOLE' },
        { field: '/lines/4/orderLineId', rule: 'WEIGHED_LINE_NOT_RETURNABLE' },
        { field: '/lines/5/qty', rule: 'QUANTITY_NOT_POSITIVE' },
      ],
    });
  });

  it('takes back a whole animal', () => {
    expect(judgeReturn(facts({ sold: [sold({ serial: true, qtySold: Quantity.parse('1.000') })], asked: [{ orderLineId: 'line-1', qty: Quantity.parse('1.000') }] }))).toEqual({ ok: true, value: null });
  });
});

describe('the approver of a return (ADR-0066)', () => {
  it('is never the person who made the return', () => {
    expect(judgeReturnApprover('owner', { makerId: 'accountant' })).toEqual({ ok: true, value: null });
    expect(judgeReturnApprover('accountant', { makerId: 'accountant' })).toEqual({ ok: false, error: 'MAKER_CANNOT_CHECK' });
  });
});

describe('the refund a return asks for (ADR-0066)', () => {
  const cash = (id: string, allocated: number, status: 'CLEARED' | 'PENDING' | 'FAILED' | 'REVERSED' = 'CLEARED') => ({ id, status, allocatedPesewas: allocated });

  it('asks back the credit note’s amount from the cleared payment that paid the most of the sale', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(4_000n), [cash('small', 1_000), cash('big', 5_000)])).toEqual({ paymentId: 'big', amount: Money.ofPesewas(4_000n) });
  });

  it('asks back no more than the sale owes the customer after the credit', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(2_500n), [cash('p', 6_000)])).toEqual({ paymentId: 'p', amount: Money.ofPesewas(2_500n) });
  });

  it('asks for nothing when the sale owes the customer nothing: an unpaid invoice is simply credited', () => {
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.zero(), [cash('p', 6_000)])).toBeNull();
    expect(planReturnRefund(Money.ofPesewas(4_000n), Money.ofPesewas(4_000n), [cash('p', 6_000, 'REVERSED'), cash('q', 6_000, 'PENDING')])).toBeNull();
  });

  it('breaks a tie between two payments by the first that was taken', () => {
    expect(planReturnRefund(Money.ofPesewas(1n), Money.ofPesewas(1n), [cash('first', 3_000), cash('second', 3_000)])).toEqual({ paymentId: 'first', amount: Money.ofPesewas(1n) });
  });
});

describe('part of a crate returned as single eggs (owner, 2026-11-18, ADR-0075 running total)', () => {
  const crate = (over: Partial<SoldLine> = {}): SoldLine => sold({ id: 'crate', qtySold: Quantity.parse('1.000'), piecesPerUnit: 30n, ...over });
  const eggs = (qty: string, over: Record<string, unknown> = {}) => ({ orderLineId: 'crate', qty: Quantity.parse(qty), inPieces: true, disposition: 'RETURNS_HOLD' as const, ...over });

  it('takes five eggs of a crate back, and the last of its thirty, but never a thirty-first', () => {
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('5.000')] }))).toEqual({ ok: true, value: null });
    expect(judgeReturn(facts({ sold: [crate({ piecesReturned: Quantity.parse('29.000') })], asked: [eggs('1.000')] }))).toEqual({ ok: true, value: null });
    expect(judgeReturn(facts({ sold: [crate({ piecesReturned: Quantity.parse('30.000') })], asked: [eggs('1.000')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('31.000')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
  });

  it('counts a whole crate returned before against the eggs, and the eggs against a whole crate', () => {
    const two = crate({ qtySold: Quantity.parse('2.000'), piecesReturned: Quantity.parse('35.000') });
    expect(judgeReturn(facts({ sold: [two], asked: [eggs('25.000')] }))).toEqual({ ok: true, value: null });
    expect(judgeReturn(facts({ sold: [two], asked: [eggs('26.000')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
    expect(judgeReturn(facts({ sold: [two], asked: [{ orderLineId: 'crate', qty: Quantity.parse('1.000') }] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'RETURN_EXCEEDS_SOLD' }] });
    expect(judgeReturn(facts({ sold: [crate({ qtySold: Quantity.parse('2.000'), piecesReturned: Quantity.parse('30.000') })], asked: [{ orderLineId: 'crate', qty: Quantity.parse('1.000') }] }))).toEqual({ ok: true, value: null });
  });

  it('takes eggs whole only, of a line sold in a unit of several, and never back onto the shelf before inspection', () => {
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('2.500')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/qty', rule: 'INEXACT_QUANTITY' }] });
    expect(judgeReturn(facts({ sold: [sold({ id: 'crate' })], asked: [eggs('1.000')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/uom', rule: 'UNIT_NOT_SOLD' }] });
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('1.000', { unitSold: false })] }))).toEqual({ ok: false, error: [{ field: '/lines/0/uom', rule: 'UNIT_NOT_SOLD' }] });
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('1.000', { disposition: 'RESTOCK' })] }))).toEqual({ ok: false, error: [{ field: '/lines/0/disposition', rule: 'PART_RETURN_TO_HOLD' }] });
    expect(judgeReturn(facts({ sold: [crate()], asked: [eggs('1.000', { disposition: 'WRITE_OFF' })] }))).toEqual({ ok: true, value: null });
  });

  it('waits for an open return of the line to be decided, so the pieces always add up', () => {
    expect(judgeReturn(facts({ sold: [crate({ openReturns: 1 })], asked: [eggs('1.000')] }))).toEqual({ ok: false, error: [{ field: '/lines/0/orderLineId', rule: 'RETURN_OPEN_ON_LINE' }] });
    expect(judgeReturn(facts({ sold: [crate({ qtySold: Quantity.parse('2.000'), openReturns: 1, openPartReturns: 1 })], asked: [{ orderLineId: 'crate', qty: Quantity.parse('1.000') }] }))).toEqual({
      ok: false,
      error: [{ field: '/lines/0/orderLineId', rule: 'RETURN_OPEN_ON_LINE' }],
    });
    // Whole crates may still wait beside each other, as before.
    expect(judgeReturn(facts({ sold: [crate({ qtySold: Quantity.parse('2.000'), openReturns: 1 })], asked: [{ orderLineId: 'crate', qty: Quantity.parse('1.000') }] }))).toEqual({ ok: true, value: null });
  });
});

describe('the refund of part of a crate: round(paid x cumulative / pieces) less round(paid x previous / pieces), half-up', () => {
  const p = (n: bigint) => Money.ofPesewas(n);
  const q = (n: number) => Quantity.parse(`${n}.000`);

  it('refunds five eggs of a GHS 55.00 crate exactly 917 (5,500 x 5 / 30 = 916.67), never the single-egg price', () => {
    expect(pieceRefund(p(5_500n), q(30), q(0), q(5))).toEqual(p(917n));
  });

  it('refunds a crate returned one egg at a time, all 30, exactly 5,500 in total, never more', () => {
    const pieces = Array.from({ length: 30 }, (_, i) => pieceRefund(p(5_500n), q(30), q(i), q(1)).pesewas);
    expect(pieces.reduce((a, b) => a + b, 0n)).toBe(5_500n);
    // Each egg alone rounded would refund 183 x 30 = 5,490: the running total is what makes the pieces add up.
    expect(pieces.slice(0, 6)).toEqual([183n, 184n, 183n, 183n, 184n, 183n]);
  });

  it('refunds the second five eggs the rest of the first ten: 1,833 less 917', () => {
    expect(pieceRefund(p(5_500n), q(30), q(5), q(5))).toEqual(p(916n));
  });

  it('rounds an exact half pesewa up, once, and one below half down, one above up', () => {
    expect(pieceRefund(p(3n), q(2), q(0), q(1))).toEqual(p(2n)); // 1.5
    expect(pieceRefund(p(3n), q(2), q(1), q(1))).toEqual(p(1n)); // 3 - 2
    expect(pieceRefund(p(7n), q(30), q(0), q(2))).toEqual(p(0n)); // 0.4667
    expect(pieceRefund(p(8n), q(30), q(0), q(2))).toEqual(p(1n)); // 0.5333
  });

  it('refunds nothing of a line that cost nothing, and the largest amount whole', () => {
    expect(pieceRefund(p(0n), q(30), q(0), q(5))).toEqual(p(0n));
    expect(pieceRefund(p(Money.MAX_PESEWAS), q(30), q(0), q(30))).toEqual(p(Money.MAX_PESEWAS));
    expect(pieceRefund(p(Money.MAX_PESEWAS), q(30), q(29), q(1)).plus(pieceRefund(p(Money.MAX_PESEWAS), q(30), q(0), q(29)))).toEqual(p(Money.MAX_PESEWAS));
  });
});
