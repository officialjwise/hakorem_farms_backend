import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, signReport, type NtfHarness } from '../../support/ntf';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Message templates by version (FR-NTF-001, the owner 2026-11-23: listed so a reminder level picks one), with two
 * people to each change and no link of a template's own (abuse case 57); and the provider's signed delivery reports
 * (FR-NTF-007), applied once and changing nothing but a message's delivery status. Over the seeded farm; the SMS
 * provider is a test double; the webhook secret is drawn for the run, never written down.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let branchId = '';
let orderId = '';
const WEBHOOK_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const rows = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows;
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const codes = (res: request.Response) => [res.status, res.body.error?.code, ...((res.body.error?.details ?? []) as { code: string }[]).map((d) => d.code)];
const hook = (provider: string, body: string, signature: string | null) => {
  const call = request(api.server).post(`/v1/webhooks/messaging/${provider}`).set('Content-Type', 'application/json');
  return (signature === null ? call : call.set('X-Provider-Signature', signature)).send(body);
};
const report = (messageId: string, reportId: string, status: string, extra: object = {}) => JSON.stringify({ type: 'delivery', id: reportId, reference: messageId, status, ...extra });

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { SMS_WEBHOOK_SECRET: WEBHOOK_SECRET } });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }, { tradingDay: true }));
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  orderId = (await one<{ id: string }>("SELECT id FROM ord.sales_order WHERE contact_phone_e164 = '+233200000301' LIMIT 1")).id;
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['cashier', 'Adwoa Darko', 'CASHIER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) sessions.set(key, await login(api.server, await createUser(database, { name, grants: [{ role, branchId }] })));
  for (const [key, name, role] of [['manager', 'Abena Owusu', 'MANAGER'], ['owner', 'Kwame Mensah', 'OWNER'], ['accountant', 'Esi Badu', 'ACCOUNTANT']] as const) {
    sessions.set(key, await enrolAndLogin(api.server, await createUser(database, { name, grants: [{ role, branchId }] }), () => clock.now()));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('message templates: listed, versioned, two people to each change, no link of their own (FR-NTF-001)', () => {
  let v1 = '';
  let v2 = '';
  const body = 'HaKorem Farms: order {{orderNo}} left the farm with {{items}}. Total {{total}}, pay on delivery {{codDue}}.';

  it('lists the seeded messages, one active version of each, for every role that reads templates and no other', async () => {
    const listed = await get('accountant', '/notification-templates?status=ACTIVE&limit=100');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    // The customer's messages (B11 continued 10), the payment reminders and the returned death report in the console (B11 continued 11).
    expect(listed.body.data.map((t: { code: string; channel: string; versionNo: number }) => `${t.code}/${t.channel}/${String(t.versionNo)}`).sort()).toEqual(
      [
        ...['DELIVERY_CANCELLED', 'DELIVERY_COMPLETED', 'DELIVERY_ON_THE_WAY', 'DELIVERY_PART_COMPLETED', 'DELIVERY_RESCHEDULED'].map((c) => `${c}/SMS/1`),
        'MORTALITY_RETURNED/IN_APP/1',
        ...['ORDER_COLLECTED', 'ORDER_DISPATCHED', 'PAYMENT_REMINDER_1', 'PAYMENT_REMINDER_2', 'PAYMENT_REMINDER_3'].map((c) => `${c}/SMS/1`),
      ],
    );
    v1 = listed.body.data.find((t: { code: string }) => t.code === 'ORDER_DISPATCHED').id as string;
    expect((await get('sales', `/notification-templates/${v1}`)).body).toMatchObject({ code: 'ORDER_DISPATCHED', category: 'TRANSACTIONAL', locale: 'en-GH', status: 'ACTIVE', subject: null });
    const paged = await get('owner', '/notification-templates?limit=2');
    expect(paged.body.page).toMatchObject({ limit: 2, hasMore: true });
    const next = await get('owner', `/notification-templates?limit=2&cursor=${encodeURIComponent(paged.body.page.nextCursor as string)}`);
    expect(next.body.data.map((t: { id: string }) => t.id)).not.toContain(paged.body.data[0].id);
    for (const who of ['storekeeper', 'cashier', 'driver']) {
      expect((await get(who, '/notification-templates')).status, who).toBe(403);
      expect((await get(who, `/notification-templates/${v1}`)).status, who).toBe(403);
    }
    expect((await get('owner', `/notification-templates/${randomUUID()}`)).status).toBe(404);
  });

  it('refuses a misspelt merge field, a link typed into the text, an unknown code and a subject on an SMS; the wrong roles cannot draft', async () => {
    const draft = { code: 'ORDER_DISPATCHED', channel: 'SMS', category: 'TRANSACTIONAL', body };
    expect(codes(await post('manager', '/notification-templates', { ...draft, body: 'Total {{totl}}' }))).toEqual([422, 'TEMPLATE_INVALID', 'UNKNOWN_MERGE_FIELD']);
    expect(codes(await post('manager', '/notification-templates', { ...draft, body: 'Pay now at https://hakorem-pay.example {{total}}' }))).toEqual([422, 'TEMPLATE_INVALID', 'LINK_NOT_ALLOWED']);
    expect(codes(await post('manager', '/notification-templates', { ...draft, code: 'PAY_HERE' }))).toEqual([422, 'TEMPLATE_INVALID', 'UNKNOWN_TEMPLATE_CODE']);
    expect(codes(await post('manager', '/notification-templates', { ...draft, subject: 'Your order' }))).toEqual([422, 'TEMPLATE_INVALID', 'SUBJECT_EMAIL_ONLY']);
    expect((await post('manager', '/notification-templates', { ...draft, extra: 1 })).status).toBe(400);
    for (const who of ['sales', 'accountant', 'storekeeper', 'cashier', 'driver']) expect((await post(who, '/notification-templates', draft)).status, who).toBe(403);
    expect(await count("SELECT count(*) AS n FROM ntf.template WHERE code = 'ORDER_DISPATCHED'")).toBe(1);
  });

  it('drafts version 2, previews it, and only another person activates it, retiring version 1; messages already made keep version 1', async () => {
    const eventBefore = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-T1' } });
    const key = randomUUID();
    const drafted = await post('manager', '/notification-templates', { code: 'ORDER_DISPATCHED', channel: 'SMS', category: 'TRANSACTIONAL', body }, key);
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body).toMatchObject({ versionNo: 2, status: 'DRAFT', locale: 'en-GH', body });
    expect((await post('manager', '/notification-templates', { code: 'ORDER_DISPATCHED', channel: 'SMS', category: 'TRANSACTIONAL', body }, key)).body).toEqual(drafted.body);
    v2 = drafted.body.id as string;

    const shown = await post('sales', `/notification-templates/${v2}/preview`, { data: { orderNo: 'SO-2026-000777', total: 'GHS 1,379.00' } });
    expect(shown.status, JSON.stringify(shown.body)).toBe(200);
    expect(shown.body).toEqual({ subject: null, body: 'HaKorem Farms: order SO-2026-000777 left the farm with 1 Eggs, big (crate of 30). Total GHS 1,379.00, pay on delivery GHS 940.00.', characterCount: 129, smsSegments: 1 });
    expect(codes(await post('sales', `/notification-templates/${v2}/preview`, { data: { totl: '1' } }))).toEqual([422, 'TEMPLATE_INVALID', 'UNKNOWN_MERGE_FIELD']);
    expect((await post('driver', `/notification-templates/${v2}/preview`, { data: {} })).status).toBe(403);

    expect(codes(await post('manager', `/notification-templates/${v2}/activate`, {}))).toEqual([422, 'TEMPLATE_NOT_ACTIVATABLE', 'OWN_DRAFT']);
    expect((await post('sales', `/notification-templates/${v2}/activate`, {})).status).toBe(403);
    const activated = await post('owner', `/notification-templates/${v2}/activate`, {});
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body).toMatchObject({ id: v2, status: 'ACTIVE' });
    expect(codes(await post('owner', `/notification-templates/${v2}/activate`, {}))).toEqual([422, 'TEMPLATE_NOT_ACTIVATABLE', 'NOT_DRAFT']);
    expect(await rows("SELECT version_no, status FROM ntf.template WHERE code = 'ORDER_DISPATCHED' ORDER BY version_no")).toEqual([
      { version_no: 1, status: 'RETIRED' },
      { version_no: 2, status: 'ACTIVE' },
    ]);
    expect(await one("SELECT convert_from(after, 'UTF8')::jsonb->>'body' AS body, convert_from(after, 'UTF8')::jsonb->>'draftedBy' IS NOT NULL AS named FROM platform.audit_event WHERE entity_type = 'NotificationTemplate' AND action = 'ACTIVATE' AND entity_id = $1", [v2])).toEqual({ body, named: true });

    await ntf.dispatch();
    const kept = await one<{ template_id: string }>('SELECT template_id FROM ntf.message WHERE source_event_ref = $1', [eventBefore]);
    const dispatched = await ntf.publish({ type: 'ord.OrderDispatched', subjectType: 'SalesOrder', subjectId: orderId, branchId, payload: { orderId, deliveryNo: 'DLV-T2', finalTotalPesewas: 137_900, codDuePesewas: 0, dueDate: null, backorderNo: null, bookedSlotId: null, lines: [{ name: 'Goat meat', quantity: '1.000', uom: 'KG', weightKg: '2.350' }] } });
    await ntf.dispatch();
    expect(await one('SELECT template_id, rendered_body AS body FROM ntf.message WHERE source_event_ref = $1', [dispatched])).toEqual({
      template_id: v2,
      body: `HaKorem Farms: order ${(await one<{ order_no: string }>('SELECT order_no FROM ord.sales_order WHERE id = $1', [orderId])).order_no} left the farm with 2.350 kg Goat meat. Total GHS 1,379.00, pay on delivery GHS 0.00.`,
    });
    expect(kept.template_id).not.toBe(v2);
    expect((await one<{ body: string }>('SELECT body FROM ntf.template WHERE id = $1', [v1])).body).toContain('is on its way');
  });

  it('the database holds a version\'s text, its order of states and the second person', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query("UPDATE ntf.template SET body = 'Pay to 0559999999', version = version + 1 WHERE id = $1", [v2]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE ntf.template SET status = 'ACTIVE', version = version + 1 WHERE id = $1", [v1]))).toBe(SQLSTATE.documentFrozen);
    const drafted = await post('manager', '/notification-templates', { code: 'DELIVERY_CANCELLED', channel: 'SMS', category: 'TRANSACTIONAL', body: 'Delivery {{deliveryNo}} cancelled.' });
    const drafter = (await one<{ created_by: string }>('SELECT created_by FROM ntf.template WHERE id = $1', [drafted.body.id])).created_by;
    expect(
      await sqlStateOf(app.query("UPDATE ntf.template SET status = 'ACTIVE', activated_at = now(), activated_by = $2, version = version + 1 WHERE id = $1", [drafted.body.id, drafter])),
    ).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(app.query("UPDATE ntf.template SET status = 'ACTIVE', version = version + 1 WHERE id = $1", [drafted.body.id]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('DELETE FROM ntf.template WHERE id = $1', [v1]))).toBe(SQLSTATE.insufficientPrivilege);
  });
});

describe("the provider's delivery reports: signed, applied once, changing nothing but the delivery status (FR-NTF-007, abuse case 57)", () => {
  let sent = '';

  beforeAll(async () => {
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-R1' } });
    await ntf.dispatch();
    sent = (await one<{ id: string }>('SELECT id FROM ntf.message WHERE source_event_ref = $1', [eventId])).id;
    await ntf.sender(new FakeSms()).run(SCHEDULER);
    expect(await one('SELECT status FROM ntf.message WHERE id = $1', [sent])).toEqual({ status: 'SENT' });
  });

  it('refuses a report without the provider\'s signature, logs it and publishes it for the exception report; nothing changes', async () => {
    const forged = report(sent, 'dlr-forged', 'FAILED');
    expect((await hook('GENERIC_HTTP', forged, null)).status).toBe(401);
    expect((await hook('GENERIC_HTTP', forged, signReport('not-the-secret-not-the-secret-xx', forged))).status).toBe(401);
    expect((await hook('GENERIC_HTTP', forged, 'zz')).status).toBe(401);
    expect(await one('SELECT status FROM ntf.message WHERE id = $1', [sent])).toEqual({ status: 'SENT' });
    expect(await count("SELECT count(*) AS n FROM ntf.provider_report WHERE outcome = 'REJECTED_SIGNATURE'")).toBe(3);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ntf.DeliveryReportRejected' AND payload->'abuseCases' = '[57, 59]'")).toBe(3);
    expect((await hook('HUBTEL', forged, signReport(WEBHOOK_SECRET, forged))).status).toBe(404);
    expect((await hook('SOMEONE', forged, signReport(WEBHOOK_SECRET, forged))).status).toBe(400);
  });

  it('applies a signed DELIVERED report once; a replay and a later FAILED report change nothing; only the status moves', async () => {
    const before = await one<Record<string, unknown>>('SELECT * FROM ntf.message WHERE id = $1', [sent]);
    const delivered = report(sent, 'dlr-1', 'DELIVERED', { to: '+233559999999', text: 'Pay to 0559999999', templateId: randomUUID() });
    const first = await hook('GENERIC_HTTP', delivered, signReport(WEBHOOK_SECRET, delivered));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ received: true });
    const after = await one<Record<string, unknown>>('SELECT * FROM ntf.message WHERE id = $1', [sent]);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k])).sort();
    expect(changed).toEqual(['delivered_at', 'status', 'updated_at', 'updated_by', 'version']);
    expect(after['status']).toBe('DELIVERED');
    expect((await hook('GENERIC_HTTP', delivered, signReport(WEBHOOK_SECRET, delivered))).status).toBe(200);
    const late = report(sent, 'dlr-2', 'UNDELIVERED');
    expect((await hook('GENERIC_HTTP', late, signReport(WEBHOOK_SECRET, late))).status).toBe(200);
    expect(await one('SELECT status FROM ntf.message WHERE id = $1', [sent])).toEqual({ status: 'DELIVERED' });
    expect(await rows("SELECT report_key, outcome FROM ntf.provider_report WHERE report_key IS NOT NULL ORDER BY recorded_at, id")).toEqual([
      { report_key: 'dlr-1', outcome: 'APPLIED' },
      { report_key: 'dlr-1', outcome: 'REPLAYED' },
      { report_key: 'dlr-2', outcome: 'NO_CHANGE' },
    ]);
    const listed = await get('manager', `/notifications/messages/${sent}`);
    expect(listed.body).toMatchObject({ status: 'DELIVERED', addressMasked: '+23320*****01' });
    expect(listed.body.deliveredAt).not.toBeNull();
  });

  it('an UNDELIVERED report fails a sent message, which then shows as FAILED; an unknown message, a reply that is no instruction and a body it cannot read are logged and acknowledged', async () => {
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: orderId, branchId, payload: { orderDocumentId: orderId, deliveryNo: 'DLV-R2' } });
    await ntf.dispatch();
    const second = (await one<{ id: string }>('SELECT id FROM ntf.message WHERE source_event_ref = $1', [eventId])).id;
    await ntf.sender(new FakeSms()).run(SCHEDULER);
    const failed = report(second, 'dlr-3', 'UNDELIVERED');
    expect((await hook('GENERIC_HTTP', failed, signReport(WEBHOOK_SECRET, failed))).status).toBe(200);
    expect(await one('SELECT status, failure_reason AS reason FROM ntf.message WHERE id = $1', [second])).toEqual({ status: 'FAILED', reason: 'reported undelivered by the provider' });
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ntf.MessageFailed' AND subject_id = $1", [second])).toBe(1);
    expect((await get('manager', '/notifications/messages?status=FAILED')).body.data.map((m: { id: string }) => m.id)).toEqual([second]);

    const unknown = report(randomUUID(), 'dlr-4', 'DELIVERED');
    // A reply that is no instruction (a STOP is an opt-out at once since B11 continued 11: ntf/preferences-and-opt-outs).
    const reply = JSON.stringify({ type: 'inbound', id: 'mo-1', from: '+233200000301', text: 'Thank you' });
    const garbled = '{"type": "delivery", "id": 7}';
    for (const raw of [unknown, reply, garbled]) expect((await hook('GENERIC_HTTP', raw, signReport(WEBHOOK_SECRET, raw))).status, raw).toBe(200);
    expect((await hook('GENERIC_HTTP', 'not json', signReport(WEBHOOK_SECRET, 'not json'))).status).toBe(400);
    expect(await rows("SELECT outcome FROM ntf.provider_report WHERE outcome IN ('UNKNOWN_MESSAGE', 'IGNORED', 'REJECTED_MALFORMED') ORDER BY recorded_at, id")).toEqual([
      { outcome: 'UNKNOWN_MESSAGE' },
      { outcome: 'IGNORED' },
      { outcome: 'REJECTED_MALFORMED' },
    ]);
    expect(JSON.stringify(await rows('SELECT * FROM ntf.provider_report'))).not.toContain('200000301');
  });

  it('the report log is insert only', async () => {
    expect(await sqlStateOf(database.pool('app').query("UPDATE ntf.provider_report SET outcome = 'APPLIED'"))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query("UPDATE ntf.provider_report SET outcome = 'APPLIED'"))).toBe(SQLSTATE.ledgerImmutable);
  });
});
