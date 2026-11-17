import { describe, expect, it } from 'vitest';
import { oldestFirst, type PickKey } from './oldest-first';

const at = (iso: string) => new Date(iso);
const key = (name: string, expiresOn: string | null, receivedAt: string | null, locationId = 'L1'): PickKey & { name: string } => ({
  name,
  expiresOn,
  receivedAt: receivedAt === null ? null : at(receivedAt),
  stockUnitId: `unit-${name}`,
  locationId,
});
const order = (keys: ReadonlyArray<PickKey & { name: string }>) => [...keys].sort(oldestFirst).map((k) => k.name);

describe('oldest first: by expiry, then by received date (B09e continued, the owner\'s decision 4)', () => {
  it('puts the lot that expires first first, even when it was received later', () => {
    const olderReceivedLaterExpiry = key('older', '2026-12-10', '2026-11-10T08:00:00Z');
    const newerReceivedEarlierExpiry = key('newer', '2026-12-01', '2026-11-15T08:00:00Z');
    expect(order([olderReceivedLaterExpiry, newerReceivedEarlierExpiry])).toEqual(['newer', 'older']);
  });

  it('breaks a tie on expiry by the received date, earliest first, whatever the unit ids say', () => {
    // The ids run a, b, c (UUIDv7 in creation order); the received dates run c, a, b.
    const keys = [key('a', '2026-12-01', '2026-11-12T08:00:00Z'), key('b', '2026-12-01', '2026-11-13T08:00:00Z'), key('c', '2026-12-01', '2026-11-11T08:00:00Z')];
    expect(order(keys)).toEqual(['c', 'a', 'b']);
  });

  it('puts a lot with no expiry after every dated one, and one with no received date after every received one', () => {
    expect(order([key('undated', null, '2026-11-01T08:00:00Z'), key('dated', '2027-01-01', '2026-11-20T08:00:00Z')])).toEqual(['dated', 'undated']);
    expect(order([key('unreceived', '2026-12-01', null), key('received', '2026-12-01', '2026-11-20T08:00:00Z')])).toEqual(['received', 'unreceived']);
    expect(order([key('none', null, null), key('received', null, '2026-11-20T08:00:00Z')])).toEqual(['received', 'none']);
  });

  it('keeps a full tie stable by unit, an untracked balance first, then by location', () => {
    const untracked: PickKey & { name: string } = { name: 'untracked', expiresOn: null, receivedAt: null, stockUnitId: null, locationId: 'L1' };
    expect(order([key('x', null, null), untracked])).toEqual(['untracked', 'x']);
    const sameUnit = [{ ...key('second', null, null, 'L2') }, { ...key('first', null, null, 'L1'), stockUnitId: 'unit-second' }];
    expect(order(sameUnit)).toEqual(['first', 'second']);
    expect(oldestFirst(key('same', '2026-12-01', '2026-11-20T08:00:00Z'), key('same', '2026-12-01', '2026-11-20T08:00:00Z'))).toBe(0);
  });

  it('answers each comparison both ways, so any sort agrees', () => {
    const pairs: ReadonlyArray<readonly [PickKey, PickKey]> = [
      [key('a', '2026-12-01', null), key('b', '2026-12-02', null)],
      [key('a', '2026-12-01', '2026-11-10T08:00:00Z'), key('a', '2026-12-01', '2026-11-11T08:00:00Z')],
      [{ ...key('a', null, null), stockUnitId: 'unit-a' }, { ...key('a', null, null), stockUnitId: 'unit-b' }],
      [key('a', null, null, 'L1'), key('a', null, null, 'L2')],
      [key('a', '2026-12-01', null), key('a', null, null)],
      [key('a', null, '2026-11-10T08:00:00Z'), key('a', null, null)],
      [{ ...key('a', null, null), stockUnitId: null }, key('a', null, null)],
    ];
    for (const [first, second] of pairs) {
      expect(oldestFirst(first, second)).toBe(-1);
      expect(oldestFirst(second, first)).toBe(1);
    }
  });
});
