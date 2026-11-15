import { randomBytes } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor, Realm } from '../../../platform/context/request-context';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys } from '../../../platform/crypto/subject-keys';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { accountStatus, formatTemporaryPassword, judgeGrant, TEMPORARY_PASSWORD_BYTES, wouldRemoveLastOwner, type AccountStatus } from '../domain/access-admin';
import type { GrantChanged } from '../events';
import type { AccessStore, GrantRow, PermissionRecord, UserRecord } from './access-store';
import { roleView, type RoleView } from './role-view';
import type { ScopeNamesRegistry } from './authentication.service';
import type { Authoriser, AuthoriseScope } from './authoriser';
import {
  GrantInvalidError,
  IamDuplicateValueError,
  IamReferenceNotFoundError,
  RoleExceedsGranterError,
  SelfAdministrationError,
  UserInvalidError,
} from './errors';
import type { IamStore, LoginThrottle, PasswordHasher } from './ports';

/** The Owner role's fixed id (migration 0004). */
export const OWNER_ROLE_ID = '01900000-0000-7000-8000-000000000101';

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

export interface GrantSummaryView {
  readonly roleCode: string;
  readonly roleName: string;
  readonly branchId: string;
  readonly branchCode: string;
  readonly locationId: string | null;
  readonly locationCode: string | null;
}

/** The contract's `UserAccount`. */
export interface UserAccountView {
  readonly id: string;
  readonly displayName: string;
  readonly realm: Realm;
  readonly email: string | null;
  readonly phone: string | null;
  readonly status: AccountStatus;
  readonly totpEnrolled: boolean;
  readonly totpRequired: boolean;
  readonly mustChangePassword: boolean;
  readonly lastLoginAt: string | null;
  readonly grants: readonly GrantSummaryView[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserCreatedView {
  readonly user: UserAccountView;
  readonly temporaryPassword: string;
}

/** The contract's `RoleGrant`. */
export interface RoleGrantView {
  readonly id: string;
  readonly principal: { readonly id: string; readonly displayName: string };
  readonly role: { readonly id: string; readonly code: string; readonly name: string };
  readonly branch: { readonly id: string; readonly code: string; readonly name: string };
  readonly location: { readonly id: string; readonly code: string; readonly name: string; readonly kind: string } | null;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly displayName: string };
}

export type { RoleView } from './role-view';

export type PermissionView = Omit<PermissionRecord, 'id'>;

export interface GrantInputRequest {
  readonly roleId: string;
  readonly branchId: string;
  readonly locationId?: string | undefined;
  readonly validFrom?: string | undefined;
  readonly validTo?: string | undefined;
}

export interface UserCreateRequest {
  readonly displayName: string;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly realm: 'STAFF' | 'INVESTOR';
  readonly grants: readonly GrantInputRequest[];
}

export interface UserUpdateRequest {
  readonly version: number;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
}

export interface UserListFilter {
  readonly realm?: Realm | undefined;
  readonly status?: AccountStatus | undefined;
  readonly q?: string | undefined;
}

export interface GrantListFilter {
  readonly principalId?: string | undefined;
  readonly roleId?: string | undefined;
  readonly branchId?: string | undefined;
}

/** What the idempotency store keeps for a response holding a temporary password: the password sealed, never plain. */
interface ConcealedPassword<V> {
  readonly view: V;
  readonly sealed: { readonly keyId: string; readonly ciphertext: string };
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function passwordPlace(principalId: string, operationId: string): string {
  return `idempotency:${operationId}:${principalId}:temporary_password`;
}

/**
 * User, role and grant administration (FR-IAM-001, FR-IAM-008, FR-IAM-015, FR-IAM-017, FR-IAM-022, ADR-0017, A-120).
 * Every handler authorises in the application layer before it reads (ADR-0035): first the permission anywhere, then
 * at every branch the target user holds a grant at, or at the grant's branch and location. Nobody administers their
 * own access, nobody grants a role holding a permission they lack at that scope, and the farm always keeps one
 * active Owner. A temporary password is shown once: the idempotency store keeps it sealed with the user's key, so a
 * retry shows the same one and no table holds it in the clear.
 */
export class AccessAdmin {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: AccessStore,
    private readonly iamStore: IamStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly cursors: Cursors,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly hasher: PasswordHasher,
    private readonly throttle: LoginThrottle,
    private readonly scopeNames: ScopeNamesRegistry,
    private readonly subjectKeys: SubjectKeys,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // ---------------------------------------------------------------- users

  listUsers(actor: Actor | undefined, filter: UserListFilter, cursor: string | undefined, limit: number): Promise<Page<UserAccountView>> {
    const filters = { realm: filter.realm ?? null, status: filter.status ?? null, q: filter.q?.trim() || null };
    return this.page(actor, 'iam.user.read', 'listUsers', filters, cursor, limit, async (tx, after) => {
      const rows = await this.store.listUsers(tx, filters, after, limit + 1, this.clock.now());
      return this.userViews(tx, rows);
    });
  }

  getUser(actor: Actor | undefined, id: string): Promise<UserAccountView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'iam.user.read');
      return this.userView(tx, await this.requireUser(tx, id));
    });
  }

  createUser(actor: Actor | undefined, body: UserCreateRequest, idempotencyKey: string): Promise<StoredResponse<UserCreatedView>> {
    return this.writeConcealed(actor, 'iam.user.create', 'createUser', body, idempotencyKey, async (tx) => {
      for (const grant of body.grants) {
        await this.authoriser.authorise(tx, actor, 'iam.user.create', { branchId: grant.branchId });
      }
      if (body.realm === 'INVESTOR') {
        throw new UserInvalidError('/realm', 'INVESTOR_ACCOUNTS_NOT_AVAILABLE');
      }
      const created = await this.insertUser(tx, actor!, body);
      for (const grant of body.grants) {
        await this.grantInside(tx, actor!, created.id, 'STAFF', grant);
      }
      return { status: 201, id: created.id, password: created.password };
    }) as Promise<StoredResponse<UserCreatedView>>;
  }

  updateUser(actor: Actor | undefined, id: string, body: UserUpdateRequest, idempotencyKey: string): Promise<StoredResponse<UserAccountView>> {
    return this.write(actor, 'iam.user.update', 'updateUser', { id, ...body }, idempotencyKey, async (tx) => {
      await this.authoriseOnTarget(tx, actor!, 'iam.user.update', id);
      const state = await this.store.lockUser(tx, id);
      if (state === null) throw new NotFoundError(`no user ${id}`);
      if (state.version !== body.version) throw new VersionConflictError(`user ${id} is at version ${state.version}, not ${body.version}`);
      const before = await this.userView(tx, await this.requireUser(tx, id));
      const email = body.email?.trim().toLowerCase();
      await this.refuseTakenIdentifiers(tx, before.realm, email, body.phone, id);
      const set = {
        ...(body.displayName === undefined ? {} : { displayName: body.displayName.trim() }),
        ...(email === undefined ? {} : { email }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
      };
      if (Object.keys(set).length > 0 && !(await this.store.updateUser(tx, id, body.version, set, actor!.principalId))) {
        throw new VersionConflictError(`user ${id} changed while it was updated`);
      }
      const after = await this.userView(tx, await this.requireUser(tx, id));
      await this.auditUser(tx, 'UPDATE', id, before, after, null);
      return { status: 200, body: after };
    });
  }

  disableUser(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<UserAccountView>> {
    return this.write(actor, 'iam.user.disable', 'disableUser', { id, reason }, idempotencyKey, async (tx) => {
      const before = await this.lockTarget(tx, actor!, 'iam.user.disable', id);
      if (before.status === 'DISABLED') throw new InvalidStateTransitionError(`user ${id} is already disabled`);
      const now = this.clock.now();
      const holdsOwner = (await this.store.currentGrantsOf(tx, [id], now)).some((grant) => grant.roleId === OWNER_ROLE_ID);
      if (wouldRemoveLastOwner({ targetHoldsOwner: holdsOwner, otherActiveOwners: await this.store.otherActiveOwners(tx, now, id, null) })) {
        throw new UserInvalidError(null, 'LAST_OWNER');
      }
      await this.store.setPrincipalStatus(tx, id, 'DISABLED', actor!.principalId);
      const revoked = await this.iamStore.revokeOtherSessions(tx, id, null, actor!.principalId, 'ACCOUNT_DISABLED', now);
      const after = await this.userView(tx, await this.requireUser(tx, id));
      await this.auditUser(tx, 'DISABLE', id, before, after, { reason, sessionsRevoked: revoked.length });
      return { status: 200, body: after };
    });
  }

  enableUser(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<UserAccountView>> {
    return this.write(actor, 'iam.user.disable', 'enableUser', { id, reason }, idempotencyKey, async (tx) => {
      const before = await this.lockTarget(tx, actor!, 'iam.user.disable', id);
      if (before.status !== 'DISABLED') throw new InvalidStateTransitionError(`user ${id} is not disabled`);
      await this.store.setPrincipalStatus(tx, id, 'ACTIVE', actor!.principalId);
      const after = await this.userView(tx, await this.requireUser(tx, id));
      await this.auditUser(tx, 'ENABLE', id, before, after, { reason });
      return { status: 200, body: after };
    });
  }

  async unlockUser(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<UserAccountView>> {
    const response = await this.write(actor, 'iam.user.unlock', 'unlockUser', { id, reason }, idempotencyKey, async (tx) => {
      const before = await this.lockTarget(tx, actor!, 'iam.user.unlock', id);
      await this.store.clearLock(tx, id, actor!.principalId);
      const after = await this.userView(tx, await this.requireUser(tx, id));
      await this.auditUser(tx, 'UNLOCK', id, before, after, { reason });
      return { status: 200, body: after };
    });
    // The lockout itself lives in Redis (ADR-0034): cleared once the unlock has committed. Clearing it again on a
    // retry changes nothing.
    const account = response.body;
    for (const identifier of [account.email, account.phone, `principal:${account.id}`]) {
      if (identifier !== null) await this.throttle.reset(account.realm, identifier);
    }
    return response;
  }

  resetUserPassword(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<{ temporaryPassword: string }>> {
    return this.writeConcealed(
      actor,
      'iam.user.reset_password',
      'resetUserPassword',
      { id, reason },
      idempotencyKey,
      async (tx) => {
        const before = await this.lockTarget(tx, actor!, 'iam.user.reset_password', id);
        const password = formatTemporaryPassword(randomBytes(TEMPORARY_PASSWORD_BYTES));
        const now = this.clock.now();
        await this.store.setTemporaryPassword(tx, id, await this.hasher.hash(password), now, actor!.principalId);
        const revoked = await this.iamStore.revokeOtherSessions(tx, id, null, actor!.principalId, 'PASSWORD_RESET', now);
        const after = await this.userView(tx, await this.requireUser(tx, id));
        await this.auditUser(tx, 'PASSWORD_RESET_BY_ADMIN', id, before, after, { reason, sessionsRevoked: revoked.length });
        return { status: 200, id, password };
      },
      false,
    ) as Promise<StoredResponse<{ temporaryPassword: string }>>;
  }

  /**
   * The farm's first Owner (ADR-0043): run by the SYSTEM principal only, and only while no staff account exists at
   * all. It writes through the same steps as `createUser` and `createGrant`, the System as the actor, and has no
   * route. Every later account is created by a granted person.
   */
  bootstrapFirstOwner(system: Actor, body: { displayName: string; email: string; phone?: string; branchId: string }): Promise<UserCreatedView> {
    if (system.kind !== 'SYSTEM') {
      throw new Error('the first Owner is created by the SYSTEM principal only');
    }
    return this.translateErrors(
      this.uow.run({ isolation: 'serializable' }, async (tx) => {
        if (await this.store.staffAccountExists(tx)) {
          throw new Error('refused: a staff account exists, so the first Owner has already been created');
        }
        const created = await this.insertUser(tx, system, { displayName: body.displayName, email: body.email, phone: body.phone, realm: 'STAFF', grants: [] });
        await this.grantInside(tx, system, created.id, 'STAFF', { roleId: OWNER_ROLE_ID, branchId: body.branchId }, false);
        return { user: await this.userView(tx, await this.requireUser(tx, created.id)), temporaryPassword: created.password };
      }),
    );
  }

  // ---------------------------------------------------------------- roles and permissions

  listRoles(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<RoleView>> {
    return this.page(actor, 'iam.role.read', 'listRoles', {}, cursor, limit, async (tx, after) =>
      (await this.store.listRoles(tx, after, limit + 1, this.clock.now())).map(roleView),
    );
  }

  getRole(actor: Actor | undefined, id: string): Promise<RoleView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'iam.role.read');
      const role = await this.store.role(tx, id, this.clock.now());
      if (role === null) throw new NotFoundError(`no role ${id}`);
      return roleView(role);
    });
  }

  listPermissions(actor: Actor | undefined, module: string | undefined, cursor: string | undefined, limit: number): Promise<Page<PermissionView>> {
    return this.page(actor, 'iam.role.read', 'listPermissions', { module: module ?? null }, cursor, limit, async (tx, after) =>
      (await this.store.listPermissions(tx, module ?? null, after, limit + 1)).map(({ id, ...view }) => ({ ...view, id })),
    ).then((page) => ({ data: page.data.map(({ id: _id, ...view }) => view), page: page.page }));
  }

  // ---------------------------------------------------------------- grants

  listGrants(actor: Actor | undefined, filter: GrantListFilter, cursor: string | undefined, limit: number): Promise<Page<RoleGrantView>> {
    const filters = { principalId: filter.principalId ?? null, roleId: filter.roleId ?? null, branchId: filter.branchId ?? null };
    return this.page(
      actor,
      'iam.grant.read',
      'listGrants',
      filters,
      cursor,
      limit,
      async (tx, after) => this.grantViews(tx, await this.store.listGrants(tx, filters, after, limit + 1)),
      filters.branchId === null ? undefined : { branchId: filters.branchId },
    );
  }

  createGrant(actor: Actor | undefined, body: GrantInputRequest & { principalId: string }, idempotencyKey: string): Promise<StoredResponse<RoleGrantView>> {
    return this.write(actor, 'iam.grant.manage', 'createGrant', body, idempotencyKey, async (tx) => {
      const grantee = await this.store.user(tx, body.principalId);
      if (grantee === null) throw new IamReferenceNotFoundError(['/principalId']);
      const id = await this.grantInside(tx, actor!, grantee.id, grantee.realm, body);
      return { status: 201, body: (await this.grantViews(tx, [(await this.store.grant(tx, id))!]))[0]! };
    });
  }

  revokeGrant(actor: Actor | undefined, id: string, reason: string, idempotencyKey: string): Promise<StoredResponse<RoleGrantView>> {
    return this.write(actor, 'iam.grant.manage', 'revokeGrant', { id, reason }, idempotencyKey, async (tx) => {
      const found = await this.store.grant(tx, id);
      if (found === null || found.deletedAt !== null) throw new NotFoundError(`no live grant ${id}`);
      await this.authoriser.authorise(tx, actor, 'iam.grant.manage', { branchId: found.branchId, locationId: found.locationId });
      if (found.principalId === actor!.principalId) {
        await this.refuseDetached(actor!, 'iam.grant.manage', 'SELF_REVOKE', found.branchId);
        throw new SelfAdministrationError('nobody revokes their own grant');
      }
      await this.requireGranterHolds(tx, actor!, found.roleId, found.branchId, found.locationId);
      await this.store.lockGrant(tx, id);
      const now = this.clock.now();
      const inForce = found.validFrom.getTime() <= now.getTime() && (found.validTo === null || found.validTo.getTime() > now.getTime());
      if (found.roleId === OWNER_ROLE_ID && inForce && (await this.store.otherActiveOwners(tx, now, null, id)) === 0) {
        throw new GrantInvalidError([{ field: null, rule: 'LAST_OWNER' }]);
      }
      const [view] = await this.grantViews(tx, [found]);
      await this.store.revokeGrant(tx, id, reason, actor!.principalId);
      await this.grantChanged(tx, 'REVOKED', found, view!, reason);
      return { status: 200, body: view! };
    });
  }

  // ---------------------------------------------------------------- the shared steps

  private async insertUser(tx: Transaction, actor: Actor, body: UserCreateRequest): Promise<{ id: string; password: string }> {
    const email = body.email?.trim().toLowerCase() ?? null;
    const phone = body.phone ?? null;
    if (email === null && phone === null) throw new UserInvalidError(null, 'NO_IDENTIFIER');
    await this.refuseTakenIdentifiers(tx, 'STAFF', email ?? undefined, phone ?? undefined, null);
    const id = this.nextId();
    const password = formatTemporaryPassword(randomBytes(TEMPORARY_PASSWORD_BYTES));
    await this.store.insertUser(tx, { id, displayName: body.displayName.trim(), realm: 'STAFF', email, phone, passwordHash: await this.hasher.hash(password) }, actor.principalId);
    await this.auditUser(tx, 'CREATE', id, null, await this.userView(tx, (await this.store.user(tx, id))!), null);
    return { id, password };
  }

  /** Judges and writes one grant: scope authorised, nobody to themselves, nothing beyond what the granter holds. */
  private async grantInside(tx: Transaction, actor: Actor, granteeId: string, granteeRealm: Realm, input: GrantInputRequest, authorise = true): Promise<string> {
    const locationId = input.locationId ?? null;
    if (authorise) {
      await this.authoriser.authorise(tx, actor, 'iam.grant.manage', { branchId: input.branchId, locationId });
    }
    const now = this.clock.now();
    const role = await this.store.role(tx, input.roleId, now);
    const refs = await this.scopeNames.get().refs(tx, [input.branchId], locationId === null ? [] : [locationId]);
    const missing = [...(role === null ? ['/roleId'] : []), ...(refs.branches.has(input.branchId) ? [] : ['/branchId'])];
    if (missing.length > 0) throw new IamReferenceNotFoundError(missing);
    const validFrom = input.validFrom === undefined ? now : new Date(input.validFrom);
    const validTo = input.validTo === undefined ? null : new Date(input.validTo);
    const judgement = judgeGrant({
      granterId: actor.principalId,
      granteeId,
      granteeRealm,
      roleCode: role!.code,
      rolePermissions: role!.permissions,
      // The System bootstraps the first Owner only (ADR-0043); it holds no grant to compare with.
      granterPermissions: actor.kind === 'SYSTEM' ? new Set(role!.permissions) : await this.store.permissionsAtScope(tx, actor.principalId, input.branchId, locationId, now),
      branchId: input.branchId,
      locationBranchId: locationId === null ? undefined : (refs.locations.get(locationId)?.branchId ?? null),
      validFrom,
      validTo,
    });
    if (judgement.kind === 'FORBIDDEN') {
      await this.refuseDetached(actor, 'iam.grant.manage', judgement.reason, input.branchId, judgement.missing);
      throw judgement.reason === 'SELF_GRANT' ? new SelfAdministrationError('nobody grants themselves a role') : new RoleExceedsGranterError(`the role holds ${judgement.missing.join(', ')}`);
    }
    if (judgement.kind === 'INVALID') throw new GrantInvalidError(judgement.rules);
    const id = this.nextId();
    await this.store.insertGrant(tx, { id, principalId: granteeId, roleId: role!.id, branchId: input.branchId, locationId, validFrom, validTo }, actor.principalId);
    const row = (await this.store.grant(tx, id))!;
    await this.grantChanged(tx, 'GRANTED', row, (await this.grantViews(tx, [row]))[0]!, null);
    return id;
  }

  private async requireGranterHolds(tx: Transaction, actor: Actor, roleId: string, branchId: string, locationId: string | null): Promise<void> {
    const now = this.clock.now();
    const role = (await this.store.role(tx, roleId, now))!;
    const held = await this.store.permissionsAtScope(tx, actor.principalId, branchId, locationId, now);
    const missing = role.permissions.filter((code) => !held.has(code));
    if (missing.length > 0) {
      await this.refuseDetached(actor, 'iam.grant.manage', 'ROLE_EXCEEDS_GRANTER', branchId, missing);
      throw new RoleExceedsGranterError(`the role holds ${missing.join(', ')}`);
    }
  }

  /** Authorises at every branch the target holds a current grant at; nobody administers their own account here. */
  private async authoriseOnTarget(tx: Transaction, actor: Actor, permission: string, id: string, allowSelf = true): Promise<void> {
    const branches = new Set((await this.store.currentGrantsOf(tx, [id], this.clock.now())).map((grant) => grant.branchId));
    for (const branchId of branches) {
      await this.authoriser.authorise(tx, actor, permission, { branchId });
    }
    if (!allowSelf && id === actor.principalId) {
      await this.refuseDetached(actor, permission, 'SELF_ADMINISTRATION', null);
      throw new SelfAdministrationError(`nobody uses ${permission} on themselves`);
    }
  }

  private async lockTarget(tx: Transaction, actor: Actor, permission: string, id: string): Promise<UserAccountView> {
    if ((await this.store.user(tx, id)) === null) throw new NotFoundError(`no user ${id}`);
    await this.authoriseOnTarget(tx, actor, permission, id, false);
    await this.store.lockUser(tx, id);
    return this.userView(tx, await this.requireUser(tx, id));
  }

  private async refuseTakenIdentifiers(tx: Transaction, realm: Realm, email: string | undefined, phone: string | undefined, exceptId: string | null): Promise<void> {
    const taken = [
      ...(email !== undefined && (await this.store.identifierTaken(tx, realm, 'email', email, exceptId)) ? ['/email'] : []),
      ...(phone !== undefined && (await this.store.identifierTaken(tx, realm, 'phone_e164', phone, exceptId)) ? ['/phone'] : []),
    ];
    if (taken.length > 0) throw new IamDuplicateValueError(taken);
  }

  private async requireUser(tx: Transaction, id: string): Promise<UserRecord> {
    const found = await this.store.user(tx, id);
    if (found === null) throw new NotFoundError(`no user ${id}`);
    return found;
  }

  private async userView(tx: Transaction, record: UserRecord): Promise<UserAccountView> {
    return (await this.userViews(tx, [record]))[0]!;
  }

  private async userViews(tx: Transaction, records: readonly UserRecord[]): Promise<UserAccountView[]> {
    const now = this.clock.now();
    const grants = await this.store.currentGrantsOf(tx, records.map((record) => record.id), now);
    const refs = await this.scopeNames.get().refs(
      tx,
      [...new Set(grants.map((grant) => grant.branchId))],
      [...new Set(grants.flatMap((grant) => (grant.locationId === null ? [] : [grant.locationId])))],
    );
    return records.map((record) => {
      const own = grants.filter((grant) => grant.principalId === record.id);
      return {
        id: record.id,
        displayName: record.displayName,
        realm: record.realm,
        email: record.email,
        phone: record.phone,
        status: accountStatus(record.principalStatus, record.lockedUntil, now),
        totpEnrolled: record.totpEnrolled,
        totpRequired: record.totpRequired || own.some((grant) => grant.roleRequiresTotp),
        mustChangePassword: record.mustChangePassword,
        lastLoginAt: iso(record.lastLoginAt),
        grants: own.map((grant) => ({
          roleCode: grant.roleCode,
          roleName: grant.roleName,
          branchId: grant.branchId,
          branchCode: refs.branches.get(grant.branchId)?.code ?? '',
          locationId: grant.locationId,
          locationCode: grant.locationId === null ? null : (refs.locations.get(grant.locationId)?.code ?? null),
        })),
        version: record.version,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      };
    });
  }

  private async grantViews(tx: Transaction, rows: readonly GrantRow[]): Promise<RoleGrantView[]> {
    const refs = await this.scopeNames.get().refs(
      tx,
      [...new Set(rows.map((row) => row.branchId))],
      [...new Set(rows.flatMap((row) => (row.locationId === null ? [] : [row.locationId])))],
    );
    return rows.map((row) => {
      const branch = refs.branches.get(row.branchId);
      const location = row.locationId === null ? undefined : refs.locations.get(row.locationId);
      return {
        id: row.id,
        principal: { id: row.principalId, displayName: row.principalName },
        role: { id: row.roleId, code: row.roleCode, name: row.roleName },
        branch: { id: row.branchId, code: branch?.code ?? '', name: branch?.name ?? '' },
        location: location === undefined ? null : { id: location.id, code: location.code, name: location.name, kind: location.kind },
        validFrom: row.validFrom.toISOString(),
        validTo: iso(row.validTo),
        createdAt: row.createdAt.toISOString(),
        createdBy: { id: row.createdBy, displayName: row.createdByName },
      };
    });
  }

  private async auditUser(tx: Transaction, action: string, id: string, before: UserAccountView | null, after: UserAccountView, metadata: Record<string, unknown> | null): Promise<void> {
    await this.audit.record(tx, {
      module: 'iam',
      action,
      entityType: 'UserAccount',
      entityId: id,
      before: before as never,
      after: after as never,
      metadata: metadata as never,
      subject: { type: 'STAFF', id },
      personalFields: ['email', 'phone'],
    });
  }

  /** Every accepted grant change is audited as `PERMISSION_CHANGE` and published (`iam.RoleGranted`, `iam.RoleRevoked`), for the owner's review (FR-IAM-022). */
  private async grantChanged(tx: Transaction, change: 'GRANTED' | 'REVOKED', row: GrantRow, view: RoleGrantView, reason: string | null): Promise<void> {
    await this.audit.record(tx, {
      module: 'iam',
      action: 'PERMISSION_CHANGE',
      entityType: 'RoleGrant',
      entityId: row.id,
      branchId: row.branchId,
      before: change === 'REVOKED' ? (view as never) : null,
      after: change === 'GRANTED' ? (view as never) : null,
      metadata: { change, granteePrincipalId: row.principalId, roleCode: row.roleCode, reason },
    });
    const payload: GrantChanged = {
      grantId: row.id,
      change,
      principalId: row.principalId,
      roleCode: row.roleCode,
      branchId: row.branchId,
      locationId: row.locationId,
    };
    await this.events.publish(tx, { type: change === 'GRANTED' ? 'iam.RoleGranted' : 'iam.RoleRevoked', subjectType: 'RoleGrant', subjectId: row.id, payload });
  }

  private async refuseDetached(actor: Actor, permission: string, reason: string, branchId: string | null, missing: readonly string[] = []): Promise<void> {
    await this.audit.recordDetached({
      module: 'iam',
      action: 'AUTHORISATION_FAILURE',
      entityType: 'Permission',
      branchId,
      metadata: { permission, reason, missingPermissions: [...missing], principalId: actor.principalId },
    });
  }

  private async write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    return this.translateErrors(
      this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, permission);
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
        const response = await work(tx);
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      }),
    );
  }

  /** As `write`, for a response that shows a temporary password: stored sealed with the user's key, opened on a retry. */
  private async writeConcealed(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    request: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<{ status: number; id: string; password: string }>,
    withUser = true,
  ): Promise<StoredResponse<UserCreatedView | { temporaryPassword: string }>> {
    return this.translateErrors(
      this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, permission);
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
        if (claim.kind === 'REPLAY') {
          const stored = claim.response as StoredResponse<ConcealedPassword<{ id: string; user: UserAccountView | null }>>;
          const key = await this.subjectKeys.keyById(tx, stored.body.sealed.keyId);
          if (key === null) throw new NotFoundError('the account behind this request was erased');
          const password = openWithSubjectKey(key, Buffer.from(stored.body.sealed.ciphertext, 'base64'), passwordPlace(stored.body.view.id, operationId));
          return { status: stored.status, body: stored.body.view.user === null ? { temporaryPassword: password } : { user: stored.body.view.user, temporaryPassword: password } };
        }
        const done = await work(tx);
        const user = withUser ? await this.userView(tx, await this.requireUser(tx, done.id)) : null;
        const key = await this.subjectKeys.keyFor(tx, { type: 'STAFF', id: done.id }, actor!.principalId);
        const sealed = { keyId: key.id, ciphertext: sealWithSubjectKey(key, done.password, passwordPlace(done.id, operationId)).toString('base64') };
        await this.idempotency.complete(tx, claim.id, { status: done.status, body: { view: { id: done.id, user }, sealed } });
        return { status: done.status, body: user === null ? { temporaryPassword: done.password } : { user, temporaryPassword: done.password } };
      }),
    );
  }

  private page<V extends { readonly id: string }>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    filters: Record<string, unknown>,
    cursor: string | undefined,
    limit: number,
    rows: (tx: Transaction, afterId: string | null) => Promise<V[]>,
    scope?: AuthoriseScope,
  ): Promise<Page<V>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission, scope);
      const binding = { operationId, principalId: actor!.principalId, filters };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await rows(tx, after);
      const hasMore = found.length > limit;
      const data = found.slice(0, limit);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  private async translateErrors<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (error) {
      const state = sqlStateOf(error);
      const constraint = databaseErrorOf(error)?.constraint ?? '';
      if (state === '23505' && constraint === 'uq_role_grant_scope') throw new IamDuplicateValueError(['/roleId']);
      if (state === '23505' && constraint === 'uq_user_account_realm_email') throw new IamDuplicateValueError(['/email']);
      if (state === '23505' && constraint === 'uq_user_account_realm_phone') throw new IamDuplicateValueError(['/phone']);
      throw error;
    }
  }
}
