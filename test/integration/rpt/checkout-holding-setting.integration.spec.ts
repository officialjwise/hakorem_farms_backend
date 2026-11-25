import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionProjector } from '../../../src/modules/rpt';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker, type DocumentWorker } from '../../support/documents';
import { stepUp } from '../../support/fin';
import { consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The checkout holding threshold as the Owner's setting (A-390 approved by the owner, 2026-11-24: "Make the 3 a setting
 * the Owner can change, audited, not a constant"): AUD's `rpt.checkout_holding.unpaid_checkouts`, a whole number from
 * 1, default 3, changed only by a holder of `aud.setting.manage` and `rpt.exception_rules.manage` (the Owner), each
 * change audited with the old value, the new, who and when. The projector judges each checkout by the value in force
 * when it ended, so a later change, and the projection's rebuild, never rewrite an earlier day's items.
 */
const KEY = 'rpt.checkout_holding.unpaid_checkouts';
const PATH = `/v1/admin/settings/${KEY}`;
const DAY_MS = 86_400_000;

let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let worker: DocumentWorker;
let nextId: () => string;
let owner: TestSession & { readonly secret: Buffer };
let ownerId: string;
const refused = new Map<string, TestSession>();
const admin = () => database.pool('admin');

/** An event in the outbox for the exception projector alone, as the outbox would hold and deliver it. */
async function outbox(type: string, payload: Record<string, unknown>): Promise<void> {
  const id = nextId();
  await admin().query(
    `INSERT INTO platform.outbox_message (id, event_type, event_version, subject_type, subject_id, branch_id, actor_id, correlation_id, causation_id, payload, occurred_at, recorded_at)
     VALUES ($1, $2, 1, 'Checkout', $1, NULL, $3, $4, NULL, $5, $6, $6)`,
    [id, type, SYSTEM_PRINCIPAL, randomUUID(), payload, clock.now()],
  );
  await admin().query("INSERT INTO platform.outbox_delivery (message_id, consumer, subject_id, status, next_attempt_at) VALUES ($1, 'rpt.exception-items', $2, 'PENDING', $3)", [id, id, clock.now()]);
}

/** One address letting `count` checkouts expire unpaid, now. */
async function lapse(address: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const checkoutId = randomUUID();
    await outbox('shp.CheckoutStarted', { checkoutId, cartId: randomUUID(), reservedUntil: clock.now().toISOString(), estimatedTotalPesewas: 22_000, lineCount: 1, clientAddressHash: address });
    await outbox('shp.CheckoutExpired', { checkoutId, cartId: randomUUID(), reservedUntil: clock.now().toISOString(), reason: 'EXPIRED' });
  }
  await worker.settle();
}

async function holding(address: string): Promise<{ date: string; unpaid: number; threshold: number }[]> {
  const { rows } = await admin().query<{ date: string; unpaid: number; threshold: number }>(
    "SELECT exception_date::text AS date, (details ->> 'unpaid')::int AS unpaid, (details ->> 'threshold')::int AS threshold FROM rpt.exception_item WHERE kind = 'CHECKOUT_HOLDING' AND details ->> 'addressHash' = $1 ORDER BY exception_date",
    [address],
  );
  return rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800' } });
  worker = documentWorker(api, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await worker.settle();
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const ownerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  ownerId = ownerUser.principalId;
  owner = await enrolAndLogin(api.server, ownerUser, () => clock.now());
  for (const role of ['MANAGER', 'ACCOUNTANT'] as const) {
    const session = await enrolAndLogin(api.server, await createUser(database, { name: `Seed ${role}`, grants: [{ role, branchId }] }), () => clock.now());
    await stepUp(api.server, session, clock);
    refused.set(role, session);
  }
  for (const role of ['CASHIER', 'STOREKEEPER', 'SALES', 'DRIVER'] as const) {
    refused.set(role, await login(api.server, await createUser(database, { name: `Seed ${role}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the checkout holding threshold is the Owner\'s setting (A-390 approved, the owner 2026-11-24)', () => {
  it('refuses the Manager and every other role, writing nothing; only the Owner holds the rule permission', async () => {
    for (const [role, session] of refused) {
      const response = await consolePut(api.server, session, PATH).send({ value: 5, version: 0 });
      expect(response.status, `${role} ${JSON.stringify(response.body)}`).toBe(403);
    }
    expect((await admin().query('SELECT 1 FROM platform.setting WHERE key = $1', [KEY])).rows).toEqual([]);
    const holders = await admin().query<{ code: string }>("SELECT r.code FROM iam.role_permission rp JOIN iam.role r ON r.id = rp.role_id WHERE rp.permission_code = 'rpt.exception_rules.manage' AND r.deleted_at IS NULL");
    expect(holders.rows.map((r) => r.code)).toEqual(['OWNER']);
  });

  it('takes a whole number of at least 1 only', async () => {
    await stepUp(api.server, owner, clock);
    for (const value of [0, -1, 2.5, '4', null]) {
      const response = await consolePut(api.server, owner, PATH).send({ value, version: 0 });
      expect(response.status, `${String(value)} ${JSON.stringify(response.body)}`).toBe(422);
      expect(response.body.error).toMatchObject({ code: 'SETTING_INVALID', details: [{ field: '/value', code: typeof value === 'number' && Number.isInteger(value) ? 'OUT_OF_RANGE' : 'WRONG_TYPE' }] });
    }
  });

  it("judges each day by the value in force then: a later change and a rebuild never rewrite an earlier day's items", async () => {
    const first = 'c'.repeat(64);
    const second = 'd'.repeat(64);
    const third = 'e'.repeat(64);
    // Day one at the default of 3: three lapsed checkouts are an item.
    await lapse(first, 3);
    const dayOne = toBusinessDate(clock.now());
    expect(await holding(first)).toEqual([{ date: dayOne, unpaid: 3, threshold: 3 }]);

    // The next day the Owner raises it to 5, audited with the old value, the new, who and when.
    clock.advanceBy(DAY_MS);
    await stepUp(api.server, owner, clock);
    const changedAt = clock.now();
    const changed = await consolePut(api.server, owner, PATH).send({ value: 5, version: 0 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ key: KEY, value: 5, version: 1, updatedBy: { id: ownerId } });
    const audit = await admin().query<{ actor_id: string; occurred_at: Date; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `SELECT actor_id, occurred_at, convert_from("before", 'UTF8')::jsonb AS before, convert_from("after", 'UTF8')::jsonb AS after FROM platform.audit_event
        WHERE module = 'aud' AND action = 'UPDATE' AND entity_type = 'Setting' AND convert_from("after", 'UTF8')::jsonb ->> 'key' = $1`,
      [KEY],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_id: ownerId, before: { key: KEY, value: 3, isDefault: true }, after: { key: KEY, value: 5 } });
    expect(audit.rows[0]!.occurred_at.getTime()).toBe(changedAt.getTime());

    // Day two: three lapsed checkouts are no longer an item; five are.
    const dayTwo = toBusinessDate(clock.now());
    await lapse(second, 3);
    expect(await holding(second)).toEqual([]);
    await lapse(third, 5);
    expect(await holding(third)).toEqual([{ date: dayTwo, unpaid: 5, threshold: 5 }]);

    // A rebuild replays every checkout against the value in force when it ended: day one keeps its item at 3.
    await api.app.get(ExceptionProjector).rebuild();
    expect(await holding(first)).toEqual([{ date: dayOne, unpaid: 3, threshold: 3 }]);
    expect(await holding(second)).toEqual([]);
    expect(await holding(third)).toEqual([{ date: dayTwo, unpaid: 5, threshold: 5 }]);
  });
});
