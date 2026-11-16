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
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { CleanScanner } from '../../support/imports';
import { startTestApp, TEST_PUBLIC_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B09a continued 1c reconciliation operations answer in the shapes of contract/openapi.yaml, refusals included. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let scanner: FileScanner;
let accountant: TestSession;
let cashier: TestSession;
let gcb: string;
let transferMethod: string;
let tema: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

async function upload(rows: string[][]): Promise<string> {
  const content = Buffer.from(`${rows.map((r) => r.join(',')).join('\r\n')}\r\n`);
  const response = await consolePost(api.server, accountant, '/v1/files').field('purpose', 'IMPORT').attach('file', content, { filename: 'reconciliation.csv', contentType: 'application/octet-stream' });
  expect(response.status).toBe(201);
  await scanner.scanPending(50);
  return response.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const workerPool = database.pool('worker');
  scanner = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
  const admin = database.pool('admin');
  const branchId = (await admin.query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  gcb = (await admin.query<{ id: string }>("SELECT id FROM fin.bank_account WHERE name = 'GCB current account (SEED)'")).rows[0]!.id;
  transferMethod = (await admin.query<{ id: string }>("SELECT id FROM mdm.payment_method WHERE code = 'BANK_TRANSFER'")).rows[0]!.id;
  tema = (await admin.query<{ id: string }>('SELECT id FROM mdm.customer WHERE name = $1', ['Tema Cold Store Ltd (SEED)'])).rows[0]!.id;
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  cashier = await login(api.server, await createUser(database, { name: 'Adwoa Darko', grants: [{ role: 'CASHIER', branchId }] }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the reconciliation operations in the contract’s shapes (FR-PAY-016, FR-PAY-017)', () => {
  it('answers settlement reports, bank statements, line matches, breaks and resolutions as the contract says', async () => {
    const today = toBusinessDate(clock.now());
    const settlementFile = await upload([
      ['settlement_ref', 'settled_on', 'reference', 'amount', 'fee'],
      ['STL-60001', today, 'T7730994017', '180.00', '3.51'],
    ]);
    const imported = await consolePost(api.server, accountant, '/v1/reconciliation/settlement-reports').send({ provider: 'PAYSTACK', fileId: settlementFile, bankAccountId: gcb });
    expect(imported.status).toBe(202);
    expectShape('SettlementReport', imported.body);
    const matched = await consolePost(api.server, accountant, `/v1/reconciliation/settlement-reports/${imported.body.id as string}/match`).send({});
    expect(matched.status).toBe(200);
    expectShape('SettlementReport', matched.body);
    expectShape('SettlementReport', (await consoleGet(api.server, accountant, `/v1/reconciliation/settlement-reports/${imported.body.id as string}`)).body);
    expectShape('SettlementReportPage', (await consoleGet(api.server, accountant, '/v1/reconciliation/settlement-reports?status=HAS_BREAKS')).body);

    const transferId = randomUUID();
    expect((await consolePost(api.server, accountant, '/v1/payments').send({ id: transferId, paymentMethodId: transferMethod, amountPesewas: 75_000, customerId: tema, bankAccountId: gcb, externalReference: 'HK-INV-0042', receivedAt: clock.now().toISOString() })).status).toBe(201);
    const statementFile = await upload([
      ['value_date', 'direction', 'amount', 'balance', 'reference', 'narration'],
      [today, 'IN', '750.00', '10750.00', 'TRF HK-INV-0042', 'Tema Cold Store transfer'],
      [today, 'OUT', '25.00', '10725.00', '', 'Bank charges'],
    ]);
    const statement = await consolePost(api.server, accountant, '/v1/reconciliation/bank-statements').send({ bankAccountId: gcb, fileId: statementFile, periodStart: today, periodEnd: today });
    expect(statement.status).toBe(202);
    expectShape('BankStatement', statement.body);
    const auto = await consolePost(api.server, accountant, `/v1/reconciliation/bank-statements/${statement.body.id as string}/match`).send({});
    expect(auto.status).toBe(200);
    expectShape('BankStatement', auto.body);
    expectShape('BankStatement', (await consoleGet(api.server, accountant, `/v1/reconciliation/bank-statements/${statement.body.id as string}`)).body);
    expectShape('BankStatementPage', (await consoleGet(api.server, accountant, '/v1/reconciliation/bank-statements')).body);
    const lineRefused = await consolePost(api.server, accountant, `/v1/bank-statement-lines/${auto.body.lines[1].id as string}/match`).send({ paymentId: transferId });
    expect(lineRefused.status).toBe(422);
    expectShape('Error', lineRefused.body);

    const breaks = await consoleGet(api.server, accountant, '/v1/reconciliation/breaks?status=OPEN');
    expect(breaks.status).toBe(200);
    expectShape('ReconciliationBreakPage', breaks.body);
    const oneBreak = breaks.body.data[0] as { id: string };
    expectShape('ReconciliationBreak', (await consoleGet(api.server, accountant, `/v1/reconciliation/breaks/${oneBreak.id}`)).body);
    const resolution = await consolePost(api.server, accountant, `/v1/reconciliation/breaks/${oneBreak.id}/resolve`).send({ note: 'Checked with the bank' });
    expect(resolution.status).toBe(202);
    expectShape('ApprovalPending', resolution.body);
    const duplicate = await consolePost(api.server, accountant, '/v1/reconciliation/settlement-reports').send({ provider: 'PAYSTACK', fileId: settlementFile, bankAccountId: gcb });
    expect(duplicate.status).toBe(422);
    expectShape('Error', duplicate.body);
    const forbidden = await consoleGet(api.server, cashier, '/v1/reconciliation/breaks');
    expect(forbidden.status).toBe(403);
    expectShape('Error', forbidden.body);
  });
});
