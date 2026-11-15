import type { Transaction } from '../../../platform/database/unit-of-work';
import type { NewCustomer, OneTimePurpose, OneTimeToken, SelfServiceStore } from '../application/self-service-store';

/** `iam.principal`, `iam.user_account` and `iam.verification_token` for the customer realm and password reset (A-123). */
export class PgSelfServiceStore implements SelfServiceStore {
  async emailTaken(tx: Transaction, realm: 'CUSTOMER', email: string): Promise<boolean> {
    const { rowCount } = await tx.query('SELECT 1 FROM iam.user_account WHERE realm = $1 AND email = $2 AND deleted_at IS NULL', [realm, email]);
    return (rowCount ?? 0) > 0;
  }

  async insertCustomer(tx: Transaction, customer: NewCustomer): Promise<void> {
    await tx.query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, 'ACTIVE', $1, $1)", [
      customer.id,
      customer.displayName,
    ]);
    await tx.query(
      `INSERT INTO iam.user_account (principal_id, realm, email, phone_e164, password_hash, password_changed_at, must_change_password, created_by, updated_by)
       VALUES ($1, 'CUSTOMER', $2, $3, $4, now(), false, $1, $1)`,
      [customer.id, customer.email, customer.phone, customer.passwordHash],
    );
  }

  async markPhoneVerified(tx: Transaction, principalId: string, now: Date): Promise<void> {
    await tx.query(
      `UPDATE iam.user_account SET phone_verified_at = $2, version = version + 1, updated_by = principal_id
        WHERE principal_id = $1 AND phone_verified_at IS NULL`,
      [principalId, now],
    );
  }

  async createToken(tx: Transaction, token: OneTimeToken & { readonly tokenHash: Buffer }): Promise<void> {
    await tx.query(
      `INSERT INTO iam.verification_token (id, principal_id, purpose, token_hash, code_hash, device_label, expires_at, attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [token.id, token.principalId, token.purpose, token.tokenHash, token.codeHash, token.deviceLabel, token.expiresAt],
    );
  }

  async tokenByHash(tx: Transaction, tokenHash: Buffer, purpose: OneTimePurpose): Promise<OneTimeToken | null> {
    const { rows } = await tx.query<{
      id: string;
      principal_id: string;
      purpose: OneTimePurpose;
      device_label: string | null;
      expires_at: Date;
      consumed_at: Date | null;
      code_hash: Buffer | null;
    }>(
      `SELECT id, principal_id, purpose, device_label, expires_at, consumed_at, code_hash FROM iam.verification_token
        WHERE token_hash = $1 AND purpose = $2 FOR UPDATE`,
      [tokenHash, purpose],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, principalId: row.principal_id, purpose: row.purpose, deviceLabel: row.device_label, expiresAt: row.expires_at, consumedAt: row.consumed_at, codeHash: row.code_hash };
  }

  async consumeOpenTokens(tx: Transaction, principalId: string, purpose: OneTimePurpose, now: Date): Promise<void> {
    await tx.query('UPDATE iam.verification_token SET consumed_at = $3 WHERE principal_id = $1 AND purpose = $2 AND consumed_at IS NULL', [principalId, purpose, now]);
  }
}
