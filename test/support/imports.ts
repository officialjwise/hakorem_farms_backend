import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { expect } from 'vitest';
import { totpAt } from '../../src/modules/iam/domain/totp';
import { AuditTrail } from '../../src/platform/audit/audit-trail';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import { FileScanner } from '../../src/platform/storage/file-scanner';
import { SharpImageRenderer } from '../../src/platform/storage/image-renderer';
import type { MalwareScanner, ScanVerdict } from '../../src/platform/storage/malware-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/platform/storage/object-storage';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from './iam';
import { startTestApp, TEST_ORIGIN, TEST_PUBLIC_BUCKET, type TestApp } from './test-app';
import { createTestDatabase, type TestDatabase } from './test-database';

/** The scanner port, answering CLEAN: the verdict path itself is ClamAV's, proved in file-store.integration.spec.ts. */
export class CleanScanner implements MalwareScanner {
  scan(): Promise<ScanVerdict> {
    return Promise.resolve({ outcome: 'CLEAN' });
  }
}

export type PrivilegedSession = TestSession & { readonly secret: Buffer };

/** A test API with the seeded roles logged in at one branch, and a worker scan that passes every file. */
export interface ImportWorld {
  readonly database: TestDatabase;
  readonly api: TestApp;
  readonly clock: ManualClock;
  readonly worker: FileScanner;
  readonly manager: PrivilegedSession;
  readonly owner: PrivilegedSession;
  readonly accountant: PrivilegedSession;
  /** The roles that hold no import or export permission, and a user with no grant. */
  readonly refused: Readonly<Record<string, TestSession>>;
  readonly storekeeper: TestSession;
}

export const REFUSED_ROLES: readonly RoleCode[] = ['CASHIER', 'SALES', 'DRIVER', 'FARM_HAND', 'STOREKEEPER'];

export async function startImportWorld(): Promise<ImportWorld> {
  const database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const api = await startTestApp(database, { clock });
  const branch = await createBranch(database, 'DDW');
  const now = () => clock.now();
  const user = (name: string, role: RoleCode) => createUser(database, { name, grants: [{ role, branchId: branch.branchId }] });
  const manager = await enrolAndLogin(api.server, await user('Kwabena Owusu', 'MANAGER'), now);
  const owner = await enrolAndLogin(api.server, await user('Nana Ama Boateng', 'OWNER'), now);
  const accountant = await enrolAndLogin(api.server, await user('Efua Asante', 'ACCOUNTANT'), now);
  const refused: Record<string, TestSession> = {};
  for (const role of REFUSED_ROLES) refused[role] = await login(api.server, await user(`Ama ${role.toLowerCase()}`, role));
  refused['NO_GRANT'] = await login(api.server, await createUser(database, { name: 'Efua Nkansah' }));
  const workerPool = database.pool('worker');
  const worker = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
  return { database, api, clock, worker, manager, owner, accountant, refused, storekeeper: refused['STOREKEEPER']! };
}

/** Access tokens last ten minutes: refreshes every session, as each test begins. */
export async function refreshAll(world: ImportWorld): Promise<void> {
  for (const session of [world.manager, world.owner, world.accountant, ...Object.values(world.refused)]) {
    const refreshed = await request(world.api.server).post('/v1/auth/refresh').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
    expect(refreshed.status).toBe(200);
    session.jar.store(refreshed.headers['set-cookie']);
  }
}

export const post = (world: ImportWorld, session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(world.api.server, session, `/v1${path}`, key).send(body);
export const get = (world: ImportWorld, session: TestSession, path: string) => consoleGet(world.api.server, session, `/v1${path}`);

/** Uploads a file for the IMPORT use and, unless asked not to, lets the worker scan it CLEAN. */
export async function importFile(world: ImportWorld, content: Buffer, filename: string, session: TestSession = world.manager, scan = true): Promise<string> {
  const response = await consolePost(world.api.server, session, '/v1/files').field('purpose', 'IMPORT').attach('file', content, { filename, contentType: 'application/octet-stream' });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  if (scan) await world.worker.scanPending(50);
  return response.body.id as string;
}

/** A fresh TOTP step-up on the session (FR-IAM-007), thirty seconds after the last so the code is new. */
export async function stepUp(world: ImportWorld, session: PrivilegedSession): Promise<void> {
  world.clock.advanceBy(30_000);
  const response = await post(world, session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(world.clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

export const count = async (world: ImportWorld, sql: string, values: unknown[] = []) => (await world.database.pool('admin').query<{ n: number }>(sql, values)).rows[0]!.n;

/** `n` customer rows as a CSV, each with its own Ghanaian mobile number; `bad` maps a row index to cells to replace. */
export function customerCsv(n: number, start: number, bad: Readonly<Record<number, Partial<Record<'kind' | 'name' | 'phone' | 'email' | 'tier', string>>>> = {}): Buffer {
  const lines = ['customerNo,kind,name,phone,email,tier'];
  for (let i = 0; i < n; i += 1) {
    const number = start + i;
    const row = { kind: i % 5 === 0 ? 'BUSINESS' : 'INDIVIDUAL', name: `Customer ${number} Mensah`, phone: `024${String(number).padStart(7, '0')}`, email: `customer${number}@example.com`, tier: i % 5 === 0 ? 'WHOLESALE' : 'RETAIL', ...bad[i] };
    lines.push(`,${row.kind},${row.name},${row.phone},${row.email},${row.tier}`);
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n`);
}
