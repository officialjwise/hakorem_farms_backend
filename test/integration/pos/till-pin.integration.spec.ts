import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { setTillPin, tillVerifier, type TillPinBody } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The till PIN (B09b continued 3, CR-032 and CR-050 as the owner set them on 2026-11-17 and 2026-11-18, ADR-0080): a
 * person sets their own PIN as the verifier the till derived, PBKDF2-SHA256 with at least 600,000 iterations and a
 * 16-byte salt, never weaker; an enrolled till is issued the verifiers it checks a PIN against offline; tills report
 * every try, counted once per person by its client id, five wrong tries lock; a locked cashier is signed out only by a
 * different supervisor's PIN; a drop's witness is a supervisor who confirmed it with their PIN, offered from the same
 * "signed in at the branch" source the witnesses read answers from. Every figure is read back by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const credentials = new Map<string, string>();
const verifiers = new Map<string, TillPinBody>();
const id = (code: string) => ids.get(code)!;
const who = (name: string) => users.get(name)!.principalId;
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const post = (name: string, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, as(name), `/v1${path}`, key).send(body);
const step = (name: string) => stepUp(api.server, as(name) as TotpSession, clock);
const verifiersOf = (name: string, till: string, credential: string | null = credentials.get(till)!) => {
  const call = consoleGet(api.server, as(name), `/v1/registers/${id(`till:${till}`)}/pin-verifiers`);
  return credential === null ? call : call.set('X-Device-Credential', credential);
};
const report = (name: string, till: string, body: object, credential: string | null = credentials.get(till)!) => {
  const call = consolePost(api.server, as(name), `/v1/registers/${id(`till:${till}`)}/pin-events`);
  return (credential === null ? call : call.set('X-Device-Credential', credential)).send(body);
};
const tryPin = (name: string, version: number, outcome: 'FAILED' | 'SUCCEEDED', purpose = 'UNLOCK', eventId: string = nextId()) => ({ id: eventId, principalId: who(name), pinVersion: version, outcome, purpose, occurredAt: clock.now().toISOString() });
const wrongTries = async (name: string, version: number) => (await one<{ n: number }>("SELECT count(*)::int AS n FROM pos.till_pin_event WHERE principal_id = $1 AND pin_version = $2 AND outcome = 'FAILED'", [who(name), version])).n;
const flags = (kind: string, subject?: string) =>
  rows<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.TillPinFlagged' AND payload->>'exceptionKind' = $1 AND ($2::uuid IS NULL OR subject_id = $2) ORDER BY recorded_at",
    [kind, subject ?? null],
  );
const pinCount = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.till_pin')).n;
const drop = (name: string, shift: string, extra: object) => {
  const movementId = nextId();
  return post(name, `/shifts/${shift}/cash-movements`, { id: movementId, kind: 'CASH_DROP', amountPesewas: 5_000, reasonCode: 'SAFE_DROP', occurredAt: clock.now().toISOString(), ...extra }, movementId).then((r) => ({ r, movementId }));
};

async function pinFor(name: string, pin: string): Promise<number> {
  const body = await tillVerifier(pin);
  const set = await setTillPin(api.server, as(name), body);
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  verifiers.set(name, body);
  return set.body.version as number;
}

async function enrol(till: string): Promise<void> {
  await step('manager');
  const enrolled = await post('manager', `/registers/${id(`till:${till}`)}/devices`, { deviceLabel: `Shop tablet ${till}` });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credentials.set(till, enrolled.body.deviceCredential as string);
  ids.set(`device:${till}`, enrolled.body.device.id as string);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL (SELECT 'elsewhere', id FROM mdm.branch WHERE code <> 'DDW' ORDER BY code LIMIT 1)`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [name, display, role, totp, branch] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', true, 'branch'],
    ['esi', 'Esi Ofori', 'MANAGER', true, 'branch'],
    ['yaa', 'Yaa Asantewaa', 'MANAGER', true, 'branch'],
    ['kofi', 'Kofi Boateng', 'CASHIER', false, 'branch'],
    ['ama', 'Ama Asante', 'CASHIER', false, 'branch'],
    ['abena', 'Abena Sarpong', 'CASHIER', false, 'branch'],
    ['storekeeper', 'Kojo Mensah', 'STOREKEEPER', false, 'branch'],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true, 'branch'],
    ['afar', 'Akua Nyarko', 'CASHIER', false, 'elsewhere'],
  ] as const) {
    const user = await createUser(database, { name: display, grants: [{ role, branchId: id(branch), ...(branch === 'branch' && (role === 'CASHIER' || role === 'STOREKEEPER') ? { locationId: id('shop') } : {}) }] });
    users.set(name, user);
    sessions.set(name, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  for (const code of ['P1', 'P2']) {
    const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code, name: `Shop till ${code}` });
    expect(till.status, JSON.stringify(till.body)).toBe(201);
    ids.set(`till:${code}`, till.body.id as string);
    await enrol(code);
  }
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('setTillPin: one\'s own PIN, sent only as the verifier the till derived (CR-032 points 1 to 3)', () => {
  it('stores a PBKDF2-SHA256 verifier of 600,000 iterations with a 16-byte salt, and answers neither the salt nor the hash', async () => {
    const body = await tillVerifier('482915');
    const set = await setTillPin(api.server, as('kofi'), body);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ principal: { id: who('kofi'), displayName: 'Kofi Boateng' }, version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600_000, setAt: clock.now().toISOString(), wrongTries: 0, locked: false });
    verifiers.set('kofi', body);
    const stored = await one<{ algorithm: string; iterations: number; salt: Buffer; hash: Buffer; actor_id: string }>('SELECT algorithm, iterations, salt, hash, actor_id FROM pos.till_pin WHERE principal_id = $1', [who('kofi')]);
    expect(stored.algorithm).toBe('PBKDF2-SHA256');
    expect(stored.iterations).toBe(600_000);
    expect(stored.salt.length).toBe(16);
    expect(stored.hash.length).toBe(32);
    expect(stored.salt.toString('base64')).toBe(body.pinSalt);
    expect(stored.hash.toString('base64')).toBe(body.pinHash);
    expect(stored.actor_id).toBe(who('kofi'));
    // Neither the salt nor the hash reaches the audit trail, the idempotency store or the outbox.
    for (const secret of [body.pinSalt, body.pinHash]) {
      const leaks = await one<{ n: string }>(
        `SELECT ((SELECT count(*) FROM platform.idempotency_key WHERE response_body::text LIKE '%' || $1 || '%')
               + (SELECT count(*) FROM platform.audit_event WHERE position(convert_to($1, 'UTF8') IN coalesce("after", ''::bytea) || coalesce("before", ''::bytea) || coalesce(metadata::text::bytea, ''::bytea)) > 0)
               + (SELECT count(*) FROM platform.outbox_message WHERE payload::text LIKE '%' || $1 || '%'))::text AS n`,
        [secret],
      );
      expect(Number(leaks.n)).toBe(0);
    }
    expect(await one("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'SET_TILL_PIN' AND actor_id = $1", [who('kofi')])).toEqual({ n: 1 });
  });

  it('refuses a weaker verifier, each by its rule, and stores nothing', async () => {
    const before = await pinCount();
    const cases: readonly [Promise<TillPinBody>, string][] = [
      [tillVerifier('482915', { iterations: 599_999 }), 'PIN_ITERATIONS_TOO_FEW'],
      [tillVerifier('482915', { saltBytes: 15 }), 'PIN_SALT_TOO_SHORT'],
      [tillVerifier('482915').then((b) => ({ ...b, algorithm: 'PBKDF2-SHA1' })), 'PIN_ALGORITHM_NOT_ALLOWED'],
      [tillVerifier('482915').then((b) => ({ ...b, pinHash: Buffer.alloc(31, 1).toString('base64') })), 'PIN_HASH_NOT_32_BYTES'],
      [Promise.resolve({ ...verifiers.get('kofi')! }), 'PIN_SALT_REUSED'],
      [tillVerifier('482915', { salt: Buffer.alloc(16, 9) }), 'PIN_SALT_NOT_RANDOM'],
    ];
    for (const [body, rule] of cases) {
      const refused = await setTillPin(api.server, as('ama'), await body);
      expect(refused.status, rule).toBe(422);
      expect(refused.body.error.code).toBe('TILL_PIN_INVALID');
      expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual([rule]);
    }
    expect(await pinCount()).toBe(before);
  });

  it('refuses the storekeeper and the accountant, storing nothing (deny by default)', async () => {
    const before = await pinCount();
    for (const name of ['storekeeper', 'accountant']) {
      const refused = await setTillPin(api.server, as(name), await tillVerifier('730164'));
      expect(refused.status, name).toBe(403);
    }
    expect(await pinCount()).toBe(before);
  });

  it('gives each later PIN the next version, which replaces the last', async () => {
    expect(await pinFor('ama', '615203')).toBe(1);
    expect(await pinFor('abena', '908172')).toBe(1);
    expect(await pinFor('manager', '554031')).toBe(1);
    expect(await pinFor('esi', '210987')).toBe(1);
    expect(await pinFor('yaa', '334455')).toBe(1);
    expect(await pinFor('esi', '210988')).toBe(2);
    expect(await rows('SELECT version FROM pos.till_pin WHERE principal_id = $1 ORDER BY version', [who('esi')])).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('the database refuses a weaker verifier, another person setting it, a skipped version and any change', async () => {
    const insert = (over: Record<string, unknown>) =>
      admin().query('INSERT INTO pos.till_pin (id, principal_id, version, algorithm, iterations, salt, hash, set_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)', [
        randomUUID(),
        over['principal'] ?? who('abena'),
        over['version'] ?? 2,
        over['algorithm'] ?? 'PBKDF2-SHA256',
        over['iterations'] ?? 600_000,
        over['salt'] ?? Buffer.from(randomUUID().replace(/-/g, ''), 'hex'),
        over['hash'] ?? Buffer.alloc(32, 3),
        clock.now(),
        over['actor'] ?? who('abena'),
      ]);
    await expect(insert({ iterations: 599_999 })).rejects.toMatchObject({ constraint: 'ck_till_pin_iterations' });
    await expect(insert({ salt: Buffer.alloc(15, 2) })).rejects.toMatchObject({ constraint: 'ck_till_pin_salt' });
    await expect(insert({ algorithm: 'PBKDF2-SHA1' })).rejects.toMatchObject({ constraint: 'ck_till_pin_algorithm' });
    await expect(insert({ hash: Buffer.alloc(31, 3) })).rejects.toMatchObject({ constraint: 'ck_till_pin_hash' });
    await expect(insert({ actor: who('manager') })).rejects.toMatchObject({ constraint: 'ck_till_pin_own' });
    await expect(insert({ version: 3 })).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_pin_version' });
    await expect(insert({ salt: Buffer.from(verifiers.get('kofi')!.pinSalt, 'base64') })).rejects.toMatchObject({ constraint: 'uq_till_pin_salt' });
    await expect(admin().query('UPDATE pos.till_pin SET iterations = 1000000 WHERE principal_id = $1', [who('abena')])).rejects.toMatchObject({ code: 'HK001' });
  });

  it('takes no PIN anywhere: no operation in the contract has a field named pin (CR-032 point 2)', async () => {
    const contract = readFileSync(resolve(__dirname, '../../../contract/openapi.yaml'), 'utf8');
    expect(contract).not.toMatch(/^\s+pin:\s*$/m);
    expect(contract).not.toMatch(/^\s+tillPin:\s*$/m);
  });
});

describe('listTillPinVerifiers: what an enrolled till checks a PIN against offline (CR-032 point 1)', () => {
  it('gives the caller theirs and every supervisor\'s at the branch, never another cashier\'s, and audits whose versions it gave', async () => {
    const read = await verifiersOf('kofi', 'P1');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const byName = new Map((read.body.data as { principal: { displayName: string }; role: string; version: number; pinSalt: string | null; pinHash: string | null }[]).map((v) => [v.principal.displayName, v] as const));
    expect([...byName.keys()].sort()).toEqual(['Esi Ofori', 'Kofi Boateng', 'Kwabena Owusu', 'Yaa Asantewaa']);
    expect(byName.get('Kofi Boateng')).toMatchObject({ role: 'OPERATOR', version: 1, pinSalt: verifiers.get('kofi')!.pinSalt, pinHash: verifiers.get('kofi')!.pinHash, wrongTries: 0, locked: false });
    expect(byName.get('Esi Ofori')).toMatchObject({ role: 'SUPERVISOR', version: 2, pinSalt: verifiers.get('esi')!.pinSalt, locked: false });
    expect(read.body.policy).toEqual({ maxWrongTries: 5, lockedUntil: 'NEW_PIN_SET' });
    const audit = await one<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'ISSUE_TILL_PIN_VERIFIERS' AND entity_id = $1 AND actor_id = $2", [id('till:P1'), who('kofi')]);
    expect(audit.n).toBe(1);
  });

  it('refuses a call with no device, another till\'s device, the storekeeper and another branch\'s cashier', async () => {
    expect((await verifiersOf('kofi', 'P1', null)).status).toBe(401);
    expect((await verifiersOf('kofi', 'P1', credentials.get('P2')!)).status).toBe(403);
    expect((await verifiersOf('storekeeper', 'P1')).status).toBe(403);
    expect((await verifiersOf('afar', 'P1')).status).toBe(403);
  });
});

describe('reportTillPinEvents: five wrong tries lock, counted once per person (CR-032 point 3)', () => {
  const kofiTries: ReturnType<typeof tryPin>[] = [];

  it('counts four wrong tries without a lock, locks at the fifth and raises it once', async () => {
    for (let n = 0; n < 4; n += 1) kofiTries.push(tryPin('kofi', 1, 'FAILED'));
    const first = await report('kofi', 'P1', { events: kofiTries });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.eventResults.map((r: { outcome: string }) => r.outcome)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED']);
    expect(first.body.locked).toEqual([]);
    expect(await wrongTries('kofi', 1)).toBe(4);
    expect(await flags('TILL_PIN_LOCKED')).toEqual([]);
    // The fifth wrong try is made on another till: the count is the person's, wherever the tries were made.
    kofiTries.push(tryPin('kofi', 1, 'FAILED'));
    const fifth = await report('kofi', 'P2', { events: [kofiTries[4]] });
    expect(fifth.body).toMatchObject({ eventResults: [{ outcome: 'APPLIED' }], locked: [{ id: who('kofi'), displayName: 'Kofi Boateng' }] });
    expect(await wrongTries('kofi', 1)).toBe(5);
    const locked = await flags('TILL_PIN_LOCKED');
    expect(locked).toHaveLength(1);
    expect(locked[0]!.payload).toMatchObject({ principalId: who('kofi'), pinVersion: 1, severity: 'URGENT', abuseCases: [35], register: { code: 'P2' }, deviceId: id('device:P2') });
  });

  it('counts each try exactly once: the same tries sent again are duplicates, the count stays five and nothing is raised again', async () => {
    // Each till sends its own again; a try sent from a till that did not make it is another's, refused below.
    const again = await report('kofi', 'P1', { events: kofiTries.slice(0, 4) });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.eventResults.map((r: { outcome: string }) => r.outcome)).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE']);
    expect((await report('kofi', 'P2', { events: [kofiTries[4]] })).body.eventResults).toEqual([{ id: kofiTries[4]!.id, outcome: 'DUPLICATE', reason: null }]);
    expect((await report('kofi', 'P1', { events: [kofiTries[4]] })).body.eventResults).toEqual([{ id: kofiTries[4]!.id, outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' }]);
    expect(await wrongTries('kofi', 1)).toBe(5);
    expect(await flags('TILL_PIN_LOCKED')).toHaveLength(1);
    // The same id with other content is refused and raised, never counted.
    const reused = await report('kofi', 'P1', { events: [{ ...kofiTries[0]!, outcome: 'SUCCEEDED' }] });
    expect(reused.body.eventResults).toEqual([{ id: kofiTries[0]!.id, outcome: 'REJECTED', reason: 'ID_REUSED_WITH_OTHER_CONTENT' }]);
    expect(await flags('TILL_PIN_REPORT_REJECTED', kofiTries[0]!.id)).toHaveLength(1);
  });

  it('counts per person: another cashier\'s wrong tries never count against Kofi, and Kofi\'s never against them', async () => {
    const amaTries = [tryPin('ama', 1, 'FAILED'), tryPin('ama', 1, 'FAILED'), tryPin('ama', 1, 'SUCCEEDED')];
    const sent = await report('ama', 'P1', { events: amaTries });
    expect(sent.body.locked).toEqual([]);
    expect(await wrongTries('ama', 1)).toBe(2);
    expect(await wrongTries('kofi', 1)).toBe(5);
  });

  it('hands out a locked PIN with no salt or hash, so no till unlocks with it', async () => {
    const read = await verifiersOf('kofi', 'P1');
    const kofi = (read.body.data as { principal: { id: string } }[]).find((v) => v.principal.id === who('kofi'));
    expect(kofi).toMatchObject({ version: 1, pinSalt: null, pinHash: null, wrongTries: 5, locked: true });
  });

  it('refuses a try against a version the server does not hold, and refuses the storekeeper and a call with no device', async () => {
    const unknown = tryPin('abena', 9, 'FAILED');
    const refused = await report('abena', 'P1', { events: [unknown] });
    expect(refused.body.eventResults).toEqual([{ id: unknown.id, outcome: 'REJECTED', reason: 'PIN_UNKNOWN' }]);
    expect((await report('storekeeper', 'P1', { events: [tryPin('abena', 1, 'FAILED')] })).status).toBe(403);
    expect((await report('abena', 'P1', { events: [tryPin('abena', 1, 'FAILED')] }, null)).status).toBe(401);
    expect(await wrongTries('abena', 1)).toBe(0);
  });

  it('the database refuses a try on a device of another till, and any change to a try', async () => {
    await expect(
      admin().query(
        `INSERT INTO pos.till_pin_event (id, register_id, device_id, branch_id, principal_id, pin_version, outcome, purpose, occurred_at, received_at, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'FAILED', 'UNLOCK', $6, $6, $6, $5)`,
        [nextId(), id('till:P1'), id('device:P2'), id('branch'), who('abena'), clock.now()],
      ),
    ).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_pin_event_device' });
    await expect(admin().query("UPDATE pos.till_pin_event SET outcome = 'SUCCEEDED' WHERE principal_id = $1", [who('kofi')])).rejects.toMatchObject({ code: 'HK001' });
    await expect(admin().query('DELETE FROM pos.till_pin_event WHERE principal_id = $1', [who('kofi')])).rejects.toMatchObject({ code: 'HK001' });
  });
});

describe('signing out a locked cashier needs a different supervisor\'s PIN (CR-032, the owner on 2026-11-17)', () => {
  const signOut = (cashier: string, supervisor: string, version: number) => ({ id: nextId(), cashierId: who(cashier), supervisorId: who(supervisor), supervisorPinVersion: version, occurredAt: clock.now().toISOString() });
  const signOutCount = async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.till_sign_out')).n;

  it('refuses the cashier signing themselves out, a cashier who is no supervisor, a cashier not locked, and a supervisor PIN replaced or locked', async () => {
    // Yaa's PIN is locked by five wrong tries; Esi's version 1 was replaced by version 2.
    await report('yaa', 'P1', { events: [1, 2, 3, 4, 5].map(() => tryPin('yaa', 1, 'FAILED')) });
    const cases: readonly [ReturnType<typeof signOut>, string][] = [
      [signOut('kofi', 'kofi', 1), 'SUPERVISOR_IS_CASHIER'],
      [signOut('kofi', 'ama', 1), 'SUPERVISOR_NOT_SUPERVISOR'],
      [signOut('abena', 'manager', 1), 'CASHIER_NOT_LOCKED'],
      [signOut('kofi', 'yaa', 1), 'SUPERVISOR_PIN_LOCKED'],
      [signOut('kofi', 'esi', 1), 'SUPERVISOR_PIN_SUPERSEDED'],
      [signOut('kofi', 'manager', 7), 'SUPERVISOR_PIN_UNKNOWN'],
    ];
    const before = await signOutCount();
    for (const [entry, reason] of cases) {
      const refused = await report('kofi', 'P1', { events: [], signOuts: [entry] });
      expect(refused.body.signOutResults, reason).toEqual([{ id: entry.id, outcome: 'REJECTED', reason }]);
      expect((await flags('TILL_PIN_REPORT_REJECTED', entry.id))[0]?.payload).toMatchObject({ principalId: entry.cashierId, supervisorId: entry.supervisorId, severity: 'URGENT', abuseCases: [35] });
    }
    expect(await signOutCount()).toBe(before);
  });

  it('signs a locked cashier out with a different supervisor\'s PIN, audited and raised once, and a resend is a duplicate', async () => {
    const entry = signOut('kofi', 'manager', 1);
    const witnessTry = tryPin('manager', 1, 'SUCCEEDED', 'SIGN_OUT');
    const done = await report('kofi', 'P1', { events: [witnessTry], signOuts: [entry] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.signOutResults).toEqual([{ id: entry.id, outcome: 'APPLIED', reason: null }]);
    expect(await one('SELECT cashier_id, supervisor_id, supervisor_pin_version, device_id FROM pos.till_sign_out WHERE id = $1', [entry.id])).toEqual({
      cashier_id: who('kofi'),
      supervisor_id: who('manager'),
      supervisor_pin_version: 1,
      device_id: id('device:P1'),
    });
    expect(await one("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'SIGN_OUT_LOCKED_CASHIER' AND entity_id = $1", [entry.id])).toEqual({ n: 1 });
    const raised = await flags('LOCKED_CASHIER_SIGNED_OUT', entry.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.payload).toMatchObject({ principalId: who('kofi'), supervisorId: who('manager'), severity: 'REVIEW', abuseCases: [35] });
    const again = await report('kofi', 'P1', { events: [witnessTry], signOuts: [entry] });
    expect(again.body).toMatchObject({ eventResults: [{ outcome: 'DUPLICATE' }], signOutResults: [{ outcome: 'DUPLICATE' }] });
    expect(await flags('LOCKED_CASHIER_SIGNED_OUT', entry.id)).toHaveLength(1);
  });

  it('the database holds the sign-out: never by the cashier, only a supervisor, only a locked cashier, only a supervisor PIN in force', async () => {
    const insert = (cashier: string, supervisor: string, version: number) =>
      admin().query(
        `INSERT INTO pos.till_sign_out (id, register_id, device_id, branch_id, shift_id, cashier_id, supervisor_id, supervisor_pin_version, occurred_at, received_at, recorded_at, actor_id)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $8, $8, $5)`,
        [nextId(), id('till:P1'), id('device:P1'), id('branch'), who(cashier), who(supervisor), version, clock.now()],
      );
    await expect(insert('kofi', 'kofi', 1)).rejects.toMatchObject({ constraint: 'ck_till_sign_out_checker' });
    await expect(insert('kofi', 'ama', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_sign_out_supervisor' });
    await expect(insert('abena', 'manager', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_sign_out_locked' });
    await expect(insert('kofi', 'yaa', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_sign_out_supervisor_pin' });
    await expect(insert('kofi', 'esi', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_till_sign_out_supervisor_pin' });
  });

  it('a new PIN clears the lock: its version starts with no wrong try', async () => {
    expect(await pinFor('kofi', '482916')).toBe(2);
    const read = await verifiersOf('kofi', 'P1');
    expect((read.body.data as { principal: { id: string } }[]).find((v) => v.principal.id === who('kofi'))).toMatchObject({ version: 2, wrongTries: 0, locked: false, pinSalt: verifiers.get('kofi')!.pinSalt });
  });
});

describe('a cash drop witnessed only by a supervisor\'s PIN, offered from who is signed in (CR-050, the owner on 2026-11-18)', () => {
  let shiftId: string;

  beforeAll(async () => {
    shiftId = nextId();
    const opened = await post('abena', '/shifts', { id: shiftId, registerId: id('till:P1'), openingFloatPesewas: 50_000, openedAt: clock.now().toISOString() }, shiftId);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  });

  it('lists the supervisors signed in at the branch, never the cashier, with names only', async () => {
    const read = await consoleGet(api.server, as('abena'), `/v1/shifts/${shiftId}/witnesses`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const names = (read.body.data as { displayName: string }[]).map((p) => p.displayName).sort();
    expect(names).toEqual(['Esi Ofori', 'Kwabena Owusu', 'Yaa Asantewaa']);
    for (const p of read.body.data as object[]) expect(Object.keys(p).sort()).toEqual(['displayName', 'id']);
    expect(Object.keys(read.body).sort()).toEqual(['asOf', 'data']);
    expect(read.body.asOf).toBe(clock.now().toISOString());
  });

  it('refuses another cashier, the storekeeper and another branch\'s till cashier: they see nothing', async () => {
    for (const name of ['ama', 'storekeeper', 'afar']) {
      const refused = await consoleGet(api.server, as(name), `/v1/shifts/${shiftId}/witnesses`);
      expect(refused.status, name).toBe(403);
      expect(refused.body.data).toBeUndefined();
    }
  });

  it('records a drop witnessed by a supervisor\'s PIN version in force, marked PIN-verified', async () => {
    const { r, movementId } = await drop('abena', shiftId, { witnessId: who('manager'), witnessPinVersion: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ witness: { id: who('manager') }, witnessPinVersion: 1, unwitnessed: false });
    expect(await one('SELECT witness_id, witness_pin_version, unwitnessed FROM pos.cash_movement WHERE id = $1', [movementId])).toEqual({ witness_id: who('manager'), witness_pin_version: 1, unwitnessed: false });
  });

  it('refuses a named supervisor without a PIN, a replaced PIN, a locked PIN, the cashier and a non-supervisor, recording nothing', async () => {
    const cases: readonly [object, string][] = [
      [{ witnessId: who('manager') }, 'WITNESS_PIN_REQUIRED'],
      [{ witnessId: who('esi'), witnessPinVersion: 1 }, 'WITNESS_PIN_SUPERSEDED'],
      [{ witnessId: who('yaa'), witnessPinVersion: 1 }, 'WITNESS_PIN_LOCKED'],
      [{ witnessId: who('manager'), witnessPinVersion: 4 }, 'WITNESS_PIN_UNKNOWN'],
      [{ witnessId: who('abena'), witnessPinVersion: 1 }, 'WITNESS_IS_MAKER'],
      [{ witnessId: who('ama'), witnessPinVersion: 1 }, 'WITNESS_NOT_SUPERVISOR'],
      [{}, 'WITNESS_REQUIRED'],
    ];
    for (const [extra, rule] of cases) {
      const { r, movementId } = await drop('abena', shiftId, extra);
      expect(r.status, rule).toBe(422);
      expect(r.body.error.details.map((d: { code: string }) => d.code), rule).toContain(rule);
      expect((await rows('SELECT 1 FROM pos.cash_movement WHERE id = $1', [movementId])).length).toBe(0);
    }
  });

  it('the database refuses a witnessed drop with no PIN version, and one with a locked or replaced version', async () => {
    const insert = (witness: string, version: number | null) =>
      admin().query(
        `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, witness_id, witness_pin_version, unwitnessed, occurred_at, recorded_at, actor_id)
         VALUES ($1, $2, 'CASH_DROP', 100, 'SAFE_DROP', $3, $4, false, $5, $5, $6)`,
        [nextId(), shiftId, who(witness), version, clock.now(), who('abena')],
      );
    await expect(insert('manager', null)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_witness_pin_required' });
    await expect(insert('yaa', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_witness_pin_in_force' });
    await expect(insert('esi', 1)).rejects.toMatchObject({ code: 'HK010', constraint: 'ck_cash_movement_witness_pin_in_force' });
  });

  it('with nobody signed in the read answers empty and the drop goes unwitnessed, from the same source', async () => {
    await admin().query(
      `UPDATE iam.session s SET revoked_at = $1, revoke_reason = 'signed out'
        WHERE s.revoked_at IS NULL AND s.principal_id = ANY($2::uuid[])`,
      [clock.now(), [who('manager'), who('esi'), who('yaa')]],
    );
    const read = await consoleGet(api.server, as('abena'), `/v1/shifts/${shiftId}/witnesses`);
    expect(read.body.data).toEqual([]);
    const { r, movementId } = await drop('abena', shiftId, {});
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await one('SELECT witness_id, witness_pin_version, unwitnessed FROM pos.cash_movement WHERE id = $1', [movementId])).toEqual({ witness_id: null, witness_pin_version: null, unwitnessed: true });
  });
});
