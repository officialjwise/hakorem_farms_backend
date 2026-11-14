import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = '01900000-0000-7000-8000-000000000001';
const MANAGER_ROLE = '01900000-0000-7000-8000-000000000102';
let database: TestDatabase;
let branchId: string;
let maker: string;
let checker: string;

async function principal(name: string): Promise<string> {
  const id = randomUUID();
  await database
    .pool('app')
    .query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, 'ACTIVE', $3, $3)", [id, name, SYSTEM]);
  return id;
}

async function subjectDocument(): Promise<string> {
  const id = randomUUID();
  await database.pool('app').query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'FIXTURE_DOC', 'inv', $2, $3)", [
    id,
    branchId,
    SYSTEM,
  ]);
  return id;
}

async function pendingRequest(): Promise<string> {
  const id = randomUUID();
  await database.pool('app').query(
    `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, amount_pesewas, summary, requested_by, status)
     VALUES ($1, 'STOCK_WRITE_OFF', $2, $3, $4, 45000, 'Write off goat G-0142, died of bloat', $5, 'PENDING')`,
    [id, branchId, await subjectDocument(), Buffer.alloc(32, 7), maker],
  );
  return id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const admin = database.pool('admin');
  await admin.query("INSERT INTO platform.document_type (code, owner_module, name, is_numbered) VALUES ('FIXTURE_DOC', 'inv', 'Fixture document', false)");
  branchId = randomUUID();
  await database.pool('app').query(
    "INSERT INTO mdm.branch (id, code, name, status, created_by, updated_by) VALUES ($1, 'DDW', 'Dodowa farm and shop', 'ACTIVE', $2, $2)",
    [branchId, SYSTEM],
  );
  maker = await principal('Yaw Boateng');
  checker = await principal('Kwabena Owusu');
});

afterAll(async () => {
  await database.drop();
});

describe('maker-checker in the database (ADR-0017, security architecture section 4)', () => {
  it('refuses an approval decided by the person who requested it, whatever the application does', async () => {
    const id = await pendingRequest();
    const decide = database
      .pool('app')
      .query("UPDATE iam.approval_request SET status = 'APPROVED', decided_by = $2, decided_at = now(), version = version + 1 WHERE id = $1", [id, maker]);
    expect(await sqlStateOf(decide)).toBe(SQLSTATE.checkViolation);
  });

  it('accepts a decision by a different person, and then freezes the request', async () => {
    const id = await pendingRequest();
    const app = database.pool('app');
    await app.query("UPDATE iam.approval_request SET status = 'APPROVED', decided_by = $2, decided_at = now(), version = version + 1 WHERE id = $1", [id, checker]);
    expect(
      await sqlStateOf(app.query("UPDATE iam.approval_request SET status = 'REJECTED', decision_reason = 'changed my mind', version = version + 1 WHERE id = $1", [id])),
    ).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM iam.approval_request WHERE id = $1', [id]))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('allows one open request per subject and kind', async () => {
    const subject = await subjectDocument();
    const open = () =>
      database.pool('app').query(
        `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, status)
         VALUES ($1, 'STOCK_WRITE_OFF', $2, $3, $4, 'Write off', $5, 'PENDING')`,
        [randomUUID(), branchId, subject, Buffer.alloc(32, 1), maker],
      );
    await open();
    expect(await sqlStateOf(open())).toBe(SQLSTATE.uniqueViolation);
  });

  it('requires a reason to reject', async () => {
    const id = await pendingRequest();
    const reject = database
      .pool('app')
      .query("UPDATE iam.approval_request SET status = 'REJECTED', decided_by = $2, decided_at = now(), version = version + 1 WHERE id = $1", [id, checker]);
    expect(await sqlStateOf(reject)).toBe(SQLSTATE.checkViolation);
  });
});

describe('grants and sessions (ADR-0016, A-053)', () => {
  it('refuses a role grant made by its own recipient', async () => {
    const self = await principal('Akua Mensah');
    const grant = database
      .pool('app')
      .query('INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $2, $2)', [
        randomUUID(),
        self,
        MANAGER_ROLE,
        branchId,
      ]);
    expect(await sqlStateOf(grant)).toBe(SQLSTATE.checkViolation);
  });

  it('keeps a revoked session revoked', async () => {
    const owner = await principal('Adwoa Darko');
    const id = randomUUID();
    const app = database.pool('app');
    await app.query(
      `INSERT INTO iam.session (id, principal_id, realm, csrf_token_hash, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, 'STAFF', $3, now(), now() + interval '12 hours', now() + interval '7 days')`,
      [id, owner, Buffer.alloc(32, 3)],
    );
    await app.query("UPDATE iam.session SET revoked_at = now(), revoked_by = $2, revoke_reason = 'Logged out' WHERE id = $1", [id, owner]);
    expect(await sqlStateOf(app.query("UPDATE iam.session SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1", [id]))).toBe(SQLSTATE.sessionRevoked);
    expect(await sqlStateOf(app.query('DELETE FROM iam.session WHERE id = $1', [id]))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('enforces optimistic locking on a user account', async () => {
    const owner = await principal('Esi Bonsu');
    const app = database.pool('app');
    await app.query(
      "INSERT INTO iam.user_account (principal_id, realm, email, created_by, updated_by) VALUES ($1, 'STAFF', 'esi.bonsu@hakoremfarms.test', $2, $2)",
      [owner, SYSTEM],
    );
    expect(await sqlStateOf(app.query('UPDATE iam.user_account SET failed_attempts = 1 WHERE principal_id = $1', [owner]))).toBe(SQLSTATE.versionConflict);
  });
});
