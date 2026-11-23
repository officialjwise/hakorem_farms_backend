import { randomUUID } from 'node:crypto';
import { createUuidV7Generator, ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnverifiedOverdue } from '../../../src/modules/pay';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, consolePut, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { syncBatch, tillSale, type TillLine, type TillSale } from '../../support/offline';
import { setTillPin, tillVerifier } from '../../support/till-pin';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The unverified offline mobile money tender's clearing account (the owner's decision 3 of 2026-11-18, ADR-0003
 * Amendments, A-282, OFFLINE_SYNC 9.9, abuse case 4): booked to 1115 Mobile money awaiting verification against the
 * wallet, never straight to 1110; moved to 1110 exactly once when a second person approves its verification; left in
 * 1115 and raised URGENT once when the window passes with no verification; and, refused as never received, mirrored
 * out of 1115 back to the receivable without ever touching 1110. Every figure is read by SQL over `pay.payment`, the
 * break, the verification and overdue rows, the journal lines and the outbox, never from the answer under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let nextId: () => string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
let credential: string;
let shift: { readonly id: string; readonly seq: number };
let wallet: string;
const admin = () => database.pool('admin');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const rows = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => (await admin().query(sql, values)).rows as T[];
const one = async <T>(sql: string, values: unknown[] = []): Promise<T> => (await rows<T>(sql, values))[0]!;
const num = async (sql: string, values: unknown[] = []): Promise<number> => Number((await one<{ n: string | null }>(sql, values)).n ?? 0);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(clock.now().getTime() - ms);
const crateLine = (crates: number): TillLine => ({ productId: id('EGG-0003'), quantity: `${crates}.000`, uom: 'CRATE', agreedUnitPricePesewas: 6_000 });
const cash = (amount: number) => ({ paymentMethodId: id('CASH'), amountPesewas: amount });
const momo = (amount: number, providerReference: string) => ({
  paymentMethodId: id('MOMO'),
  amountPesewas: amount,
  unverifiedMobileMoney: { payerPhone: '+233245550142', network: 'MTN', providerReference, approvedById: users.get('manager')!.principalId, approvedByPinVersion: 1 },
});
const sync = (sales: readonly TillSale[]) => syncBatch(api.server, as('abena'), credential, { deviceId: id('device'), shiftId: shift.id, sales, cashMovements: [] });
const overdue = () => runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(UnverifiedOverdue).run({ kind: 'SYSTEM', principalId: SYSTEM_PRINCIPAL }));

/** Debits less credits on an account, against the wallet when it has one, over the journals whose source is any of the documents. */
async function balance(code: string, documents: readonly string[]): Promise<number> {
  return num(
    `SELECT sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END)::text AS n
       FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party sp ON sp.id = l.subledger_party_id
      WHERE a.code = $1 AND e.source_document_id = ANY($2::uuid[]) AND (a.subledger_kind IS DISTINCT FROM 'BANK_ACCOUNT' OR sp.ref_id = $3)`,
    [code, documents, wallet],
  );
}

/** Every line ever posted to an account against the wallet, over the whole journal. */
const linesOn = (code: string) =>
  num(
    `SELECT count(*)::text AS n FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party sp ON sp.id = l.subledger_party_id
      WHERE a.code = $1 AND sp.ref_id = $2`,
    [code, wallet],
  );

/** The sale's documents: every payment (the tender, any reversing payment, the cash) and the receipt they settle. */
async function documentsOf(saleId: string): Promise<string[]> {
  const payments = await rows<{ id: string }>('SELECT id FROM pay.payment WHERE order_document_id = $1', [saleId]);
  const receipt = await rows<{ id: string }>('SELECT id FROM bil.billing_document WHERE order_document_id = $1', [saleId]);
  return [...payments.map((r) => r.id), ...receipt.map((r) => r.id)];
}

const tenderOf = (saleId: string) =>
  one<{ id: string; status: string; verification: string; failure_reason: string | null; amount: string }>(
    "SELECT id, status, verification, failure_reason, amount_pesewas::text AS amount FROM pay.payment WHERE order_document_id = $1 AND method_kind = 'MOBILE_MONEY' AND reverses_payment_id IS NULL",
    [saleId],
  );
const breakOf = (paymentId: string) => one<{ id: string; status: string; details: Record<string, unknown> }>("SELECT id, status, details FROM pay.reconciliation_break WHERE payment_id = $1 AND kind = 'UNVERIFIED_PAYMENT'", [paymentId]);

async function approve(who: string, approvalRequestId: string) {
  await step(who);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Seen on the MTN merchant statement' });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  nextId = createUuidV7Generator(clock);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '864000', AUTH_STAFF_REFRESH_IDLE_SECONDS: '864000' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of await rows<{ code: string; id: string }>(
    `SELECT 'branch' AS code, id FROM mdm.branch WHERE code = 'DDW'
     UNION ALL SELECT 'shop', l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code = 'SHOP'
     UNION ALL SELECT sku, id FROM mdm.product WHERE sku = 'EGG-0003'
     UNION ALL SELECT code, id FROM mdm.payment_method`,
  )) {
    ids.set(row.code, row.id);
  }
  for (const [who, name, role, totp] of [
    ['owner', 'Akosua Owner', 'OWNER', true],
    ['manager', 'Kwabena Owusu', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['abena', 'Abena Sarpong', 'CASHIER', false],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
  ] as const) {
    const user = await createUser(database, { name, grants: [{ role, branchId: id('branch'), ...(role === 'CASHIER' || role === 'STOREKEEPER' ? { locationId: id('shop') } : {}) }] });
    users.set(who, user);
    sessions.set(who, totp ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
  expect((await setTillPin(api.server, as('manager'), await tillVerifier('554031'))).status).toBe(200);
  const till = await post('manager', '/registers', { branchId: id('branch'), locationId: id('shop'), code: 'V1', name: 'Shop till V1' });
  expect(till.status, JSON.stringify(till.body)).toBe(201);
  ids.set('till', till.body.id as string);
  await step('manager');
  const enrolled = await post('manager', `/registers/${id('till')}/devices`, { deviceLabel: 'Shop tablet V1' });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  credential = enrolled.body.deviceCredential as string;
  ids.set('device', enrolled.body.device.id as string);
  // The branch allows an unverified mobile money tender offline (OFFLINE_SYNC 5.2).
  await step('owner');
  const current = await rows<{ version: number }>("SELECT version FROM platform.setting WHERE key = 'pos.offline.allow_unverified_mobile_money' AND branch_id = $1 AND deleted_at IS NULL ORDER BY valid_from DESC LIMIT 1", [id('branch')]);
  const put = await consolePut(api.server, as('owner'), '/v1/admin/settings/pos.offline.allow_unverified_mobile_money').send({ value: true, version: current[0]?.version ?? 0, branchId: id('branch') });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  clock.advanceBy(7 * HOUR);
  const pack = await consoleGet(api.server, as('abena'), `/v1/registers/${id('till')}/offline-pack`).set('X-Device-Credential', credential);
  expect(pack.status, JSON.stringify(pack.body)).toBe(200);
  const shiftId = nextId();
  const opened = await consolePost(api.server, as('abena'), '/v1/shifts', shiftId).set('X-Device-Credential', credential).send({ id: shiftId, registerId: id('till'), openingFloatPesewas: 0, openedAt: ago(2 * HOUR).toISOString(), shiftSeq: pack.body.nextShiftSeq as number });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  shift = { id: shiftId, seq: pack.body.nextShiftSeq as number };
  wallet = (await one<{ id: string }>("SELECT id FROM fin.bank_account WHERE kind = 'MOBILE_MONEY' AND is_active ORDER BY (branch_id IS NULL), created_at, id LIMIT 1")).id;
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('an unverified mobile money tender waits in 1115 and moves to 1110 exactly once on its verification', () => {
  let verified: TillSale;

  it('books the tender to 1115 against the wallet, never 1110 or 1120; the receivable is settled', async () => {
    // 5 crates at 6,000 = 30,000: mobile money 20,000 approved by the shop's manager, cash 10,000 (OFFLINE_SYNC 9.9).
    verified = tillSale({ till: 'V1', shiftSeq: shift.seq, counter: 1, at: ago(90 * MINUTE), lines: [crateLine(5)], tenders: [momo(20_000, 'MP261113.1149.C41872'), cash(10_000)] });
    const synced = await sync([verified]);
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    expect((synced.body.results as Record<string, unknown>[])[0]).toMatchObject({ outcome: 'APPLIED', grossPesewas: 30_000 });
    const tender = await tenderOf(verified.id);
    expect(tender).toMatchObject({ status: 'PENDING', verification: 'UNVERIFIED', amount: '20000' });
    const docs = await documentsOf(verified.id);
    expect([await balance('1115', docs), await balance('1110', docs), await balance('1120', docs), await balance('1200', docs)]).toEqual([20_000, 0, 0, 0]);
    expect(await linesOn('1110')).toBe(0);
    const brk = await breakOf(tender.id);
    expect(brk).toMatchObject({ status: 'OPEN', details: { severity: 'REVIEW', unverifiedWindowDays: 3 } });
  });

  it('refuses to close the break while the tender waits, and refuses a cashier and a storekeeper', async () => {
    const brk = await breakOf((await tenderOf(verified.id)).id);
    const bare = await post('accountant', `/reconciliation/breaks/${brk.id}/resolve`, { note: 'Looked at it' });
    expect([bare.status, bare.body.error.code, bare.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, 'RECONCILIATION_INVALID', ['VERIFICATION_REQUIRED']]);
    for (const who of ['abena', 'storekeeper']) {
      const refused = await post(who, `/reconciliation/breaks/${brk.id}/resolve`, { note: 'Paid, I saw the message', posting: 'VERIFIED' });
      expect(refused.status).toBe(403);
    }
    expect(await num("SELECT count(*)::text AS n FROM pay.break_resolution WHERE break_id = $1", [brk.id])).toBe(0);
  });

  it('moves it to 1110 once a second person approves the verification: Dr 1110 20,000, Cr 1115 20,000, against the wallet', async () => {
    const tender = await tenderOf(verified.id);
    const brk = await breakOf(tender.id);
    const asked = await post('accountant', `/reconciliation/breaks/${brk.id}/resolve`, { note: 'MTN merchant statement shows MP261113.1149.C41872 for GHS 200.00', posting: 'VERIFIED' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const docs = await documentsOf(verified.id);
    expect([await balance('1115', docs), await balance('1110', docs)]).toEqual([20_000, 0]);
    // The maker cannot check it; a manager with a fresh step-up can.
    const own = await approve('accountant', asked.body.approvalRequestId as string);
    expect(own.status).toBe(403);
    const approved = await approve('manager', asked.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect([await balance('1115', docs), await balance('1110', docs), await balance('1200', docs)]).toEqual([0, 20_000, 0]);
    const lines = await rows<{ code: string; side: string; amount: string; party: string }>(
      `SELECT a.code, l.side, l.amount_pesewas::text AS amount, sp.ref_id AS party FROM fin.journal_line l JOIN fin.journal_entry e ON e.id = l.journal_entry_id
         JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party sp ON sp.id = l.subledger_party_id
        WHERE e.event_code = 'pay.UnverifiedPaymentVerified' AND e.source_document_id = $1 ORDER BY l.side DESC`,
      [tender.id],
    );
    expect(lines).toEqual([
      { code: '1110', side: 'D', amount: '20000', party: wallet },
      { code: '1115', side: 'C', amount: '20000', party: wallet },
    ]);
    expect(await one('SELECT amount_pesewas::text AS amount, break_id FROM pay.unverified_verification WHERE payment_id = $1', [tender.id])).toEqual({ amount: '20000', break_id: brk.id });
    expect((await breakOf(tender.id)).status).toBe('RESOLVED');
    // The payment row itself is unchanged: a payment never cleared unverified (ck_payment_verified).
    expect(await tenderOf(verified.id)).toMatchObject({ status: 'PENDING', verification: 'UNVERIFIED' });
  });

  it('posts nothing on a second verification attempt, by the operation or by SQL, and no longer bounces it', async () => {
    const tender = await tenderOf(verified.id);
    const brk = await breakOf(tender.id);
    const again = await post('accountant', `/reconciliation/breaks/${brk.id}/resolve`, { note: 'Again', posting: 'VERIFIED' });
    expect([again.status, again.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['BREAK_NOT_OPEN']]);
    const resolution = await one<{ id: string }>("SELECT id FROM pay.break_resolution WHERE break_id = $1 AND status = 'APPROVED'", [brk.id]);
    await expect(
      admin().query("INSERT INTO pay.unverified_verification (id, payment_id, break_id, resolution_id, branch_id, amount_pesewas, verified_on, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, 20000, CURRENT_DATE, $6, $7)", [nextId(), tender.id, brk.id, resolution.id, id('branch'), clock.now(), SYSTEM_PRINCIPAL]),
    ).rejects.toMatchObject({ constraint: 'uq_unverified_verification_payment' });
    expect(await num("SELECT count(*)::text AS n FROM fin.journal_entry WHERE event_code = 'pay.UnverifiedPaymentVerified' AND source_document_id = $1", [tender.id])).toBe(1);
    const bounce = await post('manager', `/payments/${tender.id}/reverse`, { reasonCode: 'MOBILE_MONEY_NOT_RECEIVED', note: 'Customer says it bounced' });
    expect([bounce.status, bounce.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['NOT_REVERSIBLE', 'REASON_NOT_FOR_METHOD']]);
    await expect(admin().query("UPDATE pay.payment SET status = 'FAILED', failure_reason = 'x' WHERE id = $1", [tender.id])).rejects.toMatchObject({ constraint: 'ck_payment_verified_bounce' });
    await expect(admin().query('UPDATE pay.unverified_verification SET amount_pesewas = 1 WHERE payment_id = $1', [tender.id])).rejects.toThrow();
    await expect(admin().query('DELETE FROM pay.unverified_verification WHERE payment_id = $1', [tender.id])).rejects.toThrow();
    const docs = await documentsOf(verified.id);
    expect([await balance('1115', docs), await balance('1110', docs)]).toEqual([0, 20_000]);
  });
});

describe('a verification that never comes, and a tender refused as never received', () => {
  let waiting: TillSale;

  it('stays in 1115 past pay.unverified_window_days and is raised URGENT once, exactly when the window ends', async () => {
    waiting = tillSale({ till: 'V1', shiftSeq: shift.seq, counter: 2, at: ago(60 * MINUTE), lines: [crateLine(1)], tenders: [momo(6_000, 'MP261113.1300.C42000')] });
    expect((await sync([waiting])).status).toBe(200);
    const tender = await tenderOf(waiting.id);
    const brk = await breakOf(tender.id);
    const urgentFrom = new Date(new Date(waiting.occurredAt).getTime() + 3 * DAY);
    expect(brk.details['urgentFrom']).toBe(urgentFrom.toISOString());
    // A minute before the window ends: nothing raised.
    clock.set(new Date(urgentFrom.getTime() - MINUTE));
    expect(await overdue()).toEqual([]);
    clock.set(urgentFrom);
    expect(await overdue()).toEqual([brk.id]);
    expect(await overdue()).toEqual([]);
    clock.advanceBy(2 * DAY);
    expect(await overdue()).toEqual([]);
    expect(await num('SELECT count(*)::text AS n FROM pay.unverified_overdue WHERE break_id = $1', [brk.id])).toBe(1);
    const raised = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM platform.outbox_message WHERE event_type = 'pay.UnverifiedPaymentOverdue' AND subject_id = $1", [brk.id]);
    expect(raised.map((r) => r.payload)).toEqual([expect.objectContaining({ paymentId: tender.id, amountPesewas: 6_000, exceptionKind: 'UNMATCHED_PAYMENT', severity: 'URGENT', abuseCases: [4], urgentFrom: urgentFrom.toISOString() })]);
    const docs = await documentsOf(waiting.id);
    expect([await balance('1115', docs), await balance('1110', docs), await balance('1200', docs)]).toEqual([6_000, 0, 0]);
    expect((await breakOf(tender.id)).status).toBe('OPEN');
    // The verified tender of the first block was never raised: it left 1115 before its window ended.
    expect(await num('SELECT count(*)::text AS n FROM pay.unverified_overdue')).toBe(1);
  });

  it('refused as never received, it is bounced on a second person’s approval: Dr 1200, Cr 1115, and 1110 is never touched', async () => {
    const tender = await tenderOf(waiting.id);
    const linesOn1110 = await linesOn('1110');
    const asked = await post('manager', `/payments/${tender.id}/reverse`, { reasonCode: 'MOBILE_MONEY_NOT_RECEIVED', note: 'Not on the MTN merchant statement for three days' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const approved = await approve('owner', asked.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await tenderOf(waiting.id)).toMatchObject({ status: 'FAILED', failure_reason: 'Mobile money not received: Not on the MTN merchant statement for three days' });
    const docs = await documentsOf(waiting.id);
    // The receipt's Dr 1200 6,000 stands again (the receivable restored), 1115 back to nothing, 1110 never posted.
    expect([await balance('1115', docs), await balance('1110', docs), await balance('1200', docs)]).toEqual([0, 0, 6_000]);
    expect(await linesOn('1110')).toBe(linesOn1110);
    const receipt = await one<{ outstanding: string }>('SELECT s.outstanding_pesewas::text AS outstanding FROM bil.billing_document d JOIN bil.document_settlement s ON s.billing_document_id = d.id WHERE d.order_document_id = $1', [waiting.id]);
    expect(receipt.outstanding).toBe('6000');
    // Verified now is refused; the break may be closed with a note, as the tender has left 1115.
    const brk = await breakOf(tender.id);
    const verify = await post('accountant', `/reconciliation/breaks/${brk.id}/resolve`, { note: 'Paid after all', posting: 'VERIFIED' });
    expect([verify.status, verify.body.error.details.map((d: { code: string }) => d.code)]).toEqual([422, ['TENDER_NOT_PENDING']]);
    const close = await post('accountant', `/reconciliation/breaks/${brk.id}/resolve`, { note: 'Reversed as never received; the receivable is the customer’s' });
    expect(close.status, JSON.stringify(close.body)).toBe(202);
  });

  it('holds in the database: an overdue row only for an open break still waiting, a verification only through its approved resolution, both insert-only', async () => {
    const tender = await tenderOf(waiting.id);
    const brk = await breakOf(tender.id);
    await expect(
      admin().query('INSERT INTO pay.unverified_overdue (id, break_id, payment_id, branch_id, amount_pesewas, urgent_from, recorded_at, actor_id) VALUES ($1, $2, $3, $4, 6000, $5, $5, $6)', [nextId(), nextId(), tender.id, id('branch'), clock.now(), SYSTEM_PRINCIPAL]),
    ).rejects.toThrow();
    const fresh = tillSale({ till: 'V1', shiftSeq: shift.seq, counter: 3, at: ago(10 * MINUTE), lines: [crateLine(1)], tenders: [momo(6_000, 'MP261116.0900.C43001')] });
    expect((await sync([fresh])).status).toBe(200);
    const freshTender = await tenderOf(fresh.id);
    const freshBreak = await breakOf(freshTender.id);
    // Not yet due: the window has not ended (ck_unverified_overdue_due).
    await expect(
      admin().query('INSERT INTO pay.unverified_overdue (id, break_id, payment_id, branch_id, amount_pesewas, urgent_from, recorded_at, actor_id) VALUES ($1, $2, $3, $4, 6000, $5, $6, $7)', [nextId(), freshBreak.id, freshTender.id, id('branch'), new Date(clock.now().getTime() + DAY), clock.now(), SYSTEM_PRINCIPAL]),
    ).rejects.toMatchObject({ constraint: 'ck_unverified_overdue_due' });
    // A verification of the bounced tender, through another break's resolution: refused.
    const resolution = await one<{ id: string }>("SELECT id FROM pay.break_resolution WHERE status = 'APPROVED' AND posting = 'VERIFIED' LIMIT 1");
    await expect(
      admin().query('INSERT INTO pay.unverified_verification (id, payment_id, break_id, resolution_id, branch_id, amount_pesewas, verified_on, recorded_at, actor_id) VALUES ($1, $2, $3, $4, $5, 6000, CURRENT_DATE, $6, $7)', [nextId(), freshTender.id, freshBreak.id, resolution.id, id('branch'), clock.now(), SYSTEM_PRINCIPAL]),
    ).rejects.toMatchObject({ constraint: 'ck_unverified_verification' });
    await expect(admin().query('UPDATE pay.unverified_overdue SET amount_pesewas = 1 WHERE break_id = $1', [brk.id])).rejects.toThrow();
    await expect(admin().query('DELETE FROM pay.unverified_overdue WHERE break_id = $1', [brk.id])).rejects.toThrow();
    expect(await balance('1115', await documentsOf(fresh.id))).toBe(6_000);
  });
});
