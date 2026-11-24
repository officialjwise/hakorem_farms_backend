import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dunning } from '../../../src/modules/whl';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePatch, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession, type TestUser } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, signReport, type NtfHarness } from '../../support/ntf';
import { issueInvoice } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Preferences, opt-outs, quiet hours and triggers (FR-NTF-002, FR-NTF-004 to FR-NTF-006; B11 continued 11, ADR-0097,
 * A-376) over the seeded farm, through WHL's real dunning: three business customers with an invoice each, reminded at 7,
 * 14 and 30 days past due. A reminder due at 22:30 Africa/Accra waits until 07:00 and is sent then, once; a STOP reply
 * is an opt-out at once (the next reminder is suppressed, one already waiting is not sent), a START undoes it, and a
 * transactional message to the same kind of opted-out number is still sent; a customer's own preferences turn a channel
 * off or set their own quiet hours, and nobody else's are reachable; a trigger turned off stops new messages and leaves
 * the old. The provider is a test double; every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let branchId = '';
let dueOn = '';
let orderId = '';
const WEBHOOK_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const sms = new FakeSms();
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const put = (who: string, path: string, body: object, key = randomUUID()) => consolePut(api.server, as(who), `/v1${path}`, key).send(body);
const patch = (who: string, path: string, body: object, key = randomUUID()) => consolePatch(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const rows = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows;
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const codes = (res: request.Response) => [res.status, res.body.error?.code, ...((res.body.error?.details ?? []) as { code: string }[]).map((d) => d.code)];
const at = (date: string, time: string) => clock.set(new Date(`${date}T${time}Z`));
const hook = (body: string, signature: string | null) => {
  const call = request(api.server).post('/v1/webhooks/messaging/GENERIC_HTTP').set('Content-Type', 'application/json');
  return (signature === null ? call : call.set('X-Provider-Signature', signature)).send(body);
};
const reply = (from: string, text: string, replyId = `mo-${randomUUID()}`) => {
  const body = JSON.stringify({ type: 'inbound', id: replyId, from, text });
  return hook(body, signReport(WEBHOOK_SECRET, body));
};
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const runDunning = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(Dunning).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
const send = () => ntf.sender(sms).run(SCHEDULER);
const remindersOf = (customer: string) =>
  rows<{ id: string; code: string; status: string; reason: string | null; channel: string; sendAfter: Date | null; body: string; masked: string; kind: string; attempts: number }>(
    `SELECT m.id, t.code, m.status, m.suppressed_reason AS reason, m.channel, m.send_after AS "sendAfter", m.rendered_body AS body, m.address_masked AS masked,
            m.recipient_kind AS kind, m.attempts
       FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.customer_id = $1 AND m.category = 'REMINDER' ORDER BY m.created_at, m.id`,
    [id(customer)],
  );

/** Asantewaa, Ada and Kpone: business customers at Dodowa with their own numbers and an account each. */
const CUSTOMERS = [
  ['asantewaa', 'Asantewaa Chop Bar (TEST)', '0244100201'],
  ['ada', 'Ada Foods (TEST)', '0244100202'],
  ['kpone', 'Kpone Cold Store (TEST)', '0244100203'],
] as const;
const E164 = (local: string) => `+233${local.slice(1)}`;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const long = String(90 * 86_400);
  api = await startTestApp(database, { clock, environment: { SMS_WEBHOOK_SECRET: WEBHOOK_SECRET, AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long, AUTH_CUSTOMER_REFRESH_IDLE_SECONDS: long } });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  ids.set('goat', (await one<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).id);
  orderId = (await one<{ id: string }>("SELECT id FROM ord.sales_order WHERE contact_phone_e164 = '+233200000301' LIMIT 1")).id;
  const staff: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwame Mensah', 'OWNER', true],
    ['manager', 'Abena Owusu', 'MANAGER', true],
    ['accountant', 'Esi Badu', 'ACCOUNTANT', true],
    ['sales', 'Kojo Antwi', 'SALES', false],
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER', false],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
  ];
  for (const [key, name, role, privileged] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    users.set(key, user);
    sessions.set(key, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  dueOn = toBusinessDate(clock.now());
  for (const [key, name, phone] of CUSTOMERS) {
    const created = await post('sales', '/customers', { kind: 'BUSINESS', name, phone });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    ids.set(key, created.body.id as string);
    const opened = await post('owner', '/business-accounts', { customerId: created.body.id, branchId, creditLimitPesewas: 0, paymentTermsDays: 30 });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const owed = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: created.body.id as string, productId: id('goat') }, 60_000n, dueOn);
    ids.set(`invoice:${key}`, owed.documentNo);
  }
  // Kpone's buyer signs in to the shop: the customer realm, linked to Kpone's record.
  const buyer = await createUser(database, { name: 'Kwesi Tetteh', realm: 'CUSTOMER' });
  await admin().query('UPDATE mdm.customer SET principal_id = $1, version = version + 1 WHERE id = $2', [buyer.principalId, id('kpone')]);
  sessions.set('kponeBuyer', await login(api.server, buyer));
  // A shopper whose sign-in belongs to no customer record.
  sessions.set('stranger', await login(api.server, await createUser(database, { name: 'Afia Mensah', realm: 'CUSTOMER' })));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a recipient's own preferences (FR-NTF-004, getMyNotificationPreferences, replaceMyNotificationPreferences)", () => {
  it('are empty until set, then replaced whole in order, keyed, audited; quiet hours only on reminders and marketing', async () => {
    expect(await get('kponeBuyer', '/me/notification-preferences').then((r) => [r.status, r.body])).toEqual([200, { preferences: [] }]);
    const key = randomUUID();
    const body = { preferences: [{ category: 'REMINDER', channel: 'SMS', isEnabled: false }, { category: 'TRANSACTIONAL', channel: 'WHATSAPP', isEnabled: true }, { category: 'TRANSACTIONAL', channel: 'SMS', isEnabled: true }] };
    const replaced = await put('kponeBuyer', '/me/notification-preferences', body, key);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body).toEqual({
      preferences: [
        { category: 'TRANSACTIONAL', channel: 'WHATSAPP', isEnabled: true, quietFrom: null, quietTo: null },
        { category: 'TRANSACTIONAL', channel: 'SMS', isEnabled: true, quietFrom: null, quietTo: null },
        { category: 'REMINDER', channel: 'SMS', isEnabled: false, quietFrom: null, quietTo: null },
      ],
    });
    expect((await put('kponeBuyer', '/me/notification-preferences', body, key)).body).toEqual(replaced.body);
    expect(await get('kponeBuyer', '/me/notification-preferences').then((r) => r.body)).toEqual(replaced.body);
    expect(await rows('SELECT category, channel, rank FROM ntf.preference WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY category, rank', [id('kpone')])).toEqual([
      { category: 'REMINDER', channel: 'SMS', rank: 1 },
      { category: 'TRANSACTIONAL', channel: 'WHATSAPP', rank: 1 },
      { category: 'TRANSACTIONAL', channel: 'SMS', rank: 2 },
    ]);
    expect(await count("SELECT count(*) AS n FROM platform.audit_event WHERE entity_type = 'NotificationPreferences' AND entity_id = $1", [id('kpone')])).toBe(1);

    const refused = (preferences: object[]) => put('kponeBuyer', '/me/notification-preferences', { preferences }).then(codes);
    expect(await refused([{ category: 'REMINDER', channel: 'SMS', isEnabled: true }, { category: 'REMINDER', channel: 'SMS', isEnabled: false }])).toEqual([422, 'PREFERENCES_INVALID', 'DUPLICATE_PREFERENCE']);
    expect(await refused([{ category: 'REMINDER', channel: 'SMS', isEnabled: true, quietFrom: '21:00' }])).toEqual([422, 'PREFERENCES_INVALID', 'QUIET_HOURS_INCOMPLETE']);
    expect(await refused([{ category: 'TRANSACTIONAL', channel: 'SMS', isEnabled: true, quietFrom: '21:00', quietTo: '07:00' }])).toEqual([422, 'PREFERENCES_INVALID', 'QUIET_HOURS_NOT_DELAYED']);
    expect((await put('kponeBuyer', '/me/notification-preferences', { preferences: [{ category: 'REMINDER', channel: 'SMS', isEnabled: true, quietFrom: '25:00', quietTo: '07:00' }] })).status).toBe(400);
    expect((await put('kponeBuyer', '/me/notification-preferences', { preferences: [], customerId: id('ada') })).status).toBe(400);
    expect(await get('kponeBuyer', '/me/notification-preferences').then((r) => r.body)).toEqual(replaced.body);
  });

  it("are each recipient's own: staff keep theirs on their sign-in, a sign-in with no customer record has none, nobody signed in is refused", async () => {
    expect(await get('manager', '/me/notification-preferences').then((r) => r.body)).toEqual({ preferences: [] });
    const mine = await put('manager', '/me/notification-preferences', { preferences: [{ category: 'OPERATIONAL', channel: 'IN_APP', isEnabled: true }] });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(await one('SELECT principal_id, customer_id FROM ntf.preference WHERE principal_id = $1 AND deleted_at IS NULL', [users.get('manager')!.principalId])).toEqual({ principal_id: users.get('manager')!.principalId, customer_id: null });
    expect((await get('kponeBuyer', '/me/notification-preferences')).body.preferences).toHaveLength(3);
    expect((await get('stranger', '/me/notification-preferences')).status).toBe(404);
    // A customer's sign-in is no staff session: the opt-out list and the triggers answer it 401.
    for (const path of ['/notifications/opt-outs', '/notification-triggers']) expect((await get('kponeBuyer', path)).status, path).toBe(401);
    expect((await request(api.server).get('/v1/me/notification-preferences')).status).toBe(401);
    expect((await request(api.server).put('/v1/me/notification-preferences').set('Idempotency-Key', randomUUID()).send({ preferences: [] })).status).toBe(401);
  });
});

describe('reminders: quiet hours, a STOP reply, a turned-off channel (FR-NTF-005, FR-NTF-006, the B11 continued 11 gate)', () => {
  it('a reminder due at 22:30 waits until 07:00 Africa/Accra and is sent then, once, to the customer\'s own number; one turned off is PREFERENCE_OFF', async () => {
    at(addDays(dueOn, 7), '22:30:00');
    await runDunning();
    await ntf.dispatch();
    const [waiting] = await remindersOf('asantewaa');
    expect(await remindersOf('asantewaa')).toHaveLength(1);
    expect(waiting).toMatchObject({
      code: 'PAYMENT_REMINDER_1',
      status: 'DEFERRED_QUIET_HOURS',
      channel: 'SMS',
      kind: 'CUSTOMER',
      masked: '+23324*****01',
      sendAfter: new Date(`${addDays(dueOn, 8)}T07:00:00Z`),
      body: `HaKorem Farms: dear Asantewaa Chop Bar (TEST), ${id('invoice:asantewaa')} for GHS 600.00 is now 7 days overdue. Please pay at your earliest convenience.`,
    });
    expect(await remindersOf('kpone')).toMatchObject([{ code: 'PAYMENT_REMINDER_1', status: 'SUPPRESSED', reason: 'PREFERENCE_OFF' }]);
    const listed = await get('manager', `/notifications/messages?customerId=${id('asantewaa')}`);
    expect(listed.body.data).toMatchObject([{ id: waiting!.id, status: 'DEFERRED_QUIET_HOURS', sendAfter: `${addDays(dueOn, 8)}T07:00:00.000Z`, category: 'REMINDER', addressMasked: '+23324*****01' }]);

    const before = sms.calls.length;
    expect((await send()).claimed).toBe(0);
    at(addDays(dueOn, 8), '06:59:59');
    expect((await send()).claimed).toBe(0);
    expect(sms.calls.length).toBe(before);
  });

  it('a STOP reply is an opt-out of SMS at once: listed with its source, applied once, and a forged one changes nothing', async () => {
    at(addDays(dueOn, 8), '05:00:00');
    const forged = JSON.stringify({ type: 'inbound', id: 'mo-forged', from: E164('0244100201'), text: 'STOP' });
    expect((await hook(forged, null)).status).toBe(401);
    expect((await hook(forged, signReport('not-the-secret-not-the-secret-xx', forged))).status).toBe(401);
    expect(await count('SELECT count(*) AS n FROM ntf.opt_out')).toBe(0);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ntf.DeliveryReportRejected' AND payload->'abuseCases' = '[57, 59]'")).toBe(2);

    expect((await reply(E164('0244100202'), ' Stop ', 'mo-ada-1')).status).toBe(200);
    expect((await reply(E164('0244100202'), 'STOP', 'mo-ada-1')).status).toBe(200);
    expect(await rows("SELECT direction, source, channel, address_masked AS masked FROM ntf.opt_out")).toEqual([{ direction: 'OPT_OUT', source: 'REPLY_STOP', channel: 'SMS', masked: '+23324*****02' }]);
    expect(await rows("SELECT outcome FROM ntf.provider_report WHERE report_key = 'mo-ada-1' ORDER BY recorded_at, id")).toEqual([{ outcome: 'APPLIED' }, { outcome: 'REPLAYED' }]);
    expect(JSON.stringify(await rows('SELECT * FROM ntf.opt_out'))).not.toContain('244100202');
    const listed = await get('manager', '/notifications/opt-outs');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toMatchObject([{ addressMasked: '+23324*****02', channel: 'SMS', direction: 'OPT_OUT', source: 'REPLY_STOP' }]);
    for (const who of ['accountant', 'sales', 'storekeeper', 'cashier']) expect((await get(who, '/notifications/opt-outs')).status, who).toBe(403);
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE ntf.opt_out SET direction = 'OPT_IN'"))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query("UPDATE ntf.opt_out SET direction = 'OPT_IN'"))).toBe(SQLSTATE.ledgerImmutable);
  });

  it("at 07:00 the waiting reminder goes to Asantewaa once; Ada's, queued before her STOP, is not sent", async () => {
    at(addDays(dueOn, 8), '07:00:00');
    const before = sms.calls.length;
    const pass = await send();
    expect(pass).toMatchObject({ sent: 1, suppressed: 1, deferred: 0 });
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([E164('0244100201')]);
    expect(await remindersOf('asantewaa')).toMatchObject([{ status: 'SENT', attempts: 1 }]);
    expect(await remindersOf('ada')).toMatchObject([{ code: 'PAYMENT_REMINDER_1', status: 'SUPPRESSED', reason: 'OPTED_OUT', attempts: 0 }]);
    expect((await send()).claimed).toBe(0);
    expect(sms.calls.length).toBe(before + 1);
  });

  it("the next reminder to an opted-out number is suppressed when queued; a customer's own quiet hours replace the default", async () => {
    const own = await put('kponeBuyer', '/me/notification-preferences', { preferences: [{ category: 'REMINDER', channel: 'SMS', isEnabled: true, quietFrom: '09:00', quietTo: '11:00' }] });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    at(addDays(dueOn, 14), '10:00:00');
    await runDunning();
    await ntf.dispatch();
    expect((await remindersOf('ada')).map((m) => [m.code, m.status, m.reason])).toEqual([
      ['PAYMENT_REMINDER_1', 'SUPPRESSED', 'OPTED_OUT'],
      ['PAYMENT_REMINDER_2', 'SUPPRESSED', 'OPTED_OUT'],
    ]);
    expect((await remindersOf('asantewaa')).map((m) => [m.code, m.status])).toEqual([['PAYMENT_REMINDER_1', 'SENT'], ['PAYMENT_REMINDER_2', 'QUEUED']]);
    expect((await remindersOf('kpone')).at(-1)).toMatchObject({ code: 'PAYMENT_REMINDER_2', status: 'DEFERRED_QUIET_HOURS', sendAfter: new Date(`${addDays(dueOn, 14)}T11:00:00Z`) });
    const before = sms.calls.length;
    await send();
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([E164('0244100201')]);
    at(addDays(dueOn, 14), '11:00:00');
    await send();
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([E164('0244100201'), E164('0244100203')]);
    // A suppressed reminder is never retried: an opt-out is never overridden.
    expect(codes(await post('manager', `/notifications/messages/${(await remindersOf('ada'))[1]!.id}/retry`, {}))).toEqual([422, 'MESSAGE_NOT_RETRYABLE', 'SUPPRESSED']);
  });

  it('a START reply opts the number back in: the next reminder is sent', async () => {
    at(addDays(dueOn, 20), '12:00:00');
    expect((await reply(E164('0244100202'), 'START')).status).toBe(200);
    expect((await get('owner', '/notifications/opt-outs')).body.data.map((o: { direction: string; source: string }) => `${o.direction}/${o.source}`)).toEqual(['OPT_IN/REPLY_START', 'OPT_OUT/REPLY_STOP']);
    at(addDays(dueOn, 30), '10:00:00');
    await runDunning();
    await ntf.dispatch();
    const before = sms.calls.length;
    await send();
    expect((await remindersOf('ada')).at(-1)).toMatchObject({ code: 'PAYMENT_REMINDER_3', status: 'SENT' });
    expect(sms.calls.slice(before).map((c) => c.to)).toContain(E164('0244100202'));
  });

  it("a reminder goes to the notice's own customer whoever an event names; an event for no notice sends nothing", async () => {
    const notice = (await one<{ id: string }>("SELECT n.id FROM whl.dunning_notice n WHERE n.customer_id = $1 AND n.level = 1", [id('asantewaa')])).id;
    const forged = await ntf.publish({ type: 'whl.DunningNoticeDue', subjectType: 'DunningNotice', subjectId: notice, branchId, payload: { noticeId: notice, customerId: id('ada'), templateCode: 'PAYMENT_REMINDER_3', channels: ['SMS'], outstandingPesewas: 1 } });
    const stranger = randomUUID();
    const none = await ntf.publish({ type: 'whl.DunningNoticeDue', subjectType: 'DunningNotice', subjectId: stranger, branchId, payload: { noticeId: stranger, customerId: id('ada') } });
    await ntf.dispatch();
    expect(await rows('SELECT m.customer_id AS customer, t.code, m.rendered_body AS body FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.source_event_ref = $1', [forged])).toEqual([
      { customer: id('asantewaa'), code: 'PAYMENT_REMINDER_1', body: expect.stringContaining('for GHS 600.00 is now 7 days overdue') },
    ]);
    expect(await count('SELECT count(*) AS n FROM ntf.message WHERE source_event_ref = $1', [none])).toBe(0);
    const before = sms.calls.length;
    await send();
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([E164('0244100201')]);
  });

  it('a transactional message is never stopped by an opt-out: an opted-out guest still gets the delivery message', async () => {
    expect((await reply('+233200000301', 'STOP')).status).toBe(200);
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-OPT' } });
    await ntf.dispatch();
    expect(await one('SELECT status, category, suppressed_reason AS reason FROM ntf.message WHERE source_event_ref = $1', [eventId])).toEqual({ status: 'QUEUED', category: 'TRANSACTIONAL', reason: null });
    const before = sms.calls.length;
    await send();
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual(['+233200000301']);
  });
});

describe('triggers (FR-NTF-002, listNotificationTriggers, updateNotificationTrigger)', () => {
  const cancelled = () => get('manager', '/notification-triggers?limit=100').then((r) => (r.body.data as { eventType: string; templateCode: string; id: string; version: number }[]).find((t) => t.templateCode === 'DELIVERY_CANCELLED')!);

  it('lists every message NTF sends with its recipient and channels, to those who read templates', async () => {
    const listed = await get('accountant', '/notification-triggers?limit=100');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data.map((t: { eventType: string; templateCode: string; recipientKind: string; channels: string[] }) => `${t.eventType}>${t.templateCode}>${t.recipientKind}>${t.channels.join('+')}`)).toEqual([
      'bil.DocumentSendRequested>DOCUMENT_SENT>CUSTOMER>SMS+WHATSAPP+EMAIL',
      'del.DeliveryCancelled>DELIVERY_CANCELLED>CONTACT_ON_EVENT>SMS',
      'del.DeliveryCompleted>DELIVERY_COMPLETED>CONTACT_ON_EVENT>SMS',
      'del.DeliveryCompleted>DELIVERY_PART_COMPLETED>CONTACT_ON_EVENT>SMS',
      'del.DeliveryOnTheWay>DELIVERY_ON_THE_WAY>CONTACT_ON_EVENT>SMS',
      'del.DeliveryRescheduled>DELIVERY_RESCHEDULED>CONTACT_ON_EVENT>SMS',
      'liv.MortalityReturned>MORTALITY_RETURNED>PRINCIPAL_ON_EVENT>IN_APP',
      'ord.OrderCollected>ORDER_COLLECTED>CONTACT_ON_EVENT>SMS',
      'ord.OrderCompleted>SALE_RECEIPT>CONTACT_ON_EVENT>SMS',
      'ord.OrderDispatched>ORDER_DISPATCHED>CONTACT_ON_EVENT>SMS',
      'ord.OrderPlaced>ORDER_TRACKING>CONTACT_ON_EVENT>SMS',
      'pur.SupplierRemittanceReady>REMITTANCE_ADVICE>SUPPLIER>SMS+EMAIL',
      'shp.CartAbandoned>CART_REMINDER>CUSTOMER>SMS',
      'whl.DunningNoticeDue>PAYMENT_REMINDER_1>CUSTOMER>SMS+WHATSAPP+EMAIL',
      'whl.DunningNoticeDue>PAYMENT_REMINDER_2>CUSTOMER>SMS+WHATSAPP+EMAIL',
      'whl.DunningNoticeDue>PAYMENT_REMINDER_3>CUSTOMER>SMS+WHATSAPP+EMAIL',
      'whl.StatementSendRequested>DOCUMENT_SENT>CUSTOMER>SMS+WHATSAPP+EMAIL',
    ]);
    const paged = await get('sales', '/notification-triggers?limit=4');
    const next = await get('sales', `/notification-triggers?limit=4&cursor=${encodeURIComponent(paged.body.page.nextCursor as string)}`);
    expect([...paged.body.data, ...next.body.data].map((t: { id: string }) => t.id)).toEqual(listed.body.data.slice(0, 8).map((t: { id: string }) => t.id));
    for (const who of ['storekeeper', 'cashier']) expect((await get(who, '/notification-triggers')).status, who).toBe(403);
  });

  it('turned off, a trigger queues nothing new and leaves every message already made; its rules are held', async () => {
    const trigger = await cancelled();
    const madeBefore = await count("SELECT count(*) AS n FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE t.code = 'DELIVERY_CANCELLED'");
    expect(madeBefore).toBeGreaterThan(0);
    expect((await patch('sales', `/notification-triggers/${trigger.id}`, { version: trigger.version, isActive: false })).status).toBe(403);
    expect(codes(await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version, channels: ['IN_APP'] }))).toEqual([422, 'TRIGGER_INVALID', 'CHANNEL_NOT_FOR_RECIPIENT']);
    expect(codes(await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version, templateCode: 'DELIVERY_COMPLETED' }))).toEqual([422, 'TRIGGER_INVALID', 'TEMPLATE_FIXED']);
    expect(codes(await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version, channels: [] }))).toEqual([422, 'TRIGGER_INVALID', 'NO_CHANNEL']);
    expect((await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version + 5, isActive: false })).status).toBe(409);
    const key = randomUUID();
    const off = await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version, isActive: false }, key);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body).toMatchObject({ id: trigger.id, isActive: false, version: trigger.version + 1, channels: ['SMS'] });
    expect((await patch('manager', `/notification-triggers/${trigger.id}`, { version: trigger.version, isActive: false }, key)).body).toEqual(off.body);
    expect(await count("SELECT count(*) AS n FROM platform.audit_event WHERE entity_type = 'NotificationTrigger' AND entity_id = $1", [trigger.id])).toBe(1);

    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-OFF' } });
    await ntf.dispatch();
    expect(await count('SELECT count(*) AS n FROM ntf.message WHERE source_event_ref = $1', [eventId])).toBe(0);
    expect(await count("SELECT count(*) AS n FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE t.code = 'DELIVERY_CANCELLED'")).toBe(madeBefore);

    // Back on, by email first: there is no email adapter yet, so the message fails visibly rather than vanishing.
    const on = await patch('manager', `/notification-triggers/${trigger.id}`, { version: off.body.version, isActive: true, channels: ['EMAIL'] });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await admin().query("INSERT INTO ntf.template (id, code, channel, locale, category, subject, body, version_no, status, created_at, created_by, updated_at, updated_by) VALUES ($1, 'DELIVERY_CANCELLED', 'EMAIL', 'en-GH', 'TRANSACTIONAL', 'Delivery cancelled', 'Delivery {{deliveryNo}} cancelled.', 1, 'ACTIVE', now(), $2, now(), $2)", [randomUUID(), SYSTEM_PRINCIPAL]);
    const emailed = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-MAIL' } });
    await ntf.dispatch();
    await send();
    expect(await one('SELECT channel, status, failure_reason AS reason FROM ntf.message WHERE source_event_ref = $1', [emailed])).toEqual({ channel: 'EMAIL', status: 'FAILED', reason: 'no adapter sends EMAIL' });
    const restored = await patch('manager', `/notification-triggers/${trigger.id}`, { version: on.body.version, channels: ['SMS'] });
    expect(restored.body).toMatchObject({ isActive: true, channels: ['SMS'] });
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE ntf.trigger_rule SET channels = ARRAY['FAX'], version = version + 1 WHERE id = $1", [trigger.id]))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(app.query("UPDATE ntf.trigger_rule SET channels = ARRAY[]::text[], version = version + 1 WHERE id = $1", [trigger.id]))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(app.query('DELETE FROM ntf.trigger_rule WHERE id = $1', [trigger.id]))).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe('the database holds the new rules (migration 0338)', () => {
  it('refuses a deferred message without its time, quiet hours on a transactional preference, and two recipients on one preference', async () => {
    const app = database.pool('app');
    const template = (await one<{ id: string }>("SELECT id FROM ntf.template WHERE code = 'PAYMENT_REMINDER_1' AND status = 'ACTIVE'")).id;
    const deferred = app.query(
      `INSERT INTO ntf.message (id, idempotency_key, source_event_ref, source_event_type, template_id, channel, category, recipient_kind, customer_id, address_masked, rendered_body, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, 'whl.DunningNoticeDue', $4, 'SMS', 'REMINDER', 'CUSTOMER', $5, 'x', 'x', 'DEFERRED_QUIET_HOURS', now(), $6, now(), $6)`,
      [randomUUID(), randomUUID(), randomUUID(), template, id('ada'), SYSTEM_PRINCIPAL],
    );
    expect(await sqlStateOf(deferred)).toBe(SQLSTATE.documentFrozen);
    const preference = (category: string, quiet: boolean, principal: string | null) =>
      app.query(
        `INSERT INTO ntf.preference (id, customer_id, principal_id, category, channel, rank, is_enabled, quiet_from, quiet_to, created_at, created_by, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, 'SMS', 1, true, $5::time, $6::time, now(), $7, now(), $7)`,
        [randomUUID(), id('ada'), principal, category, quiet ? '21:00' : null, quiet ? '07:00' : null, SYSTEM_PRINCIPAL],
      );
    expect(await sqlStateOf(preference('TRANSACTIONAL', true, null))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(preference('REMINDER', false, SYSTEM_PRINCIPAL))).toBe(SQLSTATE.checkViolation);
  });
});
