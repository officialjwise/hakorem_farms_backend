import { randomBytes, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { consoleGet, consolePost, consolePut, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The business profile (FR-AUD-008) and the shop's contact details (CR-028), the B09x continued gate: the profile is one
 * effective-dated `platform.setting` row written only through AUD's audited administration (`aud.setting.manage`, a
 * fresh step-up, the value before and after in the audit event); the console reads it with `aud.setting.read`; the shop
 * reads only its contact fields, anonymously and cacheably, and 404 while no profile is set. Every number here is from
 * the test's own invented `+2332000009..` block.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let ownerId: string;
let manager: TotpSession;
let accountant: TotpSession;
const others = new Map<RoleCode, TestSession>();

const PROFILE = '/v1/admin/business-profile';
const SHOP = '/v1/shop/profile';
const admin = () => database.pool('admin');

const body = (version: number, overrides: Record<string, unknown> = {}) => ({
  version,
  legalName: 'Dodowa Test Farms Limited (TEST)',
  tradingName: 'Dodowa Test Farms (TEST)',
  tin: 'C0000000009',
  vatNumber: 'V0000000009',
  address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (TEST)',
  phone: '+233200000901',
  whatsapp: '+233200000902',
  email: 'shop@test.hakoremfarms.invalid',
  directions: 'Past the Presby church, second turning on the left (TEST)',
  openingHours: [
    { day: 'SATURDAY', opens: '08:00', closes: '14:00' },
    { day: 'MONDAY', opens: '07:00', closes: '18:00' },
  ],
  ...overrides,
});

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  const response = await consolePost(api.server, session, '/v1/auth/step-up').send({ code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
}

async function storedFile(purpose: string, classification: string): Promise<string> {
  const id = randomUUID();
  await admin().query(
    `INSERT INTO platform.stored_file (id, bucket, object_key, original_name, content_type, size_bytes, sha256, classification, scan_status, scanned_at, purpose, owner_module, created_by, updated_by)
     VALUES ($1, 'hk-test-private', $2, 'picture.jpg', 'image/jpeg', 1000, $6, $3, 'PENDING', NULL, $4, 'doc', $5, $5)`,
    [id, `test/${id}`, classification, purpose, SYSTEM_PRINCIPAL, randomBytes(32)],
  );
  // The scanner's verdict, as the worker records it.
  await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [id]);
  return id;
}

const put = (session: TestSession, payload: object, key: string = randomUUID()) => consolePut(api.server, session, PROFILE, key).send(payload);
const profileRows = async () =>
  (await admin().query<{ version: number; value: Record<string, unknown> }>("SELECT version, value FROM platform.setting WHERE key = 'aud.business_profile' ORDER BY valid_from")).rows;
const profileAudits = async () =>
  (
    await admin().query<{ before: string | null; after: string; actor_id: string }>(
      `SELECT convert_from("before", 'UTF8') AS before, convert_from("after", 'UTF8') AS after, actor_id FROM platform.audit_event
        WHERE entity_type = 'BusinessProfile' AND action = 'UPDATE' ORDER BY recorded_at, id`,
    )
  ).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const { branchId } = await createBranch(database);
  const ownerUser = await createUser(database, { name: 'Akua Mensah', grants: [{ role: 'OWNER', branchId }] });
  ownerId = ownerUser.principalId;
  owner = await enrolAndLogin(api.server, ownerUser, () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kofi Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  for (const role of ['STOREKEEPER', 'CASHIER', 'SALES', 'FARM_HAND', 'DRIVER'] as const) {
    others.set(role, await login(api.server, await createUser(database, { name: `Esi ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the business profile before it is set (FR-AUD-008, CR-028)', () => {
  it('answers 404 to the shop and to the console while no profile is set, never an invented one', async () => {
    const shop = await request(api.server).get(SHOP);
    expect([shop.status, shop.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(shop.headers['cache-control']).toBe('no-store');
    const console = await consoleGet(api.server, manager, PROFILE);
    expect([console.status, console.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('who may change and read the business profile (ADR-0035)', () => {
  it('refuses the change to every role but the Owner with 403, and writes nothing', async () => {
    for (const session of [manager, accountant, ...others.values()]) {
      const refused = await put(session, body(0));
      expect([refused.status, refused.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
    expect(await profileRows()).toEqual([]);
  });

  it('refuses the Owner without a step-up in the last five minutes, and writes nothing', async () => {
    clock.advanceBy(301_000);
    const stale = await put(owner, body(0));
    expect([stale.status, stale.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    expect(await profileRows()).toEqual([]);
  });

  it('refuses the console read to every role but the Owner and the Manager', async () => {
    for (const session of [accountant, ...others.values()]) {
      const refused = await consoleGet(api.server, session, PROFILE);
      expect([refused.status, refused.body.error.code]).toEqual([403, 'FORBIDDEN']);
    }
  });

  it('refuses the profile through updateSetting: its key is not in the settings catalogue', async () => {
    await stepUp(owner);
    const refused = await consolePut(api.server, owner, '/v1/admin/settings/aud.business_profile').send({ value: body(0), version: 0 });
    expect(refused.status).toBe(404);
    expect(await profileRows()).toEqual([]);
  });
});

describe('the Owner sets the business profile (FR-AUD-008)', () => {
  it('refuses hours that close before they open, overlapping hours, a phone not in E.164, an unknown field and a logo that is not a clean public image', async () => {
    await stepUp(owner);
    const backwards = await put(owner, body(0, { openingHours: [{ day: 'MONDAY', opens: '18:00', closes: '07:00' }] }));
    expect([backwards.status, backwards.body.error.code, backwards.body.error.details]).toEqual([422, 'SETTING_INVALID', [expect.objectContaining({ field: '/openingHours/0/closes', code: 'CLOSES_BEFORE_OPENS' })]]);
    const overlap = await put(owner, body(0, { openingHours: [{ day: 'MONDAY', opens: '07:00', closes: '12:00' }, { day: 'MONDAY', opens: '11:00', closes: '18:00' }] }));
    expect([overlap.status, overlap.body.error.details[0].code]).toEqual([422, 'HOURS_OVERLAP']);
    expect((await put(owner, body(0, { whatsapp: '0200000902' }))).status).toBe(400);
    expect((await put(owner, body(0, { phone: '+233 20 000 0901' }))).status).toBe(400);
    expect((await put(owner, body(0, { bankAccountNo: '0000000009' }))).status).toBe(400);
    const missing = await put(owner, body(0, { logoFileId: randomUUID() }));
    expect([missing.status, missing.body.error.details[0]]).toEqual([422, expect.objectContaining({ field: '/logoFileId', code: 'LOGO_NOT_USABLE' })]);
    const evidence = await storedFile('EVIDENCE', 'CONFIDENTIAL');
    expect((await put(owner, body(0, { logoFileId: evidence }))).body.error.details[0].code).toBe('LOGO_NOT_USABLE');
    expect(await profileRows()).toEqual([]);
  });

  it('stores the profile as one setting row at version 1, hours in week order, audited with nothing before and the profile after', async () => {
    const key = randomUUID();
    const set = await put(owner, body(0), key);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({
      ...body(0),
      version: 1,
      logoFileId: null,
      openingHours: [
        { day: 'MONDAY', opens: '07:00', closes: '18:00' },
        { day: 'SATURDAY', opens: '08:00', closes: '14:00' },
      ],
      updatedAt: clock.now().toISOString(),
    });
    const rows = await profileRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.value).toMatchObject({ tin: 'C0000000009', whatsapp: '+233200000902' });
    const audits = await profileAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toBeNull();
    expect(JSON.parse(audits[0]!.after)).toMatchObject({ version: 1, tin: 'C0000000009', phone: '+233200000901', whatsapp: '+233200000902' });
    expect(audits[0]!.actor_id).toBe(ownerId);
    const replay = await put(owner, body(0), key);
    expect([replay.status, replay.body]).toEqual([200, set.body]);
    expect(await profileRows()).toHaveLength(1);
    expect((await consoleGet(api.server, manager, PROFILE)).body).toEqual(set.body);
  });

  it('changes it as a new effective-dated row at version 2 whose audit carries the profile before and after; the first row stays', async () => {
    await stepUp(owner);
    const logo = await storedFile('PRODUCT_IMAGE', 'PUBLIC');
    const changed = await put(owner, body(1, { phone: '+233200000903', logoFileId: logo, tin: undefined, whatsapp: undefined, directions: undefined, openingHours: undefined }));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ version: 2, phone: '+233200000903', logoFileId: logo, tin: null, whatsapp: null, directions: null, openingHours: [] });
    expect((await profileRows()).map((row) => row.version)).toEqual([1, 2]);
    const audits = await profileAudits();
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]!.before!)).toMatchObject({ version: 1, phone: '+233200000901', tin: 'C0000000009' });
    expect(JSON.parse(audits[1]!.after)).toMatchObject({ version: 2, phone: '+233200000903', tin: null });
  });

  it('refuses a stale version with 409 and writes nothing', async () => {
    clock.advanceBy(1_000);
    const stale = await put(owner, body(1));
    expect([stale.status, stale.body.error.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect(await profileRows()).toHaveLength(2);
  });

  it('lands one of two concurrent changes from one version and refuses the other with 409', async () => {
    clock.advanceBy(1_000);
    const results = await Promise.all([put(owner, body(2, { tradingName: 'First (TEST)' })), put(owner, body(2, { tradingName: 'Second (TEST)' }))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await profileRows()).map((row) => row.version)).toEqual([1, 2, 3]);
  });
});

describe("the shop's contact details (CR-028)", () => {
  it('answers anyone exactly the trading name, the two numbers, the address, the directions and the hours, with a public cache lifetime', async () => {
    await stepUp(owner);
    expect((await put(owner, body(3))).status).toBe(200);
    const shop = await request(api.server).get(SHOP);
    expect(shop.status).toBe(200);
    expect(Object.keys(shop.body).sort()).toEqual(['address', 'directions', 'openingHours', 'phone', 'tradingName', 'whatsapp']);
    for (const interval of shop.body.openingHours) expect(Object.keys(interval).sort()).toEqual(['closes', 'day', 'opens']);
    expect(shop.body).toEqual({
      tradingName: 'Dodowa Test Farms (TEST)',
      phone: '+233200000901',
      whatsapp: '+233200000902',
      address: 'Off the Dodowa-Afienya road, Dodowa, GE-293-0471 (TEST)',
      directions: 'Past the Presby church, second turning on the left (TEST)',
      openingHours: [
        { day: 'MONDAY', opens: '07:00', closes: '18:00' },
        { day: 'SATURDAY', opens: '08:00', closes: '14:00' },
      ],
    });
    expect(JSON.stringify(shop.body)).not.toMatch(/C0000000009|V0000000009|Limited|invalid|version|logo/);
    expect(shop.headers['cache-control']).toBe('public, max-age=300');
    expect(shop.headers['set-cookie']).toBeUndefined();
  });

  it('limits the anonymous read by address, with the public catalogue limit', async () => {
    await database
      .pool('app')
      .query(
        `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
         VALUES ($1, 'rate_limit.public.per_address_1m', '1', 'INTEGER', now() - interval '1 day', 'Lowered for a test', $2, $2)`,
        [randomUUID(), SYSTEM_PRINCIPAL],
      );
    clock.advanceBy(31_000);
    const answers = [];
    for (let attempt = 0; attempt < 3; attempt += 1) answers.push(await request(api.server).get(SHOP));
    const limited = answers.find((answer) => answer.status === 429);
    expect(limited?.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
  });
});
