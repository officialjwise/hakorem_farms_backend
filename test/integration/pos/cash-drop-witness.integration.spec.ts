import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A cash drop's witness (FR-POS-016, the owner's decision on A-273 (d), 2026-11-17): a supervisor witnesses a drop when
 * one is signed in at the branch; when none is, the drop is taken unwitnessed, marked so on the drop and on the X and Z
 * reports, and sent to the daily exception report's source, so a one-person shop is never forced to keep cash in the
 * drawer. Every figure is read back by SQL over `pos.cash_movement`, the journal lines and the outbox.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
let cashier: TestSession;
let cashierUser: TestUser;
let managerUser: TestUser;
let branchId: string;
let shopId: string;
let tillId: string;
let shiftId: string;
const admin = () => database.pool('admin');
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const one = async <T>(sql: string, values: unknown[]): Promise<T> => (await admin().query(sql, values)).rows[0] as T;
/** A drop; a witness confirms it with their till PIN on the till, so the till sends their PIN version too (B09b continued 3). */
const drop = (amount: number, witnessId?: string, witnessPinVersion?: number) => {
  const movementId = nextId();
  const witness = witnessId === undefined ? {} : { witnessId, ...(witnessPinVersion === undefined ? {} : { witnessPinVersion }) };
  return { movementId, send: () => post(cashier, `/shifts/${shiftId}/cash-movements`, { id: movementId, kind: 'CASH_DROP', amountPesewas: amount, reasonCode: 'SAFE_DROP', ...witness, occurredAt: clock.now().toISOString() }, movementId) };
};
/** Signs out every live session of the branch's supervisors: what "no supervisor is signed in" means. */
const signOutSupervisors = () =>
  admin().query(
    `UPDATE iam.session s SET revoked_at = $1, revoke_reason = 'signed out'
      WHERE s.revoked_at IS NULL AND s.principal_id IN (
        SELECT g.principal_id FROM iam.role_grant g JOIN iam.role_permission rp ON rp.role_id = g.role_id
         WHERE rp.permission_code = 'pos.shift.close.approve' AND g.branch_id = $2 AND g.deleted_at IS NULL)`,
    [clock.now(), branchId],
  );

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'", [])).id;
  shopId = (await one<{ id: string }>("SELECT l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'", [])).id;
  managerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  cashierUser = await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId, locationId: shopId }] });
  tillId = randomUUID();
  await admin().query(
    `INSERT INTO pos.register (id, branch_id, location_id, code, name, status, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, 'W1', 'Witness till', 'ACTIVE', $4, $5, $4, $5)`,
    [tillId, branchId, shopId, clock.now(), managerUser.principalId],
  );
  await signOutSupervisors();
  cashier = await login(api.server, cashierUser);
  shiftId = nextId();
  const opened = await post(cashier, '/shifts', { id: shiftId, registerId: tillId, openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a drop with no supervisor signed in at the branch (a one-person shop)', () => {
  it('is taken unwitnessed, marked so, posted once and sent to the exception report source', async () => {
    const live = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM iam.session s JOIN iam.role_grant g ON g.principal_id = s.principal_id JOIN iam.role_permission rp ON rp.role_id = g.role_id
        WHERE rp.permission_code = 'pos.shift.close.approve' AND g.branch_id = $1 AND s.revoked_at IS NULL AND s.idle_expires_at > $2`,
      [branchId, clock.now()],
    );
    expect(live).toEqual({ n: 0 });
    const { movementId, send } = drop(15_000);
    const response = await send();
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ id: movementId, kind: 'CASH_DROP', amountPesewas: 15_000, witness: null, unwitnessed: true });
    expect(await one('SELECT unwitnessed, witness_id FROM pos.cash_movement WHERE id = $1', [movementId])).toEqual({ unwitnessed: true, witness_id: null });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.CashDropped' AND subject_id = $1", [movementId]);
    expect(event.payload).toMatchObject({ unwitnessed: true, abuseCases: [17], cashierId: cashierUser.principalId, amountsPesewas: { drop: 15_000 } });
    const safe = await one<{ n: string }>(
      `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS n
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE a.code = '1010' AND e.event_subject_id = $1`,
      [movementId],
    );
    expect(Number(safe.n)).toBe(15_000);
  });

  it('shows the unwitnessed drop on the X report, count and pesewas', async () => {
    const x = await get(cashier, `/shifts/${shiftId}/x-report`);
    expect(x.status, JSON.stringify(x.body)).toBe(200);
    expect(x.body).toMatchObject({ unwitnessedDropsCount: 1, unwitnessedDropsPesewas: 15_000, cashMovements: expect.arrayContaining([{ kind: 'CASH_DROP', amountPesewas: 15_000 }]) });
  });

  it('the database refuses a drop both witnessed and unwitnessed, one neither, and a pay-out marked unwitnessed', async () => {
    const { movementId } = drop(1);
    await admin().query(
      `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, witness_id, unwitnessed, occurred_at, recorded_at, actor_id)
       VALUES ($1, $2, 'CASH_DROP', 1, 'SAFE_DROP', $3, true, $4, $4, $5)`,
      [movementId, shiftId, managerUser.principalId, clock.now(), cashierUser.principalId],
    ).then(
      () => expect.fail('the database took a drop both witnessed and unwitnessed'),
      (error: { constraint?: string }) => expect(error.constraint).toBe('ck_cash_movement_witness'),
    );
    await admin().query(
      `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, witness_id, unwitnessed, occurred_at, recorded_at, actor_id)
       VALUES ($1, $2, 'CASH_DROP', 1, 'SAFE_DROP', NULL, false, $3, $3, $4)`,
      [drop(1).movementId, shiftId, clock.now(), cashierUser.principalId],
    ).then(
      () => expect.fail('the database took a drop neither witnessed nor marked unwitnessed'),
      (error: { constraint?: string }) => expect(error.constraint).toBe('ck_cash_movement_witness'),
    );
    await admin().query(
      `INSERT INTO pos.cash_movement (id, shift_id, kind, amount_pesewas, reason_code, note, witness_id, unwitnessed, occurred_at, recorded_at, actor_id)
       VALUES ($1, $2, 'PAY_OUT', 1, 'OTHER_PAYOUT', 'a note', NULL, true, $3, $3, $4)`,
      [drop(1).movementId, shiftId, clock.now(), cashierUser.principalId],
    ).then(
      () => expect.fail('the database took a pay-out marked unwitnessed'),
      (error: { constraint?: string }) => expect(error.constraint).toBe('ck_cash_movement_witness'),
    );
  });
});

describe('a drop while a supervisor is signed in at the branch', () => {
  let manager: TestSession;

  beforeAll(async () => {
    manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
    const pin = await setTillPin(api.server, manager, await tillVerifier('554031'));
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);
  });

  it('still needs the witness: no witness is WITNESS_REQUIRED and nothing is recorded', async () => {
    const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM pos.cash_movement WHERE shift_id = $1', [shiftId]);
    const { send } = drop(2_000);
    const refused = await send();
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'CASH_MOVEMENT_INVALID', details: [expect.objectContaining({ field: '/witnessId', code: 'WITNESS_REQUIRED' })] });
    expect(await one('SELECT count(*)::int AS n FROM pos.cash_movement WHERE shift_id = $1', [shiftId])).toEqual(before);
  });

  it('is taken with the signed-in supervisor as witness, not marked unwitnessed', async () => {
    const { movementId, send } = drop(2_000, managerUser.principalId, 1);
    const response = await send();
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ witness: { id: managerUser.principalId }, witnessPinVersion: 1, unwitnessed: false });
    const event = await one<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.CashDropped' AND subject_id = $1", [movementId]);
    expect(event.payload['unwitnessed']).toBeUndefined();
    expect(event.payload['abuseCases']).toBeUndefined();
    const x = await get(cashier, `/shifts/${shiftId}/x-report`);
    expect(x.body).toMatchObject({ unwitnessedDropsCount: 1, unwitnessedDropsPesewas: 15_000 });
  });

  it('once the supervisor signs out, a drop may go unwitnessed again', async () => {
    await signOutSupervisors();
    const { send } = drop(1_000);
    const response = await send();
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ unwitnessed: true });
    const total = await one<{ n: number; p: string }>("SELECT count(*)::int AS n, sum(amount_pesewas)::text AS p FROM pos.cash_movement WHERE shift_id = $1 AND unwitnessed", [shiftId]);
    expect(total).toEqual({ n: 2, p: '16000' });
  });
});
