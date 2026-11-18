import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePatch, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Device enrolment (FR-POS-010, ADR-0016, A-274): a manager enrols a device on a till with a fresh step-up; its
 * credential is shown once and the server keeps only its SHA-256 hash, nowhere in the clear (not in the idempotency
 * store, not in the audit trail); a replay cannot show it again; a revoked device stays revoked; and every write and read
 * refuses the wrong role and another branch.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const sessions = new Map<string, TestSession>();
let branchId: string;
let tillId: string;
let deviceId: string;
let credential: string;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
const deviceCount = async () => ((await get('manager', `/registers?branchId=${branchId}`)).body.data as { id: string; deviceCount: number }[]).find((r) => r.id === tillId)!.deviceCount;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'", [])).id;
  const shop = (await one<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).id;
  const elsewhere = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code <> 'DDW' ORDER BY code LIMIT 1", [])).id;
  for (const [who, name, role, at, totp] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', branchId, true],
    ['owner', 'Esi Mensah', 'OWNER', branchId, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId, false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', branchId, false],
    ['otherManager', 'Akosua Boateng', 'MANAGER', elsewhere, true],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: at, ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: shop } : {}) }] });
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  const till = await post('manager', '/registers', { branchId, locationId: shop, code: 'T1', name: 'Shop till 1' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  tillId = till.body.id as string;
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('enrolDevice', () => {
  it('refuses the wrong roles and another branch, and a stale step-up, enrolling nothing', async () => {
    for (const who of ['cashier', 'storekeeper', 'accountant', 'otherManager']) {
      expect((await post(who, `/registers/${tillId}/devices`, { deviceLabel: 'Tablet' })).status, who).toBe(403);
    }
    clock.advanceBy(10 * 60_000);
    const stale = await post('manager', `/registers/${tillId}/devices`, { deviceLabel: 'Tablet' });
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await one('SELECT count(*)::int AS n FROM pos.device_enrolment', [])).toEqual({ n: 0 });
  });

  it('shows the credential once and keeps only its SHA-256 hash, nowhere in the clear', async () => {
    await step('manager');
    const key = randomUUID();
    const enrolled = await post('manager', `/registers/${tillId}/devices`, { deviceLabel: 'Samsung Tab A7 Lite, till 1' }, key);
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    credential = enrolled.body.deviceCredential as string;
    deviceId = enrolled.body.device.id as string;
    expect(credential).toMatch(/^hkdev_T1\.[A-Za-z0-9_-]{43}$/);
    expect(enrolled.body.device).toMatchObject({ registerId: tillId, deviceLabel: 'Samsung Tab A7 Lite, till 1', enrolledBy: { displayName: 'Kwabena Owusu' }, lastSyncAt: null, revokedAt: null });
    const stored = await one<{ hash: Buffer }>('SELECT credential_hash AS hash FROM pos.device_enrolment WHERE id = $1', [deviceId]);
    expect(stored.hash.equals(createHash('sha256').update(credential).digest())).toBe(true);
    const secret = credential.slice('hkdev_T1.'.length);
    const leaks = await one<{ n: number }>(
      `SELECT (SELECT count(*) FROM platform.idempotency_key WHERE response_body::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM platform.audit_event WHERE position(convert_to($1, 'UTF8') IN coalesce("after", ''::bytea) || coalesce("before", ''::bytea)) > 0)
            + (SELECT count(*) FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%') AS n`,
      [secret],
    );
    expect(Number(leaks.n)).toBe(0);
    expect(await deviceCount()).toBe(1);
    // A replay cannot show the credential again, and enrols nothing more.
    const replay = await post('manager', `/registers/${tillId}/devices`, { deviceLabel: 'Samsung Tab A7 Lite, till 1' }, key);
    expect([replay.status, replay.body.error?.code]).toEqual([409, 'DEVICE_CREDENTIAL_SHOWN_ONCE']);
    expect(replay.body.deviceCredential).toBeUndefined();
    expect(await one('SELECT count(*)::int AS n FROM pos.device_enrolment', [])).toEqual({ n: 1 });
  });

  it('refuses a retired till', async () => {
    const shop = (await one<{ id: string }>("SELECT id FROM mdm.location WHERE branch_id = $1 AND code = 'SHOP'", [branchId])).id;
    const t2 = await post('manager', '/registers', { branchId, locationId: shop, code: 'T2', name: 'Shop till 2' });
    expect((await consolePatch(api.server, as('manager'), `/v1/registers/${t2.body.id as string}`).send({ version: 1, status: 'RETIRED' })).status).toBe(200);
    await step('manager');
    const refused = await post('manager', `/registers/${t2.body.id as string}/devices`, { deviceLabel: 'Spare tablet' });
    expect([refused.status, refused.body.error.code, refused.body.error.details[0].code]).toEqual([422, 'DEVICE_INVALID', 'REGISTER_RETIRED']);
  });
});

describe('listRegisterDevices', () => {
  it('lists the till devices for its managers, never the hash, and refuses the cashier, the storekeeper, the accountant and another branch', async () => {
    const listed = await get('manager', `/registers/${tillId}/devices`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ id: deviceId, registerId: tillId, revokedAt: null })]);
    expect(JSON.stringify(listed.body)).not.toContain('credential');
    for (const who of ['cashier', 'storekeeper', 'accountant', 'otherManager']) {
      expect((await get(who, `/registers/${tillId}/devices`)).status, who).toBe(403);
    }
  });
});

describe('revokeDevice', () => {
  it('refuses the wrong roles, another branch and a stale step-up, revoking nothing', async () => {
    for (const who of ['cashier', 'storekeeper', 'accountant', 'otherManager']) {
      expect((await post(who, `/devices/${deviceId}/revoke`, { reason: 'Lost' })).status, who).toBe(403);
    }
    clock.advanceBy(10 * 60_000);
    expect((await post('owner', `/devices/${deviceId}/revoke`, { reason: 'Lost' })).body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await one('SELECT revoked_at FROM pos.device_enrolment WHERE id = $1', [deviceId])).toEqual({ revoked_at: null });
  });

  it('revokes with the reason, once: the till counts no device, a second revocation is refused', async () => {
    await step('owner');
    const key = randomUUID();
    const revoked = await post('owner', `/devices/${deviceId}/revoke`, { reason: 'Tablet stolen from the market stall' }, key);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body).toMatchObject({ id: deviceId, revokedAt: clock.now().toISOString() });
    expect(await one('SELECT revoke_reason AS reason FROM pos.device_enrolment WHERE id = $1', [deviceId])).toEqual({ reason: 'Tablet stolen from the market stall' });
    expect(await deviceCount()).toBe(0);
    expect((await post('owner', `/devices/${deviceId}/revoke`, { reason: 'Tablet stolen from the market stall' }, key)).status).toBe(200);
    const again = await post('owner', `/devices/${deviceId}/revoke`, { reason: 'Again' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'DEVICE_ALREADY_REVOKED']);
  });

  it('the database keeps a revoked device revoked, and what it was enrolled as unchanged', async () => {
    await expect(admin().query('UPDATE pos.device_enrolment SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, version = version + 1 WHERE id = $1', [deviceId])).rejects.toMatchObject({ code: 'HK004' });
    await expect(admin().query("UPDATE pos.device_enrolment SET last_sync_at = now(), version = version + 1 WHERE id = $1", [deviceId])).rejects.toMatchObject({ code: 'HK004' });
    await expect(admin().query("UPDATE pos.device_enrolment SET credential_hash = $2, version = version + 1 WHERE id = $1", [deviceId, createHash('sha256').update('another').digest()])).rejects.toMatchObject({ code: 'HK004' });
  });
});
