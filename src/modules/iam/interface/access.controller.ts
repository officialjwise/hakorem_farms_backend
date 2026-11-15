import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { RoleAdmin } from '../application/role-admin';
import { AccessAdmin, type Page, type PermissionView, type RoleGrantView, type RoleView, type UserAccountView, type UserCreatedView } from '../application/access-admin';
import {
  GrantCreate,
  IdParam,
  ListGrantsQuery,
  ListPermissionsQuery,
  ListRolesQuery,
  ListUsersQuery,
  ReasonRequest,
  RoleCreate,
  RoleUpdate,
  UserCreate,
  UserUpdate,
} from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/**
 * User accounts, roles and permissions, and role grants (FR-IAM-001, FR-IAM-008, FR-IAM-015, FR-IAM-017,
 * FR-IAM-022). The controller parses and delegates; AccessAdmin authorises and decides.
 */
@Controller('iam')
export class AccessController {
  constructor(
    @Inject(AccessAdmin) private readonly admin: AccessAdmin,
    @Inject(RoleAdmin) private readonly roles: RoleAdmin,
  ) {}

  @Get('users')
  @Operation({ operationId: 'listUsers', ...READ, permission: 'iam.user.read' })
  listUsers(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListUsersQuery)) query: z.infer<typeof ListUsersQuery>): Promise<Page<UserAccountView>> {
    return this.admin.listUsers(actor, { realm: query.realm, status: query.status, q: query.q }, query.cursor, query.limit);
  }

  @Post('users')
  @Operation({ operationId: 'createUser', ...WRITE, permission: 'iam.user.create' })
  createUser(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(UserCreate)) body: z.infer<typeof UserCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserCreatedView> {
    return reply(res, this.admin.createUser(actor, body, key));
  }

  @Get('users/:id')
  @Operation({ operationId: 'getUser', ...READ, permission: 'iam.user.read' })
  getUser(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<UserAccountView> {
    return this.admin.getUser(actor, id);
  }

  @Patch('users/:id')
  @Operation({ operationId: 'updateUser', ...WRITE, permission: 'iam.user.update' })
  updateUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(UserUpdate)) body: z.infer<typeof UserUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserAccountView> {
    return reply(res, this.admin.updateUser(actor, id, body, key));
  }

  @Post('users/:id/disable')
  @Operation({ operationId: 'disableUser', ...WRITE, permission: 'iam.user.disable' })
  disableUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserAccountView> {
    return reply(res, this.admin.disableUser(actor, id, body.reason, key));
  }

  @Post('users/:id/enable')
  @Operation({ operationId: 'enableUser', ...WRITE, permission: 'iam.user.disable' })
  enableUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserAccountView> {
    return reply(res, this.admin.enableUser(actor, id, body.reason, key));
  }

  @Post('users/:id/unlock')
  @Operation({ operationId: 'unlockUser', ...WRITE, permission: 'iam.user.unlock' })
  unlockUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserAccountView> {
    return reply(res, this.admin.unlockUser(actor, id, body.reason, key));
  }

  @Post('users/:id/reset-password')
  @Operation({ operationId: 'resetUserPassword', ...WRITE, permission: 'iam.user.reset_password' })
  resetUserPassword(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ temporaryPassword: string }> {
    return reply(res, this.admin.resetUserPassword(actor, id, body.reason, key));
  }

  @Get('roles')
  @Operation({ operationId: 'listRoles', ...READ, permission: 'iam.role.read' })
  listRoles(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListRolesQuery)) query: z.infer<typeof ListRolesQuery>): Promise<Page<RoleView>> {
    return this.admin.listRoles(actor, query.cursor, query.limit);
  }

  @Post('roles')
  @Operation({ operationId: 'createRole', ...WRITE, permission: 'iam.role.manage' })
  createRole(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(RoleCreate)) body: z.infer<typeof RoleCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RoleView> {
    return reply(res, this.roles.createRole(actor, body, key));
  }

  @Patch('roles/:id')
  @Operation({ operationId: 'updateRole', ...WRITE, permission: 'iam.role.manage' })
  updateRole(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(RoleUpdate)) body: z.infer<typeof RoleUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RoleView> {
    return reply(res, this.roles.updateRole(actor, id, body, key));
  }

  @Get('roles/:id')
  @Operation({ operationId: 'getRole', ...READ, permission: 'iam.role.read' })
  getRole(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<RoleView> {
    return this.admin.getRole(actor, id);
  }

  @Get('permissions')
  @Operation({ operationId: 'listPermissions', ...READ, permission: 'iam.role.read' })
  listPermissions(
    @CurrentActor() actor: Actor | undefined,
    @Query(zodPipe(ListPermissionsQuery)) query: z.infer<typeof ListPermissionsQuery>,
  ): Promise<Page<PermissionView>> {
    return this.admin.listPermissions(actor, query.module, query.cursor, query.limit);
  }

  @Get('grants')
  @Operation({ operationId: 'listGrants', ...READ, permission: 'iam.grant.read' })
  listGrants(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ListGrantsQuery)) query: z.infer<typeof ListGrantsQuery>): Promise<Page<RoleGrantView>> {
    return this.admin.listGrants(actor, { principalId: query.principalId, roleId: query.roleId, branchId: query.branchId }, query.cursor, query.limit);
  }

  @Post('grants')
  @Operation({ operationId: 'createGrant', ...WRITE, permission: 'iam.grant.manage' })
  createGrant(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(GrantCreate)) body: z.infer<typeof GrantCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RoleGrantView> {
    return reply(res, this.admin.createGrant(actor, body, key));
  }

  @Post('grants/:id/revoke')
  @Operation({ operationId: 'revokeGrant', ...WRITE, permission: 'iam.grant.manage' })
  revokeGrant(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReasonRequest)) body: z.infer<typeof ReasonRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RoleGrantView> {
    return reply(res, this.admin.revokeGrant(actor, id, body.reason, key));
  }
}
