import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkReorderLevels, daysToExpiry, DEFAULT_EXPIRY_ALERT_DAYS, expiryKind, expiryLeadDays, judgeExpiry, judgeLevels, suggestedQty, type ReorderLevels } from './stock-alert';

const q = (text: string) => Quantity.parse(text);
const feed: ReorderLevels = { minQty: q('10.000'), reorderPointQty: q('20.000'), maxQty: q('100.000') };

describe('reorder levels (FR-INV-015)', () => {
  it('accepts a minimum at or under the reorder point at or under a maximum, and a lead time of 1 to 365 days', () => {
    expect(checkReorderLevels(feed, null)).toEqual([]);
    expect(checkReorderLevels({ minQty: q('0.000'), reorderPointQty: q('0.000'), maxQty: q('1.000') }, 1)).toEqual([]);
    expect(checkReorderLevels(feed, 365)).toEqual([]);
  });

  it('refuses a reorder point under the minimum, a maximum under the reorder point or at zero, and a lead time out of range', () => {
    expect(checkReorderLevels({ minQty: q('10.000'), reorderPointQty: q('9.999'), maxQty: q('5.000') }, 0)).toEqual([
      { field: '/reorderPointQty', rule: 'BELOW_MINIMUM' },
      { field: '/maxQty', rule: 'BELOW_REORDER_POINT' },
      { field: '/expiryAlertDays', rule: 'OUT_OF_RANGE' },
    ]);
    expect(checkReorderLevels({ minQty: q('0.000'), reorderPointQty: q('0.000'), maxQty: q('0.000') }, 366)).toEqual([
      { field: '/maxQty', rule: 'MAXIMUM_REQUIRED' },
      { field: '/expiryAlertDays', rule: 'OUT_OF_RANGE' },
    ]);
    expect(checkReorderLevels(feed, 2.5)).toEqual([{ field: '/expiryAlertDays', rule: 'OUT_OF_RANGE' }]);
  });

  it('suggests what reaches the maximum, exactly, and nothing at or above it', () => {
    expect(suggestedQty(q('19.000'), q('100.000')).toDecimalString()).toBe('81.000');
    expect(suggestedQty(Quantity.parse('-2.500'), q('100.000')).toDecimalString()).toBe('102.500');
    expect(suggestedQty(q('100.000'), q('100.000')).toDecimalString()).toBe('0.000');
    expect(suggestedQty(q('120.000'), q('100.000')).toDecimalString()).toBe('0.000');
  });
});

describe('one low-stock alert per crossing (FR-INV-015 acceptance)', () => {
  it('raises nothing above the reorder point, and LOW_STOCK at it with the suggestion to reach the maximum', () => {
    expect(judgeLevels(q('21.000'), feed, new Set())).toEqual({ raise: [], clear: [] });
    const at = judgeLevels(q('20.000'), feed, new Set());
    expect(at.raise.map((r) => [r.kind, r.thresholdQty.toDecimalString(), r.suggestedQty.toDecimalString()])).toEqual([['LOW_STOCK', '20.000', '80.000']]);
    const below = judgeLevels(q('19.000'), feed, new Set());
    expect(below.raise.map((r) => r.suggestedQty.toDecimalString())).toEqual(['81.000']);
  });

  it('raises no second alert while one is open, and clears it once stock rises above the point', () => {
    expect(judgeLevels(q('18.000'), feed, new Set(['LOW_STOCK']))).toEqual({ raise: [], clear: [] });
    expect(judgeLevels(q('20.000'), feed, new Set(['LOW_STOCK']))).toEqual({ raise: [], clear: [] });
    expect(judgeLevels(q('20.001'), feed, new Set(['LOW_STOCK']))).toEqual({ raise: [], clear: ['LOW_STOCK'] });
  });

  it('raises BELOW_MINIMUM under the minimum only, and clears it at the minimum', () => {
    expect(judgeLevels(q('10.000'), feed, new Set(['LOW_STOCK'])).raise).toEqual([]);
    const under = judgeLevels(q('9.999'), feed, new Set(['LOW_STOCK']));
    expect(under.raise.map((r) => [r.kind, r.thresholdQty.toDecimalString(), r.suggestedQty.toDecimalString()])).toEqual([['BELOW_MINIMUM', '10.000', '90.001']]);
    expect(judgeLevels(q('10.000'), feed, new Set(['LOW_STOCK', 'BELOW_MINIMUM']))).toEqual({ raise: [], clear: ['BELOW_MINIMUM'] });
    expect(judgeLevels(q('50.000'), feed, new Set(['LOW_STOCK', 'BELOW_MINIMUM']))).toEqual({ raise: [], clear: ['LOW_STOCK', 'BELOW_MINIMUM'] });
  });

  it('raises both at once when stock falls from above the point to under the minimum', () => {
    expect(judgeLevels(q('-1.000'), feed, new Set()).raise.map((r) => r.kind)).toEqual(['LOW_STOCK', 'BELOW_MINIMUM']);
  });
});

describe('expiring and expired lots (FR-INV-016 acceptance)', () => {
  it('counts whole days to expiry in calendar dates', () => {
    expect(daysToExpiry('2026-11-16', '2026-11-13')).toBe(3);
    expect(daysToExpiry('2026-11-16', '2026-11-16')).toBe(0);
    expect(daysToExpiry('2026-11-16', '2026-11-17')).toBe(-1);
    expect(daysToExpiry('2027-03-01', '2027-02-27')).toBe(2);
  });

  it('takes the rule\'s lead time, or the seeded three days', () => {
    expect(DEFAULT_EXPIRY_ALERT_DAYS).toBe(3);
    expect(expiryLeadDays(null)).toBe(3);
    expect(expiryLeadDays(undefined)).toBe(3);
    expect(expiryLeadDays(5)).toBe(5);
  });

  it('alerts a lot expiring on 16 November on the 13th, not the 12th, and marks it expired on the 17th', () => {
    expect(expiryKind('2026-11-16', '2026-11-12', 3)).toBeNull();
    expect(expiryKind('2026-11-16', '2026-11-13', 3)).toBe('EXPIRING');
    expect(expiryKind('2026-11-16', '2026-11-16', 3)).toBe('EXPIRING');
    expect(expiryKind('2026-11-16', '2026-11-17', 3)).toBe('EXPIRED');
  });

  it('raises once, moves an expiring alert to expired, and clears everything when the lot is gone', () => {
    const lot = { expiresOn: '2026-11-16', onHand: q('12.000') };
    expect(judgeExpiry(lot, '2026-11-13', 3, new Set())).toEqual({ raise: 'EXPIRING', clear: [] });
    expect(judgeExpiry(lot, '2026-11-14', 3, new Set(['EXPIRING']))).toEqual({ raise: null, clear: [] });
    expect(judgeExpiry(lot, '2026-11-17', 3, new Set(['EXPIRING']))).toEqual({ raise: 'EXPIRED', clear: ['EXPIRING'] });
    expect(judgeExpiry({ ...lot, onHand: q('0.000') }, '2026-11-17', 3, new Set(['EXPIRED', 'EXPIRING']))).toEqual({ raise: null, clear: ['EXPIRED', 'EXPIRING'] });
    expect(judgeExpiry(lot, '2026-11-01', 3, new Set(['EXPIRING']))).toEqual({ raise: null, clear: ['EXPIRING'] });
  });
});
