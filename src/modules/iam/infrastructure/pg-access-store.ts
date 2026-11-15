import type { Realm } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type {
  AccessStore,
  GrantFilter,
  GrantRow,
  NewGrant,
  NewRole,
  NewUser,
  PermissionRecord,
  RoleRecord,
  UserFilter,
  UserRecord,
} from '../application/access-store';

const USER_SELECT = `
  SELECT a.principal_id AS id, p.display_name, a.realm, a.email, a.phone_e164, p.status AS principal_status, a.locked_until,
         a.must_change_password, a.totp_required, (t.confirmed_at IS NOT NULL AND t.deleted_at IS NULL) AS totp_enrolled,
         a.last_login_at, a.version, a.created_at, greatest(a.updated_at, p.updated_at) AS updated_at
    FROM iam.user_account a
    JOIN iam.principal p ON p.id = a.principal_id
    LEFT JOIN iam.totp_credential t ON t.principal_id = a.principal_id
   WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL`;

interface UserRow {
  id: string;
  display_name: string;
  realm: Realm;
  email: string | null;
  phone_e164: string | null;
  principal_status: 'ACTIVE' | 'DISABLED';
  locked_until: Date | null;
  must_change_password: boolean;
  totp_required: boolean;
  totp_enrolled: boolean | null;
  last_login_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function user(row: UserRow): UserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    realm: row.realm,
    email: row.email,
    phone: row.phone_e164,
    principalStatus: row.principal_status,
    lockedUntil: row.locked_until,
    mustChangePassword: row.must_change_password,
    totpRequired: row.totp_required,
    totpEnrolled: row.totp_enrolled === true,
    lastLoginAt: row.last_login_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const GRANT_SELECT = `
  SELECT g.id, g.principal_id, p.display_name AS principal_name, g.role_id, r.code AS role_code, r.name AS role_name,
         r.requires_totp AS role_requires_totp, g.branch_id, g.location_id, g.valid_from, g.valid_to, g.created_at,
         g.created_by, c.display_name AS created_by_name, g.deleted_at
    FROM iam.role_grant g
    JOIN iam.role r ON r.id = g.role_id
    JOIN iam.principal p ON p.id = g.principal_id
    JOIN iam.principal c ON c.id = g.created_by`;

/** A grant that is live and in force at $2, as the policy engine reads it (PgIamStore). */
const CURRENT_GRANT = `g.deleted_at IS NULL AND g.valid_from <= $2 AND (g.valid_to IS NULL OR g.valid_to > $2) AND r.deleted_at IS NULL`;

interface GrantDbRow {
  id: string;
  principal_id: string;
  principal_name: string;
  role_id: string;
  role_code: string;
  role_name: string;
  role_requires_totp: boolean;
  branch_id: string;
  location_id: string | null;
  valid_from: Date;
  valid_to: Date | null;
  created_at: Date;
  created_by: string;
  created_by_name: string;
  deleted_at: Date | null;
}

function grant(row: GrantDbRow): GrantRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    principalName: row.principal_name,
    roleId: row.role_id,
    roleCode: row.role_code,
    roleName: row.role_name,
    roleRequiresTotp: row.role_requires_totp,
    branchId: row.branch_id,
    locationId: row.location_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    deletedAt: row.deleted_at,
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** User, role and grant administration in plain parameterised SQL, in IAM's own schema only (ADR-0008). */
export class PgAccessStore implements AccessStore {
  async listUsers(tx: Transaction, filter: UserFilter, afterId: string | null, limit: number, now: Date): Promise<UserRecord[]> {
    const { rows } = await tx.query<UserRow>(
      `${USER_SELECT}
         AND ($1::text IS NULL OR a.realm = $1)
         AND ($2::text IS NULL
              OR ($2 = 'DISABLED' AND p.status = 'DISABLED')
              OR ($2 = 'LOCKED' AND p.status = 'ACTIVE' AND a.locked_until > $6)
              OR ($2 = 'ACTIVE' AND p.status = 'ACTIVE' AND (a.locked_until IS NULL OR a.locked_until <= $6)))
         AND ($3::text IS NULL OR p.display_name ILIKE '%' || $3 || '%' OR a.email ILIKE '%' || $3 || '%' OR a.phone_e164 LIKE '%' || $3 || '%')
         AND ($4::uuid IS NULL OR a.principal_id > $4)
       ORDER BY a.principal_id
       LIMIT $5`,
      [filter.realm, filter.status, filter.q === null ? null : escapeLike(filter.q), afterId, limit, now],
    );
    return rows.map(user);
  }

  async user(tx: Transaction, id: string): Promise<UserRecord | null> {
    const { rows } = await tx.query<UserRow>(`${USER_SELECT} AND a.principal_id = $1`, [id]);
    return rows[0] === undefined ? null : user(rows[0]);
  }

  async lockUser(tx: Transaction, id: string): Promise<{ version: number } | null> {
    const { rows } = await tx.query<{ version: number }>(
      'SELECT version FROM iam.user_account WHERE principal_id = $1 AND deleted_at IS NULL FOR UPDATE',
      [id],
    );
    return rows[0] ?? null;
  }

  async identifierTaken(tx: Transaction, realm: Realm, column: 'email' | 'phone_e164', value: string, exceptId: string | null): Promise<boolean> {
    const sql =
      column === 'email'
        ? 'SELECT 1 FROM iam.user_account WHERE realm = $1 AND email = $2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR principal_id <> $3)'
        : 'SELECT 1 FROM iam.user_account WHERE realm = $1 AND phone_e164 = $2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR principal_id <> $3)';
    return ((await tx.query(sql, [realm, value, exceptId])).rowCount ?? 0) > 0;
  }

  async staffAccountExists(tx: Transaction): Promise<boolean> {
    return ((await tx.query("SELECT 1 FROM iam.user_account WHERE realm = 'STAFF' LIMIT 1")).rowCount ?? 0) > 0;
  }

  async insertUser(tx: Transaction, created: NewUser, actorId: string): Promise<void> {
    await tx.query(`INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, 'ACTIVE', $3, $3)`, [
      created.id,
      created.displayName,
      actorId,
    ]);
    await tx.query(
      `INSERT INTO iam.user_account (principal_id, realm, email, phone_e164, password_hash, must_change_password, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, true, $6, $6)`,
      [created.id, created.realm, created.email, created.phone, created.passwordHash, actorId],
    );
  }

  async updateUser(
    tx: Transaction,
    id: string,
    version: number,
    set: { displayName?: string; email?: string; phone?: string },
    actorId: string,
  ): Promise<boolean> {
    const updated = await tx.query(
      `UPDATE iam.user_account
          SET email = CASE WHEN $3::boolean THEN $4 ELSE email END,
              phone_e164 = CASE WHEN $5::boolean THEN $6 ELSE phone_e164 END,
              version = version + 1, updated_by = $7
        WHERE principal_id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, version, set.email !== undefined, set.email ?? null, set.phone !== undefined, set.phone ?? null, actorId],
    );
    if ((updated.rowCount ?? 0) === 0) return false;
    if (set.displayName !== undefined) {
      await tx.query('UPDATE iam.principal SET display_name = $2, version = version + 1, updated_by = $3 WHERE id = $1', [id, set.displayName, actorId]);
    }
    return true;
  }

  async setPrincipalStatus(tx: Transaction, id: string, status: 'ACTIVE' | 'DISABLED', actorId: string): Promise<void> {
    await tx.query('UPDATE iam.principal SET status = $2, version = version + 1, updated_by = $3 WHERE id = $1', [id, status, actorId]);
    await tx.query('UPDATE iam.user_account SET version = version + 1, updated_by = $2 WHERE principal_id = $1', [id, actorId]);
  }

  async clearLock(tx: Transaction, id: string, actorId: string): Promise<void> {
    await tx.query('UPDATE iam.user_account SET failed_attempts = 0, locked_until = NULL, version = version + 1, updated_by = $2 WHERE principal_id = $1', [
      id,
      actorId,
    ]);
  }

  async setTemporaryPassword(tx: Transaction, id: string, passwordHash: string, now: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE iam.user_account SET password_hash = $2, password_changed_at = $3, must_change_password = true, failed_attempts = 0,
              locked_until = NULL, version = version + 1, updated_by = $4
        WHERE principal_id = $1`,
      [id, passwordHash, now, actorId],
    );
  }

  async currentGrantsOf(tx: Transaction, principalIds: readonly string[], now: Date): Promise<GrantRow[]> {
    if (principalIds.length === 0) return [];
    const { rows } = await tx.query<GrantDbRow>(
      `${GRANT_SELECT} WHERE g.principal_id = ANY($1::uuid[]) AND ${CURRENT_GRANT} ORDER BY r.code, g.branch_id, g.location_id NULLS FIRST, g.id`,
      [principalIds, now],
    );
    return rows.map(grant);
  }

  async permissionsAtScope(tx: Transaction, principalId: string, branchId: string, locationId: string | null, now: Date): Promise<Set<string>> {
    const { rows } = await tx.query<{ code: string }>(
      `SELECT DISTINCT rp.permission_code AS code
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.role_permission rp ON rp.role_id = r.id AND rp.deleted_at IS NULL
         JOIN iam.principal p ON p.id = g.principal_id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT} AND p.status = 'ACTIVE'
          AND g.branch_id = $3 AND (g.location_id IS NULL OR g.location_id = $4::uuid)`,
      [principalId, now, branchId, locationId],
    );
    return new Set(rows.map((row) => row.code));
  }

  async otherActiveOwners(tx: Transaction, now: Date, exceptPrincipalId: string | null, exceptGrantId: string | null): Promise<number> {
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT g.principal_id)::int AS n
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.principal p ON p.id = g.principal_id
        WHERE r.code = 'OWNER' AND ${CURRENT_GRANT} AND p.status = 'ACTIVE' AND p.deleted_at IS NULL
          AND ($1::uuid IS NULL OR g.principal_id <> $1) AND ($3::uuid IS NULL OR g.id <> $3)`,
      [exceptPrincipalId, now, exceptGrantId],
    );
    return rows[0]!.n;
  }

  async listGrants(tx: Transaction, filter: GrantFilter, afterId: string | null, limit: number): Promise<GrantRow[]> {
    const { rows } = await tx.query<GrantDbRow>(
      `${GRANT_SELECT}
        WHERE g.deleted_at IS NULL
          AND ($1::uuid IS NULL OR g.principal_id = $1) AND ($2::uuid IS NULL OR g.role_id = $2) AND ($3::uuid IS NULL OR g.branch_id = $3)
          AND ($4::uuid IS NULL OR g.id > $4)
        ORDER BY g.id
        LIMIT $5`,
      [filter.principalId, filter.roleId, filter.branchId, afterId, limit],
    );
    return rows.map(grant);
  }

  async grant(tx: Transaction, id: string): Promise<GrantRow | null> {
    const { rows } = await tx.query<GrantDbRow>(`${GRANT_SELECT} WHERE g.id = $1`, [id]);
    return rows[0] === undefined ? null : grant(rows[0]);
  }

  async lockGrant(tx: Transaction, id: string): Promise<boolean> {
    return ((await tx.query('SELECT 1 FROM iam.role_grant WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rowCount ?? 0) > 0;
  }

  async insertGrant(tx: Transaction, created: NewGrant, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, location_id, valid_from, valid_to, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [created.id, created.principalId, created.roleId, created.branchId, created.locationId, created.validFrom, created.validTo, actorId],
    );
  }

  async revokeGrant(tx: Transaction, id: string, reason: string, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE iam.role_grant SET deleted_at = now(), deleted_by = $3, delete_reason = $2, version = version + 1, updated_by = $3
        WHERE id = $1 AND deleted_at IS NULL`,
      [id, reason, actorId],
    );
  }

  async listRoles(tx: Transaction, afterId: string | null, limit: number, now: Date): Promise<RoleRecord[]> {
    return this.roles(tx, 'AND ($2::uuid IS NULL OR r.id > $2) ORDER BY r.id LIMIT $3', [now, afterId, limit]);
  }

  async role(tx: Transaction, id: string, now: Date): Promise<RoleRecord | null> {
    return (await this.roles(tx, 'AND r.id = $2', [now, id]))[0] ?? null;
  }

  async listPermissions(tx: Transaction, module: string | null, afterCode: string | null, limit: number): Promise<PermissionRecord[]> {
    const { rows } = await tx.query<{ code: string; module: string; description: string; requires_step_up: boolean }>(
      `SELECT code, module, description, requires_step_up FROM iam.permission
        WHERE ($1::text IS NULL OR module = $1) AND ($2::text IS NULL OR code > $2)
        ORDER BY code LIMIT $3`,
      [module, afterCode, limit],
    );
    return rows.map((row) => ({ id: row.code, code: row.code, module: row.module, description: row.description, requiresStepUp: row.requires_step_up }));
  }

  async permissionCodes(tx: Transaction, codes: readonly string[]): Promise<Set<string>> {
    const { rows } = await tx.query<{ code: string }>('SELECT code FROM iam.permission WHERE code = ANY($1::text[])', [codes]);
    return new Set(rows.map((row) => row.code));
  }

  async permissionsAnywhere(tx: Transaction, principalId: string, now: Date): Promise<Set<string>> {
    const { rows } = await tx.query<{ code: string }>(
      `SELECT DISTINCT rp.permission_code AS code
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.role_permission rp ON rp.role_id = r.id AND rp.deleted_at IS NULL
         JOIN iam.principal p ON p.id = g.principal_id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT} AND p.status = 'ACTIVE'`,
      [principalId, now],
    );
    return new Set(rows.map((row) => row.code));
  }

  async holdsRole(tx: Transaction, principalId: string, roleId: string, now: Date): Promise<boolean> {
    const { rowCount } = await tx.query(`SELECT 1 FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id WHERE g.principal_id = $1 AND ${CURRENT_GRANT} AND g.role_id = $3 LIMIT 1`, [principalId, now, roleId]);
    return (rowCount ?? 0) > 0;
  }

  async lockRole(tx: Transaction, id: string): Promise<{ version: number } | null> {
    const { rows } = await tx.query<{ version: number }>('SELECT version FROM iam.role WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
    return rows[0] ?? null;
  }

  async insertRole(tx: Transaction, created: NewRole, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO iam.role (id, code, name, is_system, requires_totp, created_by, updated_by) VALUES ($1, $2, $3, false, $4, $5, $5)`,
      [created.id, created.code, created.name, created.requiresTotp, actorId],
    );
  }

  async touchRole(tx: Transaction, id: string, version: number, set: { name: string; requiresTotp: boolean }, actorId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      `UPDATE iam.role SET name = $3, requires_totp = $4, version = version + 1, updated_by = $5
        WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [id, version, set.name, set.requiresTotp, actorId],
    );
    return (rowCount ?? 0) > 0;
  }

  async addRolePermission(tx: Transaction, roleId: string, code: string, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by) VALUES ($1, $2, $3, $3)
       ON CONFLICT (role_id, permission_code) DO UPDATE
          SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL, updated_at = now(), updated_by = $3
        WHERE iam.role_permission.deleted_at IS NOT NULL`,
      [roleId, code, actorId],
    );
  }

  async removeRolePermission(tx: Transaction, roleId: string, code: string, reason: string, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE iam.role_permission SET deleted_at = now(), deleted_by = $4, delete_reason = $3, updated_at = now(), updated_by = $4
        WHERE role_id = $1 AND permission_code = $2 AND deleted_at IS NULL`,
      [roleId, code, reason, actorId],
    );
  }

  async setRoleLimit(tx: Transaction, roleId: string, limitKind: string, amountPesewas: bigint | null, reason: string, actorId: string): Promise<void> {
    if (amountPesewas === null) {
      await tx.query(
        `UPDATE iam.role_limit SET deleted_at = now(), deleted_by = $4, delete_reason = $3, version = version + 1, updated_by = $4
          WHERE role_id = $1 AND limit_kind = $2 AND deleted_at IS NULL`,
        [roleId, limitKind, reason, actorId],
      );
      return;
    }
    await tx.query(
      `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (role_id, limit_kind) DO UPDATE
          SET amount_pesewas = EXCLUDED.amount_pesewas, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL,
              version = iam.role_limit.version + 1, updated_by = $4
        WHERE iam.role_limit.amount_pesewas <> EXCLUDED.amount_pesewas OR iam.role_limit.deleted_at IS NOT NULL`,
      [roleId, limitKind, amountPesewas.toString(), actorId],
    );
  }

  private async roles(tx: Transaction, tail: string, values: unknown[]): Promise<RoleRecord[]> {
    const { rows } = await tx.query<{
      id: string;
      code: string;
      name: string;
      is_system: boolean;
      requires_totp: boolean;
      permissions: string[] | null;
      limits: Array<{ limitKind: string; amountPesewas: string }> | null;
      user_count: number;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT r.id, r.code, r.name, r.is_system, r.requires_totp,
              (SELECT array_agg(rp.permission_code ORDER BY rp.permission_code) FROM iam.role_permission rp WHERE rp.role_id = r.id AND rp.deleted_at IS NULL) AS permissions,
              (SELECT json_agg(json_build_object('limitKind', l.limit_kind, 'amountPesewas', l.amount_pesewas::text) ORDER BY l.limit_kind)
                 FROM iam.role_limit l WHERE l.role_id = r.id AND l.deleted_at IS NULL) AS limits,
              (SELECT count(DISTINCT g.principal_id)::int FROM iam.role_grant g
                WHERE g.role_id = r.id AND g.deleted_at IS NULL AND g.valid_from <= $1 AND (g.valid_to IS NULL OR g.valid_to > $1)) AS user_count,
              r.version, r.created_at, r.updated_at
         FROM iam.role r
        WHERE r.deleted_at IS NULL ${tail}`,
      values,
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isSystem: row.is_system,
      requiresTotp: row.requires_totp,
      permissions: row.permissions ?? [],
      limits: (row.limits ?? []).map((limit) => ({ limitKind: limit.limitKind, amountPesewas: BigInt(limit.amountPesewas) })),
      userCount: row.user_count,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
