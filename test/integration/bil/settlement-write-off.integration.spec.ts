import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing } from '../../../src/modules/bil';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { issueInvoice } from '../../support/pay';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * BIL's settlement functions as 0273 replaced them (the parent session's leave of 2026-11-18, ADR-0090): on a document
 * with nothing written off, `bil.document_settlement_keep`, both forms of `bil.apply_settlement` and
 * `bil.credit_note_refund` answer exactly what 0182's and 0187's did, proved by running one sequence of every kind of
 * step under the old bodies (taken word for word from 0273's down step) and under the new, on two documents of the
 * same figures, and comparing the summaries after each step. With something written off, the database refuses a
 * credit note or an allocation that would reach into it, and the write-off itself beyond what is outstanding.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let productId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}) => consolePost(api.server, as(who), `/v1${path}`, randomUUID()).send(body);
const actorOf = (who: string): Actor => ({ principalId: users.get(who)!.principalId, kind: 'USER', displayName: who, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const SEED_PASSWORD = `Seed-${randomUUID()}`;
const MIGRATION = readFileSync(join(__dirname, '../../../migrations/0273_bil_settlement_write_off.sql'), 'utf8');
const UP = MIGRATION.slice(MIGRATION.indexOf('-- migrate:up'), MIGRATION.indexOf('-- migrate:down'));
/** The four function bodies 0273 installs, and the four it restores on the way down (0182's and 0187's). */
const NEW_BODIES = UP.slice(UP.indexOf('CREATE OR REPLACE FUNCTION bil.document_settlement_keep'), UP.indexOf('-- A bad-debt write-off applied'));
const OLD_BODIES = MIGRATION.slice(MIGRATION.indexOf("-- 0182's trigger function"), MIGRATION.indexOf('ALTER TABLE bil.document_settlement DROP CONSTRAINT'));

const inUow = <T>(work: (billing: Billing, tx: Parameters<Parameters<UnitOfWork['run']>[1]>[0]) => Promise<T>) =>
  runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'settlement test', actor: actorOf('accountant') }, () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => work(api.app.get(Billing), tx)),
  );
const summary = async (documentId: string) =>
  (await admin().query<Record<string, string | null>>(
    `SELECT allocated_pesewas::text AS allocated, credited_pesewas::text AS credited, outstanding_pesewas::text AS outstanding, refunded_pesewas::text AS refunded,
            refundable_pesewas::text AS refundable, written_off_pesewas::text AS written_off, payment_status, (settled_at IS NULL)::text AS unsettled
       FROM bil.document_settlement WHERE billing_document_id = $1`,
    [documentId],
  )).rows[0]!;

async function creditNote(invoiceId: string, amount: number): Promise<{ status: number; id: string | null }> {
  const original = await consoleGet(api.server, as('accountant'), `/v1/billing-documents/${invoiceId}`);
  const asked = await post('accountant', `/billing-documents/${invoiceId}/credit-notes`, { reasonCode: 'QUALITY_COMPLAINT', note: 'Short weight', lines: [{ lineId: original.body.lines[0].id, amountPesewas: amount }] });
  expect(asked.status, JSON.stringify(asked.body)).toBe(202);
  await stepUp(api.server, as('owner') as TotpSession, clock);
  const approved = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked' });
  return { status: approved.status, id: approved.status === 200 ? (asked.body.subject.id as string) : null };
}

/** Every kind of step each replaced function takes, on a fresh invoice of 10,000: the summary of the invoice and its credit note after each. */
async function sequence(customerId: string): Promise<Record<string, unknown>[]> {
  const owed = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId, productId }, 10_000n);
  const snapshots: Record<string, unknown>[] = [{ step: 'issued', ...(await summary(owed.id)) }];
  await inUow((billing, tx) => billing.settleIn(tx, owed.id, 6_000n, 'APPLY'));
  snapshots.push({ step: 'apply (four arguments)', ...(await summary(owed.id)) });
  await admin().query("SELECT bil.apply_settlement($1, 4000, 'APPLY')", [owed.id]);
  snapshots.push({ step: 'apply (three arguments)', ...(await summary(owed.id)) });
  const credit = await creditNote(owed.id, 4_000);
  expect(credit.status).toBe(200);
  snapshots.push({ step: 'credit note (trigger)', ...(await summary(owed.id)), creditNote: await summary(credit.id!) });
  await admin().query("SELECT * FROM bil.credit_note_refund($1, 1500, 'HOLD')", [credit.id]);
  snapshots.push({ step: 'refund held', ...(await summary(owed.id)), creditNote: await summary(credit.id!) });
  await admin().query("SELECT * FROM bil.credit_note_refund($1, 500, 'RELEASE')", [credit.id]);
  snapshots.push({ step: 'refund released', ...(await summary(owed.id)), creditNote: await summary(credit.id!) });
  await inUow((billing, tx) => billing.settleIn(tx, owed.id, 1_000n, 'UNAPPLY'));
  snapshots.push({ step: 'unapply', ...(await summary(owed.id)) });
  await expect(inUow((billing, tx) => billing.settleIn(tx, owed.id, 4_001n, 'APPLY'))).rejects.toThrow();
  snapshots.push({ step: 'apply beyond refused', ...(await summary(owed.id)) });
  return snapshots;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: SEED_PASSWORD }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  productId = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'LIV-0004'")).rows[0]!.id;
  for (const [who, name, role] of [
    ['owner', 'Kwabena Owusu', 'OWNER'],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT'],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId }] });
    users.set(who, user);
    sessions.set(who, await enrolAndLogin(api.server, user, () => clock.now()));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

let customers = 0;
async function customer(name: string): Promise<string> {
  const id = randomUUID();
  await app().query(
    "INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by) VALUES ($1, $2, 'BUSINESS', $3, '01900000-0000-7000-8000-000000000302', 'ACTIVE', $4, $4)",
    [id, `C-5${String((customers += 1)).padStart(4, '0')}`, name, SYSTEM_PRINCIPAL],
  );
  return id;
}

describe('the settlement functions 0273 replaced, on a document with nothing written off', () => {
  it('answer exactly as 0182’s and 0187’s did, step by step', async () => {
    expect(NEW_BODIES.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
    expect(OLD_BODIES.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(4);
    expect(OLD_BODIES).not.toContain('written_off');
    await admin().query(OLD_BODIES);
    let before: Record<string, unknown>[];
    try {
      before = await sequence(await customer('Old Bodies Ltd (TEST)'));
    } finally {
      await admin().query(NEW_BODIES);
    }
    const after = await sequence(await customer('New Bodies Ltd (TEST)'));
    expect(after).toEqual(before);
    expect(after.map((s) => s['outstanding'])).toEqual(['10000', '4000', '0', '0', '0', '0', '0', '0']);
    expect(after.map((s) => s['refundable'])).toEqual(['0', '0', '0', '4000', '2500', '3000', '2000', '2000']);
    expect(after.every((s) => s['written_off'] === '0')).toBe(true);
  });
});

describe('with something written off (ADR-0090)', () => {
  it('refuses a credit note or an allocation that would reach the amount written off, and a write-off beyond what is outstanding', async () => {
    const owed = await issueInvoice(api, actorOf('accountant'), clock, { branchId, customerId: await customer('Written Off Ltd (TEST)'), productId }, 10_000n);
    await expect(inUow((billing, tx) => billing.writeOffIn(tx, owed.id, 10_001n))).rejects.toMatchObject({ code: 'ALLOCATION_EXCEEDS_AVAILABLE' });
    expect(await sqlStateOf(admin().query('SELECT bil.apply_write_off($1, 0, now())', [owed.id]))).toBe('HK010');
    expect(await inUow((billing, tx) => billing.writeOffIn(tx, owed.id, 4_000n))).toBe(6_000n);
    expect(await summary(owed.id)).toMatchObject({ outstanding: '6000', written_off: '4000', payment_status: 'UNPAID', refundable: '0' });
    // A credit note of one pesewa more than what is left would reach the 4,000 written off: refused by the database at
    // its approval. BIL's approval handler does not translate that refusal (BL-093), so it is not answered as 422 yet.
    expect((await creditNote(owed.id, 6_001)).status).not.toBe(200);
    expect(await summary(owed.id)).toMatchObject({ credited: '0', outstanding: '6000' });
    expect((await creditNote(owed.id, 2_000)).status).toBe(200);
    expect(await summary(owed.id)).toMatchObject({ credited: '2000', outstanding: '4000', written_off: '4000', payment_status: 'PART_PAID' });
    expect(await sqlStateOf(admin().query("SELECT bil.apply_settlement($1, 4001, 'APPLY', now())", [owed.id]))).toBe('HK010');
    expect(await sqlStateOf(admin().query("SELECT bil.apply_settlement($1, 4001, 'APPLY')", [owed.id]))).toBe('HK010');
    expect(await inUow((billing, tx) => billing.settleIn(tx, owed.id, 4_000n, 'APPLY'))).toBe(0n);
    expect(await summary(owed.id)).toMatchObject({ outstanding: '0', written_off: '4000', payment_status: 'PART_PAID', unsettled: 'false' });
    expect(await sqlStateOf(admin().query('SELECT bil.apply_write_off($1, 1, now())', [owed.id]))).toBe('HK010');
    // The summary is a projection hk_app only reads; the column keeps its check.
    expect(await sqlStateOf(app().query('UPDATE bil.document_settlement SET written_off_pesewas = 0 WHERE billing_document_id = $1', [owed.id]))).toBe('42501');
    expect(await sqlStateOf(admin().query('UPDATE bil.document_settlement SET refundable_pesewas = 1 WHERE billing_document_id = $1', [owed.id]))).toBe('23514');
  });
});
