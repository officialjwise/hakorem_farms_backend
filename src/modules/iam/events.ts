/**
 * Events IAM publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`.
 */

/** `iam.ApprovalDecided` v1: a maker-checker request was approved or rejected by someone other than its maker. */
export interface ApprovalDecided {
  readonly kind: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly requestedBy: string;
  readonly decidedBy: string;
  readonly subjectDocumentId: string;
}

/**
 * `iam.RoleGranted` v1 and `iam.RoleRevoked` v1: a role was granted, or a grant revoked (FR-IAM-022). Read by the daily
 * exception report as a `PERMISSION_CHANGE` item (B12); the granter or revoker is the event's actor.
 */
export interface GrantChanged {
  readonly grantId: string;
  readonly change: 'GRANTED' | 'REVOKED';
  readonly principalId: string;
  readonly roleCode: string;
  readonly branchId: string;
  readonly locationId: string | null;
}

/**
 * `iam.RoleChanged` v1: a role was created, or its permissions, limits, name or TOTP flag changed (FR-IAM-022, A-122).
 * Read by the daily exception report as a `PERMISSION_CHANGE` item (B12); the actor is the event's actor.
 */
export interface RoleChanged {
  readonly roleId: string;
  readonly roleCode: string;
  readonly change: 'CREATED' | 'UPDATED';
  readonly added: readonly string[];
  readonly removed: readonly string[];
}
