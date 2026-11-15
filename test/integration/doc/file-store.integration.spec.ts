import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { runWithRequestContext } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileScanner } from '../../../src/platform/storage/file-scanner';
import { FileStore } from '../../../src/platform/storage/file-store';
import { ClamdScanner, MalwareScannerUnavailableError } from '../../../src/platform/storage/malware-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestBranch, type TestSession } from '../../support/iam';
import { EICAR, SCANNER_PORT, startScanner } from '../../support/scanner';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, TEST_PRIVATE_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The file store (FR-DOC-006, FR-DOC-007, SEC-027, ADR-0044): every operation refuses the wrong role in the
 * application layer (ADR-0035); the type comes from the bytes and the size is capped; a file is PENDING until the
 * real ClamAV scanner says CLEAN, and only then is it linked, by a link that expires, refuses tampering and is logged.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let scannerContainer: StartedTestContainer;
let scanner: FileScanner;
let dodowa: TestBranch;
let manager: TestSession;
let accountant: TestSession;
let storekeeper: TestSession;
let secondStorekeeper: TestSession;
const refused: Record<string, TestSession> = {};
const REFUSED_ROLES: readonly RoleCode[] = ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND'];

const MB = 1_048_576;
const jpeg = (size = 2_048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(size - 4)]);
const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size - 9, 0x20)]);
const admin = () => database.pool('admin');

function upload(session: TestSession, purpose: string, content: Buffer, filename: string, key: string = randomUUID()) {
  return consolePost(api.server, session, '/v1/files', key).field('purpose', purpose).attach('file', content, { filename, contentType: 'application/octet-stream' });
}
const getFile = (session: TestSession, id: string) => consoleGet(api.server, session, `/v1/files/${id}`);
const signedUrl = (session: TestSession, id: string) =>
  request(api.server).post(`/v1/files/${id}/signed-url`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN);
const count = async (sql: string, values: unknown[] = []) => (await admin().query<{ n: number }>(sql, values)).rows[0]!.n;
const storedFiles = () => count('SELECT count(*)::int AS n FROM platform.stored_file');
const failures = () => count("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");

async function uploaded(session: TestSession, purpose: string, content: Buffer, filename: string): Promise<string> {
  const response = await upload(session, purpose, content, filename);
  expect(response.status).toBe(201);
  return response.body.id as string;
}

beforeAll(async () => {
  [database, scannerContainer] = await Promise.all([createTestDatabase(), startScanner()]);
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database, 'DDW');
  const now = () => clock.now();
  const user = (name: string, role: RoleCode) => createUser(database, { name, grants: [{ role, branchId: dodowa.branchId }] });
  manager = await enrolAndLogin(api.server, await user('Kwabena Owusu', 'MANAGER'), now);
  accountant = await enrolAndLogin(api.server, await user('Yaw Agyeman', 'ACCOUNTANT'), now);
  storekeeper = await login(api.server, await user('Abena Quaye', 'STOREKEEPER'));
  secondStorekeeper = await login(api.server, await user('Kofi Mensah', 'STOREKEEPER'));
  for (const role of REFUSED_ROLES) {
    refused[role] = await login(api.server, await user(`Ama ${role.toLowerCase()}`, role));
  }
  refused['NO_GRANT'] = await login(api.server, await createUser(database, { name: 'Efua Nkansah' }));

  // The worker's scanner, as the worker builds it: the hk_worker pool, the files credential, the real clamd.
  const workerPool = database.pool('worker');
  scanner = new FileScanner(
    workerPool,
    new UnitOfWork(workerPool, api.logger),
    api.app.get<ObjectStorage>(OBJECT_STORAGE),
    new ClamdScanner({ host: scannerContainer.getHost(), port: scannerContainer.getMappedPort(SCANNER_PORT), timeoutMs: 30_000 }),
    api.app.get(AuditTrail),
    clock,
    api.logger,
  );
});

// Access tokens last ten minutes; each test starts with every session refreshed.
beforeEach(async () => {
  for (const session of [manager, accountant, storekeeper, secondStorekeeper, ...Object.values(refused)]) {
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
    expect(refreshed.status).toBe(200);
    session.jar.store(refreshed.headers['set-cookie']);
  }
});

afterAll(async () => {
  await api.close();
  await Promise.all([database.drop(), scannerContainer.stop()]);
});

describe('the file store refuses the wrong role (ADR-0035, deny by default)', () => {
  it('refuses an upload to the cashier, sales, driver, farm hand and a user with no grant, stores nothing and audits each refusal', async () => {
    const before = await storedFiles();
    const failed = await failures();
    for (const [role, session] of Object.entries(refused)) {
      const response = await upload(session, 'EVIDENCE', jpeg(), 'goat-pen.jpg');
      expect(response.status, role).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    expect(await storedFiles()).toBe(before);
    expect(await failures()).toBe(failed + REFUSED_ROLES.length + 1);
  });

  it('refuses reading a file and issuing its link to the same roles', async () => {
    const id = await uploaded(storekeeper, 'EVIDENCE', jpeg(), 'broken-crate.jpg');
    for (const [role, session] of Object.entries(refused)) {
      expect((await getFile(session, id)).status, role).toBe(403);
      expect((await signedUrl(session, id)).status, role).toBe(403);
    }
  });

  it("refuses one storekeeper another's file, and lets the manager and accountant, who check approvals, read it", async () => {
    const id = await uploaded(storekeeper, 'SUPPLIER_INVOICE', pdf(4_096), 'invoice-0193.pdf');
    expect((await getFile(storekeeper, id)).status).toBe(200);
    const other = await getFile(secondStorekeeper, id);
    expect(other.status).toBe(403);
    expect((await signedUrl(secondStorekeeper, id)).status).toBe(403);
    expect((await getFile(manager, id)).status).toBe(200);
    expect((await getFile(accountant, id)).status).toBe(200);
  });

  it('answers 404 for a file that does not exist', async () => {
    expect((await getFile(manager, randomUUID())).status).toBe(404);
  });
});

describe('uploads are typed by their bytes and capped before they are read in full (FR-DOC-006, SEC-027)', () => {
  it('stores a photograph PENDING under a random key, typed by its bytes whatever its name, with its hash and audit event', async () => {
    const content = jpeg(50_000);
    const response = await upload(storekeeper, 'EVIDENCE', content, '../../etc/report.pdf');
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ contentType: 'image/jpeg', sizeBytes: 50_000, purpose: 'EVIDENCE', classification: 'CONFIDENTIAL', scanStatus: 'PENDING', originalName: 'report.pdf' });
    const { rows } = await admin().query<{ bucket: string; object_key: string; sha256: Buffer }>('SELECT bucket, object_key, sha256 FROM platform.stored_file WHERE id = $1', [response.body.id]);
    expect(rows[0]!.bucket).toBe(TEST_PRIVATE_BUCKET);
    expect(rows[0]!.object_key).toMatch(/^evidence\/[0-9a-f-]{36}$/);
    expect(rows[0]!.object_key).not.toContain('report');
    expect(rows[0]!.sha256.toString('hex')).toBe(createHash('sha256').update(content).digest('hex'));
    const stored = await api.app.get<ObjectStorage>(OBJECT_STORAGE).get(TEST_PRIVATE_BUCKET, rows[0]!.object_key);
    expect(stored.equals(content)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'StoredFile' AND entity_id = $1 AND action = 'CREATE'", [response.body.id])).toBe(1);
  });

  it('refuses a ZIP renamed .jpg with 415 FILE_TYPE_NOT_ALLOWED', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(512)]);
    const response = await upload(storekeeper, 'PRODUCT_IMAGE', zip, 'goat.jpg');
    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('refuses a 12 MB PDF at the 10 MB cap with 413 before the body is read in full, and a 6 MB photograph at the 5 MB cap', async () => {
    const before = await storedFiles();
    const tooLarge = await upload(storekeeper, 'SUPPLIER_INVOICE', pdf(12 * MB), 'scan.pdf');
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const photo = await upload(storekeeper, 'EVIDENCE', jpeg(6 * MB), 'pen.jpg');
    expect(photo.status).toBe(413);
    expect((await upload(storekeeper, 'SUPPLIER_INVOICE', pdf(10 * MB), 'scan.pdf')).status).toBe(201);
    expect(await storedFiles()).toBe(before + 1);
  });

  it('refuses a body whose declared length is over the cap without reading it', async () => {
    const response = await consolePost(api.server, storekeeper, '/v1/files').set('Content-Type', 'multipart/form-data; boundary=x').set('Content-Length', String(11 * MB)).send('--x--');
    expect(response.status).toBe(413);
  });

  it('refuses an unknown purpose, a missing file and an empty file with 400', async () => {
    expect((await upload(storekeeper, 'SELFIE', jpeg(), 'me.jpg')).status).toBe(400);
    expect((await consolePost(api.server, storekeeper, '/v1/files').field('purpose', 'EVIDENCE')).status).toBe(400);
    expect((await upload(storekeeper, 'EVIDENCE', Buffer.alloc(0), 'empty.jpg')).status).toBe(400);
  });

  it('returns the first response to a replay with the same key and stores one file', async () => {
    const key = randomUUID();
    const content = jpeg();
    const first = await upload(storekeeper, 'EVIDENCE', content, 'tray.jpg', key);
    const before = await storedFiles();
    const second = await upload(storekeeper, 'EVIDENCE', content, 'tray.jpg', key);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(await storedFiles()).toBe(before);
    expect((await upload(storekeeper, 'EVIDENCE', jpeg(), 'tray.jpg', key)).status).toBe(409);
  });
});

describe('a file is served only once the real scanner says CLEAN (A-057, FR-DOC-006)', () => {
  it('marks the EICAR test file INFECTED, and then neither shows it nor links it', async () => {
    const id = await uploaded(storekeeper, 'IMPORT', Buffer.from(EICAR), 'customers.csv');
    expect((await signedUrl(storekeeper, id)).body.error.code).toBe('FILE_NOT_CLEAN');
    const round = await scanner.scanPending(50);
    expect(round.infected).toBeGreaterThanOrEqual(1);
    const { rows } = await admin().query<{ scan_status: string; scan_verdict: string }>('SELECT scan_status, scan_verdict FROM platform.stored_file WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ scan_status: 'INFECTED', scan_verdict: 'Eicar-Test-Signature' });
    const shown = await getFile(storekeeper, id);
    expect(shown.status).toBe(422);
    expect(shown.body.error.code).toBe('FILE_NOT_CLEAN');
    expect((await signedUrl(manager, id)).status).toBe(422);
    expect(await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_id = $1 AND action = 'UPDATE' AND actor_id = '01900000-0000-7000-8000-000000000005'", [id])).toBe(1);
  });

  it('marks a clean photograph CLEAN, after which its link fetches exactly its bytes and each of three issues is one access log row', async () => {
    const content = jpeg(20_000);
    const id = await uploaded(storekeeper, 'EVIDENCE', content, 'dead-broiler.jpg');
    expect((await getFile(storekeeper, id)).body.scanStatus).toBe('PENDING');
    await scanner.scanPending(50);
    expect((await getFile(storekeeper, id)).body.scanStatus).toBe('CLEAN');
    const links = [];
    for (let issue = 0; issue < 3; issue += 1) {
      const response = await signedUrl(storekeeper, id);
      expect(response.status).toBe(200);
      expect(new Date(response.body.expiresAt as string).getTime() - clock.now().getTime()).toBe(300_000);
      links.push(response.body.url as string);
    }
    const fetched = await fetch(links[0]!);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(content)).toBe(true);
    const { rows } = await admin().query<{ n: number; ip: string | null }>("SELECT count(*)::int AS n, max(host(ip)) AS ip FROM platform.file_access_log WHERE file_id = $1 AND purpose = 'createFileSignedUrl'", [id]);
    expect(rows[0]!.n).toBe(3);
    expect(rows[0]!.ip).not.toBeNull();
  });

  it('refuses a link with one extra character in its signature, and one used five minutes and a second after it was signed (FR-DOC-007)', async () => {
    const id = await uploaded(storekeeper, 'EVIDENCE', jpeg(), 'scale-ticket.jpg');
    await scanner.scanPending(50);
    const link = (await signedUrl(storekeeper, id)).body.url as string;
    const tampered = link.replace(/X-Amz-Signature=([0-9a-f]+)/, 'X-Amz-Signature=$1a');
    expect((await fetch(tampered)).status).toBe(403);

    const past = new ManualClock(new Date(Date.now() - 301_000));
    const store = new FileStore(api.app.get<ObjectStorage>(OBJECT_STORAGE), { privateBucket: TEST_PRIVATE_BUCKET, ensureBucket: false }, api.app.get(AuditTrail), past);
    const actor = { principalId: '01900000-0000-7000-8000-000000000001', kind: 'SYSTEM' as const, displayName: 'System', realm: null, sessionId: null, steppedUpAt: null };
    const expired = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: null, actor }, () =>
      new UnitOfWork(database.pool('app'), api.logger).run({ isolation: 'read committed' }, async (tx) => store.signedLink(tx, (await store.find(tx, id))!, 'expiry test', 300)),
    );
    expect((await fetch(expired.url)).status).toBe(403);
  });

  it('leaves a file PENDING, never served, while the scanner cannot be reached', async () => {
    const id = await uploaded(storekeeper, 'EVIDENCE', jpeg(), 'gate.jpg');
    const workerPool = database.pool('worker');
    const unreachable = new FileScanner(
      workerPool,
      new UnitOfWork(workerPool, api.logger),
      api.app.get<ObjectStorage>(OBJECT_STORAGE),
      new ClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2_000 }),
      api.app.get(AuditTrail),
      clock,
      pino({ level: 'silent' }),
    );
    const round = await unreachable.scanPending(50);
    expect(round.deferred).toBeGreaterThanOrEqual(1);
    expect((await getFile(storekeeper, id)).body.scanStatus).toBe('PENDING');
    expect((await signedUrl(storekeeper, id)).status).toBe(422);
    await expect(new ClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2_000 }).scan(Buffer.from('x'))).rejects.toBeInstanceOf(MalwareScannerUnavailableError);
  });
});

describe('the database keeps a stored file honest (ADR-0044)', () => {
  it('refuses the API role marking its own upload clean, a changed content column, a second verdict and a file stored already CLEAN', async () => {
    const id = await uploaded(storekeeper, 'EVIDENCE', jpeg(), 'door.jpg');
    const app = database.pool('app');
    const worker = database.pool('worker');
    const stateOf = (pool: typeof app, sql: string, values: unknown[]) => sqlStateOf(pool.query(sql, values));
    expect(await stateOf(app, "UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [id])).toBe('HK007');
    expect(await stateOf(worker, "UPDATE platform.stored_file SET content_type = 'application/pdf', version = version + 1 WHERE id = $1", [id])).toBe('HK007');
    await worker.query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [id]);
    expect(await stateOf(worker, "UPDATE platform.stored_file SET scan_status = 'INFECTED', scan_verdict = 'late', version = version + 1 WHERE id = $1", [id])).toBe('HK007');
    expect(
      await stateOf(
        app,
        `INSERT INTO platform.stored_file (id, bucket, object_key, original_name, content_type, size_bytes, sha256, purpose, classification, scan_status, scanned_at, owner_module, created_by, updated_by)
         VALUES ($1, 'hk-test-private', $2, 'x.jpg', 'image/jpeg', 10, $3, 'EVIDENCE', 'CONFIDENTIAL', 'CLEAN', now(), 'doc', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
        [randomUUID(), `evidence/${randomUUID()}`, randomBytes(32)],
      ),
    ).toBe('HK007');
  });

  it('refuses changing or deleting an access log row, for every role', async () => {
    const { rows } = await admin().query<{ id: string }>('SELECT id FROM platform.file_access_log LIMIT 1');
    expect(rows).toHaveLength(1);
    for (const pool of [database.pool('app'), database.pool('worker'), admin()]) {
      expect(await sqlStateOf(pool.query('UPDATE platform.file_access_log SET purpose = $2 WHERE id = $1', [rows[0]!.id, 'changed']))).toMatch(/^(HK001|42501)$/);
    }
  });

  it("refuses an approval request's evidence that is not a stored file, and takes one that is", async () => {
    const subjectId = randomUUID();
    await admin().query("INSERT INTO platform.document_type (code, owner_module, name, is_numbered) VALUES ('FILE_PROBE', 'inv', 'File probe', false) ON CONFLICT DO NOTHING");
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'FILE_PROBE', 'inv', $2, '01900000-0000-7000-8000-000000000001')", [subjectId, dodowa.branchId]);
    const insert = (evidenceFileId: string) =>
      database.pool('app').query(
        `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, status, evidence_file_id)
         VALUES ($1, 'STOCK_WRITE_OFF', $2, $3, $4, 'Two broilers dead in pen 3', '01900000-0000-7000-8000-000000000001', 'PENDING', $5)`,
        [randomUUID(), dodowa.branchId, subjectId, randomBytes(32), evidenceFileId],
      );
    expect(await sqlStateOf(insert(randomUUID()))).toBe('23503');
    const evidence = await uploaded(storekeeper, 'EVIDENCE', jpeg(), 'pen-3.jpg');
    await insert(evidence);
    expect(await count('SELECT count(*)::int AS n FROM iam.approval_request WHERE evidence_file_id = $1', [evidence])).toBe(1);
  });
});
