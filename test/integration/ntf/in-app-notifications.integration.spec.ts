import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MortalityEvidenceReturns } from '../../../src/modules/liv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, type NtfHarness } from '../../support/ntf';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * In-app notifications (FR-NTF-008; B11 continued 11, A-376 (e)) over the seeded farm: a death report the malware scan
 * sends back (B06r, `liv.MortalityReturned`) reaches its own reporter in the console, once, through the outbox and the
 * sender like every message; each recipient lists and marks only their own, the unread count stays true, and another
 * person's notification is not found. Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
const sms = new FakeSms();
const sessions = new Map<string, TestSession>();
const principals = new Map<string, string>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object = {}, key?: string) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const rows = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]!.n);
const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
const SCANNER = '01900000-0000-7000-8000-000000000004';
const returns = () => runAsSystem({ principalId: SCANNER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(MortalityEvidenceReturns).run({ kind: 'SYSTEM', principalId: SCANNER }));
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);

/** A goat from Kpone, each its own tag, into the pens. */
async function buyGoat(tag: string): Promise<void> {
  const created = await post('manager', '/goods-receipts', {
    kind: 'PURCHASE',
    supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
    locationId: id('location:PENS'),
    deliveryNoteRef: `NT-${randomUUID().slice(0, 8)}`,
    receivedAt: hoursAgo(48),
    lines: [{ productId: id('product:LIV-0004'), qtyReceived: '1.000', valuePesewas: 24_000, animals: [{ tagNo: tag, sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' }] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await post('manager', `/goods-receipts/${created.body.id as string}/post`)).status).toBe(200);
  ids.set(`unit:${tag}`, (await rows<{ id: string }>("SELECT id FROM inv.stock_unit WHERE identifier = $1 AND status = 'ACTIVE'", [tag]))[0]!.id);
}

/** A farm hand's death report with its photograph, submitted, and the scanner's verdict on the photograph: sent back. */
async function returnedReport(who: string, tag: string, seed: number, verdict: 'INFECTED' | 'FAILED'): Promise<string> {
  const fileId = (await consolePost(api.server, as(who), '/v1/files').field('purpose', 'EVIDENCE').attach('file', photo(seed), 'carcass.jpg')).body.id as string;
  const reported = await post(who, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id(`unit:${tag}`), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1), photoFileId: fileId });
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  expect((await post(who, `/care/mortality-records/${reported.body.id as string}/submit`)).status).toBe(202);
  await database.pool('worker').query('UPDATE platform.stored_file SET scan_status = $2, scanned_at = now(), version = version + 1 WHERE id = $1', [fileId, verdict]);
  return reported.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'location:' || l.code AS code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
     UNION ALL SELECT 'product:' || sku, id FROM mdm.product
     UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier`,
  )) ids.set(row.code, row.id);
  const branchId = (await rows<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'"))[0]!.id;
  sessions.set('manager', await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now()));
  for (const [key, name] of [['abena', 'Abena Quaye'], ['kofi', 'Kofi Addo']] as const) {
    const user = await createUser(database, { name, grants: [{ role: 'FARM_HAND', branchId }] });
    principals.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  for (const tag of ['NT-G01', 'NT-G02', 'NT-G03', 'NT-G04']) await buyGoat(tag);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a death report sent back reaches its own reporter in the console (FR-NTF-008, the B11 continued 11 gate)', () => {
  const reports = new Map<string, string>();

  it('queues one IN_APP message to the reporter through the outbox, and the sender writes its notification once', async () => {
    reports.set('NT-G01', await returnedReport('abena', 'NT-G01', 31, 'INFECTED'));
    reports.set('NT-G02', await returnedReport('abena', 'NT-G02', 32, 'FAILED'));
    reports.set('NT-G03', await returnedReport('abena', 'NT-G03', 33, 'INFECTED'));
    reports.set('NT-G04', await returnedReport('kofi', 'NT-G04', 34, 'INFECTED'));
    expect(await returns()).toEqual({ returned: 4 });
    await ntf.dispatch();
    const messages = await rows<{ channel: string; kind: string; principal: string; status: string; masked: string; subject: string; link: string; body: string }>(
      `SELECT m.channel, m.recipient_kind AS kind, m.principal_id AS principal, m.status, m.address_masked AS masked, m.rendered_subject AS subject, m.link_path AS link, m.rendered_body AS body
         FROM ntf.message m WHERE m.source_event_type = 'liv.MortalityReturned' ORDER BY m.created_at, m.id`,
    );
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({
      channel: 'IN_APP',
      kind: 'STAFF',
      principal: principals.get('abena'),
      status: 'QUEUED',
      masked: '',
      subject: 'Death report sent back',
      link: `/livestock/mortality/${reports.get('NT-G01')!}`,
      body: 'The death report of NT-G01 came back to you: the photograph did not pass the virus scan. Report it again with a new photograph.',
    });
    expect(messages[1]!.body).toBe('The death report of NT-G02 came back to you: the photograph could not be scanned. Report it again with a new photograph.');
    expect(messages[3]!.principal).toBe(principals.get('kofi'));

    expect(await ntf.sender(sms).run(SCHEDULER)).toMatchObject({ claimed: 4, sent: 4 });
    expect(sms.calls).toEqual([]);
    expect((await ntf.sender(sms).run(SCHEDULER)).claimed).toBe(0);
    // The outbox redelivered and the handler replayed: still one message and one notification per report.
    await admin().query("UPDATE platform.outbox_delivery SET status = 'PENDING', next_attempt_at = now() - interval '1 second', delivered_at = NULL WHERE consumer = 'ntf.staff-notifications'");
    await ntf.dispatch();
    expect(await count("SELECT count(*) AS n FROM ntf.message WHERE source_event_type = 'liv.MortalityReturned'")).toBe(4);
    expect(await count('SELECT count(*) AS n FROM ntf.in_app_notification')).toBe(4);
    expect(await rows("SELECT m.status, a.attempt_no, a.outcome FROM ntf.message m JOIN ntf.message_attempt a ON a.message_id = m.id WHERE m.principal_id = $1 ORDER BY m.created_at LIMIT 1", [principals.get('abena')])).toEqual([
      { status: 'SENT', attempt_no: 1, outcome: 'ACCEPTED' },
    ]);
    const logged = await get('manager', '/notifications/messages?channel=IN_APP');
    expect(logged.body.data.map((m: { recipient: { kind: string; id: string } }) => m.recipient)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'STAFF', id: principals.get('kofi') })]));
  });

  it('lists only the caller\'s own, newest first, with the unread count; marking one of three read leaves two, once', async () => {
    const mine = await get('abena', '/me/notifications');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.unreadCount).toBe(3);
    expect(mine.body.data.map((n: { body: string }) => n.body.slice(0, 32))).toEqual(['The death report of NT-G03 came ', 'The death report of NT-G02 came ', 'The death report of NT-G01 came ']);
    expect(mine.body.data[0]).toMatchObject({ title: 'Death report sent back', link: `/livestock/mortality/${reports.get('NT-G03')!}`, readAt: null });
    const theirs = await get('kofi', '/me/notifications');
    expect(theirs.body.data.map((n: { body: string }) => n.body.slice(0, 26))).toEqual(['The death report of NT-G04']);
    expect(theirs.body.unreadCount).toBe(1);
    const paged = await get('abena', '/me/notifications?limit=2');
    const rest = await get('abena', `/me/notifications?limit=2&cursor=${encodeURIComponent(paged.body.page.nextCursor as string)}`);
    expect([...paged.body.data, ...rest.body.data].map((n: { id: string }) => n.id)).toEqual(mine.body.data.map((n: { id: string }) => n.id));

    const first = mine.body.data[2].id as string;
    const read = await post('abena', `/me/notifications/${first}/read`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: first, readAt: clock.now().toISOString() });
    clock.advanceBy(60_000);
    expect((await post('abena', `/me/notifications/${first}/read`)).body.readAt).toBe(read.body.readAt);
    expect((await get('abena', '/me/notifications')).body.unreadCount).toBe(2);
    expect((await get('abena', '/me/notifications?unreadOnly=true')).body.data.map((n: { id: string }) => n.id)).toEqual(mine.body.data.slice(0, 2).map((n: { id: string }) => n.id));
  });

  it("another person's notification is not found, to read or to mark; nobody signed in is refused", async () => {
    const abenas = (await get('abena', '/me/notifications')).body.data[0].id as string;
    const kofis = (await get('kofi', '/me/notifications')).body.data[0].id as string;
    expect((await post('kofi', `/me/notifications/${abenas}/read`)).status).toBe(404);
    expect((await post('manager', `/me/notifications/${abenas}/read`)).status).toBe(404);
    expect((await post('abena', `/me/notifications/${randomUUID()}/read`)).status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM ntf.in_app_notification WHERE id = $1 AND read_at IS NULL', [abenas])).toBe(1);
    expect((await get('manager', '/me/notifications')).body).toMatchObject({ data: [], unreadCount: 0 });
    expect((await request(api.server).get('/v1/me/notifications')).status).toBe(401);
    expect((await request(api.server).post(`/v1/me/notifications/${kofis}/read`)).status).toBe(401);
  });

  it("goes to the record's own reporter whoever an event names, and only for a report that was sent back", async () => {
    const before = await count('SELECT count(*) AS n FROM ntf.in_app_notification WHERE principal_id = $1', [principals.get('kofi')]);
    // A forged event naming Kofi as the reporter of Abena's report: the record says Abena.
    const forged = await ntf.publish({
      type: 'liv.MortalityReturned',
      subjectType: 'MortalityRecord',
      subjectId: reports.get('NT-G01')!,
      payload: { mortalityRecordId: reports.get('NT-G01')!, branchId: null, stockUnitId: id('unit:NT-G01'), reportedBy: principals.get('kofi'), photoFileId: randomUUID(), reason: 'EVIDENCE_INFECTED', approvalRequestId: randomUUID() },
    });
    // An event for a record that was never sent back, and one for no record at all.
    const stranger = await ntf.publish({ type: 'liv.MortalityReturned', subjectType: 'MortalityRecord', subjectId: randomUUID(), payload: { mortalityRecordId: randomUUID(), reportedBy: principals.get('kofi'), reason: 'EVIDENCE_INFECTED' } });
    await ntf.dispatch();
    await ntf.sender(sms).run(SCHEDULER);
    expect(await rows('SELECT principal_id AS principal FROM ntf.message WHERE source_event_ref = $1', [forged])).toEqual([{ principal: principals.get('abena') }]);
    expect(await count('SELECT count(*) AS n FROM ntf.message WHERE source_event_ref = $1', [stranger])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM ntf.in_app_notification WHERE principal_id = $1', [principals.get('kofi')])).toBe(before);
  });

  it('the database keeps a notification as written and its read state once', async () => {
    const app = database.pool('app');
    const [read] = await rows<{ id: string }>('SELECT id FROM ntf.in_app_notification WHERE read_at IS NOT NULL LIMIT 1');
    const [unread] = await rows<{ id: string }>('SELECT id FROM ntf.in_app_notification WHERE read_at IS NULL LIMIT 1');
    expect(await sqlStateOf(app.query("UPDATE ntf.in_app_notification SET body = 'Pay to 0559999999' WHERE id = $1", [unread!.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE ntf.in_app_notification SET principal_id = $2 WHERE id = $1', [unread!.id, principals.get('kofi')]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE ntf.in_app_notification SET read_at = NULL WHERE id = $1', [read!.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE ntf.message SET link_path = '/elsewhere' WHERE id = (SELECT message_id FROM ntf.in_app_notification WHERE id = $1)", [unread!.id]))).toBe(SQLSTATE.documentFrozen);
  });
});
