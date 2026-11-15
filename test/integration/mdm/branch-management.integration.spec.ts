import { randomUUID } from 'node:crypto';
import { ManualClock, Quantity } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stock } from '../../../src/modules/inv';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DocumentRegistry } from '../../../src/platform/documents/document-registry';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Branch and location management where B04d continued 2 left gaps (FR-MDM-006, B05x, A-111, A-150, ADR-0051): a branch
 * is closed (deactivated) and reopened through updateBranch, refused while it is the farm's own, the last open trading
 * branch, holds stock or is named by an open document; a location holding stock or named by an open document is not
 * archived; and listBranches, listLocations, getBranch and getLocation answer only within the reader's grants.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TestSession;
let manager: TestSession;
let coldStorekeeper: TestSession;
let accountant: TestSession;
const ids = new Map<string, string>();
const id = (code: string) => ids.get(code)!;
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const post = (session: TestSession, path: string, body: object) => consolePost(api.server, session, `/v1${path}`).send(body);
const patch = (session: TestSession, path: string, body: object) =>
  request(api.server)
    .patch(`/v1${path}`)
    .set('Cookie', session.jar.header())
    .set('X-CSRF-Token', session.csrfToken)
    .set('Origin', TEST_ORIGIN)
    .set('Idempotency-Key', randomUUID())
    .send(body);

async function refresh(): Promise<void> {
  for (const row of (
    await database.pool('admin').query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || b.code || ':' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
}

/** A stock movement posted in process, as a later module would post one at the branch. */
function move(branch: string, movementType: 'ADJUST_GAIN' | 'ADJUST_LOSS', from: string, to: string, qty: string): Promise<string> {
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Branch test' }, randomUUID(), () =>
    api.app.get(UnitOfWork).run({ isolation: 'serializable' }, async (tx) => {
      const documentId = randomUUID();
      await api.app.get(DocumentRegistry).register(tx, { id: documentId, docType: 'STOCK_ADJUSTMENT', ownerModule: 'inv', branchId: id(`branch:${branch}`), actorId: SYSTEM_PRINCIPAL });
      const posted = await api.app.get(Stock).postIn(tx, SYSTEM_PRINCIPAL, {
        movementType,
        productId: id('product:PRD-YAM-TUBER'),
        stockUnitId: null,
        branchId: id(`branch:${branch}`),
        fromLocationId: id(from),
        toLocationId: id(to),
        qty: Quantity.parse(qty),
        reasonCode: movementType === 'ADJUST_GAIN' ? 'FOUND_STOCK' : 'EXPIRED',
        sourceDocumentId: documentId,
        occurredAt: clock.now(),
      });
      return posted.id;
    }),
  );
}

async function branch(code: string): Promise<{ id: string; version: number; status: string }> {
  return (await get(owner, `/branches/${id(`branch:${code}`)}`)).body as { id: string; version: number; status: string };
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await refresh();
  const now = () => clock.now();
  const ddw = id('branch:DDW');
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Ama Owusu', grants: [{ role: 'OWNER', branchId: ddw }, { role: 'OWNER', branchId: id('branch:TST') }] }), now);
  manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId: ddw }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Yaw Agyeman', grants: [{ role: 'ACCOUNTANT', branchId: ddw }] }), now);
  coldStorekeeper = await login(api.server, await createUser(database, { name: 'Kofi Mensah', grants: [{ role: 'STOREKEEPER', branchId: ddw, locationId: id('location:DDW:COLD') }] }));
  // Kasoa is a real selling point the owner creates through the API, here as a test record, never as seed data.
  const kasoa = await post(owner, '/branches', { code: 'KSA', name: 'Kasoa shop (TEST)', address: 'Kasoa new market, CX-001-0001 (TEST)', phone: '0244000111' });
  expect(kasoa.status).toBe(201);
  await refresh();
  await database.pool('app').query(
    `INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, created_by, updated_by)
     SELECT $1, g.principal_id, g.role_id, $2, $3, $3 FROM iam.role_grant g JOIN iam.role r ON r.id = g.role_id
      WHERE r.code = 'OWNER' AND g.branch_id = $4 AND g.principal_id = (SELECT principal_id FROM iam.user_account WHERE email = $5)`,
    [randomUUID(), id('branch:KSA'), SYSTEM_PRINCIPAL, id('branch:DDW'), (await database.pool('admin').query<{ email: string }>("SELECT email FROM iam.user_account WHERE email LIKE 'ama.owusu.%' LIMIT 1")).rows[0]!.email],
  );
  const shop = await post(owner, '/locations', { branchId: id('branch:KSA'), code: 'SHOP', name: 'Kasoa shop floor', kind: 'SHOP_FLOOR', isSellable: true });
  expect(shop.status).toBe(201);
  await refresh();
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('closing and reopening a branch (FR-MDM-006, B05x)', () => {
  it("refuses to close the farm's own branch, naming every reason: the farm's branch, its stock", async () => {
    const ddw = await branch('DDW');
    const refused = await patch(owner, `/branches/${ddw.id}`, { version: ddw.version, status: 'CLOSED' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('BRANCH_INVALID');
    const rules = (refused.body.error.details as Array<{ field: string; code: string }>).map((d) => d.code);
    expect(rules).toEqual(expect.arrayContaining(['FARM_BRANCH', 'HOLDS_STOCK']));
    expect(rules).not.toContain('LAST_ACTIVE_BRANCH');
    expect((await branch('DDW')).status).toBe('ACTIVE');
  });

  it('refuses a branch named by an open document, and one holding stock, and closes it once both are gone', async () => {
    const receipt = await post(owner, '/goods-receipts', {
      kind: 'HARVEST',
      locationId: id('location:KSA:SHOP'),
      receivedAt: new Date(clock.now().getTime() - 3_600_000).toISOString(),
      lines: [{ productId: id('product:PRD-YAM-TUBER'), qtyReceived: '10.000', valuePesewas: 12_000 }],
    });
    expect(receipt.status).toBe(201);
    let ksa = await branch('KSA');
    let refused = await patch(owner, `/branches/${ksa.id}`, { version: ksa.version, status: 'CLOSED' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details).toEqual([expect.objectContaining({ field: '/status', code: 'OPEN_DOCUMENTS' })]);
    expect((await post(owner, `/goods-receipts/${receipt.body.id as string}/cancel`, { reason: 'Entered at the wrong shop' })).status).toBe(200);

    await move('KSA', 'ADJUST_GAIN', 'location:KSA:V-ADJUSTMENT', 'location:KSA:SHOP', '3.000');
    ksa = await branch('KSA');
    refused = await patch(owner, `/branches/${ksa.id}`, { version: ksa.version, status: 'CLOSED' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.map((d: { code: string }) => d.code)).toEqual(['HOLDS_STOCK']);
    const location = (await get(owner, `/locations/${id('location:KSA:SHOP')}`)).body as { version: number };
    const archive = await post(owner, `/locations/${id('location:KSA:SHOP')}/archive`, { version: location.version, reason: 'Shop moved' });
    expect(archive.status).toBe(422);
    expect(archive.body.error).toMatchObject({ code: 'RECORD_IN_USE', details: [{ code: 'HOLDS_STOCK' }] });

    await move('KSA', 'ADJUST_LOSS', 'location:KSA:SHOP', 'location:KSA:V-ADJUSTMENT', '3.000');
    ksa = await branch('KSA');
    const closed = await patch(owner, `/branches/${ksa.id}`, { version: ksa.version, status: 'CLOSED' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', version: ksa.version + 1 });
    const audit = await database.pool('admin').query<{ before: { status: string }; after: { status: string } }>(
      "SELECT convert_from(before, 'UTF8')::jsonb AS before, convert_from(after, 'UTF8')::jsonb AS after FROM platform.audit_event WHERE entity_type = 'Branch' AND entity_id = $1 AND action = 'UPDATE' ORDER BY recorded_at DESC LIMIT 1",
      [ksa.id],
    );
    expect(audit.rows[0]).toMatchObject({ before: { status: 'ACTIVE' }, after: { status: 'CLOSED' } });

    const reopened = await patch(owner, `/branches/${ksa.id}`, { version: ksa.version + 1, status: 'ACTIVE' });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('ACTIVE');
  });

  it('archives an empty location once nothing stands in it and no open document names it', async () => {
    const location = (await get(owner, `/locations/${id('location:KSA:SHOP')}`)).body as { version: number };
    const archived = await post(owner, `/locations/${id('location:KSA:SHOP')}/archive`, { version: location.version, reason: 'Shop moved' });
    expect(archived.status).toBe(200);
  });

  it('closes the smoke-test branch, which holds nothing, and reopens it', async () => {
    const tst = await branch('TST');
    const closed = await patch(owner, `/branches/${tst.id}`, { version: tst.version, status: 'CLOSED' });
    expect(closed.status).toBe(200);
    expect((await patch(owner, `/branches/${tst.id}`, { version: tst.version + 1, status: 'ACTIVE' })).status).toBe(200);
  });

  it('refuses the change to anyone without mdm.branch.update at the branch: the Accountant, the Storekeeper, a Manager elsewhere', async () => {
    const ksa = await branch('KSA');
    for (const session of [accountant, coldStorekeeper, manager]) {
      const refused = await patch(session, `/branches/${ksa.id}`, { version: ksa.version, status: 'CLOSED' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    }
    expect((await branch('KSA')).status).toBe('ACTIVE');
  });
});

describe('branches and locations listed within the grants (FR-IAM-011, B05x)', () => {
  it('lists every branch the Owner holds a grant at, and only Dodowa to the Manager and the cold room Storekeeper', async () => {
    const codes = async (session: TestSession) => ((await get(session, '/branches?limit=100')).body.data as Array<{ code: string }>).map((b) => b.code).sort();
    expect(await codes(owner)).toEqual(['DDW', 'KSA', 'TST']);
    expect(await codes(manager)).toEqual(['DDW']);
    expect(await codes(coldStorekeeper)).toEqual(['DDW']);
  });

  it('lists a branch-wide reader every location of the branch, and a location-scoped reader only that location', async () => {
    const codes = async (session: TestSession, query = '') =>
      ((await get(session, `/locations?limit=100${query}`)).body.data as Array<{ code: string; branch: { code: string } }>).map((l) => `${l.branch.code}:${l.code}`).sort();
    expect((await codes(manager)).every((code) => code.startsWith('DDW:'))).toBe(true);
    expect(await codes(manager)).toContain('DDW:PENS');
    expect(await codes(coldStorekeeper)).toEqual(['DDW:COLD']);
    expect(await codes(coldStorekeeper, '&includeVirtual=true')).toEqual(['DDW:COLD']);
    expect(await codes(manager, `&branchId=${id('branch:TST')}`)).toEqual([]);
  });

  it('refuses a branch or a location outside the grants on a single read', async () => {
    expect((await get(manager, `/branches/${id('branch:TST')}`)).status).toBe(403);
    expect((await get(coldStorekeeper, `/branches/${id('branch:DDW')}`)).status).toBe(200);
    expect((await get(coldStorekeeper, `/locations/${id('location:DDW:COLD')}`)).status).toBe(200);
    expect((await get(coldStorekeeper, `/locations/${id('location:DDW:PENS')}`)).status).toBe(403);
    expect((await get(manager, `/locations/${id('location:TST:V-LOSS')}`)).status).toBe(403);
    expect((await get(manager, `/branches/${randomUUID()}`)).status).toBe(403);
  });
});
