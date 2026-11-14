import type { Realm } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import type { GrantScope } from '../domain/authorisation-policy';
import type {
  AccountRecord,
  ChallengeRecord,
  GrantRecord,
  IamStore,
  NewSession,
  RefreshTokenRecord,
  SessionListFilter,
  SessionRecord,
  TotpRecord,
} from '../application/ports';

interface AccountRow {
  principal_id: string;
  realm: Realm;
  display_name: string;
  principal_status: 'ACTIVE' | 'DISABLED';
  email: string | null;
  phone_e164: string | null;
  password_hash: string | null;
  must_change_password: boolean;
  totp_required: boolean;
  version: number;
}

const ACCOUNT_SELECT = `
  SELECT a.principal_id, a.realm, p.display_name, p.status AS principal_status, a.email, a.phone_e164, a.password_hash,
         a.must_change_password, a.totp_required, a.version
    FROM iam.user_account a JOIN iam.principal p ON p.id = a.principal_id
   WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL`;

function account(row: AccountRow | undefined): AccountRecord | null {
  if (row === undefined) {
    return null;
  }
  return {
    principalId: row.principal_id,
    realm: row.realm,
    displayName: row.display_name,
    principalStatus: row.principal_status,
    email: row.email,
    phone: row.phone_e164,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password,
    totpRequired: row.totp_required,
    version: row.version,
  };
}

interface SessionRow {
  id: string;
  principal_id: string;
  realm: Realm;
  display_name: string;
  principal_status: 'ACTIVE' | 'DISABLED';
  must_change_password: boolean | null;
  device_label: string | null;
  user_agent: string | null;
  ip_created: string | null;
  csrf_token_hash: Buffer;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  stepped_up_at: Date | null;
  revoked_at: Date | null;
}

const SESSION_SELECT = `
  SELECT s.id, s.principal_id, s.realm, p.display_name, p.status AS principal_status, a.must_change_password, s.device_label,
         s.user_agent, host(s.ip_created) AS ip_created, s.csrf_token_hash, s.created_at, s.last_seen_at, s.idle_expires_at,
         s.absolute_expires_at, s.stepped_up_at, s.revoked_at
    FROM iam.session s
    JOIN iam.principal p ON p.id = s.principal_id
    LEFT JOIN iam.user_account a ON a.principal_id = s.principal_id`;

function session(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    realm: row.realm,
    displayName: row.display_name,
    principalStatus: row.principal_status,
    mustChangePassword: row.must_change_password ?? false,
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    ipCreated: row.ip_created,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    steppedUpAt: row.stepped_up_at,
    revokedAt: row.revoked_at,
  };
}

/** Grants current at an instant: live, started, not ended, of a live role. */
const CURRENT_GRANT = `g.deleted_at IS NULL AND g.valid_from <= $2 AND (g.valid_to IS NULL OR g.valid_to > $2) AND r.deleted_at IS NULL`;

/** IAM's tables, in plain parameterised SQL, each call in the caller's transaction (ADR-0008: own schema only). */
export class PgIamStore implements IamStore {
  async accountByIdentifier(tx: Transaction, realm: Realm, column: 'email' | 'phone_e164', value: string): Promise<AccountRecord | null> {
    const filter = column === 'email' ? 'a.email = $2' : 'a.phone_e164 = $2';
    const { rows } = await tx.query<AccountRow>(`${ACCOUNT_SELECT} AND a.realm = $1 AND ${filter}`, [realm, value]);
    return account(rows[0]);
  }

  async accountById(tx: Transaction, principalId: string): Promise<AccountRecord | null> {
    const { rows } = await tx.query<AccountRow>(`${ACCOUNT_SELECT} AND a.principal_id = $1`, [principalId]);
    return account(rows[0]);
  }

  async recordLoginFailure(tx: Transaction, record: AccountRecord, failedAttempts: number, lockedUntil: Date | null): Promise<void> {
    await tx.query(
      `UPDATE iam.user_account SET failed_attempts = $2, locked_until = $3, version = version + 1, updated_by = principal_id
        WHERE principal_id = $1`,
      [record.principalId, failedAttempts, lockedUntil],
    );
  }

  async recordLoginSuccess(tx: Transaction, principalId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE iam.user_account SET failed_attempts = 0, locked_until = NULL, last_login_at = $2, version = version + 1, updated_by = principal_id
        WHERE principal_id = $1`,
      [principalId, now],
    );
  }

  async setPassword(tx: Transaction, principalId: string, passwordHash: string, now: Date, actorId: string): Promise<void> {
    await tx.query(
      `UPDATE iam.user_account SET password_hash = $2, password_changed_at = $3, must_change_password = false, failed_attempts = 0,
              locked_until = NULL, version = version + 1, updated_by = $4
        WHERE principal_id = $1`,
      [principalId, passwordHash, now, actorId],
    );
  }

  async holdsRoleRequiringTotp(tx: Transaction, principalId: string, now: Date): Promise<boolean> {
    const { rows } = await tx.query(
      `SELECT 1 FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT} AND r.requires_totp LIMIT 1`,
      [principalId, now],
    );
    return rows.length > 0;
  }

  async totp(tx: Transaction, principalId: string): Promise<TotpRecord | null> {
    const { rows } = await tx.query<{ secret_enc: Buffer; confirmed_at: Date | null; last_used_step: string | null; version: number }>(
      'SELECT secret_enc, confirmed_at, last_used_step, version FROM iam.totp_credential WHERE principal_id = $1 AND deleted_at IS NULL',
      [principalId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { secretEnc: row.secret_enc, confirmedAt: row.confirmed_at, lastUsedStep: row.last_used_step === null ? null : Number(row.last_used_step), version: row.version };
  }

  async savePendingTotp(tx: Transaction, principalId: string, secretEnc: Buffer, actorId: string): Promise<void> {
    await tx.query(
      `INSERT INTO iam.totp_credential (principal_id, secret_enc, created_by, updated_by) VALUES ($1, $2, $3, $3)
       ON CONFLICT (principal_id) DO UPDATE
         SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, last_used_step = NULL,
             version = iam.totp_credential.version + 1, updated_by = EXCLUDED.updated_by
       WHERE iam.totp_credential.confirmed_at IS NULL`,
      [principalId, secretEnc, actorId],
    );
  }

  async useTotpStep(tx: Transaction, principalId: string, step: number, confirm: boolean, actorId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE iam.totp_credential
          SET last_used_step = $2, confirmed_at = CASE WHEN $3 THEN now() ELSE confirmed_at END, version = version + 1, updated_by = $4
        WHERE principal_id = $1 AND deleted_at IS NULL AND (last_used_step IS NULL OR last_used_step < $2)
          AND (confirmed_at IS NULL) = $3`,
      [principalId, step, confirm, actorId],
    );
    return result.rowCount === 1;
  }

  async replaceRecoveryCodes(tx: Transaction, principalId: string, codeHashes: readonly Buffer[], now: Date, nextId: () => string): Promise<void> {
    await tx.query('UPDATE iam.recovery_code SET used_at = $2 WHERE principal_id = $1 AND used_at IS NULL', [principalId, now]);
    for (const hash of codeHashes) {
      await tx.query('INSERT INTO iam.recovery_code (id, principal_id, code_hash, created_at) VALUES ($1, $2, $3, $4)', [nextId(), principalId, hash, now]);
    }
  }

  async useRecoveryCode(tx: Transaction, principalId: string, codeHash: Buffer, now: Date): Promise<boolean> {
    const result = await tx.query(
      `UPDATE iam.recovery_code SET used_at = $3
        WHERE id = (SELECT id FROM iam.recovery_code WHERE principal_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)`,
      [principalId, codeHash, now],
    );
    return result.rowCount === 1;
  }

  async createChallenge(tx: Transaction, challenge: ChallengeRecord & { readonly tokenHash: Buffer }): Promise<void> {
    await tx.query(
      `INSERT INTO iam.verification_token (id, principal_id, purpose, token_hash, device_label, expires_at, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, 0)`,
      [challenge.id, challenge.principalId, challenge.purpose, challenge.tokenHash, challenge.deviceLabel, challenge.expiresAt],
    );
  }

  async challengeByHash(tx: Transaction, tokenHash: Buffer): Promise<ChallengeRecord | null> {
    const { rows } = await tx.query<{
      id: string;
      principal_id: string;
      purpose: ChallengeRecord['purpose'];
      device_label: string | null;
      expires_at: Date;
      attempts: number;
      consumed_at: Date | null;
    }>(
      `SELECT id, principal_id, purpose, device_label, expires_at, attempts, consumed_at FROM iam.verification_token
        WHERE token_hash = $1 AND purpose IN ('LOGIN_TOTP', 'LOGIN_TOTP_ENROLMENT', 'LOGIN_PASSWORD_CHANGE')`,
      [tokenHash],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          principalId: row.principal_id,
          purpose: row.purpose,
          deviceLabel: row.device_label,
          expiresAt: row.expires_at,
          attempts: row.attempts,
          consumedAt: row.consumed_at,
        };
  }

  async countChallengeAttempt(tx: Transaction, id: string): Promise<number> {
    const { rows } = await tx.query<{ attempts: number }>('UPDATE iam.verification_token SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
    return rows[0]?.attempts ?? Number.MAX_SAFE_INTEGER;
  }

  async consumeChallenge(tx: Transaction, id: string, now: Date): Promise<void> {
    await tx.query('UPDATE iam.verification_token SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL', [id, now]);
  }

  async createSession(tx: Transaction, s: NewSession): Promise<void> {
    await tx.query(
      `INSERT INTO iam.session (id, principal_id, realm, device_label, user_agent, ip_created, csrf_token_hash, created_at, last_seen_at,
                                idle_expires_at, absolute_expires_at, stepped_up_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
      [s.id, s.principalId, s.realm, s.deviceLabel, s.userAgent, s.ip, s.csrfTokenHash, s.now, s.idleExpiresAt, s.absoluteExpiresAt, s.steppedUpAt],
    );
  }

  async sessionById(tx: Transaction, id: string): Promise<SessionRecord | null> {
    const { rows } = await tx.query<SessionRow>(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
    return rows[0] === undefined ? null : session(rows[0]);
  }

  async touchSession(tx: Transaction, id: string, now: Date, idleExpiresAt: Date | null): Promise<void> {
    await tx.query(
      `UPDATE iam.session SET last_seen_at = $2, idle_expires_at = coalesce($3, idle_expires_at) WHERE id = $1 AND revoked_at IS NULL`,
      [id, now, idleExpiresAt],
    );
  }

  async stepUpSession(tx: Transaction, id: string, now: Date): Promise<void> {
    await tx.query('UPDATE iam.session SET stepped_up_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, now]);
  }

  async revokeSession(tx: Transaction, id: string, by: string, reason: string, now: Date): Promise<boolean> {
    const result = await tx.query(
      'UPDATE iam.session SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1 AND revoked_at IS NULL',
      [id, now, by, reason],
    );
    return result.rowCount === 1;
  }

  async revokeOtherSessions(tx: Transaction, principalId: string, exceptSessionId: string | null, by: string, reason: string, now: Date): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE iam.session SET revoked_at = $3, revoked_by = $4, revoke_reason = $5
        WHERE principal_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid) RETURNING id`,
      [principalId, exceptSessionId, now, by, reason],
    );
    return rows.map((row) => row.id);
  }

  async listSessions(tx: Transaction, filter: SessionListFilter): Promise<SessionRecord[]> {
    const { rows } = await tx.query<SessionRow>(
      `${SESSION_SELECT}
        WHERE ($1::uuid IS NULL OR s.principal_id = $1::uuid)
          AND ($2::boolean IS NULL OR (s.revoked_at IS NULL AND s.absolute_expires_at > now()) = $2::boolean)
          AND ($3::uuid IS NULL OR s.id < $3::uuid)
        ORDER BY s.id DESC
        LIMIT $4`,
      [filter.principalId, filter.activeOnly, filter.beforeId, filter.limit],
    );
    return rows.map(session);
  }

  async createRefreshToken(
    tx: Transaction,
    token: { id: string; sessionId: string; tokenHash: Buffer; issuedAt: Date; expiresAt: Date; replacesId?: string },
  ): Promise<void> {
    await tx.query('INSERT INTO iam.refresh_token (id, session_id, token_hash, issued_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [
      token.id,
      token.sessionId,
      token.tokenHash,
      token.issuedAt,
      token.expiresAt,
    ]);
    if (token.replacesId !== undefined) {
      await tx.query('UPDATE iam.refresh_token SET replaced_by_id = $2 WHERE id = $1', [token.replacesId, token.id]);
    }
  }

  async refreshTokenByHash(tx: Transaction, tokenHash: Buffer): Promise<RefreshTokenRecord | null> {
    const { rows } = await tx.query<{ id: string; session_id: string; expires_at: Date; used_at: Date | null }>(
      'SELECT id, session_id, expires_at, used_at FROM iam.refresh_token WHERE token_hash = $1',
      [tokenHash],
    );
    const row = rows[0];
    return row === undefined ? null : { id: row.id, sessionId: row.session_id, expiresAt: row.expires_at, usedAt: row.used_at };
  }

  async markRefreshTokenUsed(tx: Transaction, id: string, now: Date): Promise<boolean> {
    const result = await tx.query('UPDATE iam.refresh_token SET used_at = $2 WHERE id = $1 AND used_at IS NULL', [id, now]);
    return result.rowCount === 1;
  }

  async currentGrants(tx: Transaction, principalId: string, now: Date): Promise<GrantRecord[]> {
    const { rows } = await tx.query<{ role_code: string; role_name: string; branch_id: string; location_id: string | null }>(
      `SELECT r.code AS role_code, r.name AS role_name, g.branch_id, g.location_id
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT}
        ORDER BY r.code, g.branch_id, g.location_id NULLS FIRST`,
      [principalId, now],
    );
    return rows.map((row) => ({ roleCode: row.role_code, roleName: row.role_name, branchId: row.branch_id, locationId: row.location_id }));
  }

  async currentPermissions(tx: Transaction, principalId: string, now: Date): Promise<string[]> {
    const { rows } = await tx.query<{ code: string }>(
      `SELECT DISTINCT rp.permission_code AS code
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.role_permission rp ON rp.role_id = r.id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT}
        ORDER BY 1`,
      [principalId, now],
    );
    return rows.map((row) => row.code);
  }

  async grantsWithPermission(tx: Transaction, principalId: string, permission: string, now: Date): Promise<GrantScope[]> {
    const { rows } = await tx.query<{ branch_id: string; location_id: string | null }>(
      `SELECT g.branch_id, g.location_id
         FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id JOIN iam.role_permission rp ON rp.role_id = r.id
         JOIN iam.principal p ON p.id = g.principal_id
        WHERE g.principal_id = $1 AND ${CURRENT_GRANT} AND rp.permission_code = $3 AND p.status = 'ACTIVE' AND p.deleted_at IS NULL`,
      [principalId, now, permission],
    );
    return rows.map((row) => ({ branchId: row.branch_id, locationId: row.location_id }));
  }

  async permissionRequiresStepUp(tx: Transaction, permission: string): Promise<boolean | null> {
    const { rows } = await tx.query<{ requires_step_up: boolean }>('SELECT requires_step_up FROM iam.permission WHERE code = $1', [permission]);
    return rows[0]?.requires_step_up ?? null;
  }

}
