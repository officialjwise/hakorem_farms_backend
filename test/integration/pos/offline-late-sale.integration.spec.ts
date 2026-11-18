import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { syncBatch, tillSale } from '../../support/offline';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * A sale dated in a locked period (ADR-0027 point 6, FR-POS-014, OFFLINE_SYNC 9.4.1, the owner's addition (1) to
 * A-200): made at the till late on a month's last day, its month locked by the accountant while the till was off, and
 * synced in the next month. It is recorded with its receipt and cash, posts on the first open date, keeps its
 * `occurred_at`, takes its numbers in the posting date's year, and is flagged for the report (not for the cashier).
 * The clock starts at 21:00 on the last day of the month testStartTime falls in (the next month's when too close).
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
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const MINUTE = 60_000;

/** 21:00 UTC (Africa/Accra) on the last day of the month of `from`, or of the next month when that is within two hours. */
function monthEndEvening(from: Date): Date {
  const evening = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0, 21, 0, 0));
  const first = evening(from.getUTCFullYear(), from.getUTCMonth());
  return first.getTime() - from.getTime() > 2 * 60 * MINUTE ? first : evening(from.getUTCFullYear(), from.getUTCMonth() + 1);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(monthEndEvening(testStartTime()));
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  const manager = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: id('branch') }] });
  sessions.set('manager', await enrolAndLogin(api.server, manager, () => clock.now()));
  const accountant = await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId: id('branch') }] });
  sessions.set('accountant', await enrolAndLogin(api.server, accountant, () => clock.now()));
  const kwame = await createUser(database, { name: 'Kwame Asare', grants: [{ role: 'CASHIER', branchId: id('branch'), locationId: id('shop') }] });
  sessions.set('kwame', await login(api.server, kwame));
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'T2', name: 'Shop floor till' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${till.body.id as string}/devices`, { deviceLabel: 'Shop floor tablet' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  clock.advanceBy(10 * MINUTE);
  const shiftId = nextId();
  const opened = await post('kwame', '/shifts', { id: shiftId, registerId: id('till'), openingFloatPesewas: 0, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('a sale whose period locked before it synced posts on the first open date, flagged, keeping its occurred_at (OFFLINE_SYNC 9.4.1)', () => {
  it('records two crates sold on the last evening of the month and synced after the month was locked', async () => {
    const at = new Date(clock.now().getTime() + 25 * MINUTE);
    const occurredDate = toBusinessDate(at);
    // Two crates, 2 x 6,000 = 12,000, cash 15,000 handed over.
    const offline = tillSale({ till: 'T2', shiftSeq: shift.seq, counter: 31, at, lines: [{ productId: id('EGG-0003'), quantity: '2.000', uom: 'CRATE', agreedUnitPricePesewas: 6_000 }], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: 12_000, tenderedPesewas: 15_000 }] });
    // Into the next month: the accountant locks the month the sale was made in.
    clock.advanceBy(14 * 60 * MINUTE);
    const period = await one<{ id: string; status: string; end: string }>('SELECT id, status, end_date::text AS end FROM fin.accounting_period WHERE $1::date BETWEEN start_date AND end_date', [occurredDate]);
    expect([period.status, period.end]).toEqual(['OPEN', occurredDate]);
    await stepUp(api.server, as('accountant') as TotpSession, clock);
    const locked = await post('accountant', `/finance/periods/${period.id}/lock`);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    clock.advanceBy(10 * 60 * MINUTE);
    const syncDate = toBusinessDate(clock.now());
    expect(syncDate > occurredDate).toBe(true);

    const synced = await syncBatch(api.server, as('kwame'), credential, { deviceId: id('device'), shiftId: shift.id, sales: [offline] });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    // The late posting is on the sale's log and the report, not an exception for the cashier (OFFLINE_SYNC 9.4.1); the
    // cashier is told only that it is a day old, beyond the 8-hour bound (A-278 (c)).
    expect(synced.body.results[0]).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 12_000 });
    expect((synced.body.results[0].exceptions as { kind: string }[]).map((e) => e.kind)).toEqual(['OFFLINE_SALE_TOO_OLD']);
    expect(synced.body.counterGaps).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    expect(await one('SELECT posted_late_reason, posting_date::text AS posting_date FROM pos.sale_sync WHERE client_sale_id = $1', [offline.id])).toEqual({ posted_late_reason: 'PERIOD_LOCKED', posting_date: syncDate });
    const order = await one<{ placed_at: Date; order_no: string }>('SELECT placed_at, order_no FROM ord.sales_order WHERE id = $1', [offline.id]);
    expect(order.placed_at.toISOString()).toBe(at.toISOString());
    const receipt = await one<{ id: string; issue_date: string; issued_at: Date; document_no: string; synced: boolean }>(
      'SELECT id, issue_date::text, issued_at, document_no, synced_from_offline AS synced FROM bil.billing_document WHERE order_document_id = $1',
      [offline.id],
    );
    expect([receipt.issue_date, receipt.issued_at.toISOString(), receipt.synced]).toEqual([syncDate, at.toISOString(), true]);
    // The numbers take the posting date's year.
    expect(receipt.document_no).toContain(`-${syncDate.slice(0, 4)}-`);
    expect(order.order_no).toContain(`-${syncDate.slice(0, 4)}-`);
    // Every journal of the sale posts on the first open date, none in the locked month.
    const documents = (await rows<{ id: string }>('SELECT $1::uuid AS id UNION SELECT $2::uuid UNION SELECT id FROM pay.payment WHERE order_document_id = $1 UNION SELECT id FROM inv.stock_movement WHERE source_document_id = $1', [offline.id, receipt.id])).map((r) => r.id);
    expect(await rows('SELECT DISTINCT posting_date::text AS d FROM fin.journal_entry WHERE source_document_id = ANY($1::uuid[])', [documents])).toEqual([{ d: syncDate }]);
    const sums = await rows<{ code: string; n: string }>(
      `SELECT a.code, sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
         FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
        WHERE e.source_document_id = ANY($1::uuid[]) AND a.code IN ('1000', '1200', '4020') GROUP BY a.code ORDER BY a.code`,
      [documents],
    );
    expect(sums).toEqual([
      { code: '1000', n: '12000' },
      { code: '1200', n: '0' },
      { code: '4020', n: '-12000' },
    ]);
    const flags = (await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1", [offline.id])).map((r) => r.payload);
    expect(flags.map((f) => f['exceptionKind']).sort()).toEqual(['OFFLINE_LATE_POSTING', 'OFFLINE_SALE_TOO_OLD']);
    expect(flags.find((f) => f['exceptionKind'] === 'OFFLINE_LATE_POSTING')).toMatchObject({ exceptionKind: 'OFFLINE_LATE_POSTING', severity: 'REVIEW', amountPesewas: 12_000, fact: { reason: 'PERIOD_LOCKED', occurredDate, postingDate: syncDate } });
    // The document read shows both the till's time and the date it was issued on.
    const read = await consoleGet(api.server, as('manager'), `/v1/billing-documents/${receipt.id}`);
    expect(read.body).toMatchObject({ syncedFromOffline: true, issueDate: syncDate, issuedAt: at.toISOString(), occurredAt: at.toISOString(), provisionalRef: `P-T2-${shift.seq}-0031` });
  });
});
