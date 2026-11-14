import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = '01900000-0000-7000-8000-000000000001';
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function insertAuditEvent(role: 'app' | 'admin', overrides: { txid?: string; contentHash?: string } = {}): Promise<string> {
  const id = randomUUID();
  const columns = ['id', 'occurred_at', 'actor_id', 'correlation_id', 'module', 'action', 'entity_type', 'entity_id'];
  const values: unknown[] = [id, new Date('2026-11-14T09:00:00Z'), SYSTEM, randomUUID(), 'mdm', 'CREATE', 'Product', randomUUID()];
  // The application may try to supply the sealing fields; the trigger must overwrite them.
  columns.push('txid', 'content_hash');
  values.push(overrides.txid ?? '1', Buffer.from(overrides.contentHash ?? '00'.repeat(32), 'hex'));
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  await database.pool(role).query(`INSERT INTO platform.audit_event (${columns.join(', ')}) VALUES (${placeholders})`, values);
  return id;
}

describe('platform.audit_event is insert-only for every role (ADR-0006, ADR-0024)', () => {
  it('lets hk_app insert and read an event', async () => {
    const id = await insertAuditEvent('app');
    const { rowCount } = await database.pool('app').query('SELECT 1 FROM platform.audit_event WHERE id = $1', [id]);
    expect(rowCount).toBe(1);
  });

  it('refuses hk_app an update, a delete and a truncate of an audit event', async () => {
    const id = await insertAuditEvent('app');
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE platform.audit_event SET action = 'DELETE' WHERE id = $1", [id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('DELETE FROM platform.audit_event WHERE id = $1', [id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('TRUNCATE platform.audit_event'))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('refuses even the owner an update or delete, because the trigger rejects it for every role', async () => {
    const id = await insertAuditEvent('admin');
    const admin = database.pool('admin');
    expect(await sqlStateOf(admin.query("UPDATE platform.audit_event SET action = 'DELETE' WHERE id = $1", [id]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin.query('DELETE FROM platform.audit_event WHERE id = $1', [id]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await sqlStateOf(admin.query('TRUNCATE platform.audit_event CASCADE'))).toBe(SQLSTATE.ledgerImmutable);
  });

  it('sets the transaction id and content hash itself, whatever the application sends', async () => {
    const id = await insertAuditEvent('app', { txid: '1', contentHash: 'ff'.repeat(32) });
    const { rows } = await database.pool('admin').query<{ txid: string; matches: boolean; size: number }>(
      `SELECT e.txid::text AS txid, e.content_hash = platform.audit_event_content_hash(e) AS matches, length(e.content_hash) AS size
         FROM platform.audit_event e WHERE e.id = $1`,
      [id],
    );
    expect(rows[0]!.txid).not.toBe('1');
    expect(rows[0]!.matches).toBe(true);
    expect(rows[0]!.size).toBe(32);
  });
});

describe('the audit chain and anchors are written only by the sealer (ADR-0006)', () => {
  it('refuses hk_app any write to the chain or the anchors', async () => {
    const eventId = await insertAuditEvent('app');
    const app = database.pool('app');
    const zero = Buffer.alloc(32);
    expect(
      await sqlStateOf(app.query('INSERT INTO platform.audit_chain (seq, audit_event_id, prev_hash, chain_hash) VALUES (1, $1, $2, $2)', [eventId, zero])),
    ).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('UPDATE platform.audit_chain SET seq = seq'))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('DELETE FROM platform.audit_chain'))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('TRUNCATE platform.audit_chain'))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(app.query('DELETE FROM platform.audit_anchor'))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('lets hk_sealer read events and append to the chain, and refuses it an update or delete of the chain', async () => {
    const eventId = await insertAuditEvent('app');
    const sealer = database.pool('sealer');
    const { rows } = await sealer.query<{ content_hash: Buffer }>('SELECT content_hash FROM platform.audit_event WHERE id = $1', [eventId]);
    expect(rows).toHaveLength(1);
    const zero = Buffer.alloc(32);
    await sealer.query('INSERT INTO platform.audit_chain (seq, audit_event_id, prev_hash, chain_hash) VALUES (1000, $1, $2, $2)', [eventId, zero]);
    expect(await sqlStateOf(sealer.query('UPDATE platform.audit_chain SET sealed_at = now() WHERE seq = 1000'))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(sealer.query('DELETE FROM platform.audit_chain WHERE seq = 1000'))).toBe(SQLSTATE.insufficientPrivilege);
  });

  it('refuses hk_sealer every business table and every other platform table', async () => {
    const sealer = database.pool('sealer');
    for (const table of ['iam.user_account', 'iam.session', 'mdm.product', 'mdm.branch']) {
      expect(await sqlStateOf(sealer.query(`SELECT 1 FROM ${table} LIMIT 1`)), table).toBe(SQLSTATE.insufficientPrivilege);
    }
    for (const table of ['platform.outbox_message', 'platform.idempotency_key', 'platform.subject_key', 'platform.job_run']) {
      expect(await sqlStateOf(sealer.query(`SELECT 1 FROM ${table} LIMIT 1`)), table).toBe(SQLSTATE.insufficientPrivilege);
    }
    expect(await sqlStateOf(sealer.query(`INSERT INTO platform.audit_event (id) VALUES ($1)`, [randomUUID()]))).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('platform.subject_key (ADR-0022)', () => {
  it('cannot change once destroyed, and a wrapped key is present exactly while it is not destroyed', async () => {
    const app = database.pool('app');
    const id = randomUUID();
    await app.query(
      `INSERT INTO platform.subject_key (id, subject_type, subject_id, wrapped_key, kek_version, created_by, updated_by)
       VALUES ($1, 'STAFF', $2, $3, 1, $4, $4)`,
      [id, randomUUID(), Buffer.alloc(60, 1), SYSTEM],
    );
    expect(
      await sqlStateOf(app.query('UPDATE platform.subject_key SET destroyed_at = now(), version = version + 1 WHERE id = $1', [id])),
    ).toBe(SQLSTATE.checkViolation);
    await app.query(
      `UPDATE platform.subject_key SET wrapped_key = NULL, destroyed_at = now(), destroyed_by = $2, destroy_reason = 'Deletion request',
              version = version + 1 WHERE id = $1`,
      [id, SYSTEM],
    );
    expect(
      await sqlStateOf(app.query("UPDATE platform.subject_key SET destroy_reason = 'changed', version = version + 1 WHERE id = $1", [id])),
    ).toBe(SQLSTATE.subjectKeyDestroyed);
    expect(await sqlStateOf(app.query('DELETE FROM platform.subject_key WHERE id = $1', [id]))).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('platform.idempotency_key (ADR-0014)', () => {
  it('refuses a second row with the same scope and key, and a lifetime shorter than 72 hours', async () => {
    const app = database.pool('app');
    const insert = (key: string, expires: string) =>
      app.query(
        `INSERT INTO platform.idempotency_key (id, scope, key, principal_id, request_hash, status, expires_at)
         VALUES ($1, 'p:createProduct', $2, $3, $4, 'IN_PROGRESS', now() + $5::interval)`,
        [randomUUID(), key, SYSTEM, Buffer.alloc(32), expires],
      );
    await insert('019a7b1d-1c55-7fe4-b51c-071c42887ffa', '72 hours');
    expect(await sqlStateOf(insert('019a7b1d-1c55-7fe4-b51c-071c42887ffa', '72 hours'))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(insert('019a7b1d-1c55-7fe4-b51c-071c42887ffb', '71 hours'))).toBe(SQLSTATE.checkViolation);
  });
});
