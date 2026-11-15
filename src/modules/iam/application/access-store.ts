import type { Realm } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { AccountStatus } from '../domain/access-admin';

export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly realm: Realm;
  readonly email: string | null;
  readonly phone: string | null;
  readonly principalStatus: 'ACTIVE' | 'DISABLED';
  readonly lockedUntil: Date | null;
  readonly mustChangePassword: boolean;
  readonly totpRequired: boolean;
  readonly totpEnrolled: boolean;
  readonly lastLoginAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GrantRow {
  readonly id: string;
  readonly principalId: string;
  readonly principalName: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly roleName: string;
  readonly roleRequiresTotp: boolean;
  readonly branchId: string;
  readonly locationId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly deletedAt: Date | null;
}

export interface RoleRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly requiresTotp: boolean;
  readonly permissions: readonly string[];
  readonly limits: ReadonlyArray<{ readonly limitKind: string; readonly amountPesewas: bigint }>;
  readonly userCount: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PermissionRecord {
  readonly id: string;
  readonly code: string;
  readonly module: string;
  readonly description: string;
  readonly requiresStepUp: boolean;
}

export interface UserFilter {
  readonly realm: Realm | null;
  readonly status: AccountStatus | null;
  readonly q: string | null;
}

export interface GrantFilter {
  readonly principalId: string | null;
  readonly roleId: string | null;
  readonly branchId: string | null;
}

export interface NewUser {
  readonly id: string;
  readonly displayName: string;
  readonly realm: Realm;
  readonly email: string | null;
  readonly phone: string | null;
  readonly passwordHash: string;
}

export interface NewGrant {
  readonly id: string;
  readonly principalId: string;
  readonly roleId: string;
  readonly branchId: string;
  readonly locationId: string | null;
  readonly validFrom: Date;
  readonly validTo: Date | null;
}

/** IAM's user, role and grant administration tables. Every method runs in the caller's transaction. */
export interface AccessStore {
  listUsers(tx: Transaction, filter: UserFilter, afterId: string | null, limit: number, now: Date): Promise<UserRecord[]>;
  user(tx: Transaction, id: string): Promise<UserRecord | null>;
  /** Locks the account row; null when there is no live account. */
  lockUser(tx: Transaction, id: string): Promise<{ readonly version: number } | null>;
  identifierTaken(tx: Transaction, realm: Realm, column: 'email' | 'phone_e164', value: string, exceptId: string | null): Promise<boolean>;
  staffAccountExists(tx: Transaction): Promise<boolean>;
  insertUser(tx: Transaction, user: NewUser, actorId: string): Promise<void>;
  updateUser(tx: Transaction, id: string, version: number, set: { displayName?: string; email?: string; phone?: string }, actorId: string): Promise<boolean>;
  setPrincipalStatus(tx: Transaction, id: string, status: 'ACTIVE' | 'DISABLED', actorId: string): Promise<void>;
  clearLock(tx: Transaction, id: string, actorId: string): Promise<void>;
  setTemporaryPassword(tx: Transaction, id: string, passwordHash: string, now: Date, actorId: string): Promise<void>;

  /** Current grants (valid now and live) of each principal, for the account views and for scope. */
  currentGrantsOf(tx: Transaction, principalIds: readonly string[], now: Date): Promise<GrantRow[]>;
  /** The permissions the principal holds through current grants that cover the branch and, if named, the location. */
  permissionsAtScope(tx: Transaction, principalId: string, branchId: string, locationId: string | null, now: Date): Promise<Set<string>>;
  /** Distinct active principals other than `exceptPrincipalId` holding a current OWNER grant other than `exceptGrantId`. */
  otherActiveOwners(tx: Transaction, now: Date, exceptPrincipalId: string | null, exceptGrantId: string | null): Promise<number>;
  listGrants(tx: Transaction, filter: GrantFilter, afterId: string | null, limit: number): Promise<GrantRow[]>;
  grant(tx: Transaction, id: string): Promise<GrantRow | null>;
  lockGrant(tx: Transaction, id: string): Promise<boolean>;
  insertGrant(tx: Transaction, grant: NewGrant, actorId: string): Promise<void>;
  revokeGrant(tx: Transaction, id: string, reason: string, actorId: string): Promise<void>;

  listRoles(tx: Transaction, afterId: string | null, limit: number, now: Date): Promise<RoleRecord[]>;
  role(tx: Transaction, id: string, now: Date): Promise<RoleRecord | null>;
  listPermissions(tx: Transaction, module: string | null, afterCode: string | null, limit: number): Promise<PermissionRecord[]>;

  /** Role writes (B04e continued, A-122). */
  permissionCodes(tx: Transaction, codes: readonly string[]): Promise<Set<string>>;
  /** Every permission the principal holds through a current grant, at any branch. */
  permissionsAnywhere(tx: Transaction, principalId: string, now: Date): Promise<Set<string>>;
  holdsRole(tx: Transaction, principalId: string, roleId: string, now: Date): Promise<boolean>;
  /** Locks the live role row; null when there is none. */
  lockRole(tx: Transaction, id: string): Promise<{ readonly version: number } | null>;
  insertRole(tx: Transaction, role: NewRole, actorId: string): Promise<void>;
  /** Moves the role one version on, with its new name and TOTP flag; false when the version did not match. */
  touchRole(tx: Transaction, id: string, version: number, set: { name: string; requiresTotp: boolean }, actorId: string): Promise<boolean>;
  /** Adds the link, or restores a removed one. */
  addRolePermission(tx: Transaction, roleId: string, code: string, actorId: string): Promise<void>;
  /** Removes the link by soft deletion (ADR-0024). */
  removeRolePermission(tx: Transaction, roleId: string, code: string, reason: string, actorId: string): Promise<void>;
  /** Sets one limit, restoring a removed one; with null removes it by soft deletion. */
  setRoleLimit(tx: Transaction, roleId: string, limitKind: string, amountPesewas: bigint | null, reason: string, actorId: string): Promise<void>;
}

export interface NewRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly requiresTotp: boolean;
}

export const ACCESS_STORE = Symbol('ACCESS_STORE');
