import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import request from 'supertest';

/**
 * Delivery slots for the back office (FR-DEL-001 without its capacity rule, ADR-0026's delivery split, SA-13) over the
 * seeded farm: the seed's fortnight of Dodowa slots, generation counted by hand and never doubled, capacity never
 * below what is booked (in the handler and in the database), and every slot operation refused to the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const sessions = new Map<string, TestSession>();
let zoneId: string;
let branchId: string;
const MS_PER_DAY = 86_400_000;

const day = (offset: number) => toBusinessDate(new Date(clock.now().getTime() + offset * MS_PER_DAY));
const generate = (who: string, body: object, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, '/v1/delivery-slots/generate', key).send(body);
const patch = (who: string, id: string, body: object) =>
  request(api.server)
    .patch(`/v1/delivery-slots/${id}`)
    .set('Cookie', sessions.get(who)!.jar.header())
    .set('X-CSRF-Token', sessions.get(who)!.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(body);
const fortnight = () => ({ zoneId, from: day(14), to: day(27), weekdays: [2, 4, 6], times: [{ startsAt: '10:00', endsAt: '12:00', capacity: 8 }, { startsAt: '14:00', endsAt: '16:00', capacity: 8 }] });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const zone = (await database.pool('admin').query<{ id: string; branch_id: string }>("SELECT id, branch_id FROM mdm.delivery_zone WHERE code = 'DODOWA'")).rows[0]!;
  zoneId = zone.id;
  branchId = zone.branch_id;
  const people: [string, RoleCode, boolean][] = [
    ['manager', 'MANAGER', true],
    ['accountant', 'ACCOUNTANT', true],
    ['storekeeper', 'STOREKEEPER', false],
    ['cashier', 'CASHIER', false],
    ['sales', 'SALES', false],
    ['farmHand', 'FARM_HAND', false],
    ['driver', 'DRIVER', false],
  ];
  for (const [name, role, privileged] of people) {
    const user = await createUser(database, { name: `Test ${name}`, grants: [{ role, branchId }] });
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('delivery slots (FR-DEL-001)', () => {
  it('shows the seeded fortnight of Dodowa slots: three days a week, two runs of 8, nothing booked, in start order', async () => {
    const listed = await consoleGet(api.server, sessions.get('manager')!, `/v1/delivery-slots?zoneId=${zoneId}&limit=100`);
    expect(listed.status).toBe(200);
    const slots = listed.body.data as Array<{ slotDate: string; startsAt: string; capacity: number; booked: number; remaining: number; deliveryZone: { code: string } }>;
    // Any 14 days hold exactly two Tuesdays, two Thursdays and two Saturdays: 6 days, 2 runs each.
    expect(slots).toHaveLength(12);
    expect(slots.every((s) => s.capacity === 8 && s.booked === 0 && s.remaining === 8 && s.deliveryZone.code === 'DODOWA')).toBe(true);
    const starts = slots.map((s) => `${s.slotDate} ${s.startsAt}`);
    expect(starts).toEqual([...starts].sort());
  });

  it('generates the next fortnight exactly once: 12 slots, then 12 skipped, and a replay answers the first result', async () => {
    const key = randomUUID();
    const first = await generate('manager', fortnight(), key);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ created: 12, skippedExisting: 0 });
    expect((await generate('manager', fortnight(), key)).body).toEqual({ created: 12, skippedExisting: 0 });
    expect((await generate('manager', fortnight())).body).toEqual({ created: 0, skippedExisting: 12 });
  });

  it('refuses a range in the past, overlapping windows and a zone that does not deliver', async () => {
    const past = await generate('manager', { ...fortnight(), from: day(-1) });
    expect(past.status).toBe(422);
    expect(past.body.error).toMatchObject({ code: 'SLOT_REQUEST_INVALID', details: [{ field: '/from', code: 'IN_THE_PAST' }] });
    const overlap = await generate('manager', { ...fortnight(), times: [{ startsAt: '10:00', endsAt: '12:00', capacity: 8 }, { startsAt: '11:00', endsAt: '13:00', capacity: 8 }] });
    expect(overlap.body.error.details[0]).toMatchObject({ field: '/times/1', code: 'OVERLAPS' });
    expect((await generate('manager', { ...fortnight(), zoneId: randomUUID() })).body.error.code).toBe('REFERENCE_NOT_FOUND');
  });

  it('changes a capacity, refuses a stale version, and never takes it below what is booked, in the handler or the database', async () => {
    const [slot] = (await consoleGet(api.server, sessions.get('manager')!, `/v1/delivery-slots?zoneId=${zoneId}&limit=1`)).body.data as Array<{ id: string; version: number }>;
    const raised = await patch('manager', slot!.id, { version: slot!.version, capacity: 10 });
    expect(raised.status).toBe(200);
    expect(raised.body).toMatchObject({ capacity: 10, remaining: 10, version: slot!.version + 1 });
    expect((await patch('manager', slot!.id, { version: slot!.version, capacity: 12 })).status).toBe(409);
    // Since 0326 only a delivery's booking moves `booked` (B11 continued 5 books them, test/integration/del/scheduling);
    // a hand write is refused, so the four bookings this rule needs are written here with the triggers held off.
    await expect(database.pool('app').query('UPDATE del.delivery_slot SET booked = 4, version = version + 1 WHERE id = $1', [slot!.id])).rejects.toMatchObject({ code: 'HK004', constraint: 'ck_delivery_slot_booked_by_delivery' });
    const client = await database.pool('admin').connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query('UPDATE del.delivery_slot SET booked = 4, version = version + 1 WHERE id = $1', [slot!.id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const below = await patch('manager', slot!.id, { version: slot!.version + 2, capacity: 3 });
    expect(below.status).toBe(422);
    expect(below.body.error.code).toBe('CAPACITY_BELOW_BOOKED');
    expect((await patch('manager', slot!.id, { version: slot!.version + 2, capacity: 4 })).status).toBe(200);
    await expect(database.pool('app').query('UPDATE del.delivery_slot SET capacity = 3, version = version + 1 WHERE id = $1', [slot!.id])).rejects.toMatchObject({ constraint: 'ck_delivery_slot_booked' });
    await expect(database.pool('app').query('DELETE FROM del.delivery_slot WHERE id = $1', [slot!.id])).rejects.toMatchObject({ code: '42501' });
  });

  for (const who of ['accountant', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} every slot operation with 403`, async () => {
      expect((await consoleGet(api.server, sessions.get(who)!, '/v1/delivery-slots')).status).toBe(403);
      expect((await generate(who, fortnight())).status).toBe(403);
      expect((await patch(who, randomUUID(), { version: 1, capacity: 9 })).status).toBe(403);
    });
  }
});
