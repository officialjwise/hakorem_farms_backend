import { describe, expect, it } from 'vitest';
import { decideAccess, type GrantScope } from './authorisation-policy';

const DODOWA = '019a7a83-2aef-79e3-9f1b-a708a7ae1fe6';
const KASOA = '019a7a83-49de-7e1c-8a2d-2b4c6d8e0f12';
const SHOP = '019a7a84-7f34-76a9-8be1-736ae249ec48';
const PENS = '019a7a84-9e23-7a0b-9c1d-3e5f7a9b1c2d';
const CASHIER = '019a7a86-ac02-78a8-ade0-935170bb0c2f';
const MANAGER = '019a7a86-4f35-7afd-b035-b8ab03a83188';

const shopCashier: readonly GrantScope[] = [{ branchId: DODOWA, locationId: SHOP }];
const branchManager: readonly GrantScope[] = [{ branchId: DODOWA, locationId: null }];

describe('the authorisation decision (ADR-0017, deny by default)', () => {
  it('refuses an actor who holds the permission through no grant', () => {
    expect(decideAccess({ grantsWithPermission: [], scope: {} })).toEqual({ allowed: false, reason: 'NO_GRANT' });
  });

  it('allows an actor with a grant when the action names no branch', () => {
    expect(decideAccess({ grantsWithPermission: shopCashier, scope: {} })).toEqual({ allowed: true });
  });

  it('refuses a cashier at the Dodowa shop acting at another branch', () => {
    expect(decideAccess({ grantsWithPermission: shopCashier, scope: { branchId: KASOA } })).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });

  it('refuses a cashier granted only the shop floor acting at the pens of the same branch', () => {
    expect(decideAccess({ grantsWithPermission: shopCashier, scope: { branchId: DODOWA, locationId: PENS } })).toEqual({
      allowed: false,
      reason: 'OUT_OF_SCOPE',
    });
  });

  it('allows a branch-wide grant at any location of that branch', () => {
    expect(decideAccess({ grantsWithPermission: branchManager, scope: { branchId: DODOWA, locationId: PENS } })).toEqual({ allowed: true });
  });

  it('allows a location grant at that location', () => {
    expect(decideAccess({ grantsWithPermission: shopCashier, scope: { branchId: DODOWA, locationId: SHOP } })).toEqual({ allowed: true });
  });

  it("refuses an actor reaching someone else's record without the permission for anyone's", () => {
    const decision = decideAccess({
      grantsWithPermission: shopCashier,
      scope: { owner: { principalId: MANAGER, actorPrincipalId: CASHIER, holdsAnyPermission: false } },
    });
    expect(decision).toEqual({ allowed: false, reason: 'NOT_OWNER' });
  });

  it('allows the owner of a record, and anyone holding the permission for any record', () => {
    expect(
      decideAccess({ grantsWithPermission: shopCashier, scope: { owner: { principalId: CASHIER, actorPrincipalId: CASHIER, holdsAnyPermission: false } } }),
    ).toEqual({ allowed: true });
    expect(
      decideAccess({ grantsWithPermission: branchManager, scope: { owner: { principalId: CASHIER, actorPrincipalId: MANAGER, holdsAnyPermission: true } } }),
    ).toEqual({ allowed: true });
  });

  it('checks scope before ownership, so an owner outside the branch is still refused', () => {
    const decision = decideAccess({
      grantsWithPermission: shopCashier,
      scope: { branchId: KASOA, owner: { principalId: CASHIER, actorPrincipalId: CASHIER, holdsAnyPermission: false } },
    });
    expect(decision).toEqual({ allowed: false, reason: 'OUT_OF_SCOPE' });
  });
});
