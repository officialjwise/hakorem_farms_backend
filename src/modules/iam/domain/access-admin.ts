/**
 * The rules of user and grant administration (FR-IAM-001, FR-IAM-015, FR-IAM-022, ADR-0017). Pure: the handler
 * reads the facts and hands them in.
 */
export type AccountRealm = 'STAFF' | 'CUSTOMER' | 'INVESTOR';
export type AccountStatus = 'ACTIVE' | 'DISABLED' | 'LOCKED';

export interface GrantPlan {
  readonly granterId: string;
  readonly granteeId: string;
  readonly granteeRealm: AccountRealm;
  readonly roleCode: string;
  readonly rolePermissions: readonly string[];
  /** What the granter holds through current grants covering the grant's branch and location. */
  readonly granterPermissions: ReadonlySet<string>;
  readonly branchId: string;
  /** The branch of the named location: undefined when no location is named, null when it names no live location. */
  readonly locationBranchId: string | null | undefined;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

export interface GrantRuleBroken {
  readonly field: string;
  readonly rule: 'LOCATION_NOT_IN_BRANCH' | 'NOT_AFTER_VALID_FROM' | 'ROLE_NOT_FOR_REALM';
}

export type GrantJudgement =
  | { readonly kind: 'OK' }
  | { readonly kind: 'FORBIDDEN'; readonly reason: 'SELF_GRANT' | 'ROLE_EXCEEDS_GRANTER'; readonly missing: readonly string[] }
  | { readonly kind: 'INVALID'; readonly rules: readonly GrantRuleBroken[] };

/** The realm a role may be granted in: the customer and investor roles have their own; every other role is staff. */
export function realmOfRole(roleCode: string): AccountRealm {
  if (roleCode === 'CUSTOMER') return 'CUSTOMER';
  if (roleCode === 'INVESTOR') return 'INVESTOR';
  return 'STAFF';
}

/**
 * Who may grant comes first: nobody grants themselves anything, and nobody grants a role holding a permission they
 * do not hold at that scope (so a manager cannot make anyone an owner). Then what is granted must make sense.
 */
export function judgeGrant(plan: GrantPlan): GrantJudgement {
  if (plan.granterId === plan.granteeId) {
    return { kind: 'FORBIDDEN', reason: 'SELF_GRANT', missing: [] };
  }
  const missing = plan.rolePermissions.filter((code) => !plan.granterPermissions.has(code)).sort();
  if (missing.length > 0) {
    return { kind: 'FORBIDDEN', reason: 'ROLE_EXCEEDS_GRANTER', missing };
  }
  const rules: GrantRuleBroken[] = [];
  if (realmOfRole(plan.roleCode) !== plan.granteeRealm) rules.push({ field: '/roleId', rule: 'ROLE_NOT_FOR_REALM' });
  if (plan.locationBranchId !== undefined && plan.locationBranchId !== plan.branchId) rules.push({ field: '/locationId', rule: 'LOCATION_NOT_IN_BRANCH' });
  if (plan.validTo !== null && plan.validTo.getTime() <= plan.validFrom.getTime()) rules.push({ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' });
  return rules.length === 0 ? { kind: 'OK' } : { kind: 'INVALID', rules };
}

/** The status an account shows: disabled wins, then a running lock. */
export function accountStatus(principalStatus: 'ACTIVE' | 'DISABLED', lockedUntil: Date | null, now: Date): AccountStatus {
  if (principalStatus === 'DISABLED') return 'DISABLED';
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime() ? 'LOCKED' : 'ACTIVE';
}

/** Whether disabling the account or revoking the grant would leave the farm with no active owner. */
export function wouldRemoveLastOwner(facts: { readonly targetHoldsOwner: boolean; readonly otherActiveOwners: number }): boolean {
  return facts.targetHoldsOwner && facts.otherActiveOwners === 0;
}

export const TEMPORARY_PASSWORD_BYTES = 16;
const TEMPORARY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const GROUP = 4;

/** A temporary password, shown once: 16 characters from 32 unambiguous ones (80 bits), in groups of four. */
export function formatTemporaryPassword(bytes: Uint8Array): string {
  if (bytes.length !== TEMPORARY_PASSWORD_BYTES) {
    throw new Error(`a temporary password needs ${TEMPORARY_PASSWORD_BYTES} random bytes`);
  }
  const characters = [...bytes].map((byte) => TEMPORARY_ALPHABET[byte % TEMPORARY_ALPHABET.length]).join('');
  const groups: string[] = [];
  for (let start = 0; start < characters.length; start += GROUP) groups.push(characters.slice(start, start + GROUP));
  return groups.join('-');
}
