import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileScanner } from '../../../src/platform/storage/file-scanner';
import { SharpImageRenderer } from '../../../src/platform/storage/image-renderer';
import type { MalwareScanner, ScanVerdict } from '../../../src/platform/storage/malware-scanner';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { createCatalogue, type TestCatalogue } from '../../support/catalogue';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, ROLE_IDS, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestBranch, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { objectStoreEnvironment, startTestApp, TEST_ORIGIN, TEST_PRIVATE_BUCKET, TEST_PUBLIC_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Product photographs (FR-DOC-005, ADR-0045): addProductImage and removeProductImage refuse the wrong role in the
 * application layer (ADR-0035); only a CLEAN product photograph is attached; the worker re-encodes a clean photograph
 * into 320, 640 and 1280 pixel variants, WebP with a JPEG fallback, publishes them on the public origin with the
 * verdict, and the original is never there. The malware scan itself is proved against the real ClamAV in
 * file-store.integration.spec.ts; here the scanner port answers CLEAN, so the image path is what is under test.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let worker: FileScanner;
let dodowa: TestBranch;
let catalogue: TestCatalogue;
let manager: TestSession;
let owner: TestSession;
let storekeeper: TestSession;
let secondStorekeeper: TestSession;
const refused: Record<string, TestSession> = {};
const REFUSED_ROLES: readonly RoleCode[] = ['ACCOUNTANT', 'CASHIER', 'SALES', 'DRIVER', 'FARM_HAND', 'STOREKEEPER'];

/** The scanner port, answering CLEAN for every file: the verdict path itself is ClamAV's, proved elsewhere. */
class CleanScanner implements MalwareScanner {
  scan(): Promise<ScanVerdict> {
    return Promise.resolve({ outcome: 'CLEAN' });
  }
}

const admin = () => database.pool('admin');
const publicOrigin = () => `${objectStoreEnvironment()['S3_ENDPOINT']}/${TEST_PUBLIC_BUCKET}`;

/** A camera-sized JPEG of about 4 MB: smooth colour with fine grain, as a photograph of a goat pen would be. */
async function fourMegabyteJpeg(): Promise<Buffer> {
  const width = 3_400;
  const height = 2_550;
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  const grain = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 60;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      const n = grain();
      pixels[at] = Math.max(0, Math.min(255, 120 + 80 * Math.sin(x / 90) + n));
      pixels[at + 1] = Math.max(0, Math.min(255, 140 + 60 * Math.cos(y / 70) + n));
      pixels[at + 2] = Math.max(0, Math.min(255, 90 + 50 * Math.sin((x + y) / 50) + n));
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}

const smallJpeg = (width = 900, height = 600) => sharp({ create: { width, height, channels: 3, background: { r: 150, g: 110, b: 70 } } }).jpeg().toBuffer();

function upload(session: TestSession, purpose: string, content: Buffer, filename: string) {
  return consolePost(api.server, session, '/v1/files').field('purpose', purpose).attach('file', content, { filename, contentType: 'application/octet-stream' });
}

async function uploaded(session: TestSession, purpose: string, content: Buffer, filename = 'goat.jpg'): Promise<string> {
  const response = await upload(session, purpose, content, filename);
  expect(response.status).toBe(201);
  return response.body.id as string;
}

/** Uploads a photograph and lets the worker scan and publish it. */
async function cleanPhotograph(session: TestSession = manager, content?: Buffer): Promise<string> {
  const id = await uploaded(session, 'PRODUCT_IMAGE', content ?? (await smallJpeg()));
  await worker.scanPending(50);
  return id;
}

const addImage = (session: TestSession, productId: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1/products/${productId}/images`, key).send(body);
const removeImage = (session: TestSession, productId: string, imageId: string, key: string = randomUUID()) =>
  request(api.server)
    .delete(`/v1/products/${productId}/images/${imageId}`)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', key);

let skuCounter = 0;
async function product(): Promise<string> {
  skuCounter += 1;
  const response = await consolePost(api.server, manager, '/v1/products').send({
    name: `Goat meat pack ${skuCounter} kg`,
    categoryId: catalogue.meatCategoryId,
    stockPolicy: 'CATCH_WEIGHT',
    baseUom: 'KG',
    saleUom: 'PACK',
    nominalPackKg: '1.000',
    shelfLifeDays: 5,
    onlineMode: 'LISTED',
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}

const count = async (sql: string, values: unknown[] = []) => (await admin().query<{ n: number }>(sql, values)).rows[0]!.n;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  dodowa = await createBranch(database, 'DDW');
  catalogue = await createCatalogue(database);
  const now = () => clock.now();
  const user = (name: string, role: RoleCode) => createUser(database, { name, grants: [{ role, branchId: dodowa.branchId }] });
  manager = await enrolAndLogin(api.server, await user('Kwabena Owusu', 'MANAGER'), now);
  owner = await enrolAndLogin(api.server, await user('Nana Ama Boateng', 'OWNER'), now);
  for (const role of REFUSED_ROLES) {
    refused[role] = role === 'ACCOUNTANT' ? await enrolAndLogin(api.server, await user('Yaw Agyeman', role), now) : await login(api.server, await user(`Ama ${role.toLowerCase()}`, role));
  }
  refused['NO_GRANT'] = await login(api.server, await createUser(database, { name: 'Efua Nkansah' }));
  storekeeper = refused['STOREKEEPER']!;
  secondStorekeeper = await login(api.server, await user('Kofi Mensah', 'STOREKEEPER'));

  const workerPool = database.pool('worker');
  worker = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
}, 120_000);

// Access tokens last ten minutes; each test starts with every session refreshed.
beforeEach(async () => {
  for (const session of [manager, owner, secondStorekeeper, ...Object.values(refused)]) {
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
    expect(refreshed.status).toBe(200);
    session.jar.store(refreshed.headers['set-cookie']);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the product gallery refuses the wrong role (ADR-0035, deny by default)', () => {
  it('refuses addProductImage to the accountant, cashier, sales, driver, farm hand, storekeeper and a user with no grant, attaches nothing and audits each refusal', async () => {
    const productId = await product();
    const fileId = await cleanPhotograph();
    const failures = () => count("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
    const before = await failures();
    for (const [role, session] of Object.entries(refused)) {
      const response = await addImage(session, productId, { fileId, altText: 'Goat meat pack' });
      expect(response.status, role).toBe(403);
      expect(response.body.error.code, role).toBe('FORBIDDEN');
    }
    expect(await count('SELECT count(*)::int AS n FROM mdm.product_image WHERE product_id = $1', [productId])).toBe(0);
    expect(await failures()).toBe(before + REFUSED_ROLES.length + 1);
  });

  it('refuses removeProductImage to the same roles and leaves the image in the gallery', async () => {
    const productId = await product();
    const added = await addImage(manager, productId, { fileId: await cleanPhotograph(), altText: 'Front view' });
    expect(added.status).toBe(201);
    const imageId = added.body.images[0].id as string;
    for (const [role, session] of Object.entries(refused)) {
      expect((await removeImage(session, productId, imageId)).status, role).toBe(403);
    }
    expect(await count('SELECT count(*)::int AS n FROM mdm.product_image WHERE id = $1 AND deleted_at IS NULL', [imageId])).toBe(1);
  });

  it("refuses attaching another person's upload to someone who may change products but not read every file", async () => {
    // For this test only, the storekeeper role may change products; it still holds no platform.file.read.any.
    await admin().query("INSERT INTO iam.role_permission (role_id, permission_code, created_by) VALUES ($1, 'mdm.product.update', $2)", [ROLE_IDS.STOREKEEPER, SYSTEM_PRINCIPAL]);
    try {
      const productId = await product();
      const theirs = await cleanPhotograph(secondStorekeeper);
      const refusal = await addImage(storekeeper, productId, { fileId: theirs, altText: 'Pack on the scale' });
      expect(refusal.status).toBe(403);
      const own = await cleanPhotograph(storekeeper);
      expect((await addImage(storekeeper, productId, { fileId: own, altText: 'Pack on the scale' })).status).toBe(201);
      // The owner and the manager hold platform.file.read.any and attach anyone's photograph.
      expect((await addImage(owner, productId, { fileId: theirs, altText: 'Pack on the scale' })).status).toBe(201);
    } finally {
      await admin().query("DELETE FROM iam.role_permission WHERE role_id = $1 AND permission_code = 'mdm.product.update'", [ROLE_IDS.STOREKEEPER]);
    }
  });
});

describe('a 4 MB photograph becomes compressed public variants and the original stays private (FR-DOC-005)', () => {
  it('produces compressed variants and hides the original', async () => {
    const original = await fourMegabyteJpeg();
    expect(original.length).toBeGreaterThanOrEqual(4_000_000);
    expect(original.length).toBeLessThanOrEqual(5 * 1_048_576);
    const fileId = await uploaded(manager, 'PRODUCT_IMAGE', original, 'goat-pen.jpg');
    expect((await consoleGet(api.server, manager, `/v1/files/${fileId}`)).body.scanStatus).toBe('PENDING');
    // A PENDING photograph has no variants yet and is not attached.
    const productId = await product();
    const early = await addImage(manager, productId, { fileId, altText: 'Goat meat pack, vacuum sealed' });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('FILE_NOT_CLEAN');

    const round = await worker.scanPending(50);
    expect(round.published).toBeGreaterThanOrEqual(1);
    const { rows } = await admin().query<{ variant: string; content_type: string; width: number; height: number; size_bytes: string; bucket: string; object_key: string }>(
      "SELECT variant, content_type, width, height, size_bytes, bucket, object_key FROM platform.stored_file_variant WHERE file_id = $1 ORDER BY array_position(ARRAY['thumb','card','full'], variant), content_type DESC",
      [fileId],
    );
    expect(rows.map((row) => `${row.variant}:${row.content_type}:${row.width}`)).toEqual([
      'thumb:image/webp:320',
      'thumb:image/jpeg:320',
      'card:image/webp:640',
      'card:image/jpeg:640',
      'full:image/webp:1280',
      'full:image/jpeg:1280',
    ]);
    // The aspect ratio of the 3,400 by 2,550 original, to the pixel the resampler rounds to.
    for (const row of rows) expect(Math.abs(row.height - (row.width * 3) / 4), `${row.variant} ${row.height}`).toBeLessThanOrEqual(1);
    for (const row of rows.filter((r) => r.variant === 'card')) {
      expect(Number(row.size_bytes), row.content_type).toBeLessThanOrEqual(200_000);
    }
    expect(rows.every((row) => row.bucket === TEST_PUBLIC_BUCKET && row.object_key.startsWith(`p/${fileId}/`))).toBe(true);
    expect((await consoleGet(api.server, manager, `/v1/files/${fileId}`)).body.scanStatus).toBe('CLEAN');

    const added = await addImage(manager, productId, { fileId, altText: 'Goat meat pack, vacuum sealed' });
    expect(added.status).toBe(201);
    const [image] = added.body.images;
    expect(image).toEqual({ id: expect.any(String), fileId, altText: 'Goat meat pack, vacuum sealed', sortOrder: 0, variants: expect.any(Array) });
    expect(image.variants.map((v: { variant: string; width: number }) => `${v.variant}:${v.width}`)).toEqual(['thumb:320', 'card:640', 'full:1280']);
    const card = image.variants[1];
    expect(card.url).toBe(`${publicOrigin()}/p/${fileId}/card.webp`);
    expect(card.fallbackUrl).toBe(`${publicOrigin()}/p/${fileId}/card.jpg`);

    // Anyone can fetch a variant from the public origin, with no credential; the bytes are the recorded size.
    for (const variant of image.variants) {
      for (const [url, size, type] of [[variant.url, variant.sizeBytes, 'image/webp'], [variant.fallbackUrl, variant.fallbackSizeBytes, 'image/jpeg']] as const) {
        const fetched = await fetch(url);
        expect(fetched.status, url).toBe(200);
        expect(fetched.headers.get('content-type')).toBe(type);
        expect((await fetched.arrayBuffer()).byteLength).toBe(size);
      }
    }
    // The original is in the private bucket alone: the public origin answers 404 for its key and for any guess.
    const { rows: stored } = await admin().query<{ bucket: string; object_key: string }>('SELECT bucket, object_key FROM platform.stored_file WHERE id = $1', [fileId]);
    expect(stored[0]!.bucket).toBe(TEST_PRIVATE_BUCKET);
    for (const key of [stored[0]!.object_key, `p/${fileId}/original.jpg`, `p/${fileId}`]) {
      expect((await fetch(`${publicOrigin()}/${key}`)).status, key).toBe(404);
    }
    expect((await fetch(`${objectStoreEnvironment()['S3_ENDPOINT']}/${TEST_PRIVATE_BUCKET}/${stored[0]!.object_key}`)).status).toBe(403);

    // The catalogue shows the gallery on every read of the product.
    const read = await consoleGet(api.server, refused['CASHIER']!, `/v1/products/${productId}`);
    expect(read.status).toBe(200);
    expect(read.body.images).toEqual(added.body.images);
  }, 120_000);

  it('refuses a file that cannot be decoded as an image, so it is never published or attached', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4_096, 9)]);
    const fileId = await uploaded(manager, 'PRODUCT_IMAGE', fake, 'not-really.jpg');
    await worker.scanPending(50);
    const { rows } = await admin().query<{ scan_status: string; scan_verdict: string }>('SELECT scan_status, scan_verdict FROM platform.stored_file WHERE id = $1', [fileId]);
    expect(rows[0]!.scan_status).toBe('FAILED');
    expect(rows[0]!.scan_verdict).toMatch(/^image could not be/);
    expect(await count('SELECT count(*)::int AS n FROM platform.stored_file_variant WHERE file_id = $1', [fileId])).toBe(0);
    const response = await addImage(manager, await product(), { fileId, altText: 'Broken' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('FILE_NOT_CLEAN');
  });

  it('publishes no variant of a confidential file, such as evidence', async () => {
    const fileId = await uploaded(manager, 'EVIDENCE', await smallJpeg(), 'broken-crate.jpg');
    await worker.scanPending(50);
    expect(await count("SELECT count(*)::int AS n FROM platform.stored_file WHERE id = $1 AND scan_status = 'CLEAN'", [fileId])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM platform.stored_file_variant WHERE file_id = $1', [fileId])).toBe(0);
  });
});

describe('addProductImage and removeProductImage (FR-MDM-001, FR-DOC-005)', () => {
  it('reads a file of another use, or no file, as no such photograph, and refuses one already in the gallery', async () => {
    const productId = await product();
    const evidence = await uploaded(manager, 'EVIDENCE', await smallJpeg(), 'crate.jpg');
    await worker.scanPending(50);
    for (const fileId of [evidence, randomUUID()]) {
      const response = await addImage(manager, productId, { fileId, altText: 'Crate' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('REFERENCE_NOT_FOUND');
      expect(response.body.error.details[0].field).toBe('/fileId');
    }
    const fileId = await cleanPhotograph();
    expect((await addImage(manager, productId, { fileId, altText: 'Front view' })).status).toBe(201);
    const twice = await addImage(manager, productId, { fileId, altText: 'Front view again' });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('DUPLICATE_VALUE');
    expect((await addImage(manager, randomUUID(), { fileId, altText: 'Nowhere' })).status).toBe(404);
  });

  it('puts a photograph with no stated place last, audits it, publishes ProductChanged and leaves the version alone', async () => {
    const productId = await product();
    const first = await addImage(manager, productId, { fileId: await cleanPhotograph(), altText: 'Front view', sortOrder: 3 });
    const second = await addImage(manager, productId, { fileId: await cleanPhotograph(), altText: 'Side view' });
    expect(second.status).toBe(201);
    expect(second.body.images.map((image: { altText: string; sortOrder: number }) => `${image.altText}:${image.sortOrder}`)).toEqual(['Front view:3', 'Side view:4']);
    expect(second.body.version).toBe(first.body.version);
    expect(await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'ProductImage' AND action = 'CREATE' AND entity_id = ANY($1::uuid[])", [second.body.images.map((image: { id: string }) => image.id)])).toBe(2);
    const { rows } = await admin().query<{ payload: { changedFields: string[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'mdm.ProductChanged' AND subject_id = $1 ORDER BY occurred_at",
      [productId],
    );
    expect(rows.map((row) => row.payload.changedFields)).toEqual([['images'], ['images']]);
  });

  it('replays an add under the same key with one image, and refuses a different body under it', async () => {
    const productId = await product();
    const fileId = await cleanPhotograph();
    const key = randomUUID();
    const first = await addImage(manager, productId, { fileId, altText: 'Front view' }, key);
    const again = await addImage(manager, productId, { fileId, altText: 'Front view' }, key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await count('SELECT count(*)::int AS n FROM mdm.product_image WHERE product_id = $1', [productId])).toBe(1);
    expect((await addImage(manager, productId, { fileId, altText: 'Another text' }, key)).status).toBe(409);
  });

  it('removes a photograph by a soft delete with a reason, audited, and answers 404 once it is gone', async () => {
    const productId = await product();
    const added = await addImage(manager, productId, { fileId: await cleanPhotograph(), altText: 'Front view' });
    const imageId = added.body.images[0].id as string;
    const removed = await removeImage(manager, productId, imageId);
    expect(removed.status).toBe(204);
    expect((await consoleGet(api.server, manager, `/v1/products/${productId}`)).body.images).toEqual([]);
    const { rows } = await admin().query<{ deleted_by: string; delete_reason: string }>('SELECT deleted_by, delete_reason FROM mdm.product_image WHERE id = $1', [imageId]);
    expect(rows[0]!.delete_reason).toBe('Removed from the product gallery');
    expect(await count("SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'ProductImage' AND action = 'ARCHIVE' AND entity_id = $1", [imageId])).toBe(1);
    expect((await removeImage(manager, productId, imageId)).status).toBe(404);
    expect((await removeImage(manager, productId, randomUUID())).status).toBe(404);
  });
});

describe('the database keeps unscanned and private files off the catalogue (HK007, HK008)', () => {
  it('refuses a product image of a PENDING file or of a file of another use, and a change to its file', async () => {
    const productId = await product();
    const pending = await uploaded(manager, 'PRODUCT_IMAGE', await smallJpeg());
    const insert = (fileId: string) =>
      database.pool('app').query("INSERT INTO mdm.product_image (id, product_id, file_id, alt_text, created_by, updated_by) VALUES ($1, $2, $3, 'x', $4, $4)", [randomUUID(), productId, fileId, SYSTEM_PRINCIPAL]);
    expect(await sqlStateOf(insert(pending))).toBe('HK008');
    const evidence = await uploaded(manager, 'EVIDENCE', await smallJpeg());
    await worker.scanPending(50);
    expect(await sqlStateOf(insert(evidence))).toBe('HK008');
    const added = await addImage(manager, productId, { fileId: pending, altText: 'Front view' });
    expect(added.status).toBe(201);
    const change = database.pool('app').query('UPDATE mdm.product_image SET file_id = $2 WHERE id = $1', [added.body.images[0].id, evidence]);
    expect(await sqlStateOf(change)).toBe('HK008');
  });

  it('lets only the worker record a variant, only for a clean public image, and never changes one', async () => {
    const evidence = await uploaded(manager, 'EVIDENCE', await smallJpeg());
    const photograph = await cleanPhotograph();
    const variant = (pool: 'app' | 'worker', fileId: string) =>
      database
        .pool(pool)
        .query("INSERT INTO platform.stored_file_variant (file_id, variant, content_type, bucket, object_key, width, height, size_bytes) VALUES ($1, 'thumb', 'image/webp', $2, $3, 320, 240, 1000)", [
          fileId,
          TEST_PUBLIC_BUCKET,
          `p/${fileId}/thumb.webp`,
        ]);
    expect(await sqlStateOf(variant('app', photograph))).toBe('42501');
    await worker.scanPending(50);
    expect(await sqlStateOf(variant('worker', evidence))).toBe('HK007');
    const update = (pool: 'worker' | 'admin') => database.pool(pool).query("UPDATE platform.stored_file_variant SET size_bytes = 1 WHERE file_id = $1 AND variant = 'card'", [photograph]);
    expect(await sqlStateOf(update('worker'))).toBe('42501');
    expect(await sqlStateOf(update('admin'))).toBe('HK001');
    const oversized = database
      .pool('worker')
      .query("INSERT INTO platform.stored_file_variant (file_id, variant, content_type, bucket, object_key, width, height, size_bytes) VALUES ($1, 'card', 'image/webp', $2, $3, 640, 480, 200001)", [
        photograph,
        TEST_PUBLIC_BUCKET,
        `p/${photograph}/card.webp`,
      ]);
    expect(await sqlStateOf(oversized)).toBe('23514');
  });
});
