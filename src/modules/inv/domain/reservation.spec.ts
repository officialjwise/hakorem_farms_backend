import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { availabilityOf } from './availability';
import { isDue, judgeReservation } from './reservation';

const at = new Date('2026-11-15T10:00:00Z');
const pen = { isLive: true, isVirtual: false, kind: 'PEN' };
const goat = { tracking: 'SERIAL' as const, status: 'ACTIVE', currentLocationId: 'pen' };
const ask = (over: Partial<Parameters<typeof judgeReservation>[0]> = {}) =>
  judgeReservation({ qty: Quantity.parse('1.000'), location: pen, unit: goat, locationId: 'pen', expiresAt: new Date('2026-11-15T10:15:00Z'), at, ...over });

describe('what may be promised (FR-INV-021, ADR-0019)', () => {
  it('a goat where it stands, for fifteen minutes, or open-ended', () => {
    expect(ask()).toEqual({ refusal: null, reason: null });
    expect(ask({ expiresAt: null })).toEqual({ refusal: null, reason: null });
    expect(ask({ unit: null, qty: Quantity.parse('4.000') }).refusal).toBeNull();
  });

  it('a request a caller should never make: nothing, part of a goat, or an expiry already past', () => {
    expect(ask({ qty: Quantity.zero() }).refusal).toBe('INVALID_REQUEST');
    expect(ask({ qty: Quantity.parse('0.500') }).refusal).toBe('INVALID_REQUEST');
    expect(ask({ expiresAt: at }).refusal).toBe('INVALID_REQUEST');
  });

  it('stock that cannot be promised: in transit, at a site, outside, archived, a sold goat, a goat elsewhere', () => {
    expect(ask({ location: { ...pen, kind: 'IN_TRANSIT' } }).refusal).toBe('NOT_AVAILABLE');
    expect(ask({ location: { ...pen, kind: 'SITE' } }).refusal).toBe('NOT_AVAILABLE');
    expect(ask({ location: { ...pen, isVirtual: true, kind: 'CUSTOMER' } }).refusal).toBe('NOT_AVAILABLE');
    expect(ask({ location: { ...pen, isLive: false } }).refusal).toBe('NOT_AVAILABLE');
    expect(ask({ unit: { ...goat, status: 'SOLD' } })).toEqual({ refusal: 'NOT_AVAILABLE', reason: 'the stock unit is SOLD' });
    expect(ask({ locationId: 'shop' }).refusal).toBe('NOT_AVAILABLE');
    expect(ask({ unit: { tracking: 'LOT', status: 'ACTIVE', currentLocationId: null }, qty: Quantity.parse('2.500'), locationId: 'cold' }).refusal).toBeNull();
  });

  it('the expiry job releases an active reservation at or after its expiry, and nothing else', () => {
    expect(isDue({ status: 'ACTIVE', expiresAt: at }, at)).toBe(true);
    expect(isDue({ status: 'ACTIVE', expiresAt: new Date(at.getTime() + 1) }, at)).toBe(false);
    expect(isDue({ status: 'ACTIVE', expiresAt: null }, at)).toBe(false);
    expect(isDue({ status: 'CONSUMED', expiresAt: at }, at)).toBe(false);
  });
});

describe('available to promise is on hand less reserved less held (FR-INV-021)', () => {
  const q = Quantity.parse;
  it('3 goats on hand, 1 under a hold: 2 available, low', () => {
    expect(availabilityOf({ onHand: q('3.000'), reserved: q('0.000'), held: q('1.000') })).toEqual({ available: q('2.000'), availability: 'LOW_STOCK' });
  });
  it('the boundary at five is low; above it is in stock; none, or below zero after offline sales, is out of stock', () => {
    expect(availabilityOf({ onHand: q('7.000'), reserved: q('2.000'), held: q('0.000') }).availability).toBe('LOW_STOCK');
    expect(availabilityOf({ onHand: q('5.001'), reserved: q('0.000'), held: q('0.000') }).availability).toBe('IN_STOCK');
    expect(availabilityOf({ onHand: q('3.000'), reserved: q('3.000'), held: q('0.000') })).toEqual({ available: q('0.000'), availability: 'OUT_OF_STOCK' });
    expect(availabilityOf({ onHand: q('-2.000'), reserved: q('0.000'), held: q('0.000') })).toEqual({ available: q('-2.000'), availability: 'OUT_OF_STOCK' });
  });
});
