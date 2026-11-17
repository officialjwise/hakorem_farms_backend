import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { matchInvoice, matchLine, type InvoiceLineFacts } from './three-way-match';

const broilers = 'product-broiler';
const order = (over: Partial<NonNullable<InvoiceLineFacts['order']>> = {}): NonNullable<InvoiceLineFacts['order']> => ({
  productId: broilers,
  unitPrice: Money.ofPesewas(5_500n),
  qtyReceived: Quantity.parse('20.000'),
  qtyInvoicedElsewhere: Quantity.zero(),
  qtyClaimed: Quantity.zero(),
  ...over,
});
const line = (over: Partial<InvoiceLineFacts> = {}): InvoiceLineFacts => ({
  productId: broilers,
  qtyBase: Quantity.parse('20.000'),
  unitPrice: Money.ofPesewas(5_500n),
  levies: [{ charged: Money.zero(), calculated: Money.zero() }],
  order: order(),
  ...over,
});

describe('three-way match (FR-PUR-009, SA-08)', () => {
  it('applies the price and quantity tolerances', () => {
    // Order 20 broilers at 5,500, received 20.
    const at5550 = matchLine(line({ unitPrice: Money.ofPesewas(5_550n) }));
    expect(at5550).toEqual({ status: 'MATCHED', reasons: [], qtyVariance: Quantity.zero(), priceVariance: Money.ofPesewas(50n), priceVarianceDirection: 'OVER' });
    const at5600 = matchLine(line({ unitPrice: Money.ofPesewas(5_600n) }));
    expect(at5600.status).toBe('MISMATCH');
    expect(at5600.reasons).toEqual(['PRICE_OUTSIDE_TOLERANCE']);
    expect(at5600.priceVariance).toEqual(Money.ofPesewas(100n));
    const twentyTwo = matchLine(line({ qtyBase: Quantity.parse('22.000') }));
    expect(twentyTwo.status).toBe('MISMATCH');
    expect(twentyTwo.reasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
    expect(twentyTwo.qtyVariance).toEqual(Quantity.parse('2.000'));
  });

  it('matches a price exactly one percent from the order price and refuses one pesewa beyond it', () => {
    expect(matchLine(line({ unitPrice: Money.ofPesewas(5_555n) })).status).toBe('MATCHED');
    expect(matchLine(line({ unitPrice: Money.ofPesewas(5_556n) })).reasons).toEqual(['PRICE_OUTSIDE_TOLERANCE']);
    expect(matchLine(line({ unitPrice: Money.ofPesewas(5_445n) }))).toMatchObject({ status: 'MATCHED', priceVariance: Money.ofPesewas(55n), priceVarianceDirection: 'UNDER' });
    expect(matchLine(line({ unitPrice: Money.ofPesewas(5_444n) })).reasons).toEqual(['PRICE_OUTSIDE_TOLERANCE']);
  });

  it('shows no price variance and no direction when the invoice price is the order price', () => {
    expect(matchLine(line())).toEqual({ status: 'MATCHED', reasons: [], qtyVariance: Quantity.zero(), priceVariance: Money.zero(), priceVarianceDirection: null });
  });

  it('counts what other invoices already hold against the receipt, so the same goods are not invoiced twice', () => {
    const second = matchLine(line({ qtyBase: Quantity.parse('8.000'), order: order({ qtyInvoicedElsewhere: Quantity.parse('12.000') }) }));
    expect(second).toMatchObject({ status: 'MATCHED', qtyVariance: Quantity.zero() });
    const tooMany = matchLine(line({ qtyBase: Quantity.parse('8.001'), order: order({ qtyInvoicedElsewhere: Quantity.parse('12.000') }) }));
    expect(tooMany).toMatchObject({ status: 'MISMATCH', reasons: ['QTY_EXCEEDS_RECEIVED'], qtyVariance: Quantity.parse('0.001') });
  });

  it('shows a short invoice as a negative quantity variance and still matches it', () => {
    expect(matchLine(line({ qtyBase: Quantity.parse('15.000') }))).toMatchObject({ status: 'MATCHED', qtyVariance: Quantity.parse('-5.000') });
  });

  it('refuses goods that were not received at all', () => {
    expect(matchLine(line({ order: order({ qtyReceived: Quantity.zero() }) }))).toMatchObject({ status: 'MISMATCH', reasons: ['QTY_EXCEEDS_RECEIVED'], qtyVariance: Quantity.parse('20.000') });
  });

  it('names every reason a line fails on, in a fixed order', () => {
    const all = matchLine(line({ qtyBase: Quantity.parse('21.000'), unitPrice: Money.ofPesewas(6_000n), levies: [{ charged: Money.ofPesewas(1n), calculated: Money.zero() }] }));
    expect(all.reasons).toEqual(['QTY_EXCEEDS_RECEIVED', 'PRICE_OUTSIDE_TOLERANCE', 'LEVY_DIFFERS']);
  });

  it('refuses a product line with no order line, and a line whose product is not the order line product', () => {
    expect(matchLine(line({ order: null }))).toEqual({ status: 'MISMATCH', reasons: ['NO_ORDER_LINE'], qtyVariance: null, priceVariance: null, priceVarianceDirection: null });
    expect(matchLine(line({ order: order({ productId: 'product-goat' }) }))).toEqual({
      status: 'MISMATCH',
      reasons: ['PRODUCT_DIFFERS'],
      qtyVariance: null,
      priceVariance: null,
      priceVarianceDirection: null,
    });
  });

  it('needs no match for a pure expense line, unless its levies differ from the calculated ones', () => {
    const transport = line({ productId: null, qtyBase: null, order: null, unitPrice: Money.ofPesewas(15_000n) });
    expect(matchLine(transport)).toEqual({ status: 'NOT_REQUIRED', reasons: [], qtyVariance: null, priceVariance: null, priceVarianceDirection: null });
    expect(matchLine({ ...transport, levies: [{ charged: Money.ofPesewas(2_250n), calculated: Money.ofPesewas(2_249n) }] }).reasons).toEqual(['LEVY_DIFFERS']);
  });

  it('refuses a product line that has no quantity in the base unit', () => {
    expect(() => matchLine(line({ qtyBase: null }))).toThrow('a product line carries its quantity in the base unit');
  });
});

describe('the invoice match status (FR-PUR-009)', () => {
  const matched = matchLine(line());
  const mismatch = matchLine(line({ unitPrice: Money.ofPesewas(5_600n) }));
  const expense = matchLine(line({ productId: null, qtyBase: null, order: null }));

  it('is MATCHED only if every payable line matches', () => {
    expect(matchInvoice([matched, expense])).toBe('MATCHED');
    expect(matchInvoice([matched, mismatch])).toBe('MISMATCH');
    expect(matchInvoice([expense, mismatch])).toBe('MISMATCH');
  });

  it('is NOT_REQUIRED when no line needs a match', () => {
    expect(matchInvoice([expense, expense])).toBe('NOT_REQUIRED');
  });

  it('refuses an invoice with no lines', () => {
    expect(() => matchInvoice([])).toThrow('an invoice has at least one line');
  });
});

describe('the match allows exactly the open claims of an order line (ADR-0076)', () => {
  it('matches 30 eggs invoiced against 23 received while a claim for the 7 rejected is open, and reports the variance against what was received', () => {
    const facts = line({ qtyBase: Quantity.parse('30.000'), order: order({ qtyReceived: Quantity.parse('23.000'), qtyClaimed: Quantity.parse('7.000') }) });
    expect(matchLine(facts)).toMatchObject({ status: 'MATCHED', reasons: [], qtyVariance: Quantity.parse('7.000') });
  });

  it('refuses one egg more than received plus claimed, and the claimed eggs once another invoice holds them', () => {
    const over = line({ qtyBase: Quantity.parse('30.001'), order: order({ qtyReceived: Quantity.parse('23.000'), qtyClaimed: Quantity.parse('7.000') }) });
    expect(matchLine(over).reasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
    const again = line({ qtyBase: Quantity.parse('7.000'), order: order({ qtyReceived: Quantity.parse('23.000'), qtyClaimed: Quantity.parse('7.000'), qtyInvoicedElsewhere: Quantity.parse('30.000') }) });
    expect(matchLine(again).reasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
  });

  it('matches as before without a claim', () => {
    expect(matchLine(line({ qtyBase: Quantity.parse('20.001') })).reasons).toEqual(['QTY_EXCEEDS_RECEIVED']);
  });
});
