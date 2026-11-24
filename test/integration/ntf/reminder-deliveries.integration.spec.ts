import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dunning } from '../../../src/modules/whl';
import { runAsSystem, type Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestSession, type TestUser } from '../../support/iam';
import { FakeEmail, FakeSms, ntfHarness, SCHEDULER, signReport, type NtfHarness } from '../../support/ntf';
import { issueInvoice } from '../../support/pay';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Each payment reminder's delivery, per channel, on its dunning notice (B11 continued 13; the owner, 2026-11-23, from the
 * frontend's F12 and F10n; the gate: a failed reminder shows as failed on its channel). WHL's dunning job queues a
 * notice, NTF sends the reminder and records each outcome on the notice through WHL in the same transaction: sent when
 * the provider took it, delivered or failed as a signed delivery report says, failed when every attempt failed. The SMS
 * and email providers are test doubles. Every figure is read by SQL and through `listDunningNotices`.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let branchId = '';
let dueOn = '';
const WEBHOOK_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const at = (date: string, time: string) => clock.set(new Date(`${date}T${time}Z`));
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const runDunning = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(Dunning).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));
const report = (messageId: string, status: 'DELIVERED' | 'FAILED') => {
  const body = JSON.stringify({ type: 'delivery', id: `dlr-${randomUUID()}`, reference: messageId, status });
  return request(api.server).post('/v1/webhooks/messaging/GENERIC_HTTP').set('Content-Type', 'application/json').set('X-Provider-Signature', signReport(WEBHOOK_SECRET, body)).send(body);
};
const noticesOf = async (customer: string) => (await get('accountant', `/dunning-notices?customerId=${id(customer)}`)).body.data as { id: string; level: number; deliveries: { channel: string; status: string; at: string }[] }[];
const messageOf = async (noticeId: string) => (await admin().query<{ id: string; status: string; channel: string; attempts: number }>('SELECT id, status, channel, attempts FROM ntf.message WHERE record_id = $1', [noticeId])).rows;

/** Two business customers at Dodowa with their own numbers and an account each; Efua has an email too. */
const CUSTOMERS = [
  ['adjoa', 'Adjoa Provisions (TEST)', '0244100401'],
  ['efua', 'Efua Cold Store (TEST)', '0244100402'],
] as const;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const long = String(90 * 86_400);
  api = await startTestApp(database, { clock, environment: { SMS_WEBHOOK_SECRET: WEBHOOK_SECRET, AUTH_ACCESS_TTL_SECONDS: long, AUTH_STAFF_REFRESH_IDLE_SECONDS: long, AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS: long } });
  ntf = ntfHarness(api.app, database, clock);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  ids.set('goat', (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).rows[0]!.id);
  const staff: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwame Mensah', 'OWNER', true],
    ['manager', 'Abena Owusu', 'MANAGER', true],
    ['accountant', 'Esi Badu', 'ACCOUNTANT', true],
    ['sales', 'Kojo Antwi', 'SALES', false],
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
    await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: created.body.id as string, productId: id('goat') }, 60_000n, dueOn);
  }
  await admin().query('UPDATE mdm.customer SET email = $2, version = version + 1 WHERE id = $1', [id('efua'), 'accounts@efuacoldstore.example']);
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("a reminder's delivery is recorded on its notice per channel, and a failed one shows as failed (the gate)", () => {
  it('shows nothing until NTF tries it, then SENT, then DELIVERED as the signed report says', async () => {
    at(addDays(dueOn, 7), '10:00:00');
    await runDunning();
    const [notice] = await noticesOf('adjoa');
    expect(notice).toMatchObject({ level: 1, deliveries: [] });
    await ntf.dispatch();
    expect((await noticesOf('adjoa'))[0]!.deliveries).toEqual([]);

    const sms = new FakeSms();
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBeGreaterThanOrEqual(1);
    const [message] = await messageOf(notice!.id);
    expect(message).toMatchObject({ status: 'SENT', channel: 'SMS' });
    expect((await noticesOf('adjoa'))[0]!.deliveries).toEqual([{ channel: 'SMS', status: 'SENT', at: clock.now().toISOString() }]);

    clock.advanceBy(90_000);
    expect((await report(message!.id, 'DELIVERED')).status).toBe(200);
    expect((await noticesOf('adjoa'))[0]!.deliveries).toEqual([{ channel: 'SMS', status: 'DELIVERED', at: clock.now().toISOString() }]);
    // The notice's whole history is kept, insert-only, once per message and status.
    const { rows } = await admin().query<{ status: string }>('SELECT status FROM whl.dunning_notice_delivery WHERE dunning_notice_id = $1 ORDER BY occurred_at', [notice!.id]);
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'DELIVERED']);
  });

  it('shows FAILED when every attempt failed, and when the provider reports a sent one undelivered', async () => {
    const [efua] = await noticesOf('efua');
    const [message] = await messageOf(efua!.id);
    expect(message!.status).toBe('SENT');
    // Efua's level-1 reminder was sent with Adjoa's; the provider now reports it undelivered.
    clock.advanceBy(60_000);
    expect((await report(message!.id, 'FAILED')).status).toBe(200);
    expect((await noticesOf('efua'))[0]!.deliveries).toEqual([{ channel: 'SMS', status: 'FAILED', at: clock.now().toISOString() }]);

    // Level 2 for both, a fortnight in: Adjoa's fails three times; nothing on its notice says sent.
    at(addDays(dueOn, 14), '10:00:00');
    await runDunning();
    await ntf.dispatch();
    const sms = new FakeSms();
    sms.failNext('TEMPORARY', 6);
    for (let pass = 0; pass < 3; pass++) {
      await ntf.sender(sms).run(SCHEDULER);
      clock.advanceBy(16 * 60_000);
    }
    const level2 = (await noticesOf('adjoa')).find((n) => n.level === 2)!;
    const [failed] = await messageOf(level2.id);
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(level2.deliveries).toEqual([{ channel: 'SMS', status: 'FAILED', at: expect.any(String) }]);
    // Level 1 still shows what became of it.
    expect((await noticesOf('adjoa')).find((n) => n.level === 1)!.deliveries).toEqual([expect.objectContaining({ status: 'DELIVERED' })]);

    // Retried by the Manager and sent at last: the notice then shows it sent on SMS.
    expect((await post('manager', `/notifications/messages/${failed!.id}/retry`, {})).status).toBe(200);
    await ntf.sender(new FakeSms()).run(SCHEDULER);
    expect((await noticesOf('adjoa')).find((n) => n.level === 2)!.deliveries).toEqual([{ channel: 'SMS', status: 'SENT', at: clock.now().toISOString() }]);
  });

  it('records each channel on its own: an email reminder with no adapter fails visibly on EMAIL, one with the fake is sent', async () => {
    // An email reminder needs an email template; the seeded reminders have SMS ones only, so a manager drafts one and
    // another person activates it. Then level 3 goes by email alone.
    const draft = await post('manager', '/notification-templates', { code: 'PAYMENT_REMINDER_3', channel: 'EMAIL', category: 'REMINDER', subject: 'Payment reminder', body: 'Dear {{customerName}}, {{documentNo}} for {{outstanding}} is {{daysPastDue}} days overdue.' });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect((await post('owner', `/notification-templates/${draft.body.id}/activate`, {})).status).toBe(200);
    const levels = [
      { level: 1, daysOverdue: 7, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_1' },
      { level: 2, daysOverdue: 14, channels: ['SMS'], templateCode: 'PAYMENT_REMINDER_2' },
      { level: 3, daysOverdue: 30, channels: ['EMAIL'], templateCode: 'PAYMENT_REMINDER_3' },
    ];
    const replaced = await consolePut(api.server, as('manager'), '/v1/dunning-policy').send({ levels });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    at(addDays(dueOn, 30), '10:00:00');
    await runDunning();
    await ntf.dispatch();
    const level3 = (await noticesOf('efua')).find((n) => n.level === 3)!;
    const [queued] = await messageOf(level3.id);
    expect(queued).toMatchObject({ channel: 'EMAIL' });
    expect((await ntf.sender(new FakeSms()).run(SCHEDULER)).failed).toBeGreaterThanOrEqual(1);
    expect((await noticesOf('efua')).find((n) => n.level === 3)!.deliveries).toEqual([{ channel: 'EMAIL', status: 'FAILED', at: expect.any(String) }]);
    expect((await post('manager', `/notifications/messages/${queued!.id}/retry`, {})).status).toBe(200);
    const email = new FakeEmail();
    await ntf.sender(new FakeSms(), () => 0, [email]).run(SCHEDULER);
    expect(email.calls.map((c) => c.to)).toEqual(['accounts@efuacoldstore.example']);
    expect((await noticesOf('efua')).find((n) => n.level === 3)!.deliveries).toEqual([{ channel: 'EMAIL', status: 'SENT', at: clock.now().toISOString() }]);
  });

  it('the database holds a delivery insert-only and once per message and status', async () => {
    const { rows } = await admin().query<{ id: string; dunning_notice_id: string; message_ref: string; actor_id: string; status: string }>('SELECT id, dunning_notice_id, message_ref, actor_id, status FROM whl.dunning_notice_delivery LIMIT 1');
    const row = rows[0]!;
    const insert = (status: string, message: string) =>
      database.pool('app').query('INSERT INTO whl.dunning_notice_delivery (id, dunning_notice_id, channel, status, message_ref, occurred_at, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, $6, $6, $7)', [randomUUID(), row.dunning_notice_id, 'SMS', status, message, clock.now(), row.actor_id]);
    expect(await sqlStateOf(insert(row.status, row.message_ref))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(insert('READ', randomUUID()))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(database.pool('app').query("UPDATE whl.dunning_notice_delivery SET status = 'DELIVERED' WHERE id = $1", [row.id]))).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query('DELETE FROM whl.dunning_notice_delivery WHERE id = $1', [row.id]))).toBe('HK001');
  });
});
