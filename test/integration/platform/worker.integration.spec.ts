import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../../../src/platform/config/app-config';
import { BullmqJobQueue } from '../../../src/platform/queue/job-queue';
import { startWorker } from '../../../src/worker-app';
import { TEST_SECRETS } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const silent = pino({ level: 'silent' });
const prefix = `tw${randomBytes(3).toString('hex')}:`;
let database: TestDatabase;
let worker: { close(): Promise<void> };

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for the worker');
}

beforeAll(async () => {
  database = await createTestDatabase();
  const store = inject('objectStore');
  const config = loadConfig(
    {
      ...TEST_SECRETS,
      NODE_ENV: 'test',
      APP_ENV: 'test',
      APP_ROLE: 'worker',
      DATABASE_URL_WORKER: database.url('worker'),
      DATABASE_URL_SEALER: database.url('sealer'),
      REDIS_URL: inject('redisUrl'),
      REDIS_KEY_PREFIX: prefix,
      S3_ENDPOINT: store.endpoint,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ANCHOR_ACCESS_KEY_ID: store.accessKeyId,
      S3_ANCHOR_SECRET_ACCESS_KEY: store.secretAccessKey,
      S3_BUCKET_ANCHORS: `anchors-${randomBytes(4).toString('hex')}`,
      AUDIT_ANCHOR_SIGNING_KEY: generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      AUDIT_ANCHOR_KEY_ID: 'anchor-test',
      AUDIT_SEAL_INTERVAL_MS: '200',
      OUTBOX_POLL_INTERVAL_MS: '200',
      SCHEDULER_ENABLED: 'false',
      METRICS_ENABLED: 'false',
    },
    '0.1.0',
  );
  worker = await startWorker(config, silent);
});

afterAll(async () => {
  await worker.close();
  await database.drop();
});

describe('the worker process (ADR-0006, ADR-0010)', () => {
  it('seals audit events written by the API on its own, within seconds', async () => {
    const id = randomUUID();
    await database.pool('app').query(
      `INSERT INTO platform.audit_event (id, occurred_at, actor_id, correlation_id, module, action, entity_type, txid, content_hash)
       VALUES ($1, now(), '01900000-0000-7000-8000-000000000001', $2, 'mdm', 'CREATE', 'Product', '0', '\\x')`,
      [id, randomUUID()],
    );
    await waitFor(async () => (await database.pool('admin').query('SELECT 1 FROM platform.audit_chain WHERE audit_event_id = $1', [id])).rowCount === 1);
  });

  it('runs a queued anchor job: the chain head is signed, stored under object lock and recorded', async () => {
    const url = new URL(inject('redisUrl'));
    const queue = new BullmqJobQueue({ host: url.hostname, port: Number(url.port) }, `${prefix}bull`, silent);
    try {
      await queue.add('audit-anchor', {});
      await waitFor(async () => (await database.pool('admin').query("SELECT 1 FROM platform.audit_anchor WHERE reason = 'DAILY'")).rowCount === 1);
    } finally {
      await queue.close();
    }
  });

  it('purges expired idempotency keys and records the run', async () => {
    const admin = database.pool('admin');
    await admin.query(
      `INSERT INTO platform.idempotency_key (id, scope, key, principal_id, request_hash, status, created_at, expires_at)
       VALUES ($1, 'p:createProduct', 'old-key', '01900000-0000-7000-8000-000000000001', $2, 'IN_PROGRESS', now() - interval '80 hours', now() - interval '8 hours')`,
      [randomUUID(), Buffer.alloc(32)],
    );
    const url = new URL(inject('redisUrl'));
    const queue = new BullmqJobQueue({ host: url.hostname, port: Number(url.port) }, `${prefix}bull`, silent);
    try {
      await queue.add('idempotency-purge', {});
      await waitFor(async () => (await admin.query("SELECT 1 FROM platform.job_run WHERE job_name = 'idempotency-purge'")).rowCount === 1);
    } finally {
      await queue.close();
    }
    expect((await admin.query("SELECT 1 FROM platform.idempotency_key WHERE key = 'old-key'")).rowCount).toBe(0);
  });
});
