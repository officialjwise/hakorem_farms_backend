/** Where one current grant of a role holding the permission applies: a branch, and optionally one location. */
export interface GrantScope {
  readonly branchId: string;
  readonly locationId: string | null;
}

/** The ownership rule of the resource being reached (ADR-0017), resolved by the handler. */
export interface OwnershipRule {
  /** Whose record it is. */
  readonly principalId: string;
  readonly actorPrincipalId: string;
  /** Whether the actor also holds the permission for anyone's record (for example `iam.session.read.any`). */
  readonly holdsAnyPermission: boolean;
}

export interface AccessScope {
  readonly branchId?: string | null;
  readonly locationId?: string | null;
  readonly owner?: OwnershipRule;
}

export type AccessDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: 'NO_GRANT' | 'OUT_OF_SCOPE' | 'NOT_OWNER' };

function covers(grant: GrantScope, scope: AccessScope): boolean {
  if (scope.branchId === undefined || scope.branchId === null) {
    return true;
  }
  if (grant.branchId !== scope.branchId) {
    return false;
  }
  if (grant.locationId === null) {
    return true;
  }
  return scope.locationId === undefined || scope.locationId === null ? false : grant.locationId === scope.locationId;
}

/**
 * The policy decision (ADR-0017). It passes only if the actor holds the permission through a current grant, the
 * grant covers the branch and, if the grant names one, the location, and the ownership rule holds. There is no
 * allow by default: no grant, no action.
 */
export function decideAccess(input: { readonly grantsWithPermission: readonly GrantScope[]; readonly scope: AccessScope }): AccessDecision {
  if (input.grantsWithPermission.length === 0) {
    return { allowed: false, reason: 'NO_GRANT' };
  }
  if (!input.grantsWithPermission.some((grant) => covers(grant, input.scope))) {
    return { allowed: false, reason: 'OUT_OF_SCOPE' };
  }
  const owner = input.scope.owner;
  if (owner !== undefined && owner.principalId !== owner.actorPrincipalId && !owner.holdsAnyPermission) {
    return { allowed: false, reason: 'NOT_OWNER' };
  }
  return { allowed: true };
}
