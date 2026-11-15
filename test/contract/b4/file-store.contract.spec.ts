import { randomBytes, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The file store's operations answer in the shapes of contract 1.12.0 (uploadFile, getFile, createFileSignedUrl). */
let database: TestDatabase;
let api: TestApp;
let storekeeper: TestSession;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const photo = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(1_016)]);
const upload = (purpose: string, content: Buffer, name: string) => consolePost(api.server, storekeeper, '/v1/files', randomUUID()).field('purpose', purpose).attach('file', content, name);

beforeAll(async () => {
  database = await createTestDatabase();
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock: new ManualClock(testStartTime()) });
  const branch = await createBranch(database, 'DDW');
  storekeeper = await login(api.server, await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'STOREKEEPER', branchId: branch.branchId }] }));
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('file store shapes (contract 1.12.0)', () => {
  it('uploadFile answers 201 with a StoredFile, and getFile with the same StoredFile', async () => {
    const created = await upload('EVIDENCE', photo(), 'pen-3.png');
    expect(created.status).toBe(201);
    expectShape('StoredFile', created.body);
    const read = await consoleGet(api.server, storekeeper, `/v1/files/${created.body.id as string}`);
    expect(read.status).toBe(200);
    expectShape('StoredFile', read.body);
    expect(read.body).toEqual(created.body);
  });

  it('createFileSignedUrl answers a SignedUrl for a clean file, and the error envelope for one not yet scanned', async () => {
    const id = (await upload('EVIDENCE', photo(), 'pen-4.png')).body.id as string;
    const signed = () => request(api.server).post(`/v1/files/${id}/signed-url`).set('Cookie', storekeeper.jar.header()).set('X-CSRF-Token', storekeeper.csrfToken).set('Origin', TEST_ORIGIN);
    const pending = await signed();
    expect(pending.status).toBe(422);
    expectShape('Error', pending.body);
    expect(pending.body.error.code).toBe('FILE_NOT_CLEAN');
    // The scanner's verdict, written as the worker role, the only one the database lets record it.
    await database.pool('worker').query("UPDATE platform.stored_file SET scan_status = 'CLEAN', scanned_at = now(), version = version + 1 WHERE id = $1", [id]);
    const link = await signed();
    expect(link.status).toBe(200);
    expectShape('SignedUrl', link.body);
  });

  it('answers 415 and 413 with the error envelope and a correlation id', async () => {
    const wrongType = await upload('PRODUCT_IMAGE', Buffer.from('PK\u0003\u0004 not a photograph'), 'goat.jpg');
    expect(wrongType.status).toBe(415);
    expectShape('Error', wrongType.body);
    expect(wrongType.body.error.correlationId).toBe(wrongType.headers['x-correlation-id']);
    const tooLarge = await upload('EVIDENCE', Buffer.concat([photo(), Buffer.alloc(6 * 1_048_576)]), 'huge.png');
    expect(tooLarge.status).toBe(413);
    expectShape('Error', tooLarge.body);
  });
});
