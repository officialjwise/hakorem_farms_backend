import { describe, expect, it } from 'vitest';
import { checkHealthEvent, withdrawalEndsAt, withdrawalDaysFor } from './health';

describe('the end of a withdrawal period (FR-LIV-008)', () => {
  it('ends 28 days after a treatment on 1 November: 29 November at the same time', () => {
    expect(withdrawalEndsAt(new Date('2026-11-01T08:30:00Z'), 28)?.toISOString()).toBe('2026-11-29T08:30:00.000Z');
  });

  it('has no end, and so no hold, with no withdrawal days', () => {
    expect(withdrawalEndsAt(new Date('2026-11-01T08:30:00Z'), 0)).toBeNull();
  });
});

describe('the withdrawal days a health event carries', () => {
  it("defaults to the product's withdrawal days and accepts a longer period", () => {
    expect(withdrawalDaysFor(undefined, 28)).toEqual({ ok: true, value: 28 });
    expect(withdrawalDaysFor(35, 28)).toEqual({ ok: true, value: 35 });
    expect(withdrawalDaysFor(undefined, null)).toEqual({ ok: true, value: 0 });
    expect(withdrawalDaysFor(7, null)).toEqual({ ok: true, value: 7 });
  });

  it("refuses a period shorter than the product's", () => {
    expect(withdrawalDaysFor(14, 28)).toEqual({ ok: false, error: 'WITHDRAWAL_BELOW_PRODUCT' });
  });
});

describe('what a health event must name', () => {
  const base = { hasStockUnit: true, hasLocation: false, hasProduct: true, hasQtyUsed: true, occurredAt: new Date('2026-11-01T08:00:00Z'), now: new Date('2026-11-01T09:00:00Z') };

  it('accepts one animal treated with a product issued from stock, or a pen checked with nothing used', () => {
    expect(checkHealthEvent(base)).toEqual([]);
    expect(checkHealthEvent({ ...base, hasStockUnit: false, hasLocation: true, hasProduct: false, hasQtyUsed: false })).toEqual([]);
  });

  it('refuses neither or both of an animal and a pen', () => {
    expect(checkHealthEvent({ ...base, hasStockUnit: false })).toEqual([{ field: '/stockUnitId', rule: 'ANIMAL_OR_PEN_REQUIRED' }]);
    expect(checkHealthEvent({ ...base, hasLocation: true })).toEqual([{ field: '/locationId', rule: 'ANIMAL_OR_PEN_REQUIRED' }]);
  });

  it('refuses a quantity used without its product, and a product without its quantity', () => {
    expect(checkHealthEvent({ ...base, hasProduct: false })).toEqual([{ field: '/productId', rule: 'PRODUCT_AND_QTY_TOGETHER' }]);
    expect(checkHealthEvent({ ...base, hasQtyUsed: false })).toEqual([{ field: '/qtyUsed', rule: 'PRODUCT_AND_QTY_TOGETHER' }]);
  });

  it('refuses an event dated in the future', () => {
    expect(checkHealthEvent({ ...base, occurredAt: new Date('2026-11-01T09:00:01Z') })).toEqual([{ field: '/occurredAt', rule: 'IN_THE_FUTURE' }]);
  });
});
