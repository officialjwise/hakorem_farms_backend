import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkAdjustmentLines, checkStockLines, planTransferReceipt, type StockLineDraft, type StockProduct, type StockUnitState } from './stock-documents';

const goat: StockProduct = { tracking: 'SERIAL', stockPolicy: 'SERIALISED', isLive: true };
const beef: StockProduct = { tracking: 'LOT', stockPolicy: 'CATCH_WEIGHT', isLive: true };
const yam: StockProduct = { tracking: 'NONE', stockPolicy: 'COUNTABLE', isLive: true };
const service: StockProduct = { tracking: 'NONE', stockPolicy: 'NON_STOCK', isLive: true };

const unit = (productId: string, tracking: 'SERIAL' | 'LOT', status = 'ACTIVE'): StockUnitState => ({ productId, tracking, status });
const q = (text: string) => Quantity.parse(text);

function line(productId: string, product: StockProduct, qty: string, stockUnitId: string | null = null, state: StockUnitState | null = null): StockLineDraft {
  return { productId, product, qty: q(qty), stockUnitId, unit: state };
}

describe('the lines of a transfer (FR-INV-010)', () => {
  it('accepts a goat by its tag, a beef lot by its batch and loose yam', () => {
    expect(checkStockLines([line('G', goat, '1.000', 'g1', unit('G', 'SERIAL')), line('B', beef, '10.000', 'b1', unit('B', 'LOT')), line('Y', yam, '40.000')])).toEqual([]);
  });

  it('refuses a transfer with no lines', () => {
    expect(checkStockLines([])).toEqual([{ field: '/lines', rule: 'NO_LINES' }]);
  });

  it('names each broken rule by its line', () => {
    expect(
      checkStockLines([
        line('G', goat, '2.000', 'g1', unit('G', 'SERIAL')),
        line('B', beef, '10.000'),
        line('Y', yam, '1.000', 'b1', unit('B', 'LOT')),
        line('S', service, '1.000'),
        line('B', beef, '1.000', 'g1', unit('G', 'SERIAL')),
        line('B', beef, '1.000', 'b9', unit('B', 'LOT', 'DEPLETED')),
        line('G', { ...goat, isLive: false }, '1.000', 'g2', unit('G', 'SERIAL')),
      ]),
    ).toEqual([
      { field: '/lines/0/qty', rule: 'WHOLE_ANIMALS_ONLY' },
      { field: '/lines/1/stockUnitId', rule: 'STOCK_UNIT_REQUIRED' },
      { field: '/lines/2/stockUnitId', rule: 'PRODUCT_NOT_TRACKED' },
      { field: '/lines/3/productId', rule: 'PRODUCT_NOT_STOCKED' },
      { field: '/lines/4/stockUnitId', rule: 'NOT_FOR_THIS_PRODUCT' },
      { field: '/lines/5/stockUnitId', rule: 'STOCK_UNIT_NOT_ACTIVE' },
      { field: '/lines/6/productId', rule: 'PRODUCT_NOT_ACTIVE' },
    ]);
  });

  it('refuses the same product and unit twice, and the same untracked product twice', () => {
    expect(checkStockLines([line('Y', yam, '1.000'), line('Y', yam, '2.000'), line('G', goat, '1.000', 'g1', unit('G', 'SERIAL')), line('G', goat, '1.000', 'g1', unit('G', 'SERIAL'))])).toEqual([
      { field: '/lines/1', rule: 'LINE_REPEATED' },
      { field: '/lines/3', rule: 'LINE_REPEATED' },
    ]);
  });
});

describe('an adjustment line (FR-INV-012)', () => {
  it('accepts a lot gain from a depleted lot, a lot loss and a yam loss', () => {
    expect(
      checkAdjustmentLines([
        { ...line('B', beef, '0.400', 'b1', unit('B', 'LOT', 'DEPLETED')), direction: 'GAIN' },
        { ...line('B', beef, '2.000', 'b2', unit('B', 'LOT')), direction: 'LOSS' },
        { ...line('Y', yam, '6.000'), direction: 'LOSS' },
      ]),
    ).toEqual([]);
  });

  it('refuses an animal either way: it leaves by a death or a cull with their own controls, and arrives by a receipt or a birth', () => {
    expect(
      checkAdjustmentLines([
        { ...line('G', goat, '1.000', 'g1', unit('G', 'SERIAL')), direction: 'LOSS' },
        { ...line('G', goat, '1.000', 'g2', unit('G', 'SERIAL', 'WRITTEN_OFF')), direction: 'GAIN' },
      ]),
    ).toEqual([
      { field: '/lines/0/productId', rule: 'ANIMAL_NOT_ADJUSTED' },
      { field: '/lines/1/productId', rule: 'ANIMAL_NOT_ADJUSTED' },
    ]);
  });

  it('refuses a loss from a lot that is not active, and keeps the shared line rules', () => {
    expect(
      checkAdjustmentLines([
        { ...line('B', beef, '1.000', 'b1', unit('B', 'LOT', 'DEPLETED')), direction: 'LOSS' },
        { ...line('B', beef, '1.000', 'b2', unit('B', 'LOT', 'SOLD')), direction: 'GAIN' },
        { ...line('B', beef, '1.000'), direction: 'LOSS' },
      ]),
    ).toEqual([
      { field: '/lines/0/stockUnitId', rule: 'STOCK_UNIT_NOT_ACTIVE' },
      { field: '/lines/1/stockUnitId', rule: 'STOCK_UNIT_NOT_ACTIVE' },
      { field: '/lines/2/stockUnitId', rule: 'STOCK_UNIT_REQUIRED' },
    ]);
  });

  it('refuses an adjustment with no lines', () => {
    expect(checkAdjustmentLines([])).toEqual([{ field: '/lines', rule: 'NO_LINES' }]);
  });
});

describe('receiving a transfer: what arrived plus the variance is what was dispatched (FR-INV-011)', () => {
  const dispatched = [
    { lineId: 'L1', qtyDispatched: q('10.000'), serial: false },
    { lineId: 'L2', qtyDispatched: q('1.000'), serial: true },
  ];

  it('records 9.800 received and a 0.200 variance with its reason, and a goat received whole', () => {
    const plan = planTransferReceipt(dispatched, [
      { lineId: 'L1', qtyReceived: q('9.800'), varianceReasonCode: 'DAMAGED' },
      { lineId: 'L2', qtyReceived: q('1.000') },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.lines.map((l) => [l.lineId, l.received.toDecimalString(), l.variance.toDecimalString(), l.reasonCode])).toEqual([
      ['L1', '9.800', '0.200', 'DAMAGED'],
      ['L2', '1.000', '0.000', null],
    ]);
  });

  it('refuses 9.800 received with no reason for the 0.200 shortfall', () => {
    expect(planTransferReceipt(dispatched, [{ lineId: 'L1', qtyReceived: q('9.800') }, { lineId: 'L2', qtyReceived: q('1.000') }])).toEqual({
      ok: false,
      broken: [{ field: '/lines/0/varianceReasonCode', rule: 'VARIANCE_REASON_REQUIRED' }],
    });
  });

  it('refuses more than was dispatched, a reason with no variance, part of an animal, and lines unknown, repeated or missing', () => {
    expect(
      planTransferReceipt(dispatched, [
        { lineId: 'L1', qtyReceived: q('10.001') },
        { lineId: 'L2', qtyReceived: q('1.000'), varianceReasonCode: 'DAMAGED' },
        { lineId: 'L9', qtyReceived: q('1.000') },
        { lineId: 'L2', qtyReceived: q('1.000') },
      ]),
    ).toEqual({
      ok: false,
      broken: [
        { field: '/lines/0/qtyReceived', rule: 'MORE_THAN_DISPATCHED' },
        { field: '/lines/1/varianceReasonCode', rule: 'NO_VARIANCE' },
        { field: '/lines/2/lineId', rule: 'LINE_UNKNOWN' },
        { field: '/lines/3/lineId', rule: 'LINE_REPEATED' },
      ],
    });
    expect(planTransferReceipt(dispatched, [{ lineId: 'L2', qtyReceived: q('0.500'), varianceReasonCode: 'DAMAGED' }])).toEqual({
      ok: false,
      broken: [
        { field: '/lines/0/qtyReceived', rule: 'WHOLE_ANIMALS_ONLY' },
        { field: '/lines', rule: 'LINE_MISSING' },
      ],
    });
  });

  it('records a whole shortfall: nothing arrived, all of it a variance with its reason', () => {
    const plan = planTransferReceipt([dispatched[0]!], [{ lineId: 'L1', qtyReceived: q('0.000'), varianceReasonCode: 'THEFT_SUSPECTED' }]);
    expect(plan.ok && plan.lines[0]!.variance.toDecimalString()).toBe('10.000');
  });
});
