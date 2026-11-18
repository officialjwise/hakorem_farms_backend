import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillSale, type TillLine, type TillSale } from '../../support/offline';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Offline price overrides at sync (the owner on 2026-11-18, decision 3 and the clarification on prices, replacing A-278
 * (h)): the sale records the price the till charged, always; the server's price is worked out only to compare; every
 * difference reaches the daily exception report's source, for review within the cashier's own limit and URGENT beyond
 * it; beyond it the price stands on the rules only with a supervisor's PIN on the till, verified at sync, within that
 * supervisor's own line limit. Every figure is read by SQL over the order lines, the receipt and the journal lines.
 *
 * The cashier's limits are set here: 300 a line and 10,000 a shift; the manager's 400 a line. The seeded counter list
 * prices PRD-0005 at 2,000, its band 1,500 to 2,500, and the shop floor holds 40.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const who = (name: string) => users.get(name)!.principalId;
const as = (name: string) => sessions.get(name)!;
const admin = () => database.pool('admin');
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const post = (name: string, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, as(name), `/v1${path}`, key).send(body);
const MINUTE = 60_000;
const LIST = 2_000;
let credential: string;
let deviceId: string;
let shift: { readonly id: string; readonly seq: number };
let counter = 0;

const unit = (agreed: number, overrideApproval?: TillLine['overrideApproval']): TillLine => ({
  productId: id('PRD-0005'),
  quantity: '1.000',
  agreedUnitPricePesewas: agreed,
  ...(agreed === LIST ? {} : { varianceReasonCode: 'REGULAR_CUSTOMER' }),
  ...(overrideApproval === undefined ? {} : { overrideApproval }),
});

async function sell(line: TillLine): Promise<{ sale: TillSale; result: Record<string, unknown> }> {
  counter += 1;
  const sale = tillSale({ till: 'V1', shiftSeq: shift.seq, counter, at: new Date(clock.now().getTime() - 10 * MINUTE), lines: [line], tenders: [{ paymentMethodId: id('CASH'), amountPesewas: line.agreedUnitPricePesewas }] });
  const synced = await syncBatch(api.server, as('kofi'), credential, { deviceId, shiftId: shift.id, sales: [sale] });
  expect(synced.status, JSON.stringify(synced.body)).toBe(200);
  return { sale, result: (synced.body.results as Record<string, unknown>[])[0]! };
}

/** The override flags raised for a sale, as the exception report's source holds them. */
const overrideFlags = (saleId: string) =>
  rows<{ severity: string; amount: number; fact: Record<string, unknown> }>(
    "SELECT payload->>'severity' AS severity, (payload->>'amountPesewas')::int AS amount, payload->'fact' AS fact FROM platform.outbox_message WHERE event_type = 'pos.OfflineSaleFlagged' AND subject_id = $1 AND payload->>'exceptionKind' = 'PRICE_OVERRIDE'",
    [saleId],
  );

/** What posted for the sale: the order line's agreed price and variance, the receipt's gross, 1200 and 4210 by SQL. */
async function posted(saleId: string): Promise<{ agreed: number; variance: number; gross: number; receivable: number; variance4210: number }> {
  const line = await one<{ agreed: string; variance: string }>('SELECT agreed_unit_price_pesewas::text AS agreed, variance_pesewas::text AS variance FROM ord.sales_order_line WHERE sales_order_id = $1', [saleId]);
  const receipt = await one<{ id: string; gross: string }>('SELECT id, gross_pesewas::text AS gross FROM bil.billing_document WHERE order_document_id = $1', [saleId]);
  const net = async (code: string) =>
    Number(
      (
        await one<{ n: string | null }>(
          `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
             FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
            WHERE a.code = $1 AND e.source_document_id = $2`,
          [code, receipt.id],
        )
      ).n ?? 0,
    );
  return { agreed: Number(line.agreed), variance: Number(line.variance), gross: Number(receipt.gross), receivable: await net('1200'), variance4210: await net('4210') };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '172800', AUTH_STAFF_REFRESH_IDLE_SECONDS: '172800' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'PRD-0005'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [kind, role, amount] of [['PRICE_OVERRIDE_PER_LINE', 'CASHIER', 300], ['PRICE_OVERRIDE_PER_SHIFT', 'CASHIER', 10_000], ['PRICE_OVERRIDE_PER_LINE', 'MANAGER', 400]] as const) {
    await admin().query(
      `INSERT INTO iam.role_limit (role_id, limit_kind, amount_pesewas, created_by, updated_by)
       SELECT id, $1, $2, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001' FROM iam.role WHERE code = $3`,
      [kind, amount, role],
    );
  }
  for (const [name, display, role, totp] of [
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['kofi', 'Kofi Boateng', 'CASHIER', false],
    ['ama', 'Ama Asante', 'CASHIER', false],
  ] as const) {
    const user = await createUser(database, { name: display, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' ? { locationId: id('shop') } : {}) }] });
    users.set(name, user);
    sessions.set(name, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  expect((await setTillPin(api.server, as('manager'), await tillVerifier('554031'))).status).toBe(200);
  expect((await setTillPin(api.server, as('ama'), await tillVerifier('615203'))).status).toBe(200);
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'V1', name: 'Shop till V1' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till:V1', till.body.id as string);
  await stepUp(api.server, as('manager') as TotpSession, clock);
  const enrolled = await post('manager', `/registers/${id('till:V1')}/devices`, { deviceLabel: 'Shop tablet V1' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  deviceId = enrolled.body.device.id as string;
  // The shift opens well after the seeded prices take effect.
  clock.advanceBy(7 * 60 * MINUTE);
  const shiftId = nextId();
  const opened = await post('kofi', '/shifts', { id: shiftId, registerId: id('till:V1'), openingFloatPesewas: 20_000, openedAt: clock.now().toISOString() }, shiftId);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: opened.body.shiftSeq as number };
  clock.advanceBy(30 * MINUTE);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('the price the till charged always posts; every difference is raised (the owner, 2026-11-18)', () => {
  it('a line at the server price posts 2,000 and raises nothing', async () => {
    const { sale, result } = await sell(unit(LIST));
    expect(result).toMatchObject({ outcome: 'APPLIED', grossPesewas: 2_000, exceptions: [] });
    expect(await posted(sale.id)).toEqual({ agreed: 2_000, variance: 0, gross: 2_000, receivable: 2_000, variance4210: 0 });
    expect(await overrideFlags(sale.id)).toEqual([]);
  });

  it('a line 300 below list, at the cashier\'s limit, posts 1,700 charged with 300 on 4210, raised for review and not told to the till', async () => {
    const { sale, result } = await sell(unit(1_700));
    expect(result).toMatchObject({ outcome: 'APPLIED', grossPesewas: 1_700, exceptions: [] });
    expect(await posted(sale.id)).toEqual({ agreed: 1_700, variance: 300, gross: 1_700, receivable: 1_700, variance4210: 300 });
    const flags = await overrideFlags(sale.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: 'REVIEW', amount: 300, fact: { variancePesewas: 300, direction: 'BELOW', listUnitPricePesewas: 2_000, agreedUnitPricePesewas: 1_700, beyondCashier: null, basis: 'WITHIN_CASHIER_LIMIT' } });
  });

  it('a line one pesewa beyond the limit with no supervisor PIN posts 1,699 charged and is URGENT, outside the rules', async () => {
    const { sale, result } = await sell(unit(1_699));
    expect(result).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 1_699 });
    expect(await posted(sale.id)).toEqual({ agreed: 1_699, variance: 301, gross: 1_699, receivable: 1_699, variance4210: 301 });
    expect(await overrideFlags(sale.id)).toEqual([
      expect.objectContaining({ severity: 'URGENT', amount: 301, fact: expect.objectContaining({ beyondCashier: 'BEYOND_ROLE_LIMIT', basis: 'OUTSIDE_RULES', reason: 'NO_SUPERVISOR_PIN', approvedById: null }) }),
    ]);
  });

  it('a line one pesewa beyond the limit with a supervisor\'s valid PIN posts 1,699 charged, URGENT on the supervisor\'s PIN', async () => {
    const { sale, result } = await sell(unit(1_699, { approvedById: who('manager'), approvedByPinVersion: 1 }));
    expect(result).toMatchObject({ outcome: 'APPLIED_WITH_EXCEPTION', grossPesewas: 1_699 });
    expect(await posted(sale.id)).toEqual({ agreed: 1_699, variance: 301, gross: 1_699, receivable: 1_699, variance4210: 301 });
    expect(await overrideFlags(sale.id)).toEqual([
      expect.objectContaining({ severity: 'URGENT', amount: 301, fact: expect.objectContaining({ basis: 'SUPERVISOR_PIN', reason: null, approvedById: who('manager'), approvalCheck: { pinVersion: 1, verdict: 'VERIFIED' } }) }),
    ]);
  });

  it('is outside the rules when the PIN is not a supervisor\'s, is the cashier\'s own, names a version the server lacks, or the variance passes the supervisor\'s own limit', async () => {
    const cases: readonly [TillLine, string][] = [
      [unit(1_699, { approvedById: who('ama'), approvedByPinVersion: 1 }), 'SUPERVISOR_APPROVER_NOT_SUPERVISOR'],
      [unit(1_699, { approvedById: who('kofi'), approvedByPinVersion: 1 }), 'SUPERVISOR_APPROVER_IS_MAKER'],
      [unit(1_699, { approvedById: who('manager'), approvedByPinVersion: 2 }), 'SUPERVISOR_PIN_UNKNOWN'],
      [unit(1_599, { approvedById: who('manager'), approvedByPinVersion: 1 }), 'BEYOND_SUPERVISOR_LIMIT'],
    ];
    for (const [line, reason] of cases) {
      const { sale } = await sell(line);
      expect((await posted(sale.id)).agreed, reason).toBe(line.agreedUnitPricePesewas);
      expect(await overrideFlags(sale.id), reason).toEqual([expect.objectContaining({ severity: 'URGENT', fact: expect.objectContaining({ basis: 'OUTSIDE_RULES', reason }) })]);
    }
  });
});
