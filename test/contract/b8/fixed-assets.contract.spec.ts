import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import type { TotpSession } from '../../support/fin';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 1c2 operations answer in the shapes of contract/openapi.yaml: the register, a disposal, a run drafted and posted. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let accountant: TotpSession;
let branchId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  branchId = (await createBranch(database)).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 1c2 operations answer in the contract shapes', () => {
  it('the register: create, read, list, change and dispose of an asset', async () => {
    const created = await consolePost(api.server, accountant, '/v1/finance/fixed-assets').send({ name: 'Delivery tricycle', category: 'VEHICLE', branchId, acquiredOn: '2026-03-02', costPesewas: 2_400_000, residualPesewas: 200_000, usefulLifeMonths: 36 });
    expect(created.status).toBe(201);
    expectShape('FixedAsset', created.body);
    const read = await consoleGet(api.server, owner, `/v1/finance/fixed-assets/${created.body.id as string}`);
    expectShape('FixedAsset', read.body);
    const page = await consoleGet(api.server, owner, '/v1/finance/fixed-assets?status=IN_USE&limit=1');
    expect(page.status).toBe(200);
    expectShape('FixedAssetPage', page.body);
    const changed = await request(api.server)
      .patch(`/v1/finance/fixed-assets/${created.body.id as string}`)
      .set('Cookie', accountant.jar.header())
      .set('X-CSRF-Token', accountant.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, usefulLifeMonths: 48 });
    expect(changed.status).toBe(200);
    expectShape('FixedAsset', changed.body);
    const refused = await consolePost(api.server, accountant, '/v1/finance/fixed-assets').send({ name: 'Bad', category: 'VEHICLE', branchId, acquiredOn: '2026-03-02', costPesewas: 1, residualPesewas: 2, usefulLifeMonths: 36 });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const disposed = await consolePost(api.server, accountant, `/v1/finance/fixed-assets/${created.body.id as string}/dispose`).send({ disposedOn: '2026-11-02', proceedsPesewas: 1_500_000, note: 'Sold to a trader in Somanya' });
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
    expectShape('FixedAsset', disposed.body);
  });

  it('a depreciation run: drafted, listed, read and posted', async () => {
    await consolePost(api.server, accountant, '/v1/finance/fixed-assets').send({ name: 'Chest freezer', category: 'EQUIPMENT', branchId, acquiredOn: '2026-09-14', costPesewas: 640_000, usefulLifeMonths: 60 });
    const september = (await database.pool('admin').query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE fiscal_year = 2026 AND period_no = 9')).rows[0]!.id;
    const run = await consolePost(api.server, accountant, '/v1/finance/depreciation-runs').send({ periodId: september });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expectShape('DepreciationRun', run.body);
    expectShape('DepreciationRunPage', (await consoleGet(api.server, owner, '/v1/finance/depreciation-runs')).body);
    expectShape('DepreciationRun', (await consoleGet(api.server, owner, `/v1/finance/depreciation-runs/${run.body.id as string}`)).body);
    const posted = await consolePost(api.server, owner, `/v1/finance/depreciation-runs/${run.body.id as string}/post`).send({});
    expect(posted.status).toBe(200);
    expectShape('DepreciationRun', posted.body);
    const twice = await consolePost(api.server, accountant, '/v1/finance/depreciation-runs').send({ periodId: september });
    expect([twice.status, twice.body.error.code]).toEqual([422, 'DEPRECIATION_RUN_EXISTS']);
    expectShape('Error', twice.body);
  });
});
