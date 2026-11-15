import { describe, expect, it } from 'vitest';
import { isVirtualKind, planLocation, planLocationArchive, planLocationChange, VIRTUAL_KINDS } from './locations';

describe('planLocation (FR-MDM-006)', () => {
  const pen = { kind: 'PEN' as const, parent: null, tempClass: undefined, tempMinC: undefined, tempMaxC: undefined };

  it('lists the eight virtual kinds of ADR-0002', () => {
    expect(VIRTUAL_KINDS).toEqual(['SUPPLIER', 'CUSTOMER', 'PRODUCTION', 'PROCESSING', 'CONSUMPTION', 'LOSS', 'ADJUSTMENT', 'OPENING']);
    expect(isVirtualKind('LOSS')).toBe(true);
    expect(isVirtualKind('PEN')).toBe(false);
  });

  it('accepts a pen under a physical location of the same branch', () => {
    expect(planLocation({ ...pen, parent: { sameBranch: true, isVirtual: false } })).toEqual({ ok: true, value: { tempClass: null } });
  });

  it('refuses a parent in another branch and a virtual parent', () => {
    expect(planLocation({ ...pen, parent: { sameBranch: false, isVirtual: false } })).toEqual({ ok: false, error: [{ field: '/parentId', rule: 'PARENT_IN_OTHER_BRANCH' }] });
    expect(planLocation({ ...pen, parent: { sameBranch: true, isVirtual: true } })).toEqual({ ok: false, error: [{ field: '/parentId', rule: 'PARENT_IS_VIRTUAL' }] });
  });

  it('refuses a virtual kind: each branch is given its virtual locations when it is created', () => {
    expect(planLocation({ ...pen, kind: 'LOSS' })).toEqual({ ok: false, error: [{ field: '/kind', rule: 'VIRTUAL_KIND_FIXED' }] });
  });

  it('needs a cold room to carry its temperature class and range, the range rising', () => {
    const cold = { ...pen, kind: 'COLD_ROOM' as const };
    expect(planLocation(cold)).toEqual({
      ok: false,
      error: [
        { field: '/tempClass', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' },
        { field: '/tempMinC', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' },
        { field: '/tempMaxC', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' },
      ],
    });
    expect(planLocation({ ...cold, tempClass: 'AMBIENT', tempMinC: '-25.0', tempMaxC: '-18.0' })).toEqual({ ok: false, error: [{ field: '/tempClass', rule: 'COLD_ROOM_NEEDS_TEMPERATURE' }] });
    expect(planLocation({ ...cold, tempClass: 'FROZEN', tempMinC: '-18.0', tempMaxC: '-25.0' })).toEqual({ ok: false, error: [{ field: '/tempMaxC', rule: 'NOT_ABOVE_MIN' }] });
    expect(planLocation({ ...cold, tempClass: 'FROZEN', tempMinC: '-25.0', tempMaxC: '-18.0' })).toEqual({ ok: true, value: { tempClass: 'FROZEN' } });
  });

  it('accepts a store with a range of its own and refuses one that does not rise', () => {
    expect(planLocation({ ...pen, kind: 'STORE', tempMinC: '2.0', tempMaxC: '8.0' })).toMatchObject({ ok: true });
    expect(planLocation({ ...pen, kind: 'STORE', tempMinC: '8.0', tempMaxC: '8.0' })).toEqual({ ok: false, error: [{ field: '/tempMaxC', rule: 'NOT_ABOVE_MIN' }] });
  });
});

describe('planLocationChange and planLocationArchive (FR-MDM-006)', () => {
  it('refuses any change to a virtual location', () => {
    expect(planLocationChange({ isVirtual: true, kind: 'LOSS', tempMinC: null, tempMaxC: null }, {})).toEqual({ ok: false, error: [{ field: null, rule: 'VIRTUAL_LOCATION_FIXED' }] });
  });

  it('keeps a cold room range rising after a partial change', () => {
    const cold = { isVirtual: false, kind: 'COLD_ROOM' as const, tempMinC: '-25.0', tempMaxC: '-18.0' };
    expect(planLocationChange(cold, { tempMinC: '-17.0' })).toEqual({ ok: false, error: [{ field: '/tempMaxC', rule: 'NOT_ABOVE_MIN' }] });
    expect(planLocationChange(cold, { tempMaxC: '-15.0' })).toEqual({ ok: true, value: undefined });
  });

  it('refuses a new parent in another branch, a virtual parent, or the location itself or below it', () => {
    const shop = { isVirtual: false, kind: 'SHOP_FLOOR' as const, tempMinC: null, tempMaxC: null };
    expect(planLocationChange(shop, { parent: { sameBranch: false, isVirtual: false, isSelfOrBelow: false } })).toEqual({ ok: false, error: [{ field: '/parentId', rule: 'PARENT_IN_OTHER_BRANCH' }] });
    expect(planLocationChange(shop, { parent: { sameBranch: true, isVirtual: true, isSelfOrBelow: false } })).toEqual({ ok: false, error: [{ field: '/parentId', rule: 'PARENT_IS_VIRTUAL' }] });
    expect(planLocationChange(shop, { parent: { sameBranch: true, isVirtual: false, isSelfOrBelow: true } })).toEqual({ ok: false, error: [{ field: '/parentId', rule: 'PARENT_IS_SELF_OR_BELOW' }] });
    expect(planLocationChange(shop, { parent: { sameBranch: true, isVirtual: false, isSelfOrBelow: false } })).toEqual({ ok: true, value: undefined });
  });

  it('refuses to archive a virtual location or one with live children', () => {
    expect(planLocationArchive({ isVirtual: true, liveChildren: 0 })).toEqual({ ok: false, error: [{ field: null, rule: 'VIRTUAL_LOCATION_FIXED' }] });
    expect(planLocationArchive({ isVirtual: false, liveChildren: 2 })).toEqual({ ok: false, error: [{ field: null, rule: 'HAS_LIVE_CHILDREN' }] });
    expect(planLocationArchive({ isVirtual: false, liveChildren: 0 })).toEqual({ ok: true, value: undefined });
  });
});
