import { describe, expect, it } from 'vitest';
import { isVirtualKind, planBranchStatus, planLocation, planLocationArchive, planLocationChange, VIRTUAL_KINDS } from './locations';

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

  const unused = { holdsStock: false, openDocuments: 0 };

  it('refuses to archive a virtual location or one with live children', () => {
    expect(planLocationArchive({ isVirtual: true, liveChildren: 0, usage: unused })).toEqual({ ok: false, error: [{ field: null, rule: 'VIRTUAL_LOCATION_FIXED' }] });
    expect(planLocationArchive({ isVirtual: false, liveChildren: 2, usage: unused })).toEqual({ ok: false, error: [{ field: null, rule: 'HAS_LIVE_CHILDREN' }] });
    expect(planLocationArchive({ isVirtual: false, liveChildren: 0, usage: unused })).toEqual({ ok: true, value: undefined });
  });

  it('refuses to archive a location holding stock or named by an open document, naming every reason (A-111, ADR-0051)', () => {
    expect(planLocationArchive({ isVirtual: false, liveChildren: 0, usage: { holdsStock: true, openDocuments: 0 } })).toEqual({ ok: false, error: [{ field: null, rule: 'HOLDS_STOCK' }] });
    expect(planLocationArchive({ isVirtual: false, liveChildren: 1, usage: { holdsStock: true, openDocuments: 2 } })).toEqual({
      ok: false,
      error: [
        { field: null, rule: 'HAS_LIVE_CHILDREN' },
        { field: null, rule: 'HOLDS_STOCK' },
        { field: null, rule: 'OPEN_DOCUMENTS' },
      ],
    });
  });
});

describe('planBranchStatus: closing and reopening a branch (FR-MDM-006, B05x)', () => {
  const branch = { from: 'ACTIVE' as const, to: 'CLOSED' as const, isFarmBranch: false, isTest: false, otherActiveBranches: 1, usage: { holdsStock: false, openDocuments: 0 } };

  it('closes an unused branch while another stays open, and reopens a closed one without a check', () => {
    expect(planBranchStatus(branch)).toEqual({ ok: true, value: 'CLOSE' });
    expect(planBranchStatus({ ...branch, from: 'CLOSED', to: 'ACTIVE', isFarmBranch: true, otherActiveBranches: 0, usage: { holdsStock: true, openDocuments: 3 } })).toEqual({ ok: true, value: 'REOPEN' });
  });

  it('changes nothing when the status asked for is the status it has', () => {
    expect(planBranchStatus({ ...branch, to: 'ACTIVE', usage: { holdsStock: true, openDocuments: 1 } })).toEqual({ ok: true, value: 'NONE' });
    expect(planBranchStatus({ ...branch, from: 'CLOSED' })).toEqual({ ok: true, value: 'NONE' });
  });

  it("refuses to close the farm's own branch", () => {
    expect(planBranchStatus({ ...branch, isFarmBranch: true })).toEqual({ ok: false, error: [{ field: '/status', rule: 'FARM_BRANCH' }] });
  });

  it('refuses to close the last open trading branch, but closes a smoke-test branch with none left', () => {
    expect(planBranchStatus({ ...branch, otherActiveBranches: 0 })).toEqual({ ok: false, error: [{ field: '/status', rule: 'LAST_ACTIVE_BRANCH' }] });
    expect(planBranchStatus({ ...branch, isTest: true, otherActiveBranches: 0 })).toEqual({ ok: true, value: 'CLOSE' });
  });

  it('refuses to close a branch holding stock or open documents, naming every reason at once', () => {
    expect(planBranchStatus({ ...branch, usage: { holdsStock: true, openDocuments: 0 } })).toEqual({ ok: false, error: [{ field: '/status', rule: 'HOLDS_STOCK' }] });
    expect(planBranchStatus({ ...branch, isFarmBranch: true, otherActiveBranches: 0, usage: { holdsStock: true, openDocuments: 4 } })).toEqual({
      ok: false,
      error: [
        { field: '/status', rule: 'FARM_BRANCH' },
        { field: '/status', rule: 'LAST_ACTIVE_BRANCH' },
        { field: '/status', rule: 'HOLDS_STOCK' },
        { field: '/status', rule: 'OPEN_DOCUMENTS' },
      ],
    });
  });
});
