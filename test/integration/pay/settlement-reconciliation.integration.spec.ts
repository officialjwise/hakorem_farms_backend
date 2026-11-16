import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileScanner } from '../../../src/platform/storage/file-scanner';
import { SharpImageRenderer } from '../../../src/platform/storage/image-renderer';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { paystackEnvironment, startFakePaystack, type FakePaystack } from '../../support/fake-paystack';
import { stepUp, type TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { CleanScanner } from '../../support/imports';
import { approveAndDeliver, initiateCharge, journalCount, journalOf, referenceFor, trialBalanceSum } from '../../support/pay';
import { startTestApp, TEST_PUBLIC_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Settlement reports, bank statements and the break queue (FR-PAY-005, FR-PAY-010, FR-PAY-011, FR-PAY-016,
 * FR-PAY-017, ADR-0065). A settlement of three payments totalling 150,000 with a fee of 1,500 matches all three and
 * posts Dr 1100 148,500, Dr 6910 1,500, Cr 1120 150,000, and an extra line of 2,000 nobody paid for raises a break; a
 * bank transfer recorded PENDING clears into 1100 only from its matched statement line; a line nothing matches raises
 * BANK_LINE_UNMATCHED; a break resolves only through a different person's approved posting (2290 for an unidentified
 * receipt). Every amount is asserted to the pesewa; the trial balance still sums to zero.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let fake: FakePaystack;
let scanner: FileScanner;
let branchId: string;
const sessions = new Map<string, TestSession>();
const users = new Map<string, TestUser>();
const ids = new Map<string, string>();
const id = (name: string) => ids.get(name)!;
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const step = (who: string) => stepUp(api.server, as(who) as TotpSession, clock);
const today = () => toBusinessDate(clock.now());
const GCB = 'GCB current account (SEED)';
const TEMA = 'Tema Cold Store Ltd (SEED)';
const codes = (body: { error: { details: { code: string }[] } }) => body.error.details.map((d) => d.code).sort();

async function upload(who: string, rows: string[][], name = 'statement.csv'): Promise<string> {
  const content = Buffer.from(`${rows.map((r) => r.join(',')).join('\r\n')}\r\n`);
  const response = await consolePost(api.server, as(who), '/v1/files').field('purpose', 'IMPORT').attach('file', content, { filename: name, contentType: 'application/octet-stream' });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  await scanner.scanPending(50);
  return response.body.id as string;
}

/** A mobile money payment of `amount`, cleared on the provider's own webhook into 1120 (Paystack) and 2200. */
async function clearedMomo(amount: number): Promise<string> {
  const started = await initiateCharge(api.server, as('cashier'), { amountPesewas: amount, customerId: id('tema') });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  expect((await approveAndDeliver(api.server, fake, referenceFor(started.body.id as string))).status).toBe(200);
  return started.body.id as string;
}

async function transfer(amount: number, externalReference: string): Promise<string> {
  const body = { id: randomUUID(), paymentMethodId: id('BANK_TRANSFER'), amountPesewas: amount, customerId: id('tema'), bankAccountId: id('gcb'), externalReference, receivedAt: clock.now().toISOString() };
  const recorded = await post('accountant', '/payments', body);
  expect([recorded.status, recorded.body.status], JSON.stringify(recorded.body)).toEqual([201, 'PENDING']);
  return body.id;
}

async function paymentStatus(paymentId: string): Promise<string> {
  return (await admin().query<{ status: string }>('SELECT status FROM pay.payment WHERE id = $1', [paymentId])).rows[0]!.status;
}

async function breakOf(column: 'settlement_line_id' | 'bank_statement_line_id', lineId: string): Promise<{ id: string; kind: string; amount: number; status: string; details: Record<string, unknown> }> {
  const { rows } = await admin().query<{ id: string; kind: string; amount: string; status: string; details: Record<string, unknown> }>(
    `SELECT id, kind, amount_pesewas::text AS amount, status, details FROM pay.reconciliation_break WHERE ${column} = $1`,
    [lineId],
  );
  expect(rows).toHaveLength(1);
  return { ...rows[0]!, amount: Number(rows[0]!.amount) };
}

async function approve(who: string, approvalRequestId: string) {
  await step(who);
  return post(who, `/iam/approvals/${approvalRequestId}/approve`, { reason: 'Checked against the provider and the bank' });
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  fake = await startFakePaystack(() => clock.now());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { ...paystackEnvironment(fake), AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const workerPool = database.pool('worker');
  scanner = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  for (const [name, sql, value] of [
    ['tema', 'SELECT id FROM mdm.customer WHERE name = $1', TEMA],
    ['gcb', 'SELECT id FROM fin.bank_account WHERE name = $1', GCB],
    ['wallet', 'SELECT id FROM fin.bank_account WHERE name = $1', 'MTN MoMo merchant wallet (SEED)'],
    ['BANK_TRANSFER', 'SELECT id FROM mdm.payment_method WHERE code = $1', 'BANK_TRANSFER'],
  ] as const) {
    ids.set(name, (await admin().query<{ id: string }>(sql, [value])).rows[0]!.id);
  }
  const people: [string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', true],
    ['cashier', 'Adwoa Darko', 'CASHIER', false],
    ['sales', 'Kofi Mensah', 'SALES', false],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', false],
  ];
  for (const [who, name, role, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId }] });
    users.set(who, user);
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await fake?.close();
  await database?.drop();
});

describe('a provider settlement matches line by line and posts only what matched (FR-PAY-016)', () => {
  it('matches three payments of 150,000 with a fee of 1,500: Dr 1100 148,500, Dr 6910 1,500, Cr 1120 150,000, and breaks on the extra 2,000', async () => {
    const [a, b, c] = [await clearedMomo(50_000), await clearedMomo(40_000), await clearedMomo(60_000)];
    ids.set('momoA', a);
    const settledOn = today();
    const file = await upload('accountant', [
      ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'],
      ['STL-50001', settledOn, referenceFor(a), '500.00', '5.00'],
      ['STL-50001', settledOn, referenceFor(b), '400.00', '4.00'],
      ['STL-50001', settledOn, referenceFor(c), '600.00', '6.00'],
      ['STL-50001', settledOn, 'T7730994017', '20.00', '0.00'],
    ]);
    ids.set('settlementFile', file);
    const imported = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: file, bankAccountId: id('gcb') });
    expect(imported.status, JSON.stringify(imported.body)).toBe(202);
    expect(imported.body).toMatchObject({ settlementRef: 'STL-50001', settledOn, grossPesewas: 152_000, feePesewas: 1_500, netPesewas: 150_500, status: 'IMPORTED', matchedCount: 0, breakCount: 0, bankAccount: { id: id('gcb'), kind: 'BANK' } });
    expect(imported.body.lines.map((l: { matchStatus: string }) => l.matchStatus)).toEqual(['UNMATCHED', 'UNMATCHED', 'UNMATCHED', 'UNMATCHED']);
    const reportId = imported.body.id as string;
    ids.set('report', reportId);
    expect(await journalOf(database, reportId)).toEqual([]);

    const key = randomUUID();
    const matched = await post('accountant', `/reconciliation/settlement-reports/${reportId}/match`, {}, key);
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect(matched.body).toMatchObject({ status: 'HAS_BREAKS', matchedCount: 3, breakCount: 1 });
    expect(matched.body.lines.map((l: { matchStatus: string; matchedPayment: { id: string } | null }) => [l.matchStatus, l.matchedPayment?.id ?? null])).toEqual([
      ['MATCHED', a],
      ['MATCHED', b],
      ['MATCHED', c],
      ['NOT_FOUND', null],
    ]);
    expect(await journalOf(database, reportId, 'pay.ProviderSettled')).toEqual([
      ['1100', 'D', 148_500, GCB],
      ['6910', 'D', 1_500, null],
      ['1120', 'C', 150_000, 'Paystack'],
    ]);
    const extra = await breakOf('settlement_line_id', matched.body.lines[3].id as string);
    expect(extra).toMatchObject({ kind: 'SETTLEMENT_NOT_FOUND', amount: 2_000, status: 'OPEN', details: { reason: 'NO_PAYMENT', settlementRef: 'STL-50001', lineAmountPesewas: 2_000 } });
    ids.set('extraBreak', extra.id);
    ids.set('extraLine', matched.body.lines[3].id as string);
    const published = await database.pool('report').query<{ kind: string; amount: string }>('SELECT kind, amount_pesewas::text AS amount FROM pay.pub_reconciliation_break WHERE id = $1', [extra.id]);
    expect(published.rows).toEqual([{ kind: 'SETTLEMENT_NOT_FOUND', amount: '2000' }]);

    // A replay answers the same; a second match with a new key posts nothing more.
    const replay = await post('accountant', `/reconciliation/settlement-reports/${reportId}/match`, {}, key);
    expect([replay.status, replay.body]).toEqual([200, matched.body]);
    const again = await post('accountant', `/reconciliation/settlement-reports/${reportId}/match`);
    expect([again.status, codes(again.body)]).toEqual([422, ['ALREADY_MATCHED']]);
    expect(await journalCount(database, reportId, 'pay.ProviderSettled')).toBe(1);
  });

  it('imports a file once: the same file, the same content uploaded again, or a reference already settled posts nothing', async () => {
    const same = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: id('settlementFile'), bankAccountId: id('gcb') });
    expect([same.status, codes(same.body)]).toEqual([422, ['ALREADY_IMPORTED']]);
    const settledOn = today();
    const again = await upload('accountant', [
      ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'],
      ['STL-50002', settledOn, referenceFor(id('momoA')), '500.00', '5.00'],
    ]);
    const repeated = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: again, bankAccountId: id('gcb') });
    expect([repeated.status, repeated.body.error.details]).toEqual([422, [expect.objectContaining({ field: '/file/rows/2', code: 'REFERENCE_ALREADY_SETTLED' })]]);
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM pay.settlement_report WHERE provider = 'PAYSTACK'");
    expect(rows[0]!.n).toBe(1);
  });

  it('raises a difference for the right payment at another amount, and never clears a payment the provider has not confirmed', async () => {
    const d = await clearedMomo(30_000);
    const pending = await initiateCharge(api.server, as('cashier'), { amountPesewas: 9_000, customerId: id('tema') });
    expect(pending.status).toBe(201);
    const file = await upload('accountant', [
      ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'],
      ['STL-50003', today(), referenceFor(d), '300.01', '3.00'],
      ['STL-50003', today(), referenceFor(pending.body.id as string), '90.00', '0.90'],
    ]);
    const imported = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: file, bankAccountId: id('gcb') });
    expect(imported.status).toBe(202);
    const matched = await post('accountant', `/reconciliation/settlement-reports/${imported.body.id as string}/match`);
    expect(matched.body).toMatchObject({ status: 'HAS_BREAKS', matchedCount: 0, breakCount: 2 });
    expect(await breakOf('settlement_line_id', matched.body.lines[0].id as string)).toMatchObject({ kind: 'SETTLEMENT_AMOUNT_DIFFERS', amount: 1, details: { reason: 'AMOUNT_DIFFERS', paymentAmountPesewas: 30_000, lineAmountPesewas: 30_001 } });
    expect(await breakOf('settlement_line_id', matched.body.lines[1].id as string)).toMatchObject({ kind: 'SETTLEMENT_NOT_FOUND', amount: 9_000, details: { reason: 'NOT_CLEARED', paymentStatus: 'PENDING' } });
    expect(await paymentStatus(pending.body.id as string)).toBe('PENDING');
    expect(await journalOf(database, imported.body.id as string)).toEqual([]);
  });

  it('refuses a broken file, a wallet as the payout account, and a missing account, naming each', async () => {
    const broken = await upload('accountant', [
      ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'],
      ['STL-50004', today(), 'HK-x1', '15.0', '0.00'],
      ['STL-50004', today(), 'HK-x2', '1.00', '2.00'],
    ]);
    const refused = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: broken, bankAccountId: id('wallet') });
    expect([refused.status, refused.body.error.code, codes(refused.body)]).toEqual([422, 'RECONCILIATION_INVALID', ['AMOUNT_INVALID', 'BANK_ACCOUNT_NOT_USABLE', 'FEE_EXCEEDS_AMOUNT']]);
    const noAccount = await post('accountant', '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: broken });
    expect(codes(noAccount.body)).toContain('BANK_ACCOUNT_REQUIRED');
  });

  it('holds a matched line once in the database: no second line for a payment, no edit of a matched line, no report re-opened', async () => {
    const reportId = id('report');
    const { rows } = await admin().query<{ id: string; matched_payment_id: string | null }>('SELECT id, matched_payment_id FROM pay.settlement_line WHERE settlement_report_id = $1 ORDER BY line_no', [reportId]);
    await expect(app().query("UPDATE pay.settlement_line SET match_status = 'NOT_FOUND', match_reason = 'NO_PAYMENT', matched_payment_id = NULL WHERE id = $1", [rows[0]!.id])).rejects.toMatchObject({ constraint: 'ck_settlement_line_transition' });
    await expect(app().query("UPDATE pay.settlement_report SET status = 'IMPORTED', matched_at = NULL, matched_by = NULL WHERE id = $1", [reportId])).rejects.toMatchObject({ constraint: 'ck_settlement_report_transition' });
    await expect(app().query('UPDATE pay.settlement_report SET net_pesewas = net_pesewas + 1, gross_pesewas = gross_pesewas + 1 WHERE id = $1', [reportId])).rejects.toMatchObject({ constraint: 'ck_settlement_report_transition' });
    await expect(app().query('DELETE FROM pay.settlement_line WHERE id = $1', [rows[0]!.id])).rejects.toThrow(/permission denied/);
  });
});

describe('a bank statement clears a pending transfer only from its line, never on amount alone (FR-PAY-005, FR-PAY-011, FR-PAY-016)', () => {
  it('clears a transfer of 75,000 from its line (Dr 1100, Cr 2200), links the settlement payout, and breaks on the rest', async () => {
    const t = await transfer(75_000, 'HK-INV-0042');
    ids.set('transfer', t);
    expect(await journalOf(database, t)).toEqual([]);
    const period = { periodStart: today(), periodEnd: today() };
    const file = await upload('accountant', [
      ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'],
      [today(), 'IN', '750.00', '10750.00', 'TRF HK-INV-0042', 'Tema Cold Store transfer'],
      [today(), 'IN', '1505.00', '12255.00', 'STL-50001', 'PAYSTACK SETTLEMENT'],
      [today(), 'IN', '20.00', '12275.00', '', 'CASH DEPOSIT UNKNOWN'],
      [today(), 'OUT', '25.00', '12250.00', '', 'Bank charges'],
    ]);
    const imported = await post('accountant', '/reconciliation/bank-statements', { bankAccountId: id('gcb'), fileId: file, ...period });
    expect(imported.status, JSON.stringify(imported.body)).toBe(202);
    expect(imported.body).toMatchObject({ openingPesewas: 1_000_000, closingPesewas: 1_225_000, status: 'IMPORTED', lineCount: 4, unmatchedCount: 4 });
    expect(await paymentStatus(t)).toBe('PENDING');
    const statementId = imported.body.id as string;
    ids.set('statement', statementId);

    const matched = await post('accountant', `/reconciliation/bank-statements/${statementId}/match`);
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect(matched.body).toMatchObject({ status: 'HAS_BREAKS', unmatchedCount: 2 });
    const [transferLine, payoutLine, unknownLine, chargesLine] = matched.body.lines as { id: string; matchStatus: string; matchedJournalEntryId: string | null }[];
    expect(await paymentStatus(t)).toBe('CLEARED');
    expect(await journalOf(database, t, 'pay.PaymentCleared')).toEqual([
      ['1100', 'D', 75_000, GCB],
      ['2200', 'C', 75_000, TEMA],
    ]);
    const clearing = await admin().query<{ id: string; posting_date: string }>("SELECT id, posting_date::text FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'pay.PaymentCleared'", [t]);
    expect(transferLine).toMatchObject({ matchStatus: 'MATCHED', matchedJournalEntryId: clearing.rows[0]!.id });
    expect(clearing.rows[0]!.posting_date).toBe(today());
    const payout = await admin().query<{ id: string }>("SELECT id FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'pay.ProviderSettled'", [id('report')]);
    expect(payoutLine).toMatchObject({ matchStatus: 'MATCHED', matchedJournalEntryId: payout.rows[0]!.id });
    expect(await breakOf('bank_statement_line_id', unknownLine!.id)).toMatchObject({ kind: 'BANK_LINE_UNMATCHED', amount: 2_000, details: { reason: 'NO_CANDIDATE', direction: 'IN' } });
    expect(await breakOf('bank_statement_line_id', chargesLine!.id)).toMatchObject({ kind: 'BANK_LINE_UNMATCHED', amount: 2_500, details: { reason: 'NO_CANDIDATE', direction: 'OUT' } });
    ids.set('unknownLine', unknownLine!.id);
    ids.set('chargesLine', chargesLine!.id);
    // Run again: nothing new is matched, no break is raised twice, nothing posts twice.
    const rerun = await post('accountant', `/reconciliation/bank-statements/${statementId}/match`);
    expect(rerun.body).toMatchObject({ status: 'HAS_BREAKS', unmatchedCount: 2 });
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM pay.reconciliation_break WHERE source_document_id = $1', [statementId])).rows[0]!.n).toBe(2);
    expect(await journalCount(database, t, 'pay.PaymentCleared')).toBe(1);
  });

  it('raises a break for two transfers of the same reference and amount, then matches one by hand', async () => {
    const yesterday = toBusinessDate(new Date(clock.now().getTime() - 86_400_000));
    const [first, second] = [await transfer(10_000, 'HK-TIE-0001'), await transfer(10_000, 'HK-TIE-0001')];
    const file = await upload('accountant', [
      ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'],
      [yesterday, 'IN', '100.00', '10100.00', 'HK-TIE-0001', 'Transfer'],
      [yesterday, 'IN', '99.99', '10199.99', 'HK-INV-0099', 'Transfer'],
    ]);
    const imported = await post('accountant', '/reconciliation/bank-statements', { bankAccountId: id('gcb'), fileId: file, periodStart: yesterday, periodEnd: yesterday });
    expect(imported.status, JSON.stringify(imported.body)).toBe(202);
    const matched = await post('accountant', `/reconciliation/bank-statements/${imported.body.id as string}/match`);
    const [tieLine, otherLine] = matched.body.lines as { id: string }[];
    expect(await breakOf('bank_statement_line_id', tieLine!.id)).toMatchObject({ kind: 'BANK_LINE_UNMATCHED', details: { reason: 'CANDIDATES_TIE' } });
    expect(await breakOf('bank_statement_line_id', otherLine!.id)).toMatchObject({ details: { reason: 'NO_CANDIDATE' } });
    expect([await paymentStatus(first), await paymentStatus(second)]).toEqual(['PENDING', 'PENDING']);

    const wrongAmount = await post('accountant', `/bank-statement-lines/${otherLine!.id}/match`, { paymentId: second });
    expect([wrongAmount.status, codes(wrongAmount.body)]).toEqual([422, ['AMOUNT_DIFFERS']]);
    const both = await post('accountant', `/bank-statement-lines/${tieLine!.id}/match`, { paymentId: first, journalEntryId: randomUUID() });
    expect(codes(both.body)).toEqual(['PAYMENT_OR_JOURNAL_ENTRY']);
    const byHand = await post('accountant', `/bank-statement-lines/${tieLine!.id}/match`, { paymentId: first });
    expect(byHand.status, JSON.stringify(byHand.body)).toBe(200);
    expect(await paymentStatus(first)).toBe('CLEARED');
    expect(await journalOf(database, first, 'pay.PaymentCleared')).toEqual([
      ['1100', 'D', 10_000, GCB],
      ['2200', 'C', 10_000, TEMA],
    ]);
    const twice = await post('accountant', `/bank-statement-lines/${tieLine!.id}/match`, { paymentId: second });
    expect(codes(twice.body)).toEqual(['LINE_ALREADY_MATCHED']);
    expect(await paymentStatus(second)).toBe('PENDING');
    // The break the tie raised stays open: it is resolved through a second person's approval.
    expect(await breakOf('bank_statement_line_id', tieLine!.id)).toMatchObject({ status: 'OPEN' });
  });

  it('imports a statement once per file and period, and refuses a running balance broken by a pesewa', async () => {
    const overlapping = await upload('accountant', [
      ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'],
      [today(), 'IN', '1.00', '1.00', '', 'x'],
    ]);
    const refused = await post('accountant', '/reconciliation/bank-statements', { bankAccountId: id('gcb'), fileId: overlapping, periodStart: today(), periodEnd: today() });
    expect([refused.status, codes(refused.body)]).toEqual([422, ['ALREADY_IMPORTED']]);
    const broken = await upload('accountant', [
      ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'],
      [today(), 'IN', '1.00', '1.00', '', 'x'],
      [today(), 'IN', '1.00', '2.01', '', 'y'],
    ]);
    const unbalanced = await post('accountant', '/reconciliation/bank-statements', { bankAccountId: id('wallet'), fileId: broken, periodStart: today(), periodEnd: today() });
    expect(codes(unbalanced.body)).toEqual(['BALANCE_BROKEN', 'BANK_ACCOUNT_NOT_USABLE']);
  });

  it('is held by the database: a transfer never clears without its line, a line is matched once, two statements never overlap', async () => {
    const t = await transfer(5_000, 'HK-INV-0100');
    await expect(app().query("UPDATE pay.payment SET status = 'CLEARED', cleared_at = now() WHERE id = $1", [t])).rejects.toMatchObject({ constraint: 'ck_payment_transfer_cleared' });
    await expect(app().query("UPDATE pay.bank_statement_line SET match_status = 'UNMATCHED', matched_payment_id = NULL, matched_at = NULL, matched_by = NULL WHERE matched_payment_id = $1", [id('transfer')])).rejects.toMatchObject({
      constraint: 'ck_bank_statement_line_transition',
    });
    await expect(
      app().query("UPDATE pay.bank_statement_line SET match_status = 'MATCHED', matched_payment_id = $1, matched_at = now(), matched_by = created_by WHERE id = $2", [t, id('unknownLine')]),
    ).rejects.toMatchObject({ constraint: 'ck_bank_statement_line_matched_payment' });
    const docId = randomUUID();
    await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'BANK_STATEMENT', 'pay', $2, $3)", [docId, branchId, users.get('accountant')!.principalId]);
    const fileId = (await admin().query<{ file_id: string }>('SELECT file_id FROM pay.bank_statement WHERE id = $1', [id('statement')])).rows[0]!.file_id;
    await expect(
      app().query(
        `INSERT INTO pay.bank_statement (id, bank_account_id, period_start, period_end, opening_pesewas, closing_pesewas, file_id, file_sha256, branch_id, created_by, updated_by)
         VALUES ($1, $2, $3, $3, 0, 0, $4, $5, $6, $7, $7)`,
        [docId, id('gcb'), today(), fileId, Buffer.alloc(32, 7), branchId, users.get('accountant')!.principalId],
      ),
    ).rejects.toMatchObject({ constraint: 'ex_bank_statement_period' });
  });
});

describe('a break resolves only through a different person’s approved posting (FR-PAY-017)', () => {
  it('holds the 2,000 settlement line nobody paid for in 2290 on the Manager’s approval of the Accountant’s request', async () => {
    const listed = await get('accountant', '/reconciliation/breaks?status=OPEN&kind=SETTLEMENT_NOT_FOUND');
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((b: { id: string }) => b.id)).toContain(id('extraBreak'));
    const one = await get('manager', `/reconciliation/breaks/${id('extraBreak')}`);
    expect(one.body).toMatchObject({ kind: 'SETTLEMENT_NOT_FOUND', branchId, amountPesewas: 2_000, currency: 'GHS', status: 'OPEN', sourceDocument: { id: id('report'), docType: 'SETTLEMENT_REPORT' }, resolvedBy: null });
    const asked = await post('accountant', `/reconciliation/breaks/${id('extraBreak')}/resolve`, { note: 'Not in the Paystack dashboard under any customer; held until the payer comes forward', posting: 'UNIDENTIFIED_RECEIPT' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'RECONCILIATION_BREAK', subject: { docType: 'BREAK_RESOLUTION' } });
    expect(await journalOf(database, id('report'), 'pay.UnidentifiedReceiptHeld')).toEqual([]);
    const again = await post('owner', `/reconciliation/breaks/${id('extraBreak')}/resolve`, { note: 'A second ask' });
    expect([again.status, JSON.stringify(again.body)]).toEqual([422, expect.stringContaining('RESOLUTION_PENDING')]);

    // The Accountant holds no pay.reconciliation.approve; the maker is refused below too (the Owner's own).
    const own = await approve('accountant', asked.body.approvalRequestId as string);
    expect([own.status, own.body.error.code]).toEqual([403, 'FORBIDDEN']);
    clock.advanceBy(360_000); // past the five-minute window of the sign-in's own TOTP
    const noStep = await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Seen' });
    expect([noStep.status, noStep.body.error.code]).toEqual([403, 'STEP_UP_REQUIRED']);
    const approved = await approve('manager', asked.body.approvalRequestId as string);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await journalOf(database, id('report'), 'pay.UnidentifiedReceiptHeld')).toEqual([
      ['1100', 'D', 2_000, GCB],
      ['2290', 'C', 2_000, null],
    ]);
    const resolved = await get('accountant', `/reconciliation/breaks/${id('extraBreak')}`);
    expect(resolved.body).toMatchObject({ status: 'RESOLVED', resolvedBy: { id: users.get('manager')!.principalId }, resolutionNote: 'Not in the Paystack dashboard under any customer; held until the payer comes forward' });
    const closed = await post('accountant', `/reconciliation/breaks/${id('extraBreak')}/resolve`, { note: 'Again', posting: 'UNIDENTIFIED_RECEIPT' });
    expect(codes(closed.body)).toEqual(['BREAK_NOT_OPEN']);
  });

  it('holds the 2,000 deposited by an unknown payer in 2290, and resolves money going out with a note and no posting', async () => {
    const unknown = await breakOf('bank_statement_line_id', id('unknownLine'));
    const charges = await breakOf('bank_statement_line_id', id('chargesLine'));
    const out = await post('accountant', `/reconciliation/breaks/${charges.id}/resolve`, { note: 'Bank charges', posting: 'UNIDENTIFIED_RECEIPT' });
    expect(codes(out.body)).toEqual(['POSTING_NOT_FOR_BREAK']);
    const blank = await post('accountant', `/reconciliation/breaks/${charges.id}/resolve`, { note: '   ' });
    expect(blank.status).toBe(400);
    const held = await post('owner', `/reconciliation/breaks/${unknown.id}/resolve`, { note: 'Cash deposit with no name; held in suspense', posting: 'UNIDENTIFIED_RECEIPT' });
    const self = await approve('owner', held.body.approvalRequestId as string);
    expect([self.status, self.body.error.code]).toEqual([422, 'MAKER_CANNOT_CHECK']);
    expect(await journalOf(database, id('statement'), 'pay.UnidentifiedReceiptHeld')).toEqual([]);
    expect((await approve('manager', held.body.approvalRequestId as string)).status).toBe(200);
    expect(await journalOf(database, id('statement'), 'pay.UnidentifiedReceiptHeld')).toEqual([
      ['1100', 'D', 2_000, GCB],
      ['2290', 'C', 2_000, null],
    ]);
    const noted = await post('accountant', `/reconciliation/breaks/${charges.id}/resolve`, { note: 'Monthly bank charges; the accountant posts them to 6920 by manual journal' });
    expect((await approve('owner', noted.body.approvalRequestId as string)).status).toBe(200);
    expect((await breakOf('bank_statement_line_id', id('chargesLine'))).status).toBe('RESOLVED');
    expect(await journalOf(database, charges.id)).toEqual([]);
  });

  it('is held by the database: no break resolved by hand, no resolution approved by its maker, one suspense entry per line', async () => {
    const open = (await admin().query<{ id: string }>("SELECT id FROM pay.reconciliation_break WHERE status = 'OPEN' AND kind = 'SETTLEMENT_AMOUNT_DIFFERS' LIMIT 1")).rows[0]!.id;
    await expect(
      app().query("UPDATE pay.reconciliation_break SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2, resolution_note = 'by hand', version = version + 1 WHERE id = $1", [open, users.get('accountant')!.principalId]),
    ).rejects.toMatchObject({ constraint: 'ck_reconciliation_break_approved' });
    const asked = await post('accountant', `/reconciliation/breaks/${open}/resolve`, { note: 'Agreed in writing with Paystack' });
    const resolutionId = asked.body.subject.id as string;
    await expect(app().query("UPDATE pay.break_resolution SET status = 'APPROVED', updated_by = created_by, version = version + 1 WHERE id = $1", [resolutionId])).rejects.toMatchObject({ constraint: 'ck_break_resolution_checker' });
    const { rows } = await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM fin.journal_entry WHERE event_code = 'pay.UnidentifiedReceiptHeld' AND event_subject_id = $1", [id('extraLine')]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('the reconciliation writes and reads refuse the wrong role, and the books balance (ADR-0035)', () => {
  it('refuses the Cashier, Sales and the Storekeeper every reconciliation operation, and the Manager the writes', async () => {
    const someBreak = id('extraBreak');
    for (const who of ['cashier', 'sales', 'storekeeper']) {
      expect((await get(who, '/reconciliation/settlement-reports')).status, who).toBe(403);
      expect((await get(who, `/reconciliation/settlement-reports/${id('report')}`)).status, who).toBe(403);
      expect((await get(who, '/reconciliation/bank-statements')).status, who).toBe(403);
      expect((await get(who, `/reconciliation/bank-statements/${id('statement')}`)).status, who).toBe(403);
      expect((await get(who, '/reconciliation/breaks')).status, who).toBe(403);
      expect((await get(who, `/reconciliation/breaks/${someBreak}`)).status, who).toBe(403);
    }
    for (const who of ['cashier', 'sales', 'storekeeper', 'manager']) {
      expect((await post(who, '/reconciliation/settlement-reports', { provider: 'PAYSTACK', fileId: id('settlementFile'), bankAccountId: id('gcb') })).status, who).toBe(403);
      expect((await post(who, `/reconciliation/settlement-reports/${id('report')}/match`)).status, who).toBe(403);
      expect((await post(who, '/reconciliation/bank-statements', { bankAccountId: id('gcb'), fileId: id('settlementFile'), periodStart: today(), periodEnd: today() })).status, who).toBe(403);
      expect((await post(who, `/reconciliation/bank-statements/${id('statement')}/match`)).status, who).toBe(403);
      expect((await post(who, `/bank-statement-lines/${id('unknownLine')}/match`, { paymentId: id('transfer') })).status, who).toBe(403);
      expect((await post(who, `/reconciliation/breaks/${someBreak}/resolve`, { note: 'x' })).status, who).toBe(403);
    }
    expect((await get('manager', '/reconciliation/breaks')).status).toBe(200);
  });

  it('keeps the trial balance at exactly zero and 2290 at exactly the receipts held in suspense', async () => {
    expect(await trialBalanceSum(database)).toBe('0');
    const { rows } = await admin().query<{ balance: string }>(
      "SELECT COALESCE(sum(CASE l.side WHEN 'C' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS balance FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code = '2290'",
    );
    expect(rows[0]!.balance).toBe('4000');
  });
});
