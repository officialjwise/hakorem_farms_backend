import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { systemClock } from '@hakorem/kernel';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { AuditAnchor } from '../../../src/platform/audit/audit-anchor';
import { chainHash, GENESIS_HASH } from '../../../src/platform/audit/audit-chain';
import { AuditSealer } from '../../../src/platform/audit/audit-sealer';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { AuditVerifier } from '../../../src/platform/audit/audit-verifier';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { KeyRing } from '../../../src/platform/crypto/key-ring';
import { SubjectKeys } from '../../../src/platform/crypto/subject-keys';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { S3ObjectStorage } from '../../../src/platform/storage/s3-object-storage';
import { sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const SYSTEM = { principalId: '01900000-0000-7000-8000-000000000001', displayName: 'System' };
const silent = pino({ level: 'silent' });
const anchorKeys = generateKeyPairSync('ed25519');
let database: TestDatabase;
let uow: UnitOfWork;
let audit: AuditTrail;
let sealer: AuditSealer;
let verifier: AuditVerifier;
let storage: S3ObjectStorage;
const BUCKET = `anchors-${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  database = await createTestDatabase();
  uow = new UnitOfWork(database.pool('app'), silent);
  audit = new AuditTrail(new SubjectKeys(new KeyRing(new Map([[1, randomBytes(32)]]), 1), systemClock), systemClock, database.pool('app'));
  sealer = new AuditSealer(database.pool('sealer'), silent, 2);
  verifier = new AuditVerifier(database.pool('worker'), new Map([['anchor-test', anchorKeys.publicKey]]), systemClock);
  const store = inject('objectStore');
  storage = new S3ObjectStorage({ ...store, region: 'us-east-1', forcePathStyle: true, timeoutMs: 5_000 });
  await storage.ensureBucket(BUCKET, { objectLock: true });
});

afterAll(async () => {
  storage.close();
  await database.drop();
});

const record = (entityType = 'Probe') =>
  runAsSystem(SYSTEM, randomUUID(), () =>
    uow.run({ isolation: 'read committed' }, (tx) => audit.record(tx, { module: 'mdm', action: 'CREATE', entityType, entityId: randomUUID() })),
  );

async function chain(): Promise<Array<{ seq: string; audit_event_id: string; prev_hash: Buffer; chain_hash: Buffer; content_hash: Buffer }>> {
  const { rows } = await database.pool('admin').query(
    `SELECT c.seq::text AS seq, c.audit_event_id, c.prev_hash, c.chain_hash, e.content_hash
       FROM platform.audit_chain c JOIN platform.audit_event e ON e.id = c.audit_event_id ORDER BY c.seq`,
  );
  return rows as never;
}

describe('the audit sealer (ADR-0006, stage two)', () => {
  it('chains committed events with gap-free positions, each holding the hash of the one before', async () => {
    const ids = [await record(), await record(), await record()];
    expect(await sealer.sealOnce()).toBe(3);
    const rows = await chain();
    expect(rows.map((row) => row.seq)).toEqual(['1', '2', '3']);
    expect(rows.map((row) => row.audit_event_id)).toEqual(ids);
    let previous: Buffer = GENESIS_HASH;
    for (const row of rows) {
      expect(row.prev_hash.equals(previous)).toBe(true);
      expect(row.chain_hash.equals(chainHash(previous, row.content_hash, BigInt(row.seq)))).toBe(true);
      previous = row.chain_hash;
    }
    expect(await sealer.sealOnce()).toBe(0);
  });

  it('waits for an older transaction still open, then seals both in transaction order, so the order is final', async () => {
    const client = await database.pool('app').connect();
    try {
      // An older transaction takes its id and writes its audit row, then stays open.
      await client.query('BEGIN');
      const olderEvent = randomUUID();
      await client.query(
        `INSERT INTO platform.audit_event (id, occurred_at, actor_id, correlation_id, module, action, entity_type, txid, content_hash)
         VALUES ($1, now(), $2, $3, 'mdm', 'CREATE', 'Probe', '0', '\\x')`,
        [olderEvent, SYSTEM.principalId, randomUUID()],
      );
      const newerEvent = await record();
      expect(await sealer.sealOnce()).toBe(0);
      await client.query('COMMIT');
      expect(await sealer.sealOnce()).toBe(2);
      const rows = await chain();
      expect(rows.slice(-2).map((row) => row.audit_event_id)).toEqual([olderEvent, newerEvent]);
    } finally {
      client.release();
    }
  });

  it('runs one sealer at a time', async () => {
    await record();
    await record();
    const [a, b] = await Promise.all([sealer.sealOnce(), sealer.sealOnce()]);
    expect(a + b).toBe(2);
    expect(Math.min(a, b)).toBe(0);
  });
});

describe('the verifier and the anchor (ADR-0006, stage three)', () => {
  it('finds nothing wrong in an untouched chain and records SUCCESS', async () => {
    await record();
    await sealer.sealOnce();
    const report = await verifier.verify();
    expect(report).toMatchObject({ outcome: 'SUCCESS', tamperedSeqs: [], gaps: [], unsealedOlderThanAlert: 0 });
    const { rows } = await database.pool('admin').query<{ outcome: string }>("SELECT outcome FROM platform.job_run WHERE job_name = 'audit-verify' ORDER BY finished_at DESC LIMIT 1");
    expect(rows[0]!.outcome).toBe('SUCCESS');
  });

  it('signs the chain head, stores the copy off the server under object lock, and the verifier checks the signature', async () => {
    const anchor = new AuditAnchor(database.pool('sealer'), storage, anchorKeys.privateKey, systemClock, { keyId: 'anchor-test', bucket: BUCKET, retentionDays: 1 });
    const anchored = await anchor.anchor('MANUAL');
    expect(anchored).not.toBeNull();
    const key = anchored!.storageUri.replace(`s3://${BUCKET}/`, '');
    const copy = JSON.parse((await storage.get(BUCKET, key)).toString('utf8')) as { seq: string; chainHash: string; signature: string };
    expect(copy.seq).toBe(anchored!.seq.toString());
    expect(copy.chainHash).toBe(anchored!.chainHash.toString('hex'));
    expect((await verifier.verify()).anchor).toEqual({ seq: anchored!.seq.toString(), signatureValid: true, matchesChain: true });
    expect(await sqlStateOf(database.pool('app').query('DELETE FROM platform.audit_anchor'))).toBe('42501');
  });

  it('reports the exact position of an event a superuser altered behind the triggers', async () => {
    const victim = await record('Payment');
    await sealer.sealOnce();
    const { rows } = await database.pool('admin').query<{ seq: string }>('SELECT seq::text AS seq FROM platform.audit_chain WHERE audit_event_id = $1', [victim]);
    const admin = await database.pool('admin').connect();
    try {
      // A database superuser can switch triggers off for the session: the only way to change a stored row.
      await admin.query("SET session_replication_role = 'replica'");
      await admin.query("UPDATE platform.audit_event SET action = 'DELETE', metadata = '{\"note\":\"never happened\"}' WHERE id = $1", [victim]);
    } finally {
      await admin.query("SET session_replication_role = 'origin'");
      admin.release();
    }
    const report = await verifier.verify();
    expect(report.outcome).toBe('DRIFT');
    expect(report.tamperedSeqs).toEqual([rows[0]!.seq]);
    const { rows: runs } = await database
      .pool('admin')
      .query<{ outcome: string; summary: { tamperedSeqs: string[] } }>("SELECT outcome, summary FROM platform.job_run WHERE job_name = 'audit-verify' ORDER BY finished_at DESC LIMIT 1");
    expect(runs[0]).toMatchObject({ outcome: 'DRIFT', summary: { tamperedSeqs: [rows[0]!.seq] } });
  });
});
