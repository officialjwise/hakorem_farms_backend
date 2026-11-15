/**
 * The rules of role administration (FR-IAM-008, FR-IAM-022, A-122). Pure: the handler reads the facts and hands them in.
 */

/** Roles whose holders must sign in with a second factor (FR-IAM-006): their TOTP flag cannot be switched off. */
export const ROLES_REQUIRING_TOTP: ReadonlySet<string> = new Set(['OWNER', 'MANAGER', 'ACCOUNTANT']);

export interface RoleChangePlan {
  readonly roleCode: string;
  /** Whether the actor holds a current grant of this role: then the change would alter their own access. */
  readonly actorHoldsRole: boolean;
  /** Every permission the actor holds through a current grant, at any branch. */
  readonly actorPermissions: ReadonlySet<string>;
  /** Every permission code in `iam.permission`. */
  readonly knownPermissions: ReadonlySet<string>;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** The role's TOTP flag after the change. */
  readonly requiresTotp: boolean;
  /** The limit kinds of the change, as sent. */
  readonly limitKinds: readonly string[];
}

export interface RoleRuleBroken {
  readonly field: string;
  readonly rule: 'UNKNOWN_PERMISSION' | 'TOTP_REQUIRED_FOR_ROLE' | 'DUPLICATE_LIMIT_KIND';
}

export type RoleChangeJudgement =
  | { readonly kind: 'OK' }
  | { readonly kind: 'FORBIDDEN'; readonly reason: 'SELF_ADMINISTRATION' | 'PERMISSION_BEYOND_ACTOR'; readonly missing: readonly string[] }
  | { readonly kind: 'INVALID'; readonly rules: readonly RoleRuleBroken[] };

/** What a new permission set adds to and removes from the current one, each code once, sorted. */
export function planRolePermissions(current: readonly string[], next: readonly string[]): { added: string[]; removed: string[] } {
  const before = new Set(current);
  const after = new Set(next);
  return { added: [...after].filter((code) => !before.has(code)).sort(), removed: [...before].filter((code) => !after.has(code)).sort() };
}

/**
 * Who may change comes first: nobody changes a role they hold, since that changes their own access. Then the change
 * must make sense. Last, nobody adds or removes a permission they do not hold themselves, so a role cannot be used to
 * reach beyond the person who wrote it.
 */
export function judgeRoleChange(plan: RoleChangePlan): RoleChangeJudgement {
  if (plan.actorHoldsRole) {
    return { kind: 'FORBIDDEN', reason: 'SELF_ADMINISTRATION', missing: [] };
  }
  const rules: RoleRuleBroken[] = [];
  if (plan.added.some((code) => !plan.knownPermissions.has(code))) rules.push({ field: '/permissions', rule: 'UNKNOWN_PERMISSION' });
  if (ROLES_REQUIRING_TOTP.has(plan.roleCode) && !plan.requiresTotp) rules.push({ field: '/requiresTotp', rule: 'TOTP_REQUIRED_FOR_ROLE' });
  if (new Set(plan.limitKinds).size !== plan.limitKinds.length) rules.push({ field: '/limits', rule: 'DUPLICATE_LIMIT_KIND' });
  if (rules.length > 0) {
    return { kind: 'INVALID', rules };
  }
  const missing = [...plan.added, ...plan.removed].filter((code) => !plan.actorPermissions.has(code)).sort();
  return missing.length === 0 ? { kind: 'OK' } : { kind: 'FORBIDDEN', reason: 'PERMISSION_BEYOND_ACTOR', missing };
}
