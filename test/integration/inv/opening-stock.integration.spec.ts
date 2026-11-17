import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { AuditTrail } from '../../../src/platform/audit/audit-trail';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { FileScanner } from '../../../src/platform/storage/file-scanner';
import { SharpImageRenderer } from '../../../src/platform/storage/image-renderer';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { readSheet } from '../../../src/platform/spreadsheet/spreadsheet';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { addDays } from '../../../src/seed/seed-calendar';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { CleanScanner } from '../../support/imports';
import { startTestApp, TEST_PUBLIC_BUCKET, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Opening stock through the OPENING_STOCK import sheet (A-128, A-136, A-147, ADR-0050, threat model abuse case 26):
 * INV's sheet, registered with MDM's imports, checks every row in the dry run, and apply posts one goods receipt of
 * kind OPENING per location, its OPENING_BALANCE movements at the stated cost, all or none, in the import's
 * transaction; only the Owner loads it, once per product and branch; a receipt of kind OPENING is still refused.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let worker: FileScanner;
let owner: TestSession & { readonly secret: Buffer };
let manager: TestSession & { readonly secret: Buffer };
let storekeeper: TestSession;
const admin = () => database.pool('admin');
const post = (session: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const HEADER = 'branch,location,sku,qty,valuePesewas,batch,expiresOn,tag,sex,weightKg';
/** The pork lot's and the wings' expiry, 75 and 46 days after the suite's first day, never a fixed date (B09t2). */
let porkExpiresOn: string;
let wingsExpireOn: string;
const good = () => [
  'DDW,PENS,LIV-0003,1,150000,,,P-0001,FEMALE,12.500',
  'DDW,PENS,LIV-0003,1.000,150001,,,P-0002,male,',
  `DDW,COLD,MEAT-0006,30.000,340000,PORK-2026-1101,${porkExpiresOn},,,30.000`,
  'DDW,SHOP,PRD-0004,6,120000,,,,,',
];

async function upload(session: TestSession, lines: readonly string[]): Promise<string> {
  const response = await consolePost(api.server, session, '/v1/files')
    .field('purpose', 'IMPORT')
    .attach('file', Buffer.from([HEADER, ...lines].join('\r\n')), { filename: 'opening-stock.csv', contentType: 'application/octet-stream' });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  await worker.scanPending(50);
  return response.body.id as string;
}

async function stepUp(session: TestSession & { readonly secret: Buffer }): Promise<void> {
  clock.advanceBy(30_000);
  expect((await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

const openingCount = async () =>
  (await admin().query<{ receipts: number; movements: number }>(
    "SELECT (SELECT count(*)::int FROM inv.goods_receipt WHERE kind = 'OPENING') AS receipts, (SELECT count(*)::int FROM inv.stock_movement WHERE movement_type = 'OPENING_BALANCE') AS movements",
  )).rows[0]!;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  porkExpiresOn = addDays(toBusinessDate(clock.now()), 75);
  wingsExpireOn = addDays(toBusinessDate(clock.now()), 46);
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const pens = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE code = 'PENS' AND branch_id = $1", [branchId])).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Nana Ama Korsah', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
  storekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId, locationId: pens }] }));
  const workerPool = database.pool('worker');
  worker = new FileScanner(workerPool, new UnitOfWork(workerPool, api.logger), api.app.get<ObjectStorage>(OBJECT_STORAGE), new CleanScanner(), api.app.get(AuditTrail), clock, api.logger, {
    renderer: new SharpImageRenderer(),
    publicBucket: TEST_PUBLIC_BUCKET,
    ensureBucket: true,
  });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the OPENING_STOCK dry run (A-128, A-147)', () => {
  it('checks a pig per row, a dated pork lot and untracked carrots, and writes nothing but the job', async () => {
    const before = await openingCount();
    const job = await post(owner, '/imports', { entity: 'OPENING_STOCK', fileId: await upload(owner, good()) });
    expect(job.status, JSON.stringify(job.body)).toBe(202);
    expect(job.body).toMatchObject({ entity: 'OPENING_STOCK', status: 'VALIDATED', rowsTotal: 4, rowsValid: 4, rowsToCreate: 4, rowsToUpdate: 0 });
    expect(await openingCount()).toEqual(before);
  });

  it('names each broken row and column: a product with stock history, an unknown branch, in transit, no value, no batch, two pigs on one row, a repeated tag', async () => {
    const job = await post(owner, '/imports', {
      entity: 'OPENING_STOCK',
      fileId: await upload(owner, [
        'DDW,SHOP,PRD-0005,10,5000,,,,,',
        'KSA,SHOP,PRD-0004,1,1000,,,,,',
        'DDW,TRANSIT,PRD-0001,1,1000,,,,,',
        'DDW,SHOP,PRD-0006,1,0,,,,,',
        `DDW,COLD,MEAT-0002,15.000,90000,,${wingsExpireOn},,,`,
        'DDW,PENS,LIV-0007,2,4000,,,R-01,FEMALE,',
        'DDW,PENS,LIV-0007,1,4000,,,R-02,MALE,',
        'DDW,PENS,LIV-0007,1,4000,,,R-02,MALE,',
        'DDW,PENS,LIV-0007,1,4000,,,R-03,,',
      ]),
    });
    expect(job.body).toMatchObject({ status: 'VALIDATED', rowsTotal: 9, rowsValid: 1 });
    const errors = await get(owner, `/imports/${job.body.id as string}/errors?limit=100`);
    const byRow = new Map<number, string[]>();
    for (const e of errors.body.data as Array<{ rowNo: number; column: string; message: string }>) byRow.set(e.rowNo, [...(byRow.get(e.rowNo) ?? []), `${e.column}: ${e.message}`]);
    expect(byRow.get(2)).toEqual(['sku: PRD-0005 already has stock history at DDW: opening stock is loaded once, before trading']);
    expect(byRow.get(3)).toEqual(['branch: No branch KSA']);
    expect(byRow.get(4)).toEqual(['location: TRANSIT does not hold stock of its own']);
    expect(byRow.get(5)).toEqual(['valuePesewas: Opening stock is carried at its cost: valuePesewas must be above zero']);
    expect(byRow.get(6)).toEqual(['batch: A lot needs its batch number']);
    expect(byRow.get(7)).toEqual(['tag: An animal is one row with its tag and qty 1']);
    expect(byRow.get(8)).toBeUndefined();
    expect(byRow.get(9)).toEqual(['tag: Duplicate of row 8']);
    expect(byRow.get(10)).toEqual(['sex: An animal needs its sex: MALE, FEMALE or UNKNOWN']);
    expect((await post(owner, `/imports/${job.body.id as string}/apply`)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
  });

  it('is refused to a storekeeper, who holds no import permission', async () => {
    expect((await post(storekeeper, '/imports', { entity: 'OPENING_STOCK', fileId: randomUUID() })).status).toBe(403);
  });
});

describe('applying opening stock (A-147, ADR-0050)', () => {
  let jobId: string;

  it('is refused to the manager, who may apply imports but not load opening stock, and writes nothing', async () => {
    const job = await post(manager, '/imports', { entity: 'OPENING_STOCK', fileId: await upload(manager, good()) });
    expect(job.body.status).toBe('VALIDATED');
    const refused = await post(manager, `/imports/${job.body.id as string}/apply`);
    expect(refused.status).toBe(403);
    expect(await openingCount()).toEqual({ receipts: 0, movements: 0 });
    const job2 = await post(owner, '/imports', { entity: 'OPENING_STOCK', fileId: await upload(owner, good()) });
    jobId = job2.body.id as string;
  });

  it('posts one OPENING receipt per location and an OPENING_BALANCE movement per row at its cost, from the opening location, in one transaction', async () => {
    const applied = await post(owner, `/imports/${jobId}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect(applied.body).toMatchObject({ status: 'APPLIED', rowsApplied: 4 });
    expect(await openingCount()).toEqual({ receipts: 3, movements: 4 });
    const movements = (
      await admin().query<{ sku: string; to: string; from_kind: string; qty: string; value: string; element: string; identifier: string | null; weight: string | null; source: string | null }>(
        `SELECT p.sku, t.code AS "to", f.kind AS from_kind, m.qty_base::text AS qty, m.value_pesewas::text AS value, m.cost_element AS element, u.identifier,
                m.weight_kg::text AS weight, m.weight_source AS source
           FROM inv.stock_movement m JOIN mdm.product p ON p.id = m.product_id JOIN mdm.location t ON t.id = m.to_location_id
           JOIN mdm.location f ON f.id = m.from_location_id LEFT JOIN inv.stock_unit u ON u.id = m.stock_unit_id
          WHERE m.movement_type = 'OPENING_BALANCE' ORDER BY p.sku, u.identifier`,
      )
    ).rows;
    expect(movements).toEqual([
      { sku: 'LIV-0003', to: 'PENS', from_kind: 'OPENING', qty: '1.000', value: '150000', element: 'PURCHASE', identifier: 'P-0001', weight: '12.500', source: 'MANUAL' },
      { sku: 'LIV-0003', to: 'PENS', from_kind: 'OPENING', qty: '1.000', value: '150001', element: 'PURCHASE', identifier: 'P-0002', weight: null, source: null },
      { sku: 'MEAT-0006', to: 'COLD', from_kind: 'OPENING', qty: '30.000', value: '340000', element: 'PURCHASE', identifier: 'PORK-2026-1101', weight: '30.000', source: 'MANUAL' },
      { sku: 'PRD-0004', to: 'SHOP', from_kind: 'OPENING', qty: '6.000', value: '120000', element: 'PURCHASE', identifier: null, weight: null, source: null },
    ]);
    const posted = await admin().query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'inv.OpeningStockLoaded'");
    expect(posted.rowCount).toBe(4);
    const pool = await admin().query<{ value: string }>("SELECT sum(c.value_pesewas)::text AS value FROM inv.cost_pool c JOIN mdm.product p ON p.id = c.product_id WHERE p.sku IN ('LIV-0003', 'MEAT-0006', 'PRD-0004')");
    expect(pool.rows[0]!.value).toBe('760001');
    const pork = await admin().query<{ expires_on: string; status: string }>("SELECT to_char(expires_on, 'YYYY-MM-DD') AS expires_on, status FROM inv.stock_unit WHERE identifier = 'PORK-2026-1101'");
    expect(pork.rows).toEqual([{ expires_on: porkExpiresOn, status: 'ACTIVE' }]);
  });

  it('refuses the same opening stock a second time: each product now has stock history at Dodowa', async () => {
    const job = await post(owner, '/imports', { entity: 'OPENING_STOCK', fileId: await upload(owner, good()) });
    expect(job.body).toMatchObject({ status: 'VALIDATED', rowsValid: 0 });
  });

  it('still refuses a goods receipt of kind OPENING over HTTP (A-136, decided in A-147)', async () => {
    const location = (await admin().query<{ id: string }>("SELECT id FROM mdm.location WHERE code = 'SHOP'")).rows[0]!.id;
    const product = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'PRD-0001'")).rows[0]!.id;
    const refused = await post(owner, '/goods-receipts', { kind: 'OPENING', locationId: location, receivedAt: clock.now().toISOString(), lines: [{ productId: product, qtyReceived: '1.000', valuePesewas: 1000 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'GOODS_RECEIPT_INVALID', details: [{ field: '/kind', code: 'OPENING_NOT_AVAILABLE' }] });
  });

  it('exports the empty template with its columns, with a step-up', async () => {
    await stepUp(owner);
    const exported = await post(owner, '/exports', { entity: 'OPENING_STOCK', format: 'CSV' });
    expect(exported.status, JSON.stringify(exported.body)).toBe(202);
    expect(exported.body).toMatchObject({ entity: 'OPENING_STOCK', rowsTotal: 0 });
    await worker.scanPending(50);
    const linked = await post(owner, `/files/${exported.body.file.id as string}/signed-url`);
    const rows = readSheet(Buffer.from(await (await fetch(linked.body.url as string)).arrayBuffer()), 'text/csv', 10);
    expect(rows).toEqual([HEADER.split(',')]);
  });
});
