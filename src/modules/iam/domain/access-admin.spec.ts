import { describe, expect, it } from 'vitest';
import {
  accountStatus,
  formatTemporaryPassword,
  judgeGrant,
  realmOfRole,
  TEMPORARY_PASSWORD_BYTES,
  wouldRemoveLastOwner,
  type GrantPlan,
} from './access-admin';

const now = new Date('2026-11-15T08:00:00Z');
const plan = (overrides: Partial<GrantPlan> = {}): GrantPlan => ({
  granterId: 'granter',
  granteeId: 'grantee',
  granteeRealm: 'STAFF',
  roleCode: 'CASHIER',
  rolePermissions: ['pos.sale.create', 'mdm.product.read'],
  granterPermissions: new Set(['pos.sale.create', 'mdm.product.read', 'iam.grant.manage']),
  branchId: 'ddw',
  locationBranchId: undefined,
  validFrom: now,
  validTo: null,
  ...overrides,
});

describe('a grant is judged before it is written (FR-IAM-022, ADR-0017)', () => {
  it('passes a role whose every permission the granter holds at the scope', () => {
    expect(judgeGrant(plan())).toEqual({ kind: 'OK' });
  });

  it('refuses a grant to the granter themselves, whatever the role', () => {
    expect(judgeGrant(plan({ granteeId: 'granter' }))).toEqual({ kind: 'FORBIDDEN', reason: 'SELF_GRANT', missing: [] });
  });

  it('refuses a role holding a permission the granter does not hold, naming each missing permission in order', () => {
    expect(judgeGrant(plan({ rolePermissions: ['fin.journal.post', 'pos.sale.create', 'cap.distribution.post'] }))).toEqual({
      kind: 'FORBIDDEN',
      reason: 'ROLE_EXCEEDS_GRANTER',
      missing: ['cap.distribution.post', 'fin.journal.post'],
    });
  });

  it('refuses a location of another branch, an unknown location, a window that ends before it starts, and a role of another realm', () => {
    expect(judgeGrant(plan({ locationBranchId: 'tst' }))).toEqual({ kind: 'INVALID', rules: [{ field: '/locationId', rule: 'LOCATION_NOT_IN_BRANCH' }] });
    expect(judgeGrant(plan({ locationBranchId: null }))).toEqual({ kind: 'INVALID', rules: [{ field: '/locationId', rule: 'LOCATION_NOT_IN_BRANCH' }] });
    expect(judgeGrant(plan({ validTo: now }))).toEqual({ kind: 'INVALID', rules: [{ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' }] });
    expect(judgeGrant(plan({ roleCode: 'INVESTOR' }))).toEqual({ kind: 'INVALID', rules: [{ field: '/roleId', rule: 'ROLE_NOT_FOR_REALM' }] });
    expect(judgeGrant(plan({ granteeRealm: 'CUSTOMER' }))).toEqual({ kind: 'INVALID', rules: [{ field: '/roleId', rule: 'ROLE_NOT_FOR_REALM' }] });
  });

  it('passes a location of the grant branch and a window that ends after it starts', () => {
    expect(judgeGrant(plan({ locationBranchId: 'ddw', validTo: new Date(now.getTime() + 1) }))).toEqual({ kind: 'OK' });
  });

  it('judges who may grant before what is granted: a self-grant of a bad window is still a refusal', () => {
    expect(judgeGrant(plan({ granteeId: 'granter', validTo: now })).kind).toBe('FORBIDDEN');
  });
});

describe('roles belong to realms', () => {
  it('gives the customer and investor roles their own realms and every other role the staff realm', () => {
    expect(realmOfRole('CUSTOMER')).toBe('CUSTOMER');
    expect(realmOfRole('INVESTOR')).toBe('INVESTOR');
    expect(realmOfRole('OWNER')).toBe('STAFF');
    expect(realmOfRole('BUTCHER')).toBe('STAFF');
  });
});

describe('an account shows one status', () => {
  it('is DISABLED when its principal is, LOCKED while a lock runs, otherwise ACTIVE', () => {
    expect(accountStatus('DISABLED', new Date(now.getTime() + 60_000), now)).toBe('DISABLED');
    expect(accountStatus('ACTIVE', new Date(now.getTime() + 1), now)).toBe('LOCKED');
    expect(accountStatus('ACTIVE', now, now)).toBe('ACTIVE');
    expect(accountStatus('ACTIVE', null, now)).toBe('ACTIVE');
  });
});

describe('the last owner stays', () => {
  it('refuses a change that leaves no other active owner, and allows it when another remains or the target holds no owner grant', () => {
    expect(wouldRemoveLastOwner({ targetHoldsOwner: true, otherActiveOwners: 0 })).toBe(true);
    expect(wouldRemoveLastOwner({ targetHoldsOwner: true, otherActiveOwners: 1 })).toBe(false);
    expect(wouldRemoveLastOwner({ targetHoldsOwner: false, otherActiveOwners: 0 })).toBe(false);
  });
});

describe('a temporary password (FR-IAM-001)', () => {
  it('is four groups of four from an unambiguous alphabet, 19 characters, from exactly 16 random bytes', () => {
    const bytes = Uint8Array.from({ length: TEMPORARY_PASSWORD_BYTES }, (_, index) => index * 17);
    const password = formatTemporaryPassword(bytes);
    expect(password).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(password).toHaveLength(19);
    expect(formatTemporaryPassword(bytes)).toBe(password);
  });

  it('refuses a source of the wrong length', () => {
    expect(() => formatTemporaryPassword(new Uint8Array(15))).toThrow(/16 random bytes/);
  });
});
