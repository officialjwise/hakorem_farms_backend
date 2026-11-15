import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { judgeRoleChange, planRolePermissions } from '../domain/role-admin';
import type { RoleChanged } from '../events';
import type { AccessStore, RoleRecord } from './access-store';
import type { Authoriser } from './authoriser';
import { IamDuplicateValueError, RoleBeyondActorError, RoleInvalidError, SelfAdministrationError } from './errors';
import { roleView, type RoleView } from './role-view';

export interface RoleLimitInput {
  readonly limitKind: string;
  readonly amountPesewas: number;
}

export interface RoleCreateRequest {
  readonly code: string;
  readonly name: string;
  readonly requiresTotp: boolean;
  readonly permissions: readonly string[];
  readonly limits?: readonly RoleLimitInput[] | undefined;
}

export interface RoleUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly requiresTotp?: boolean | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly limits?: readonly RoleLimitInput[] | undefined;
}

const PERMISSION = 'iam.role.manage';
/** The reason recorded on a link or limit a role change removes; the audit event carries the whole before state. */
const REMOVED_BY_ROLE_CHANGE = 'Removed by a role change';

/**
 * Role writes (FR-IAM-008, FR-IAM-022, A-122). `iam.role.manage` needs step-up, which the policy engine enforces. Nobody
 * changes a role they hold (that would change their own access), and nobody adds or removes a permission they do not
 * hold. A system role stays: the database refuses its deletion, and no operation deletes a role. Every change is
 * audited as `PERMISSION_CHANGE` with the role before and after, and published as `iam.RoleChanged`.
 */
export class RoleAdmin {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: AccessStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  createRole(actor: Actor | undefined, body: RoleCreateRequest, idempotencyKey: string): Promise<StoredResponse<RoleView>> {
    return this.write(actor, 'createRole', body, idempotencyKey, async (tx) => {
      const permissions = [...new Set(body.permissions)].sort();
      const limits = body.limits ?? [];
      await this.judge(tx, actor!, { roleCode: body.code, holdsRole: false, added: permissions, removed: [], requiresTotp: body.requiresTotp, limits });
      const id = this.nextId();
      await this.store.insertRole(tx, { id, code: body.code, name: body.name.trim(), requiresTotp: body.requiresTotp }, actor!.principalId);
      for (const code of permissions) await this.store.addRolePermission(tx, id, code, actor!.principalId);
      for (const limit of limits) await this.store.setRoleLimit(tx, id, limit.limitKind, BigInt(limit.amountPesewas), REMOVED_BY_ROLE_CHANGE, actor!.principalId);
      const after = await this.requireRole(tx, id);
      await this.changed(tx, 'CREATED', null, after, permissions, []);
      return { status: 201, body: roleView(after) };
    });
  }

  updateRole(actor: Actor | undefined, id: string, body: RoleUpdateRequest, idempotencyKey: string): Promise<StoredResponse<RoleView>> {
    return this.write(actor, 'updateRole', { id, ...body }, idempotencyKey, async (tx) => {
      const state = await this.store.lockRole(tx, id);
      if (state === null) throw new NotFoundError(`no role ${id}`);
      if (state.version !== body.version) throw new VersionConflictError(`role ${id} is at version ${state.version}, not ${body.version}`);
      const before = await this.requireRole(tx, id);
      const { added, removed } = body.permissions === undefined ? { added: [], removed: [] } : planRolePermissions(before.permissions, body.permissions);
      const requiresTotp = body.requiresTotp ?? before.requiresTotp;
      const holdsRole = await this.store.holdsRole(tx, actor!.principalId, id, this.clock.now());
      await this.judge(tx, actor!, { roleCode: before.code, holdsRole, added, removed, requiresTotp, limits: body.limits ?? [] });
      if (!(await this.store.touchRole(tx, id, body.version, { name: body.name?.trim() ?? before.name, requiresTotp }, actor!.principalId))) {
        throw new VersionConflictError(`role ${id} changed while it was updated`);
      }
      for (const code of added) await this.store.addRolePermission(tx, id, code, actor!.principalId);
      for (const code of removed) await this.store.removeRolePermission(tx, id, code, REMOVED_BY_ROLE_CHANGE, actor!.principalId);
      if (body.limits !== undefined) {
        const next = new Map(body.limits.map((limit) => [limit.limitKind, BigInt(limit.amountPesewas)] as const));
        for (const limit of before.limits) {
          if (!next.has(limit.limitKind)) await this.store.setRoleLimit(tx, id, limit.limitKind, null, REMOVED_BY_ROLE_CHANGE, actor!.principalId);
        }
        for (const [kind, amount] of next) await this.store.setRoleLimit(tx, id, kind, amount, REMOVED_BY_ROLE_CHANGE, actor!.principalId);
      }
      const after = await this.requireRole(tx, id);
      await this.changed(tx, 'UPDATED', before, after, added, removed);
      return { status: 200, body: roleView(after) };
    });
  }

  private async judge(
    tx: Transaction,
    actor: Actor,
    change: { roleCode: string; holdsRole: boolean; added: readonly string[]; removed: readonly string[]; requiresTotp: boolean; limits: readonly RoleLimitInput[] },
  ): Promise<void> {
    const judgement = judgeRoleChange({
      roleCode: change.roleCode,
      actorHoldsRole: change.holdsRole,
      actorPermissions: await this.store.permissionsAnywhere(tx, actor.principalId, this.clock.now()),
      knownPermissions: await this.store.permissionCodes(tx, change.added),
      added: change.added,
      removed: change.removed,
      requiresTotp: change.requiresTotp,
      limitKinds: change.limits.map((limit) => limit.limitKind),
    });
    if (judgement.kind === 'INVALID') throw new RoleInvalidError(judgement.rules);
    if (judgement.kind === 'FORBIDDEN') {
      await this.audit.recordDetached({
        module: 'iam',
        action: 'AUTHORISATION_FAILURE',
        entityType: 'Permission',
        metadata: { permission: PERMISSION, reason: judgement.reason, missingPermissions: [...judgement.missing], principalId: actor.principalId, roleCode: change.roleCode },
      });
      throw judgement.reason === 'SELF_ADMINISTRATION'
        ? new SelfAdministrationError('nobody changes a role they hold')
        : new RoleBeyondActorError(`the change touches ${judgement.missing.join(', ')}`);
    }
  }

  private async requireRole(tx: Transaction, id: string): Promise<RoleRecord> {
    const role = await this.store.role(tx, id, this.clock.now());
    if (role === null) throw new NotFoundError(`no role ${id}`);
    return role;
  }

  /** Every role change is a permission change for the owner's review (FR-IAM-022), audited and published. */
  private async changed(tx: Transaction, change: 'CREATED' | 'UPDATED', before: RoleRecord | null, after: RoleRecord, added: readonly string[], removed: readonly string[]): Promise<void> {
    await this.audit.record(tx, {
      module: 'iam',
      action: 'PERMISSION_CHANGE',
      entityType: 'Role',
      entityId: after.id,
      before: before === null ? null : (roleView(before) as never),
      after: roleView(after) as never,
      metadata: { change: change === 'CREATED' ? 'ROLE_CREATED' : 'ROLE_UPDATED', roleCode: after.code, added: [...added], removed: [...removed] },
    });
    const payload: RoleChanged = { roleId: after.id, roleCode: after.code, change, added: [...added], removed: [...removed] };
    await this.events.publish(tx, { type: 'iam.RoleChanged', subjectType: 'Role', subjectId: after.id, payload });
  }

  private async write<T>(
    actor: Actor | undefined,
    operationId: string,
    request: object,
    idempotencyKey: string,
    work: (tx: Transaction) => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, PERMISSION);
        const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
        const response = await work(tx);
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === 'uq_role_code') throw new IamDuplicateValueError(['/code']);
      throw error;
    }
  }
}
