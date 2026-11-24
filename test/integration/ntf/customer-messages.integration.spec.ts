import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, formatCedis, ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { FakeSms, ntfHarness, SCHEDULER, type NtfHarness } from '../../support/ntf';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, TEST_SECRETS, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The customer's messages through the outbox (FR-ORD-011, FR-DEL-003, FR-DEL-012, FR-NTF-003, FR-NTF-007), the B11
 * continued 10 gate, over the seeded farm: a guest's crate of eggs dispatched, on the way and delivered sends one SMS at
 * each step, to the order's own contact and no one else; the collected, rescheduled, cancelled and part-delivered
 * messages from their events; each exactly once under a redelivered event, a replayed handler, two workers at once and a
 * worker that died mid-send; a failed message shows as FAILED with its attempts and can be retried. The provider is a
 * test double (no network, no key). Every figure is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let ntf: NtfHarness;
let branchId = '';
let today = '';
const nextId = () => createUuidV7Generator(clock)();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const sessions = new Map<string, TestSession>();
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const post = (who: string, path: string, body: object, key = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const rows = async <T extends object>(sql: string, params: unknown[] = []) => (await admin().query<T & Record<string, unknown>>(sql, params)).rows;
const one = async <T extends object>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0]!;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const codes = (res: request.Response) => [res.status, res.body.error?.code, ...((res.body.error?.details ?? []) as { code: string }[]).map((d) => d.code)];
const messagesOf = (orderId: string) =>
  rows<{ id: string; code: string; status: string; body: string; masked: string; attempts: number; kind: string; reason: string | null }>(
    `SELECT m.id, t.code, m.status, m.rendered_body AS body, m.address_masked AS masked, m.attempts, m.recipient_kind AS kind, m.suppressed_reason AS reason
       FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.sales_order_id = $1 ORDER BY m.created_at, m.id`,
    [orderId],
  );

const dodowa = { recipientName: 'Ama Serwaa Ofori', recipientPhone: '0244512876', line1: 'Two houses after the Presby church', area: 'Dodowa', city: 'Dodowa', region: 'Greater Accra' };
const photo = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);
/** The guest's own number, as the checkout took it: the order's contact. */
const GUEST_PHONE = '+233201234567';

/** A guest's order of one crate of big eggs on cash on delivery, picked, packed and dispatched onto VAN1 to the driver. */
async function dispatchedCrate(): Promise<{ readonly orderId: string; readonly deliveryId: string; readonly due: number }> {
  const created = await request(api.server).post('/v1/shop/carts').set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID());
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-hk_guest='))!.split(';')[0]!;
  const cartId = created.body.id as string;
  const guest = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).set('Cookie', cookie).send(body);
  expect((await guest(`/shop/carts/${cartId}/lines`, { productId: id('EGG-0003'), quantity: '1.000' })).status).toBe(200);
  const started = await guest(`/shop/carts/${cartId}/checkout`, { contactName: 'Kofi Boateng', contactPhone: '0201234567', fulfilmentMode: 'DELIVERY', address: dodowa, paymentTerms: 'COD' });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const placed = await guest(`/shop/checkouts/${started.body.id as string}/place`, { paymentMethod: 'COD' });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.orderId as string;
  const made = await post('storekeeper', `/orders/${orderId}/fulfilments`, { pickLocationId: id('location:SHOP') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const lineId = (await get('manager', `/orders/${orderId}`)).body.lines[0].id as string;
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/picks`, { picks: [{ id: nextId(), orderLineId: lineId, stockUnitId: id('lot:EGG-0003'), qty: '1.000' }] })).status).toBe(200);
  expect((await post('storekeeper', `/fulfilments/${made.body.id as string}/pack`, { packageCount: 1 })).status).toBe(200);
  const sent = await post('manager', `/fulfilments/${made.body.id as string}/dispatch`, { driverId: id('driver'), vehicleLocationId: id('location:VAN1') });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const delivery = (await get('manager', `/deliveries?orderId=${orderId}`)).body.data[0];
  return { orderId, deliveryId: delivery.id as string, due: delivery.codDuePesewas as number };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  today = toBusinessDate(clock.now());
  await relaxRateLimits(database);
  for (const key of ['rate_limit.public.per_address_1m', 'rate_limit.checkout.per_address_10m']) {
    await database.pool('app').query(
      `INSERT INTO platform.setting (id, key, value, value_type, valid_from, description, created_by, updated_by)
       VALUES ($1, $2, '100000', 'INTEGER', now() - interval '1 day', 'Raised for a test file', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')`,
      [randomUUID(), key],
    );
  }
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  ntf = ntfHarness(api.app, database, clock, TEST_SECRETS['LOOKUP_HMAC_KEY']!);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>('SELECT sku AS code, id FROM mdm.product')) ids.set(row.code, row.id);
  branchId = (await one<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).id;
  for (const row of await rows<{ code: string; id: string }>('SELECT l.code, l.id FROM mdm.location l WHERE l.branch_id = $1', [branchId])) ids.set(`location:${row.code}`, row.id);
  ids.set('lot:EGG-0003', (await one<{ id: string }>("SELECT u.id FROM inv.stock_unit u JOIN mdm.product p ON p.id = u.product_id WHERE p.sku = 'EGG-0003' AND u.tracking = 'LOT'")).id);
  const staff: [string, string, RoleCode][] = [
    ['storekeeper', 'Yaw Boateng', 'STOREKEEPER'],
    ['sales', 'Kojo Antwi', 'SALES'],
    ['driver', 'Kwabena Asare', 'DRIVER'],
  ];
  for (const [key, name, role] of staff) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    ids.set(key, user.principalId);
    sessions.set(key, await login(api.server, user));
  }
  const manager = await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe("the customer's messages, each sent once, only to the order's own contact (the B11 continued 10 gate)", () => {
  let crate: { readonly orderId: string; readonly deliveryId: string; readonly due: number };
  const sms = new FakeSms();

  beforeAll(async () => {
    crate = await dispatchedCrate();
  });

  it('dispatch queues one ORDER_DISPATCHED message with the goods and the final total, to the order\'s contact, sent once', async () => {
    expect(await messagesOf(crate.orderId)).toEqual([]);
    await ntf.dispatch();
    const event = await one<{ id: string; payload: { orderNo: string; deliveryNo: string; finalTotalPesewas: number; codDuePesewas: number; lines: { name: string }[] } }>(
      "SELECT id, payload FROM platform.outbox_message WHERE event_type = 'ord.OrderDispatched' AND subject_id = $1",
      [crate.orderId],
    );
    const p = event.payload;
    const [message] = await messagesOf(crate.orderId);
    expect(await messagesOf(crate.orderId)).toHaveLength(1);
    expect(message).toMatchObject({
      code: 'ORDER_DISPATCHED',
      status: 'QUEUED',
      kind: 'CONTACT',
      masked: '+23320*****67',
      attempts: 0,
      body: `HaKorem Farms: order ${p.orderNo} is on its way (${p.deliveryNo}): 1 ${p.lines[0]!.name}. Total ${formatCedis(BigInt(p.finalTotalPesewas))}, to pay on delivery ${formatCedis(BigInt(p.codDuePesewas))}.`,
    });
    expect(p.codDuePesewas).toBe(crate.due);
    expect(await one<{ ref: string; key: string }>('SELECT source_event_ref AS ref, idempotency_key AS key FROM ntf.message WHERE id = $1', [message!.id])).toEqual({ ref: event.id, key: `${event.id}:ORDER_DISPATCHED:SMS:${crate.orderId}` });

    expect(await ntf.sender(sms).run(SCHEDULER)).toEqual({ claimed: 1, sent: 1, retrying: 0, failed: 0, suppressed: 0, circuitOpen: false });
    expect(sms.calls).toEqual([{ to: GUEST_PHONE, text: message!.body, idempotencyKey: message!.id }]);
    expect(await one('SELECT status, attempts, provider_message_ref AS ref FROM ntf.message WHERE id = $1', [message!.id])).toEqual({ status: 'SENT', attempts: 1, ref: `fake-${message!.id}` });
    expect(await rows('SELECT attempt_no, outcome FROM ntf.message_attempt WHERE message_id = $1', [message!.id])).toEqual([{ attempt_no: 1, outcome: 'ACCEPTED' }]);
    expect((await ntf.sender(sms).run(SCHEDULER)).claimed).toBe(0);
    expect(sms.calls).toHaveLength(1);
  });

  it('a redelivered event, the handler run again past the inbox, and a duplicate row straight into the table all leave one message', async () => {
    const eventId = (await one<{ id: string }>("SELECT id FROM platform.outbox_message WHERE event_type = 'ord.OrderDispatched' AND subject_id = $1", [crate.orderId])).id;
    await admin().query("UPDATE platform.outbox_delivery SET status = 'PENDING', next_attempt_at = now() - interval '1 second', delivered_at = NULL WHERE message_id = $1 AND consumer = 'ntf.customer-messages'", [eventId]);
    await ntf.dispatch();
    const envelope = await one<{ id: string; type: string; payload: Record<string, unknown> }>('SELECT id, event_type AS type, payload FROM platform.outbox_message WHERE id = $1', [eventId]);
    const again = await runAsSystem({ principalId: '01900000-0000-7000-8000-000000000003', displayName: 'Outbox dispatcher' }, randomUUID(), () =>
      ntf.workerUow.run({ isolation: 'serializable' }, (tx) =>
        ntf.customerMessages.queueIn(tx, { ...envelope, version: 1, occurredAt: clock.now(), recordedAt: clock.now(), actorId: SCHEDULER.principalId, branchId, correlationId: randomUUID(), causationId: null, subjectType: 'SalesOrder', subjectId: crate.orderId }),
      ),
    );
    expect(again).toBe(false);
    expect(await messagesOf(crate.orderId)).toHaveLength(1);
    const copy = await one<Record<string, unknown>>('SELECT * FROM ntf.message WHERE sales_order_id = $1', [crate.orderId]);
    const duplicate = database
      .pool('app')
      .query(
        `INSERT INTO ntf.message (id, idempotency_key, source_event_ref, source_event_type, branch_id, sales_order_id, template_id, channel, category, recipient_kind, address_masked, rendered_body, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'SMS', 'TRANSACTIONAL', 'CONTACT', 'x', 'x', 'QUEUED', now(), $8, now(), $8)`,
        [randomUUID(), copy['idempotency_key'], copy['source_event_ref'], copy['source_event_type'], branchId, crate.orderId, copy['template_id'], SCHEDULER.principalId],
      );
    expect(await sqlStateOf(duplicate)).toBe(SQLSTATE.uniqueViolation);
    expect(await ntf.sender(sms).run(SCHEDULER)).toMatchObject({ claimed: 0 });
    expect(sms.calls).toHaveLength(1);
  });

  it('a message goes to the order\'s own contact whatever number an event carries; an event for no order sends nothing', async () => {
    const forged = await ntf.publish({
      type: 'ord.OrderDispatched',
      subjectType: 'SalesOrder',
      subjectId: crate.orderId,
      branchId,
      payload: { orderId: crate.orderId, contactPhone: '+233209999999', deliveryNo: 'DLV-X', finalTotalPesewas: 1, codDuePesewas: 1, dueDate: null, backorderNo: null, bookedSlotId: null, lines: [] },
    });
    const stranger = randomUUID();
    await ntf.publish({ type: 'del.DeliveryOnTheWay', subjectType: 'Delivery', subjectId: stranger, branchId, payload: { orderDocumentId: stranger, deliveryNo: 'DLV-Y', etaMinutes: 5, contactPhone: '+233209999999' } });
    await ntf.dispatch();
    expect(await count('SELECT count(*) AS n FROM ntf.message WHERE source_event_ref = $1', [forged])).toBe(1);
    expect(await count("SELECT count(*) AS n FROM ntf.message WHERE source_event_type = 'del.DeliveryOnTheWay' AND sales_order_id IS NULL")).toBe(0);
    const before = sms.calls.length;
    await ntf.sender(sms).run(SCHEDULER);
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([GUEST_PHONE]);
    expect(sms.calls.every((c) => c.to === GUEST_PHONE)).toBe(true);
  });

  it('a change that rolls back queues no message', async () => {
    const before = await count('SELECT count(*) AS n FROM ntf.message');
    const failed = await runAsSystem({ principalId: '01900000-0000-7000-8000-000000000001', displayName: 'System' }, randomUUID(), () =>
      ntf.workerUow
        .run({ isolation: 'serializable' }, async (tx) => {
          await ntf.events.publish(tx, { type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: crate.orderId, deliveryNo: 'DLV-Z' } });
          throw new Error('the cancellation failed after publishing');
        })
        .catch((error: unknown) => error),
    );
    expect(failed).toBeInstanceOf(Error);
    await ntf.dispatch();
    expect(await count('SELECT count(*) AS n FROM ntf.message')).toBe(before);
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE payload->>'deliveryNo' = 'DLV-Z'")).toBe(0);
  });

  it('on the way and delivered each send one message, to the same contact', async () => {
    const route = await post('manager', '/routes', { driverId: id('driver'), routeDate: today, vehicleLocationId: id('location:VAN1'), deliveryIds: [crate.deliveryId] });
    expect(route.status, JSON.stringify(route.body)).toBe(201);
    expect((await post('manager', `/routes/${route.body.id as string}/start`, {})).status).toBe(200);
    expect((await post('driver', `/driver/deliveries/${crate.deliveryId}/on-the-way`, { occurredAt: clock.now().toISOString(), etaMinutes: 20 })).status).toBe(200);
    const uploaded = await consolePost(api.server, as('driver'), '/v1/files').field('purpose', 'PROOF_OF_DELIVERY').attach('file', photo(7), 'door.jpg');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    clock.advanceBy(60_000);
    const proof = await post('driver', `/driver/deliveries/${crate.deliveryId}/proof`, { id: nextId(), recipientName: 'Ama Serwaa Ofori', photoFileId: uploaded.body.id as string, codCollectedPesewas: crate.due, capturedAt: clock.now().toISOString() });
    expect(proof.status, JSON.stringify(proof.body)).toBe(200);
    await ntf.dispatch();
    const orderNo = (await one<{ order_no: string }>('SELECT order_no FROM ord.sales_order WHERE id = $1', [crate.orderId])).order_no;
    const deliveryNo = (await one<{ delivery_no: string }>('SELECT delivery_no FROM del.delivery WHERE id = $1', [crate.deliveryId])).delivery_no;
    const latest = (await messagesOf(crate.orderId)).slice(-2);
    expect(latest.map((m) => [m.code, m.status, m.body])).toEqual([
      ['DELIVERY_ON_THE_WAY', 'QUEUED', `HaKorem Farms: our driver is on the way with order ${orderNo} (${deliveryNo}).`],
      ['DELIVERY_COMPLETED', 'QUEUED', `HaKorem Farms: order ${orderNo} was delivered. Paid on delivery ${formatCedis(BigInt(crate.due))}. Thank you!`],
    ]);
    const before = sms.calls.length;
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(2);
    expect(sms.calls.slice(before).map((c) => c.to)).toEqual([GUEST_PHONE, GUEST_PHONE]);
    await ntf.dispatch();
    expect((await ntf.sender(sms).run(SCHEDULER)).claimed).toBe(0);
  });

  it('collected, rescheduled, cancelled and part delivered: one message each, from what the event says, to the order\'s contact', async () => {
    const orderNo = (await one<{ order_no: string }>('SELECT order_no FROM ord.sales_order WHERE id = $1', [crate.orderId])).order_no;
    const o = crate.orderId;
    const published = [
      await ntf.publish({ type: 'ord.OrderCollected', subjectType: 'SalesOrder', subjectId: o, branchId, payload: { orderId: o, billingDocumentNo: 'INV-T-1', finalTotalPesewas: 137_900, dueAtTillPesewas: 37_900, dueDate: null } }),
      await ntf.publish({ type: 'del.DeliveryRescheduled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: o, deliveryNo: 'DLV-R', slotDate: '2026-11-26', slotStartsAt: '14:00', slotEndsAt: '16:00' } }),
      await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: o, deliveryNo: 'DLV-C' } }),
    ];
    await ntf.dispatch();
    // A part delivery's event is DEL's, which ORD posts in its own transaction (stock, credit): it is handed to NTF's
    // consumer straight, as the dispatcher would, so only the message is made here.
    const part = randomUUID();
    published.push(part);
    await runAsSystem({ principalId: '01900000-0000-7000-8000-000000000003', displayName: 'Outbox dispatcher' }, randomUUID(), () =>
      ntf.workerUow.run({ isolation: 'serializable' }, (tx) =>
        ntf.customerMessages.queueIn(tx, {
          id: part,
          type: 'del.DeliveryCompleted',
          version: 1,
          occurredAt: clock.now(),
          recordedAt: clock.now(),
          actorId: SCHEDULER.principalId,
          branchId,
          correlationId: randomUUID(),
          causationId: null,
          subjectType: 'Delivery',
          subjectId: crate.deliveryId,
          payload: { orderDocumentId: o, deliveryNo: 'DLV-P', codCollectedPesewas: 88_000, returnedLines: [{ orderLineId: o }], returnedCreditPesewas: 6_000 },
        }),
      ),
    );
    const made = await rows<{ code: string; body: string }>(
      'SELECT t.code, m.rendered_body AS body FROM ntf.message m JOIN ntf.template t ON t.id = m.template_id WHERE m.source_event_ref = ANY($1::uuid[]) ORDER BY m.created_at, m.id',
      [published],
    );
    expect(made).toEqual([
      { code: 'ORDER_COLLECTED', body: `HaKorem Farms: thank you for collecting order ${orderNo}. Invoice INV-T-1, total GHS 1,379.00, left to pay GHS 379.00.` },
      { code: 'DELIVERY_RESCHEDULED', body: `HaKorem Farms: delivery DLV-R of order ${orderNo} is now on 2026-11-26, 14:00 to 16:00.` },
      { code: 'DELIVERY_CANCELLED', body: `HaKorem Farms: delivery DLV-C of order ${orderNo} has been cancelled. We will call you about it.` },
      { code: 'DELIVERY_PART_COMPLETED', body: `HaKorem Farms: part of order ${orderNo} was delivered. Paid on delivery GHS 880.00; GHS 60.00 credited for what came back.` },
    ]);
    const before = sms.calls.length;
    expect((await ntf.sender(sms).run(SCHEDULER)).sent).toBe(4);
    expect(new Set(sms.calls.slice(before).map((c) => c.to))).toEqual(new Set([GUEST_PHONE]));
  });

  it('two workers at once send each message once', async () => {
    clock.advanceBy(3_700_000);
    const o = crate.orderId;
    for (let i = 0; i < 6; i++) {
      await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: o, deliveryNo: `DLV-W${String(i)}` } });
    }
    await ntf.dispatch();
    const queued = await rows<{ id: string }>("SELECT id FROM ntf.message WHERE status = 'QUEUED'");
    expect(queued.length).toBeGreaterThan(0);
    const a = new FakeSms();
    const b = new FakeSms();
    const passes = await Promise.all([ntf.sender(a).run(SCHEDULER), ntf.sender(b).run(SCHEDULER)]);
    expect(passes[0]!.sent + passes[1]!.sent).toBe(queued.length);
    const keys = [...a.calls, ...b.calls].map((c) => c.idempotencyKey).sort();
    expect(keys).toEqual(queued.map((q) => q.id).sort());
    expect(await count("SELECT count(*) AS n FROM ntf.message WHERE id = ANY($1::uuid[]) AND status = 'SENT' AND attempts = 1", [queued.map((q) => q.id)])).toBe(queued.length);
    expect(await count('SELECT count(*) AS n FROM ntf.message_attempt WHERE message_id = ANY($1::uuid[])', [queued.map((q) => q.id)])).toBe(queued.length);
  });

  it('a worker that dies mid-send: its claim expires, the next worker sends with the same key, the customer gets one, the late answer changes nothing', async () => {
    clock.advanceBy(3_700_000);
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: crate.orderId, deliveryNo: 'DLV-D' } });
    await ntf.dispatch();
    const messageId = (await one<{ id: string }>('SELECT id FROM ntf.message WHERE source_event_ref = $1', [eventId])).id;
    const provider = new FakeSms();
    provider.holdNext();
    const dying = ntf.sender(provider).run(SCHEDULER);
    await expect.poll(() => provider.calls.length).toBe(1);
    expect((await ntf.sender(provider).run(SCHEDULER)).claimed).toBe(0);
    clock.advanceBy(121_000);
    expect(await ntf.sender(provider).run(SCHEDULER)).toMatchObject({ claimed: 1, sent: 1 });
    expect(provider.calls.map((c) => c.idempotencyKey)).toEqual([messageId, messageId]);
    expect([...provider.delivered.keys()]).toEqual([messageId]);
    provider.release();
    expect(await dying).toMatchObject({ claimed: 1, sent: 1 });
    expect(await one('SELECT status, attempts FROM ntf.message WHERE id = $1', [messageId])).toEqual({ status: 'SENT', attempts: 1 });
    expect(await count('SELECT count(*) AS n FROM ntf.message_attempt WHERE message_id = $1', [messageId])).toBe(1);
  });

  it('a recipient gets at most ten messages an hour; the rest are SUPPRESSED, RATE_LIMITED, and published for the exception report', async () => {
    clock.advanceBy(3_700_000);
    for (let i = 0; i < 11; i++) {
      await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: crate.orderId, deliveryNo: `DLV-S${String(i)}` } });
    }
    await ntf.dispatch();
    const storm = await rows<{ status: string; reason: string | null }>("SELECT status, suppressed_reason AS reason FROM ntf.message WHERE rendered_body LIKE '%DLV-S%' ORDER BY created_at, id");
    expect(storm.filter((m) => m.status === 'QUEUED')).toHaveLength(10);
    expect(storm.filter((m) => m.status === 'SUPPRESSED')).toEqual([{ status: 'SUPPRESSED', reason: 'RATE_LIMITED' }]);
    expect(await rows("SELECT payload->>'reason' AS reason, payload->'abuseCases' AS cases FROM platform.outbox_message WHERE event_type = 'ntf.MessageSuppressed'")).toEqual([{ reason: 'RATE_LIMITED', cases: [58] }]);
    await ntf.sender(new FakeSms()).run(SCHEDULER);
  });

  it('a failed message shows as FAILED with its three attempts, is published, and a manager may queue it again; nobody else', async () => {
    clock.advanceBy(3_700_000);
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: crate.orderId, deliveryNo: 'DLV-F' } });
    await ntf.dispatch();
    const messageId = (await one<{ id: string }>('SELECT id FROM ntf.message WHERE source_event_ref = $1', [eventId])).id;
    const flaky = new FakeSms();
    flaky.failNext('TEMPORARY', 3);
    expect(await ntf.sender(flaky).run(SCHEDULER)).toMatchObject({ claimed: 1, retrying: 1, circuitOpen: true });
    expect((await ntf.sender(flaky).run(SCHEDULER)).claimed).toBe(0);
    clock.advanceBy(30_000);
    expect(await ntf.sender(flaky).run(SCHEDULER)).toMatchObject({ claimed: 1, retrying: 1 });
    clock.advanceBy(60_000);
    expect(await ntf.sender(flaky).run(SCHEDULER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await rows('SELECT attempt_no, outcome, provider_response FROM ntf.message_attempt WHERE message_id = $1 ORDER BY attempt_no', [messageId])).toEqual([1, 2, 3].map((n) => ({ attempt_no: n, outcome: 'TEMPORARY_FAILURE', provider_response: 'the SMS provider answered 503' })));
    expect(await count("SELECT count(*) AS n FROM platform.outbox_message WHERE event_type = 'ntf.MessageFailed' AND subject_id = $1", [messageId])).toBe(1);

    const listed = await get('manager', '/notifications/messages?status=FAILED');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({ id: messageId, templateCode: 'DELIVERY_CANCELLED', channel: 'SMS', status: 'FAILED', addressMasked: '+23320*****67', recipient: { kind: 'CONTACT', id: null, displayName: 'Kofi Boateng' }, sentAt: null });
    expect(listed.body.data[0].attempts.map((a: { outcome: string }) => a.outcome)).toEqual(['TEMPORARY_FAILURE', 'TEMPORARY_FAILURE', 'TEMPORARY_FAILURE']);
    expect(JSON.stringify(listed.body)).not.toContain('201234567');

    for (const who of ['storekeeper', 'sales', 'driver']) {
      expect((await post(who, `/notifications/messages/${messageId}/retry`, {})).status, who).toBe(403);
      expect((await get(who, `/notifications/messages/${messageId}`)).status, who).toBe(403);
    }
    expect((await get('sales', '/notifications/messages')).status).toBe(403);
    const key = randomUUID();
    const retried = await post('manager', `/notifications/messages/${messageId}/retry`, {}, key);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body).toMatchObject({ status: 'QUEUED', attempts: [{ attemptNo: 1 }, { attemptNo: 2 }, { attemptNo: 3 }] });
    expect((await post('manager', `/notifications/messages/${messageId}/retry`, {}, key)).body).toEqual(retried.body);
    expect(codes(await post('manager', `/notifications/messages/${messageId}/retry`, {}))).toEqual([422, 'MESSAGE_NOT_RETRYABLE', 'NOT_FAILED']);
    expect(await count("SELECT count(*) AS n FROM platform.audit_event WHERE entity_type = 'NotificationMessage' AND action = 'RETRY' AND entity_id = $1", [messageId])).toBe(1);
    const healthy = new FakeSms();
    expect(await ntf.sender(healthy).run(SCHEDULER)).toMatchObject({ claimed: 1, sent: 1 });
    expect(await one('SELECT status, attempts FROM ntf.message WHERE id = $1', [messageId])).toEqual({ status: 'SENT', attempts: 4 });

    const suppressed = (await one<{ id: string }>("SELECT id FROM ntf.message WHERE status = 'SUPPRESSED' LIMIT 1")).id;
    expect(codes(await post('manager', `/notifications/messages/${suppressed}/retry`, {}))).toEqual([422, 'MESSAGE_NOT_RETRYABLE', 'SUPPRESSED']);
    expect((await get('manager', `/notifications/messages/${randomUUID()}`)).status).toBe(404);
  });

  it('a permanent failure is FAILED at once', async () => {
    const eventId = await ntf.publish({ type: 'del.DeliveryCancelled', subjectType: 'Delivery', subjectId: crate.deliveryId, branchId, payload: { orderDocumentId: crate.orderId, deliveryNo: 'DLV-P1' } });
    await ntf.dispatch();
    const messageId = (await one<{ id: string }>('SELECT id FROM ntf.message WHERE source_event_ref = $1', [eventId])).id;
    const refusing = new FakeSms();
    refusing.failNext('PERMANENT');
    expect(await ntf.sender(refusing).run(SCHEDULER)).toMatchObject({ claimed: 1, failed: 1, circuitOpen: false });
    expect(await one('SELECT status, attempts FROM ntf.message WHERE id = $1', [messageId])).toEqual({ status: 'FAILED', attempts: 1 });
  });
});

describe('the database holds the message log', () => {
  it('what a message is never changes, its status moves only forward, and an attempt is never altered', async () => {
    const sent = (await one<{ id: string }>("SELECT id FROM ntf.message WHERE status = 'SENT' LIMIT 1")).id;
    const app = database.pool('app');
    const refused = (sql: string, params: unknown[]) => sqlStateOf(app.query(sql, params));
    expect(await refused('UPDATE ntf.message SET sales_order_id = NULL WHERE id = $1', [sent])).toBe(SQLSTATE.documentFrozen);
    expect(await refused("UPDATE ntf.message SET rendered_body = 'Pay to 0559999999' WHERE id = $1", [sent])).toBe(SQLSTATE.documentFrozen);
    expect(await refused("UPDATE ntf.message SET status = 'QUEUED' WHERE id = $1", [sent])).toBe(SQLSTATE.documentFrozen);
    expect(await refused('UPDATE ntf.message SET attempts = 0 WHERE id = $1', [sent])).toBe(SQLSTATE.documentFrozen);
    expect(await refused("UPDATE ntf.message SET status = 'SUPPRESSED', suppressed_reason = 'NO_ADDRESS' WHERE id = $1", [sent])).toBe(SQLSTATE.documentFrozen);
    expect(await refused("UPDATE ntf.message_attempt SET outcome = 'PERMANENT_FAILURE' WHERE message_id = $1", [sent])).toBe(SQLSTATE.insufficientPrivilege);
    expect(await sqlStateOf(admin().query("UPDATE ntf.message_attempt SET outcome = 'PERMANENT_FAILURE' WHERE message_id = $1", [sent]))).toBe(SQLSTATE.ledgerImmutable);
    expect(await refused('DELETE FROM ntf.message_attempt WHERE message_id = $1', [sent])).toBe(SQLSTATE.insufficientPrivilege);
    expect(await refused('DELETE FROM ntf.message WHERE id = $1', [sent])).toBe(SQLSTATE.insufficientPrivilege);
    expect(await refused("INSERT INTO ntf.message (id, idempotency_key, source_event_ref, source_event_type, template_id, channel, category, recipient_kind, address_masked, status, attempts, created_at, created_by, updated_at, updated_by) SELECT $1, 'k-sent', id, 'ord.OrderDispatched', template_id, 'SMS', 'TRANSACTIONAL', 'CONTACT', '', 'SENT', 0, now(), created_by, now(), created_by FROM ntf.message WHERE id = $2", [randomUUID(), sent])).toBe(SQLSTATE.documentFrozen);
  });
});
