import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Approvals, type ApprovalRecord } from '../../../src/modules/iam';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork, type Transaction } from '../../../src/platform/database/unit-of-work';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, login, relaxRateLimits, ROLE_IDS, SYSTEM_PRINCIPAL, testStartTime, type RoleCode, type TestBranch, type TestSession } from '../../support/iam';
import { sqlStateOf } from '../../support/sql-state';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Role writes and the approval endpoints (FR-IAM-008, FR-IAM-012, FR-IAM-022, A-122): each write refuses the wrong
 * role in the application layer (ADR-0035), nobody changes a role they hold or beyond what they hold, the maker never
 * checks, an approval binds to the subject's payload, and only the maker withdraws a request.
 */
const KIND = 'STOCK_WRITE_OFF';
const APPROVER = 'inv.adjustment.approve';
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let uow: UnitOfWork;
let approvals: Approvals;
let dodowa: TestBranch;
let kasoa: TestBranch;
let owner: TestSession & { secret: Buffer };
let manager: TestSession & { secret: Buffer };
let secondManager: TestSession & { secret: Buffer };
let kasoaManager: TestSession & { secret: Buffer };
let accountant: TestSession & { secret: Buffer };
let sales: TestSession;
let cashier: TestSession;
let storekeeper: TestSession;
let driver: TestSession;
const actors = new Map<string, Actor>();
const effects: string[] = [];

const post = (session: TestSession, path: string, body: object, key: string = randomUUID()) => consolePost(api.server, session, `/v1${path}`, key).send(body);
const patch = (session: TestSession, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', session.jar.header()).set('X-CSRF-Token', session.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const admin = () => database.pool('admin');
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const stepUp = async (session: TestSession & { secret: Buffer }) => {
  clock.advanceBy(30_000);
  const response = await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) });
  expect(response.status).toBe(200);
};
const failures = async () => (await admin().query<{ n: number }>("SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'")).rows[0]!.n;

/** A write-off asked for by `maker`, its subject a probe row whose note is the payload. */
async function writeOff(maker: string, note: string, branch: TestBranch = dodowa, expiresAt: Date | null = null): Promise<ApprovalRecord> {
  const subjectId = randomUUID();
  await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [subjectId, branch.branchId, SYSTEM_PRINCIPAL]);
  await admin().query('INSERT INTO platform.approval_probe (id, note) VALUES ($1, $2)', [subjectId, note]);
  const actor = actors.get(maker)!;
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor }, () =>
    uow.run({ isolation: 'serializable' }, (tx: Transaction) =>
      approvals.request(tx, actor, { kind: KIND, branchId: branch.branchId, subjectDocumentId: subjectId, payloadHash: hashOf(note), amountPesewas: 58_900n, summary: note, expiresAt }),
    ),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  uow = api.app.get(UnitOfWork);
  approvals = api.app.get(Approvals);
  dodowa = await createBranch(database, 'DDW');
  kasoa = await createBranch(database, 'KSA');
  await admin().query("INSERT INTO platform.document_type (code, owner_module, name, is_numbered) VALUES ('STOCK_ADJUSTMENT', 'inv', 'Stock adjustment', false)");
  await admin().query('CREATE TABLE platform.approval_probe (id uuid PRIMARY KEY, note text NOT NULL, applied boolean NOT NULL DEFAULT false)');
  await admin().query('GRANT SELECT, INSERT, UPDATE ON platform.approval_probe TO hk_app');
  await admin().query(`INSERT INTO iam.permission (code, module, description) VALUES ('${APPROVER}', 'inv', 'Approve a stock adjustment')`);
  await admin().query(`INSERT INTO iam.role_permission (role_id, permission_code, created_by) VALUES ($1, '${APPROVER}', $2)`, [ROLE_IDS.MANAGER, SYSTEM_PRINCIPAL]);
  await admin().query(`INSERT INTO iam.approval_policy (id, kind, approver_permission, created_by, updated_by) VALUES ($1, $2, '${APPROVER}', $3, $3)`, [randomUUID(), KIND, SYSTEM_PRINCIPAL]);
  approvals.registerHandler(KIND, {
    async currentPayloadHash(tx, subjectId) {
      const { rows } = await tx.query<{ note: string }>('SELECT note FROM platform.approval_probe WHERE id = $1', [subjectId]);
      return hashOf(rows[0]!.note);
    },
    async onApproved(tx, decided) {
      await tx.query('UPDATE platform.approval_probe SET applied = true WHERE id = $1', [decided.subjectDocumentId]);
      effects.push(decided.id);
    },
  });
  const now = () => clock.now();
  const make = async (key: string, name: string, role: RoleCode, branch = dodowa) => {
    const user = await createUser(database, { name, grants: [{ role, branchId: branch.branchId }] });
    actors.set(key, { principalId: user.principalId, kind: 'USER', displayName: name, realm: 'STAFF', sessionId: null, steppedUpAt: null });
    return user;
  };
  owner = await enrolAndLogin(api.server, await make('owner', 'Abena Owusu', 'OWNER'), now);
  manager = await enrolAndLogin(api.server, await make('manager', 'Kwabena Owusu', 'MANAGER'), now);
  secondManager = await enrolAndLogin(api.server, await make('secondManager', 'Akosua Boateng', 'MANAGER'), now);
  kasoaManager = await enrolAndLogin(api.server, await make('kasoaManager', 'Esi Arthur', 'MANAGER', kasoa), now);
  accountant = await enrolAndLogin(api.server, await make('accountant', 'Yaw Agyeman', 'ACCOUNTANT'), now);
  sales = await login(api.server, await make('sales', 'Esi Appiah', 'SALES'));
  cashier = await login(api.server, await make('cashier', 'Adwoa Darko', 'CASHIER'));
  storekeeper = await login(api.server, await make('storekeeper', 'Abena Quaye', 'STOREKEEPER'));
  driver = await login(api.server, await make('driver', 'Selorm Agbeko', 'DRIVER'));
});

// Access tokens last ten minutes and these tests move the clock on: each test starts with every session refreshed.
beforeEach(async () => {
  for (const session of [owner, manager, secondManager, kasoaManager, accountant, sales, cashier, storekeeper, driver]) {
    const refreshed = await request(api.server).post('/v1/auth/refresh').set('Cookie', session.jar.header()).set('Origin', TEST_ORIGIN);
    expect(refreshed.status).toBe(200);
    session.jar.store(refreshed.headers['set-cookie']);
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

const newRole = (overrides: object = {}) => ({
  code: `SHOP_SUP_${randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z]/g, 'X')}`,
  name: 'Shop supervisor',
  requiresTotp: false,
  permissions: ['iam.approval.read'],
  limits: [{ limitKind: 'PRICE_OVERRIDE_PER_LINE', amountPesewas: 15_000 }],
  ...overrides,
});

describe('role writes refuse the wrong role (ADR-0035, A-122)', () => {
  it('createRole and updateRole: the Manager, Accountant, Sales, Cashier, Storekeeper and Driver get 403 FORBIDDEN, each audited', async () => {
    const before = await failures();
    for (const [role, session] of Object.entries({ manager, accountant, sales, cashier, storekeeper, driver })) {
      const created = await post(session, '/iam/roles', newRole());
      expect(created.status, role).toBe(403);
      expect(created.body.error.code, role).toBe('FORBIDDEN');
      const updated = await patch(session, `/iam/roles/${ROLE_IDS.CASHIER}`, { version: 1, name: 'Refused' });
      expect(updated.status, role).toBe(403);
      expect(updated.body.error.code, role).toBe('FORBIDDEN');
    }
    expect((await failures()) - before).toBe(12);
  });

  it('the Owner needs a step-up within five minutes', async () => {
    clock.advanceBy(301_000);
    const stale = await post(owner, '/iam/roles', newRole());
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    await stepUp(owner);
  });
});

describe('creating and changing a role (FR-IAM-008, FR-IAM-022)', () => {
  it('creates a non-system role with its permissions and limits, audited as PERMISSION_CHANGE and published, and a retry shows the same role', async () => {
    const key = randomUUID();
    const body = newRole();
    const created = await post(owner, '/iam/roles', body, key);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: body.code, name: 'Shop supervisor', isSystem: false, requiresTotp: false, permissions: ['iam.approval.read'], limits: body.limits, userCount: 0, version: 1 });
    const replay = await post(owner, '/iam/roles', body, key);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(created.body.id);
    const audit = await admin().query("SELECT metadata FROM platform.audit_event WHERE action = 'PERMISSION_CHANGE' AND entity_id = $1", [created.body.id]);
    expect(audit.rows.map((row) => row.metadata)).toEqual([expect.objectContaining({ change: 'ROLE_CREATED', roleCode: body.code, added: ['iam.approval.read'] })]);
    const outbox = await admin().query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'iam.RoleChanged' AND subject_id = $1", [created.body.id]);
    expect(outbox.rows[0].n).toBe(1);
    expect((await post(owner, '/iam/roles', { ...newRole(), code: body.code })).body.error.code).toBe('DUPLICATE_VALUE');
  });

  it('refuses a permission the Owner does not hold (403), an unknown code and one limit kind twice (422 ROLE_INVALID)', async () => {
    const beyond = await post(owner, '/iam/roles', newRole({ permissions: [APPROVER] }));
    expect(beyond.status).toBe(403);
    expect(beyond.body.error.code).toBe('FORBIDDEN');
    const unknown = await post(owner, '/iam/roles', newRole({ permissions: ['inv.nothing.here'] }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toMatchObject({ code: 'ROLE_INVALID', details: [{ field: '/permissions', code: 'UNKNOWN_PERMISSION' }] });
    const twice = await post(owner, '/iam/roles', newRole({ limits: [{ limitKind: 'PRICE_OVERRIDE_PER_LINE', amountPesewas: 1 }, { limitKind: 'PRICE_OVERRIDE_PER_LINE', amountPesewas: 2 }] }));
    expect(twice.body.error).toMatchObject({ code: 'ROLE_INVALID', details: [{ field: '/limits', code: 'DUPLICATE_LIMIT_KIND' }] });
  });

  it('replaces permissions and limits, soft-deleting what goes with the actor, and the change reaches a holder on the next request', async () => {
    const created = await post(owner, '/iam/roles', newRole({ permissions: ['iam.approval.read', 'iam.role.read'] }));
    const roleId = created.body.id as string;
    const holder = await createUser(database, { name: 'Kojo Antwi' });
    await admin().query('INSERT INTO iam.role_grant (id, principal_id, role_id, branch_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)', [randomUUID(), holder.principalId, roleId, dodowa.branchId, SYSTEM_PRINCIPAL]);
    const holderSession = await login(api.server, holder);
    expect((await get(holderSession, '/iam/roles')).status).toBe(200);
    const updated = await patch(owner, `/iam/roles/${roleId}`, { version: 1, name: 'Shop lead', permissions: ['iam.approval.read'], limits: [{ limitKind: 'REFUND_WITHOUT_APPROVAL', amountPesewas: 2_000 }] });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Shop lead', permissions: ['iam.approval.read'], limits: [{ limitKind: 'REFUND_WITHOUT_APPROVAL', amountPesewas: 2_000 }], version: 2, userCount: 1 });
    expect((await get(holderSession, '/iam/roles')).status).toBe(403);
    const link = await admin().query('SELECT deleted_by, delete_reason FROM iam.role_permission WHERE role_id = $1 AND permission_code = $2', [roleId, 'iam.role.read']);
    expect(link.rows[0]).toMatchObject({ deleted_by: actors.get('owner')!.principalId, delete_reason: 'Removed by a role change' });
    const limit = await admin().query("SELECT deleted_at IS NOT NULL AS gone FROM iam.role_limit WHERE role_id = $1 AND limit_kind = 'PRICE_OVERRIDE_PER_LINE'", [roleId]);
    expect(limit.rows[0].gone).toBe(true);
    const restored = await patch(owner, `/iam/roles/${roleId}`, { version: 2, permissions: ['iam.approval.read', 'iam.role.read'] });
    expect(restored.body.permissions).toEqual(['iam.approval.read', 'iam.role.read']);
    expect((await get(holderSession, '/iam/roles')).status).toBe(200);
    const stale = await patch(owner, `/iam/roles/${roleId}`, { version: 1, name: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('nobody changes a role they hold: the Owner cannot change the Owner role (403, audited)', async () => {
    const before = await failures();
    const response = await patch(owner, `/iam/roles/${ROLE_IDS.OWNER}`, { version: 1, name: 'Boss' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect((await failures()) - before).toBe(1);
  });

  it('keeps TOTP on the Manager role (422 ROLE_INVALID), and the database refuses deleting a system role', async () => {
    const role = await get(owner, `/iam/roles/${ROLE_IDS.MANAGER}`);
    const response = await patch(owner, `/iam/roles/${ROLE_IDS.MANAGER}`, { version: role.body.version, requiresTotp: false });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({ code: 'ROLE_INVALID', details: [{ field: '/requiresTotp', code: 'TOTP_REQUIRED_FOR_ROLE' }] });
    expect(await sqlStateOf(admin().query("UPDATE iam.role SET deleted_at = now(), deleted_by = $2, delete_reason = 'Gone', version = version + 1 WHERE id = $1", [ROLE_IDS.CASHIER, SYSTEM_PRINCIPAL]))).toBe('23514');
  });

  it('lists exactly ten system roles still', async () => {
    const { rows } = await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM iam.role WHERE is_system AND deleted_at IS NULL');
    expect(rows[0]!.n).toBe(10);
  });
});

describe('the approval endpoints refuse the wrong role (ADR-0035, A-122)', () => {
  it('listApprovals, getApproval and cancelApprovalRequest: Sales, the Cashier, the Storekeeper and the Driver get 403', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: goat G-0171, found dead in pen 2');
    for (const [role, session] of Object.entries({ sales, cashier, storekeeper, driver })) {
      expect((await get(session, '/iam/approvals')).status, role).toBe(403);
      expect((await get(session, `/iam/approvals/${pending.id}`)).status, role).toBe(403);
      const cancelled = await post(session, `/iam/approvals/${pending.id}/cancel`, { reason: 'Refused' });
      expect(cancelled.status, role).toBe(403);
      expect(cancelled.body.error.code, role).toBe('FORBIDDEN');
    }
  });

  it('approveRequest and rejectRequest: those four, and the Accountant who lacks the policy permission, get 403; nothing changes', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: goat G-0172, found dead in pen 3');
    for (const [role, session] of Object.entries({ sales, cashier, storekeeper, driver, accountant })) {
      const approved = await post(session, `/iam/approvals/${pending.id}/approve`, { reason: 'Refused' });
      expect(approved.status, role).toBe(403);
      expect(approved.body.error.code, role).toBe('FORBIDDEN');
      const rejected = await post(session, `/iam/approvals/${pending.id}/reject`, { reason: 'Refused' });
      expect(rejected.status, role).toBe(403);
    }
    const kasoaRefused = await post(kasoaManager, `/iam/approvals/${pending.id}/approve`, {});
    expect(kasoaRefused.status).toBe(403);
    expect((await admin().query('SELECT status FROM iam.approval_request WHERE id = $1', [pending.id])).rows[0].status).toBe('PENDING');
  });
});

describe('the approval inbox (FR-IAM-012)', () => {
  it('lists what the viewer may see, newest first, with canDecide, and the decidableByMe and requestedByMe filters', async () => {
    const mine = await writeOff('manager', 'Stock take variance: two crates of eggs short');
    const theirs = await writeOff('storekeeper', 'Mortality: rabbit R-0042 found dead');
    const elsewhere = await writeOff('kasoaManager', 'Kasoa: one goat missing at count', kasoa);
    const all = await get(manager, '/iam/approvals?status=PENDING&limit=100');
    expect(all.status).toBe(200);
    const ids = all.body.data.map((row: { id: string }) => row.id);
    expect(ids.indexOf(theirs.id)).toBeLessThan(ids.indexOf(mine.id));
    expect(ids).not.toContain(elsewhere.id);
    const row = all.body.data.find((candidate: { id: string }) => candidate.id === theirs.id);
    expect(row).toMatchObject({ kind: KIND, status: 'PENDING', branchId: dodowa.branchId, subject: { id: theirs.subjectDocumentId, docType: 'STOCK_ADJUSTMENT', number: null }, amountPesewas: 58_900, currency: 'GHS', requestedBy: { displayName: 'Abena Quaye' }, decidedBy: null, canDecide: true });
    expect(all.body.data.find((candidate: { id: string }) => candidate.id === mine.id).canDecide).toBe(false);
    const decidable = (await get(manager, '/iam/approvals?decidableByMe=true&limit=100')).body.data.map((r: { id: string }) => r.id);
    expect(decidable).toContain(theirs.id);
    expect(decidable).not.toContain(mine.id);
    const own = (await get(manager, '/iam/approvals?requestedByMe=true&limit=100')).body.data.map((r: { id: string }) => r.id);
    expect(own).toContain(mine.id);
    expect(own).not.toContain(theirs.id);
    const accountantView = (await get(accountant, `/iam/approvals/${theirs.id}`)).body;
    expect(accountantView.canDecide).toBe(false);
    expect((await get(kasoaManager, `/iam/approvals/${theirs.id}`)).status).toBe(403);
    expect((await get(manager, `/iam/approvals/${randomUUID()}`)).status).toBe(404);
  });

  it('pages with a cursor bound to the filters', async () => {
    const first = await get(manager, '/iam/approvals?limit=2');
    expect(first.body.page).toMatchObject({ limit: 2, hasMore: true });
    const second = await get(manager, `/iam/approvals?limit=2&cursor=${encodeURIComponent(first.body.page.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.data[0].id < first.body.data[1].id).toBe(true);
    expect((await get(manager, `/iam/approvals?limit=2&kind=REFUND&cursor=${encodeURIComponent(first.body.page.nextCursor)}`)).status).toBe(400);
  });
});

describe('deciding over HTTP (FR-IAM-012)', () => {
  it('approves: the handler runs in the same transaction, the decision is audited and published, and a retry with the key replays', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: goat G-0180, carcass photographed');
    const key = randomUUID();
    const approved = await post(manager, `/iam/approvals/${pending.id}/approve`, { reason: 'Checked the carcass photograph with the vet' }, key);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', decidedBy: { displayName: 'Kwabena Owusu' }, decisionReason: 'Checked the carcass photograph with the vet', canDecide: false });
    expect(effects).toContain(pending.id);
    expect((await admin().query('SELECT applied FROM platform.approval_probe WHERE id = $1', [pending.subjectDocumentId])).rows[0].applied).toBe(true);
    expect((await post(manager, `/iam/approvals/${pending.id}/approve`, { reason: 'Checked the carcass photograph with the vet' }, key)).body.status).toBe('APPROVED');
    const again = await post(secondManager, `/iam/approvals/${pending.id}/approve`, {});
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
    const outbox = await admin().query("SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'iam.ApprovalDecided' AND subject_id = $1", [pending.id]);
    expect(outbox.rows[0].n).toBe(1);
  });

  it('refuses the maker as checker with 422 MAKER_CANNOT_CHECK', async () => {
    const pending = await writeOff('manager', 'Write off three broken crates of eggs');
    const response = await post(manager, `/iam/approvals/${pending.id}/approve`, {});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post(secondManager, `/iam/approvals/${pending.id}/approve`, {})).status).toBe(200);
  });

  it('refuses an approval whose subject changed after the request (422 APPROVAL_SUBJECT_CHANGED)', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: sheep S-0031');
    await admin().query("UPDATE platform.approval_probe SET note = 'Mortality: sheep S-0032' WHERE id = $1", [pending.subjectDocumentId]);
    const response = await post(manager, `/iam/approvals/${pending.id}/approve`, {});
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('APPROVAL_SUBJECT_CHANGED');
  });

  it('rejects with a required reason, and the request stays unapplied', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: goat G-0190');
    expect((await post(manager, `/iam/approvals/${pending.id}/reject`, {})).status).toBe(400);
    const rejected = await post(manager, `/iam/approvals/${pending.id}/reject`, { reason: 'The goat was sold on 12 November; this is not a mortality' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decisionReason: 'The goat was sold on 12 November; this is not a mortality' });
    expect((await admin().query('SELECT applied FROM platform.approval_probe WHERE id = $1', [pending.subjectDocumentId])).rows[0].applied).toBe(false);
  });

  it('asks for a step-up when the policy requires one', async () => {
    await admin().query('UPDATE iam.approval_policy SET requires_step_up = true, version = version + 1 WHERE kind = $1', [KIND]);
    try {
      const pending = await writeOff('storekeeper', 'Mortality: duck D-0007');
      clock.advanceBy(301_000);
      const stale = await post(manager, `/iam/approvals/${pending.id}/approve`, {});
      expect(stale.status).toBe(403);
      expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
      await stepUp(manager);
      expect((await post(manager, `/iam/approvals/${pending.id}/approve`, {})).status).toBe(200);
    } finally {
      await admin().query('UPDATE iam.approval_policy SET requires_step_up = false, version = version + 1 WHERE kind = $1', [KIND]);
    }
  });

  it('shows a lapsed request as EXPIRED and refuses to approve it (422 APPROVAL_EXPIRED)', async () => {
    const pending = await writeOff('storekeeper', 'Mortality: pig P-0011', dodowa, new Date(clock.now().getTime() + 60_000));
    clock.advanceBy(61_000);
    expect((await get(manager, `/iam/approvals/${pending.id}`)).body.status).toBe('EXPIRED');
    expect((await get(manager, '/iam/approvals?status=EXPIRED&limit=100')).body.data.map((r: { id: string }) => r.id)).toContain(pending.id);
    const response = await post(manager, `/iam/approvals/${pending.id}/approve`, {});
    expect(response.body.error.code).toBe('APPROVAL_EXPIRED');
  });
});

describe('withdrawing a request (A-122)', () => {
  it('lets the maker withdraw their own pending request, refuses anyone else (audited) and a second withdrawal', async () => {
    const pending = await writeOff('manager', 'Write off a torn bag of layer mash');
    const before = await failures();
    const other = await post(secondManager, `/iam/approvals/${pending.id}/cancel`, { reason: 'Not mine' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('FORBIDDEN');
    expect((await failures()) - before).toBe(1);
    const cancelled = await post(manager, `/iam/approvals/${pending.id}/cancel`, { reason: 'Counted twice in error at the morning check' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', decidedBy: null, decisionReason: 'Counted twice in error at the morning check', canDecide: false });
    const twice = await post(manager, `/iam/approvals/${pending.id}/cancel`, { reason: 'Again' });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
    expect((await post(secondManager, `/iam/approvals/${pending.id}/approve`, {})).body.error.code).toBe('APPROVAL_ALREADY_DECIDED');
  });
});
