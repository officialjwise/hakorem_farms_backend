import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MortalityEvidenceReturns } from '../../../src/modules/liv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The Farm hand's death reports under a second person (owner, 2026-11-15; B06r, the frontend's F6, CR-021; threat
 * model abuse case 2), over the real API on the seeded farm. The Farm hand finds a goat by its exact tag with no cost,
 * reports its death, uploads the photograph (EVIDENCE, the only use the role may upload for) and submits, and someone
 * above them confirms: below the 50,000 write-off threshold a manager (`liv.mortality.confirm`), at or above it the
 * mortality approver with step-up. The Farm hand never writes stock off alone. A report may be submitted while its
 * photograph is still being scanned; approval waits for CLEAN; a rejected scan sends the report back to its maker. A
 * photograph whose exact bytes were already attached to another death report is published for the exception report.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;
let storekeeper: TestSession;
let farmHand: TestSession;
let accountant: TestSession;
let farmHandId: string;
let managerId: string;
const wrong = new Map<string, TestSession>();
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const v1 = (path: string) => `/v1${path}`;
const post = (session: TestSession, path: string, body: object = {}, key?: string) => consolePost(api.server, session, v1(path), key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, v1(path));
const admin = () => database.pool('admin');
const hoursAgo = (hours: number) => new Date(clock.now().getTime() - hours * 3_600_000).toISOString();
const COST = /pesewas|cost/i;
const statusOf = async (tag: string) => (await admin().query<{ status: string }>('SELECT status FROM liv.animal WHERE tag_no = $1 ORDER BY created_at DESC LIMIT 1', [tag])).rows[0]?.status;
const recordOf = async (recordId: string) =>
  (await admin().query<{ status: string; returned_reason: string | null; posted_by: string | null; confirmation_required: boolean }>(
    'SELECT status, returned_reason, posted_by::text, confirmation_required FROM liv.mortality_record WHERE id = $1',
    [recordId],
  )).rows[0]!;
const eventsOf = async (type: string, subjectId: string) =>
  (await admin().query<{ payload: Record<string, unknown> }>('SELECT payload FROM platform.outbox_message WHERE event_type = $1 AND subject_id = $2', [type, subjectId])).rows.map((r) => r.payload);

function costKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => costKeys(item, `${path}[${index}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [...(COST.test(key) ? [`${path}.${key}`] : []), ...costKeys(inner, `${path}.${key}`)]);
}

async function refresh(): Promise<void> {
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product
       UNION ALL SELECT 'supplier:' || name, id FROM mdm.supplier
       UNION ALL SELECT 'unit:' || identifier, id FROM inv.stock_unit WHERE status = 'ACTIVE'`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

/** Goats bought from Kpone, each at its own value, into the pens. */
async function buyGoats(goats: ReadonlyArray<readonly [tag: string, valuePesewas: number]>): Promise<void> {
  for (const [tag, valuePesewas] of goats) {
    const created = await post(manager, '/goods-receipts', {
      kind: 'PURCHASE',
      supplierId: id('supplier:Kpone Livestock Traders (SEED)'),
      locationId: id('location:PENS'),
      deliveryNoteRef: `FH-${randomUUID().slice(0, 8)}`,
      receivedAt: hoursAgo(48),
      lines: [{ productId: id('product:LIV-0004'), qtyReceived: '1.000', valuePesewas, animals: [{ tagNo: tag, sex: 'MALE', breed: 'West African Dwarf', purpose: 'GROWING' }] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await post(manager, `/goods-receipts/${created.body.id as string}/post`)).status).toBe(200);
  }
  await refresh();
}

/** A photograph of the carcass as the phone's camera takes it: a JPEG, its bytes distinct unless `seed` repeats. */
function photo(seed: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_020, seed)]);
}

async function upload(session: TestSession, bytes: Buffer, purpose = 'EVIDENCE') {
  return consolePost(api.server, session, '/v1/files').field('purpose', purpose).attach('file', bytes, 'carcass.jpg');
}

/** The scanner's verdict, as the worker records it (hk_worker is the only role that may). */
async function scanned(fileId: string, status: 'CLEAN' | 'INFECTED' | 'FAILED'): Promise<void> {
  await database.pool('worker').query('UPDATE platform.stored_file SET scan_status = $2, scanned_at = now(), version = version + 1 WHERE id = $1', [fileId, status]);
}

async function report(session: TestSession, tag: string, photoFileId?: string) {
  const path = session === farmHand ? '/care/mortality-records' : '/mortality-records';
  const reported = await post(session, path, { kind: 'DEATH', stockUnitId: id(`unit:${tag}`), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1), ...(photoFileId === undefined ? {} : { photoFileId }) });
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  return reported.body.id as string;
}

const submit = (session: TestSession, recordId: string) => post(session, session === farmHand ? `/care/mortality-records/${recordId}/submit` : `/mortality-records/${recordId}/submit`);
const approve = (session: TestSession, requestId: string) => post(session, `/iam/approvals/${requestId}/approve`, { reason: 'Saw the carcass at the pen' });
/** The scheduled job's run, as the worker runs it: as the Scheduler (ADR-0049). */
const SCHEDULER = '01900000-0000-7000-8000-000000000004';
const returns = () => runAsSystem({ principalId: SCHEDULER, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(MortalityEvidenceReturns).run({ kind: 'SYSTEM', principalId: SCHEDULER }));

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  const branchId = id('branch:DDW');
  const managerUser = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  managerId = managerUser.principalId;
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
  const storekeeperUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'STOREKEEPER', branchId }] });
  storekeeper = await login(api.server, storekeeperUser);
  const farmHandUser = await createUser(database, { name: 'Abena Quaye', grants: [{ role: 'FARM_HAND', branchId }] });
  farmHandId = farmHandUser.principalId;
  farmHand = await login(api.server, farmHandUser);
  for (const role of ['CASHIER', 'SALES', 'DRIVER', 'INVESTOR'] as const satisfies readonly RoleCode[]) {
    wrong.set(role, await login(api.server, await createUser(database, { name: `Wrong ${role.toLowerCase()}`, grants: [{ role, branchId }] })));
  }
  await buyGoats([
    ['FH-G01', 62_000],
    ['FH-G02', 18_000],
    ['FH-G03', 21_000],
    ['FH-G04', 24_000],
    ['FH-G05', 26_000],
    ['FH-G06', 27_000],
    ['FH-G07', 28_000],
    ['FH-G08', 29_000],
    ['FH-G09', 30_000],
    ['FH-G10', 31_000],
    ['FH-G11', 19_000],
  ]);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the Farm hand finds a live animal by its exact tag, with no cost (CR-021, ADR-0052)', () => {
  it('answers the live goat for its exact tag, in the cost-free shape', async () => {
    const found = await get(farmHand, '/care/animal-tags/FH-G01');
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body).toMatchObject({ id: id('unit:FH-G01'), tagNo: 'FH-G01', status: 'ALIVE', species: { code: 'GOAT' }, currentLocation: { code: 'PENS' } });
    expect(costKeys(found.body)).toEqual([]);
    expect(contractSchema('CareAnimal')(found.body)).toBe(true);
  });

  it('matches exactly: another case, a prefix or an unknown tag is 404', async () => {
    for (const tag of ['fh-g01', 'FH-G0', 'FH-G011', 'NO-SUCH-TAG']) {
      const missed = await get(farmHand, `/care/animal-tags/${tag}`);
      expect(missed.status, tag).toBe(404);
      expect(missed.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('refuses every role without the care read: the Storekeeper, Accountant, Cashier, Sales, Driver and Investor', async () => {
    for (const [role, session] of [['STOREKEEPER', storekeeper], ['ACCOUNTANT', accountant], ...wrong.entries()] as const) {
      const refused = await get(session, '/care/animal-tags/FH-G01');
      expect(refused.status, role).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('the Farm hand uploads EVIDENCE and nothing else (owner, 2026-11-15)', () => {
  it('stores an EVIDENCE photograph, PENDING its scan', async () => {
    const uploaded = await upload(farmHand, photo(1));
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    expect(uploaded.body).toMatchObject({ purpose: 'EVIDENCE', scanStatus: 'PENDING', classification: 'CONFIDENTIAL' });
  });

  it('refuses the Farm hand every other use, and refuses EVIDENCE to a role with no upload permission', async () => {
    for (const purpose of ['PRODUCT_IMAGE', 'PROOF_OF_DELIVERY', 'SIGNATURE', 'SUPPLIER_DOCUMENT', 'SUPPLIER_INVOICE', 'INVESTOR_DOCUMENT', 'IMPORT', 'STATEMENT', 'AGREEMENT']) {
      const refused = await upload(farmHand, photo(2), purpose);
      expect(refused.status, purpose).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    for (const [role, session] of wrong) {
      expect((await upload(session, photo(3))).status, role).toBe(403);
    }
    // The Storekeeper keeps the broader upload it already held.
    expect((await upload(storekeeper, photo(4), 'PRODUCT_IMAGE')).status).toBe(201);
  });
});

describe('at or above the threshold: the Farm hand reports and submits, and the mortality approver confirms once the photograph is CLEAN (FR-LIV-012, abuse case 2)', () => {
  let recordId: string;
  let requestId: string;
  let fileId: string;

  it('submits FH-G01 at 62,000 while its photograph is still PENDING, and it waits as PENDING_APPROVAL with the goat on hand', async () => {
    const uploaded = await upload(farmHand, photo(11));
    fileId = uploaded.body.id as string;
    recordId = await report(farmHand, 'FH-G01', fileId);
    const submitted = await submit(farmHand, recordId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'MORTALITY_WRITE_OFF', subject: { id: recordId, docType: 'MORTALITY_RECORD' } });
    expect(contractSchema('ApprovalPending')(submitted.body)).toBe(true);
    requestId = submitted.body.approvalRequestId as string;
    expect(await statusOf('FH-G01')).toBe('ALIVE');
  });

  it('refuses the approval while the photograph is PENDING, and refuses the Farm hand and the Storekeeper as approvers', async () => {
    const early = await approve(manager, requestId);
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(early.body.error.code).toBe('EVIDENCE_NOT_SCANNED');
    expect((await recordOf(recordId)).status).toBe('PENDING_APPROVAL');
    expect((await approve(farmHand, requestId)).status).toBe(403);
    expect((await approve(storekeeper, requestId)).status).toBe(403);
  });

  it('posts on the manager\'s approval once the scanner passed the photograph: the goat is DEAD and its tag no longer found', async () => {
    await scanned(fileId, 'CLEAN');
    const approved = await approve(manager, requestId);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const record = await get(manager, `/mortality-records/${recordId}`);
    expect(record.body).toMatchObject({ status: 'POSTED', valuePesewas: 62_000, photoFileId: fileId, approvalRequestId: requestId, returnedReason: null });
    expect(contractSchema('MortalityRecord')(record.body)).toBe(true);
    expect(await statusOf('FH-G01')).toBe('DEAD');
    expect((await get(farmHand, '/care/animal-tags/FH-G01')).status).toBe(404);
    expect(await eventsOf('liv.MortalityReported', recordId)).toEqual([expect.objectContaining({ needsApproval: true, approvalKind: 'MORTALITY_WRITE_OFF', abuseCases: [2] })]);
  });
});

/** One statement as the superuser with every trigger off: to stand up a record the rules no longer let anyone write. */
async function bypassingTriggers(sql: string, values: unknown[]): Promise<void> {
  const client = await admin().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** A distinct EVIDENCE photograph the Farm hand uploads for one report, its id. */
async function evidence(seed: number): Promise<string> {
  const uploaded = await upload(farmHand, photo(seed));
  expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
  return uploaded.body.id as string;
}

describe('the Farm hand\'s death report always carries its photograph, whatever its value (owner, 2026-11-16)', () => {
  it('refuses the Farm hand\'s report of FH-G02 at 18,000, below the 50,000 threshold, without its photograph, naming no value', async () => {
    const refused = await post(farmHand, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:FH-G02'), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1) });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'MORTALITY_PHOTO_REQUIRED', details: [{ field: '/photoFileId', code: 'PHOTO_REQUIRED' }] });
    // The Farm hand cannot see the value, so the refusal does not tell it.
    expect(JSON.stringify(refused.body)).not.toMatch(/18000|18,000|50000|50,000/);
    expect(await statusOf('FH-G02')).toBe('ALIVE');
    const { rows } = await admin().query('SELECT id FROM liv.mortality_record WHERE stock_unit_id = $1', [id('unit:FH-G02')]);
    expect(rows).toEqual([]);
  });

  it('refuses the submission of a Farm hand record of FH-G11 at 19,000 that has lost its photograph, below the threshold', async () => {
    const recordId = await report(farmHand, 'FH-G11', await evidence(201));
    // A record reported before the rule, without its photograph, stands for one here. The database never lets a
    // reported photograph go, so the record is changed with the triggers off, as only a superuser can.
    await bypassingTriggers('UPDATE liv.mortality_record SET photo_file_id = NULL, photo_sha256 = NULL WHERE id = $1', [recordId]);
    const refused = await submit(farmHand, recordId);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'MORTALITY_PHOTO_REQUIRED', details: [{ field: '/photoFileId', code: 'PHOTO_REQUIRED' }] });
    expect(JSON.stringify(refused.body)).not.toMatch(/19000|19,000|50000|50,000/);
    expect((await recordOf(recordId)).status).toBe('REPORTED');
    expect(await statusOf('FH-G11')).toBe('ALIVE');
  });

  it('refuses the care report to every role without the report permission, photograph or not', async () => {
    const photoFileId = await evidence(202);
    for (const [role, session] of [['ACCOUNTANT', accountant], ...wrong.entries()] as const) {
      const refused = await post(session, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:FH-G02'), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1), photoFileId });
      expect(refused.status, role).toBe(403);
    }
  });
});

describe('below the threshold: the Farm hand never writes off alone, and a manager confirms (owner, 2026-11-15)', () => {
  it('holds FH-G02 at 18,000 for a manager\'s confirmation instead of posting it, and refuses every other confirmer', async () => {
    const photoFileId = await evidence(203);
    await scanned(photoFileId, 'CLEAN');
    const recordId = await report(farmHand, 'FH-G02', photoFileId);
    const submitted = await submit(farmHand, recordId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'MORTALITY_CONFIRMATION', subject: { id: recordId } });
    expect(await statusOf('FH-G02')).toBe('ALIVE');
    expect((await recordOf(recordId)).confirmation_required).toBe(true);

    const requestId = submitted.body.approvalRequestId as string;
    // The Storekeeper may write off its own reports below the threshold, but a person above the Farm hand confirms.
    for (const [role, session] of [['FARM_HAND', farmHand], ['STOREKEEPER', storekeeper], ['ACCOUNTANT', accountant], ...wrong.entries()] as const) {
      expect((await approve(session, requestId)).status, role).toBe(403);
    }
    const confirmed = await approve(manager, requestId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await recordOf(recordId)).toMatchObject({ status: 'POSTED' });
    expect(await statusOf('FH-G02')).toBe('DEAD');
    const posted = await admin().query<{ actor: string }>('SELECT m.actor_id::text AS actor FROM inv.stock_movement m JOIN liv.mortality_record r ON r.movement_id = m.id WHERE r.id = $1', [recordId]);
    expect(posted.rows[0]!.actor).toBe((await recordOf(recordId)).posted_by);
    expect(await eventsOf('liv.MortalityReported', recordId)).toEqual([expect.objectContaining({ needsApproval: true, approvalKind: 'MORTALITY_CONFIRMATION', valuePesewas: 18_000 })]);
  });

  it('lets the Storekeeper, who sees the value, still report FH-G03 at 21,000 without a photograph and write it off directly: the threshold rule is unchanged for every other maker', async () => {
    const recordId = await report(storekeeper, 'FH-G03');
    const submitted = await submit(storekeeper, recordId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'POSTED', approvalRequestId: null, valuePesewas: 21_000 });
  });
});

describe('the photograph\'s scan decides: approval waits for CLEAN, a rejected scan returns the report to its maker', () => {
  it('returns FH-G04 to the Farm hand with EVIDENCE_INFECTED when the scanner finds the photograph infected', async () => {
    const fileId = (await upload(farmHand, photo(21))).body.id as string;
    const recordId = await report(farmHand, 'FH-G04', fileId);
    const submitted = await submit(farmHand, recordId);
    expect(submitted.status).toBe(202);
    await scanned(fileId, 'INFECTED');
    expect(await returns()).toEqual({ returned: 1 });
    expect(await recordOf(recordId)).toMatchObject({ status: 'RETURNED', returned_reason: 'EVIDENCE_INFECTED' });
    expect((await get(manager, `/mortality-records/${recordId}`)).body).toMatchObject({ status: 'RETURNED', returnedReason: 'EVIDENCE_INFECTED', movementId: null });
    const request = await get(manager, `/iam/approvals/${submitted.body.approvalRequestId as string}`);
    expect(request.body.status).toBe('CANCELLED');
    expect((await approve(manager, submitted.body.approvalRequestId as string)).body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
    expect(await eventsOf('liv.MortalityReturned', recordId)).toEqual([expect.objectContaining({ mortalityRecordId: recordId, reportedBy: farmHandId, reason: 'EVIDENCE_INFECTED', photoFileId: fileId })]);
    expect(await statusOf('FH-G04')).toBe('ALIVE');
    // A second run finds nothing more to return; the goat may be reported again with a new photograph.
    expect(await returns()).toEqual({ returned: 0 });
    const again = (await upload(farmHand, photo(22))).body.id as string;
    expect((await submit(farmHand, await report(farmHand, 'FH-G04', again))).status).toBe(202);
  });

  it('returns FH-G05 with EVIDENCE_UNSCANNABLE when the scanner cannot read the photograph', async () => {
    const fileId = (await upload(farmHand, photo(23))).body.id as string;
    const recordId = await report(farmHand, 'FH-G05', fileId);
    expect((await submit(farmHand, recordId)).status).toBe(202);
    await scanned(fileId, 'FAILED');
    expect(await returns()).toEqual({ returned: 1 });
    expect(await recordOf(recordId)).toMatchObject({ status: 'RETURNED', returned_reason: 'EVIDENCE_UNSCANNABLE' });
  });

  it('refuses a report or a submission whose photograph has already been rejected', async () => {
    const fileId = (await upload(farmHand, photo(24))).body.id as string;
    const recordId = await report(farmHand, 'FH-G06', fileId);
    await scanned(fileId, 'INFECTED');
    const refused = await submit(farmHand, recordId);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ code: 'PHOTO_NOT_USABLE' })]);
    const reported = await post(farmHand, '/care/mortality-records', { kind: 'DEATH', stockUnitId: id('unit:FH-G06'), reasonCode: 'UNKNOWN_CAUSE', foundAt: hoursAgo(1), photoFileId: fileId });
    expect(reported.body.error.details).toEqual([expect.objectContaining({ code: 'PHOTO_NOT_USABLE' })]);
  });
});

describe('a photograph reused on a second death report goes to the exception report (abuse case 2)', () => {
  it('publishes liv.MortalityPhotoReused when the same bytes, uploaded again, are attached to another death', async () => {
    const first = (await upload(farmHand, photo(31))).body.id as string;
    const firstRecord = await report(farmHand, 'FH-G07', first);
    expect(await eventsOf('liv.MortalityPhotoReused', firstRecord)).toEqual([]);
    const second = (await upload(farmHand, photo(31))).body.id as string;
    expect(second).not.toBe(first);
    const secondRecord = await report(farmHand, 'FH-G08', second);
    expect(await eventsOf('liv.MortalityPhotoReused', secondRecord)).toEqual([
      expect.objectContaining({
        mortalityRecordId: secondRecord,
        photoFileId: second,
        reportedBy: farmHandId,
        earlierMortalityRecordIds: [firstRecord],
        matchedBy: 'SHA256',
        abuseCases: [2],
      }),
    ]);
  });
});

describe('the database holds the confirmation and the photograph on its own (abuse case 2)', () => {
  it('refuses to post a record that needs a confirmation without an approval, and an approval checked by its reporter', async () => {
    const photoFileId = await evidence(209);
    await scanned(photoFileId, 'CLEAN');
    const recordId = await report(farmHand, 'FH-G09', photoFileId);
    await submit(farmHand, recordId);
    const movement = (await admin().query<{ id: string }>('SELECT id FROM inv.stock_movement LIMIT 1')).rows[0]!.id;
    const unconfirmed = await admin()
      .query("UPDATE liv.mortality_record SET status = 'POSTED', approval_request_id = NULL, movement_id = $2, posted_at = now(), posted_by = reported_by, version = version + 1 WHERE id = $1", [recordId, movement])
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint ?? 'refused',
      );
    expect(['ck_mortality_record_pending', 'ck_mortality_record_confirmed']).toContain(unconfirmed);
    const selfChecked = await admin()
      .query("UPDATE liv.mortality_record SET status = 'POSTED', movement_id = $2, posted_at = now(), posted_by = reported_by, version = version + 1 WHERE id = $1", [recordId, movement])
      .then(
        () => null,
        (error: { constraint?: string }) => error.constraint ?? 'refused',
      );
    expect(selfChecked).toBe('ck_mortality_record_checker');
  });

  it('refuses to post a record whose photograph is not CLEAN (HK008)', async () => {
    const fileId = (await upload(farmHand, photo(41))).body.id as string;
    const recordId = await report(farmHand, 'FH-G10', fileId);
    await submit(farmHand, recordId);
    const movement = (await admin().query<{ id: string }>('SELECT id FROM inv.stock_movement LIMIT 1')).rows[0]!.id;
    const checker = managerId;
    expect(
      await sqlStateOf(admin().query("UPDATE liv.mortality_record SET status = 'POSTED', movement_id = $2, posted_at = now(), posted_by = $3, version = version + 1 WHERE id = $1", [recordId, movement, checker])),
    ).toBe(SQLSTATE.productImageGuard);
  });
});
