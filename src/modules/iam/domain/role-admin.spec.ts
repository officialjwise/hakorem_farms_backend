import { describe, expect, it } from 'vitest';
import { judgeRoleChange, planRolePermissions, type RoleChangePlan } from './role-admin';

const held = new Set(['pos.sale.create', 'pos.shift.open', 'pos.shift.close', 'iam.role.manage']);
const known = new Set([...held, 'fin.journal.post', 'mdm.price_list.approve']);

const plan = (overrides: Partial<RoleChangePlan> = {}): RoleChangePlan => ({
  roleCode: 'SHOP_SUPERVISOR',
  actorHoldsRole: false,
  actorPermissions: held,
  knownPermissions: known,
  added: ['pos.sale.create'],
  removed: [],
  requiresTotp: false,
  limitKinds: ['PRICE_OVERRIDE_PER_LINE'],
  ...overrides,
});

describe('planRolePermissions', () => {
  it('lists what is added and what is removed, each once and sorted', () => {
    expect(planRolePermissions(['b', 'a'], ['c', 'a', 'c'])).toEqual({ added: ['c'], removed: ['b'] });
    expect(planRolePermissions([], ['x'])).toEqual({ added: ['x'], removed: [] });
  });
});

describe('judgeRoleChange (FR-IAM-008, FR-IAM-022, A-122)', () => {
  it('accepts a change made of permissions the actor holds', () => {
    expect(judgeRoleChange(plan())).toEqual({ kind: 'OK' });
  });

  it('refuses a change to a role the actor holds: nobody changes their own access', () => {
    expect(judgeRoleChange(plan({ actorHoldsRole: true }))).toEqual({ kind: 'FORBIDDEN', reason: 'SELF_ADMINISTRATION', missing: [] });
  });

  it('refuses adding or removing a permission the actor does not hold, naming it', () => {
    expect(judgeRoleChange(plan({ added: ['mdm.price_list.approve', 'pos.sale.create'], removed: ['fin.journal.post'] }))).toEqual({
      kind: 'FORBIDDEN',
      reason: 'PERMISSION_BEYOND_ACTOR',
      missing: ['fin.journal.post', 'mdm.price_list.approve'],
    });
  });

  it('names an unknown permission code before judging whether the actor holds it', () => {
    expect(judgeRoleChange(plan({ added: ['inv.nothing.here'] }))).toEqual({ kind: 'INVALID', rules: [{ field: '/permissions', rule: 'UNKNOWN_PERMISSION' }] });
  });

  it('keeps TOTP on the Owner, Manager and Accountant roles (FR-IAM-006)', () => {
    for (const roleCode of ['OWNER', 'MANAGER', 'ACCOUNTANT']) {
      expect(judgeRoleChange(plan({ roleCode, requiresTotp: false, added: [] }))).toEqual({ kind: 'INVALID', rules: [{ field: '/requiresTotp', rule: 'TOTP_REQUIRED_FOR_ROLE' }] });
      expect(judgeRoleChange(plan({ roleCode, requiresTotp: true, added: [] }))).toEqual({ kind: 'OK' });
    }
  });

  it('refuses the same limit kind twice', () => {
    expect(judgeRoleChange(plan({ limitKinds: ['PRICE_OVERRIDE_PER_LINE', 'PRICE_OVERRIDE_PER_LINE'] }))).toEqual({
      kind: 'INVALID',
      rules: [{ field: '/limits', rule: 'DUPLICATE_LIMIT_KIND' }],
    });
  });

  it('reports every broken rule together', () => {
    expect(judgeRoleChange(plan({ roleCode: 'MANAGER', added: ['nope.nope.nope'], limitKinds: ['A', 'A'] }))).toEqual({
      kind: 'INVALID',
      rules: [
        { field: '/permissions', rule: 'UNKNOWN_PERMISSION' },
        { field: '/requiresTotp', rule: 'TOTP_REQUIRED_FOR_ROLE' },
        { field: '/limits', rule: 'DUPLICATE_LIMIT_KIND' },
      ],
    });
  });
});
