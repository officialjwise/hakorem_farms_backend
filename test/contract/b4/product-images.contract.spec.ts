import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileScanner } from '../../../src/platform/storage/file-scanner';
import { SharpImageRenderer } from '../../../src/platform/storage/image-renderer';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { createCatalogue, type TestCatalogue } from '../../support/catalogue';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, TEST_PUBLIC_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The product gallery answers in the shapes of contract 1.13.0 (addProductImage, removeProductImage, ImageVariant). */
let database: TestDatabase;
let api: TestApp;
let manager: TestSession;
let catalogue: TestCatalogue;
let worker: FileScanner;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

async function photograph(): Promise<string> {
  const content = await sharp({ create: { width: 1_600, height: 1_200, channels: 3, background: { r: 140, g: 100, b: 60 } } }).jpeg().toBuffer();
  const response = await consolePost(api.server, manager, '/v1/files').field('purpose', 'PRODUCT_IMAGE').attach('file', content, 'goat.jpg');
  expect(response.status).toBe(201);
  return response.body.id as string;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const branch = await createBranch(database, 'DDW');
  catalogue = await createCatalogue(database);
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: branch.branchId }] }), () => clock.now());
  const pool = database.pool('worker');
  // The scanner port answers CLEAN: the shapes are under test here, the scan in file-store.integration.spec.ts.
  worker = new FileScanner(pool, new UnitOfWork(pool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), { scan: () => Promise.resolve({ outcome: 'CLEAN' }) }, api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('product gallery shapes (contract 1.13.0)', () => {
  it('addProductImage answers 201 with a Product whose images carry ImageVariants, and getProduct the same', async () => {
    const created = await consolePost(api.server, manager, '/v1/products').send({
      name: 'Goat meat pack 1 kg',
      categoryId: catalogue.meatCategoryId,
      stockPolicy: 'CATCH_WEIGHT',
      baseUom: 'KG',
      saleUom: 'PACK',
      nominalPackKg: '1.000',
      shelfLifeDays: 5,
      onlineMode: 'LISTED',
    });
    const productId = created.body.id as string;
    const fileId = await photograph();

    const pending = await consolePost(api.server, manager, `/v1/products/${productId}/images`).send({ fileId, altText: 'Goat meat pack' });
    expect(pending.status).toBe(422);
    expectShape('Error', pending.body);
    expect(pending.body.error.code).toBe('FILE_NOT_CLEAN');

    await worker.scanPending(10);
    const added = await consolePost(api.server, manager, `/v1/products/${productId}/images`).send({ fileId, altText: 'Goat meat pack', sortOrder: 0 });
    expect(added.status).toBe(201);
    expectShape('Product', added.body);
    expect(added.body.images[0].variants).toHaveLength(3);
    for (const variant of added.body.images[0].variants) expectShape('ImageVariant', variant);
    const read = await consoleGet(api.server, manager, `/v1/products/${productId}`);
    expect(read.body).toEqual(added.body);

    const removed = await request(api.server)
      .delete(`/v1/products/${productId}/images/${added.body.images[0].id as string}`)
      .set('Cookie', manager.jar.header())
      .set('X-CSRF-Token', manager.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID());
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
  });
});
