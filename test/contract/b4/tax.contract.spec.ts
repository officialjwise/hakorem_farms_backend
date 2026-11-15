import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { TAX_CATEGORY } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The tax operations (B04 continued) answer in the shapes of contract/openapi.yaml 1.5.0. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let accountant: TestSession;
let ownerId: string;

const LEVIES = ['01900000-0000-7000-8000-000000000501', '01900000-0000-7000-8000-000000000502', '01900000-0000-7000-8000-000000000503'];

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const { branchId } = await createBranch(database);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  const owner = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  await enrolAndLogin(api.server, owner, () => clock.now());
  ownerId = owner.principalId;
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('tax operations answer in the contract shapes', () => {
  it('the levy and category lists and creates, the version lifecycle, and calculateTax', async () => {
    expectShape('TaxLevyPage', (await consoleGet(api.server, accountant, '/v1/tax/levies')).body);
    const categories = await consoleGet(api.server, accountant, '/v1/tax/categories?limit=100');
    expectShape('TaxCategoryPage', categories.body);
    const levy = await consolePost(api.server, accountant, '/v1/tax/levies').send({ code: 'TOURISM', name: 'Tourism Levy', sortOrder: 9 });
    expect(levy.status).toBe(201);
    expectShape('TaxLevy', levy.body);
    const category = await consolePost(api.server, accountant, '/v1/tax/categories').send({ code: 'SEEDS', name: 'Seeds and seedlings' });
    expect(category.status).toBe(201);
    expectShape('TaxCategory', category.body);

    const version = await consolePost(api.server, accountant, '/v1/tax/scheme-versions').send({ validFrom: toBusinessDate(clock.now()), sourceNote: 'Contract shape test' });
    expect(version.status).toBe(201);
    expectShape('TaxSchemeVersion', version.body);
    const categoryIds = [...categories.body.data.map((row: { id: string }) => row.id), category.body.id];
    const cells = categoryIds.flatMap((taxCategoryId: string) =>
      [...LEVIES, levy.body.id].map((levyId, index) => ({ taxCategoryId, levyId, treatment: 'ZERO_RATED', ratePercent: '0', baseKind: 'NET', isReclaimable: true, calcOrder: index + 1 })),
    );
    const put = (body: object) =>
      request(api.server)
        .put(`/v1/tax/scheme-versions/${version.body.id}/cells`)
        .set('Cookie', accountant.jar.header())
        .set('X-CSRF-Token', accountant.csrfToken)
        .set('Origin', TEST_ORIGIN)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const incomplete = await put({ version: 1, cells: cells.slice(1) });
    expect(incomplete.status).toBe(422);
    expectShape('Error', incomplete.body);
    const replaced = await put({ version: 1, cells });
    expect(replaced.status).toBe(200);
    expectShape('TaxSchemeVersion', replaced.body);
    expectShape('TaxSchemeVersion', (await consoleGet(api.server, accountant, `/v1/tax/scheme-versions/${version.body.id}`)).body);
    expectShape('TaxSchemeVersionPage', (await consoleGet(api.server, accountant, '/v1/tax/scheme-versions')).body);
    const submitted = await consolePost(api.server, accountant, `/v1/tax/scheme-versions/${version.body.id}/submit`).send({});
    expect(submitted.status).toBe(202);
    expectShape('ApprovalPending', submitted.body);

    const owner = { principalId: ownerId, kind: 'USER' as const, displayName: 'Kwabena Owusu', realm: 'STAFF' as const, sessionId: null, steppedUpAt: clock.now() };
    await runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: owner }, () =>
      api.app.get(UnitOfWork).run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, owner, submitted.body.approvalRequestId, 'APPROVED', null)),
    );
    const calculated = await consolePost(api.server, accountant, '/v1/tax/calculate').send({
      taxInclusive: true,
      taxDate: toBusinessDate(clock.now()),
      lines: [{ lineRef: '1', taxCategoryId: TAX_CATEGORY.EGGS, amountPesewas: 6_000 }],
    });
    expect(calculated.status).toBe(200);
    expectShape('TaxCalculationResult', calculated.body);
  });
});
