import { randomBytes, randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale, type TillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The receipt link's revoke (ADR-0074 Amendments, ADR-0083, A-284 (f), B09b continued 4b): a holder of
 * `pos.shift.close.approve` at the sale's branch revokes a sale's link with a reason, audited, and the link then reads
 * nothing, with the same answer as a guessed token. Nobody else can: the cashier, a manager of another branch and a
 * caller with no session are refused and nothing is written. The database holds the rule too
 * (`ck_receipt_link_revocation_supervisor`). Every row is read by SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential = '';
let shift = { id: '', seq: 0 };
let counter = 0;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const read = (token: string) => request(api.server).get(`/v1/shop/receipts/${encodeURIComponent(token)}`);
const revoke = (who: string, saleId: string, body: object = { reason: 'Link sent to the wrong number' }, key: string = randomUUID()) =>
  consolePost(api.server, as(who), `/v1/pos/sales/${saleId}/revoke-receipt-link`, key).send(body);
const tillToken = () => randomBytes(16).toString('base64url');
const MINUTE = 60_000;
const revocations = async (saleId: string) =>
  rows<{ reason: string; actor_id: string; revoked_at: Date }>('SELECT r.reason, r.actor_id, r.revoked_at FROM pos.receipt_link_revocation r JOIN pos.receipt_link l ON l.id = r.receipt_link_id WHERE l.order_document_id = $1', [saleId]);

function crates(token: string | undefined): TillSale {
  counter += 1;
  clock.advanceBy(MINUTE);
  return tillSale({
    till: 'T2',
    shiftSeq: shift.seq,
    counter,
    at: clock.now(),
    lines: [{ productId: id('EGG-0003'), quantity: '1.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }],
    tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 6_000, tenderedPesewas: 6_000 }],
    ...(token === undefined ? {} : { receiptToken: token }),
  });
}

async function synced(token: string | undefined): Promise<TillSale> {
  const sale = crates(token);
  const answer = await syncBatch(api.server, as('kwame'), credential, { deviceId: id('device'), shiftId: shift.id, sales: [sale] });
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  expect(answer.body.results[0].outcome, JSON.stringify(answer.body)).toBe('APPLIED');
  return sale;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { RECEIPT_LINK_BASE_URL: 'https://shop.hakorem.test', AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const other = await createBranch(database, 'RVK');
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  ids.set('manager', manager.principalId);
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const elsewhere = await createUser(database, { name: 'Efua Boateng', grants: [{ role: 'MANAGER', branchId: other.branchId }] });
  sessions.set('elsewhere', await enrolAndLogin(api.server, elsewhere, () => clock.now()));
  const kwame = await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  ids.set('kwame', kwame.principalId);
  sessions.set('kwame', await login(api.server, kwame));
  const till = await consolePost(api.server, as('manager'), '/v1/registers').send({ branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await consolePost(api.server, as('manager'), `/v1/registers/${till.body.id as string}/devices`).send({ deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  const shiftId = nextId();
  const opened = await consolePost(api.server, as('kwame'), '/v1/shifts', shiftId).send({ id: shiftId, registerId: till.body.id, openingFloatPesewas: 0, openedAt: clock.now().toISOString() });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a supervisor of the sale’s branch revokes its link with a reason (A-284 (f))', () => {
  it('records it once, audits it, and the link then reads nothing, answered exactly as a guessed token', async () => {
    const token = tillToken();
    const sale = await synced(token);
    expect((await read(token)).status).toBe(200);
    const guessed = await read(tillToken());
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const key = randomUUID();
    const answer = await revoke('manager', sale.id, { reason: 'Link sent to the wrong number' }, key);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({ saleId: sale.id, reason: 'Link sent to the wrong number', revokedAt: clock.now().toISOString(), revokedBy: { id: id('manager'), displayName: 'Kwabena Owusu' } });
    const stored = await revocations(sale.id);
    expect(stored).toEqual([{ reason: 'Link sent to the wrong number', actor_id: id('manager'), revoked_at: clock.now() }]);
    const audit = await rows<{ action: string; entity_type: string; after: Record<string, unknown> }>("SELECT action, entity_type, convert_from(after, 'UTF8')::jsonb AS after FROM platform.audit_event WHERE module = 'pos' AND action = 'REVOKE' AND entity_type = 'ReceiptLink'");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toMatchObject({ saleId: sale.id, reason: 'Link sent to the wrong number' });
    expect(JSON.stringify(audit[0]!.after)).not.toContain(token);

    const after = await read(token);
    expect(after.status).toBe(404);
    expect({ ...after.body, error: { ...after.body.error, correlationId: null } }).toEqual({ ...guessed.body, error: { ...guessed.body.error, correlationId: null } });

    const replay = await revoke('manager', sale.id, { reason: 'Link sent to the wrong number' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(answer.body);
    const again = await revoke('manager', sale.id, { reason: 'Once more' });
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(again.body.error.code).toBe('RECEIPT_LINK_INVALID');
    expect(again.body.error.details).toEqual([expect.objectContaining({ code: 'RECEIPT_LINK_ALREADY_REVOKED' })]);
    expect(await revocations(sale.id)).toHaveLength(1);
  });

  it('asks for a reason, and answers 404 for a sale with no link and for an id that names nothing', async () => {
    const sale = await synced(tillToken());
    await stepUp(api.server, as('manager') as TotpSession, clock);
    const blank = await revoke('manager', sale.id, { reason: '  ' });
    expect(blank.status, JSON.stringify(blank.body)).toBe(400);
    const none = await revoke('manager', sale.id, {});
    expect(none.status).toBe(400);
    const unlinked = await synced(undefined);
    const noLink = await revoke('manager', unlinked.id);
    expect(noLink.status, JSON.stringify(noLink.body)).toBe(404);
    const random = await revoke('manager', randomUUID());
    expect(random.status).toBe(404);
    expect({ ...noLink.body, error: { ...noLink.body.error, correlationId: null } }).toEqual({ ...random.body, error: { ...random.body.error, correlationId: null } });
    expect(await revocations(sale.id)).toEqual([]);
  });
});

describe('nobody else revokes a link (ADR-0035, deny by default)', () => {
  it('refuses the cashier who sold it, a manager of another branch and a caller with no session, writing nothing', async () => {
    const token = tillToken();
    const sale = await synced(token);
    const cashier = await revoke('kwame', sale.id);
    expect(cashier.status, JSON.stringify(cashier.body)).toBe(403);
    await stepUp(api.server, as('elsewhere') as TotpSession, clock);
    const other = await revoke('elsewhere', sale.id);
    expect([403, 404], JSON.stringify(other.body)).toContain(other.status);
    expect(JSON.stringify(other.body)).not.toContain(sale.id);
    const anonymous = await request(api.server).post(`/v1/pos/sales/${sale.id}/revoke-receipt-link`).set('Idempotency-Key', randomUUID()).send({ reason: 'No session' });
    expect([401, 403]).toContain(anonymous.status);
    expect(await revocations(sale.id)).toEqual([]);
    expect((await read(token)).status).toBe(200);
  });

  it('asks the manager for a fresh step-up', async () => {
    const sale = await synced(tillToken());
    clock.advanceBy(10 * MINUTE);
    const stale = await revoke('manager', sale.id);
    expect(stale.status, JSON.stringify(stale.body)).toBe(403);
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await revocations(sale.id)).toEqual([]);
  });

  it('is held by the database: a revocation by anyone not holding pos.shift.close.approve at the branch is refused', async () => {
    const sale = await synced(tillToken());
    const link = await one<{ id: string }>('SELECT id FROM pos.receipt_link WHERE order_document_id = $1', [sale.id]);
    await expect(
      admin().query('INSERT INTO pos.receipt_link_revocation (receipt_link_id, reason, revoked_at, recorded_at, actor_id) VALUES ($1, $2, $3, $3, $4)', [link.id, 'By the cashier', clock.now(), id('kwame')]),
    ).rejects.toMatchObject({ constraint: 'ck_receipt_link_revocation_supervisor' });
    await admin().query('INSERT INTO pos.receipt_link_revocation (receipt_link_id, reason, revoked_at, recorded_at, actor_id) VALUES ($1, $2, $3, $3, $4)', [link.id, 'By the manager', clock.now(), id('manager')]);
    expect(await revocations(sale.id)).toHaveLength(1);
  });
});
