import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals, type ApprovalRecord } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork, type Transaction } from '../../../src/platform/database/unit-of-work';
import { createBranch, createUser, SYSTEM_PRINCIPAL, testStartTime, type TestBranch } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const KIND = 'STOCK_WRITE_OFF';
let database: TestDatabase;
let api: TestApp;
let approvals: Approvals;
let uow: UnitOfWork;
let dodowa: TestBranch;
let kasoa: TestBranch;
let storekeeper: Actor;
let manager: Actor;
let kasoaManager: Actor;
const effects: string[] = [];

const actor = (principalId: string, displayName: string): Actor => ({ principalId, kind: 'USER', displayName, realm: 'STAFF', sessionId: null, steppedUpAt: null });
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** The subject's current content, as a module would hash its document. */
async function subjectHash(tx: Transaction, subjectId: string): Promise<string> {
  const { rows } = await tx.query<{ note: string }>('SELECT note FROM platform.approval_probe WHERE id = $1', [subjectId]);
  return hashOf(rows[0]!.note);
}

function as<T>(who: Actor, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return runWithRequestContext({ correlationId: randomUUID(), ip: '127.0.0.1', userAgent: 'test', actor: who }, () =>
    uow.run({ isolation: 'serializable' }, fn),
  );
}

async function writeOff(note: string, branch: TestBranch = dodowa): Promise<ApprovalRecord> {
  const subjectId = randomUUID();
  const admin = database.pool('admin');
  await admin.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [
    subjectId,
    branch.branchId,
    SYSTEM_PRINCIPAL,
  ]);
  await admin.query('INSERT INTO platform.approval_probe (id, note) VALUES ($1, $2)', [subjectId, note]);
  return as(storekeeper, (tx) =>
    approvals.request(tx, storekeeper, { kind: KIND, branchId: branch.branchId, subjectDocumentId: subjectId, payloadHash: hashOf(note), amountPesewas: 145_000n, summary: note }),
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database, { clock: new ManualClock(testStartTime()) });
  approvals = api.app.get(Approvals);
  uow = api.app.get(UnitOfWork);
  dodowa = await createBranch(database, 'DDW');
  kasoa = await createBranch(database, 'KSA');
  const admin = database.pool('admin');
  await admin.query("INSERT INTO platform.document_type (code, owner_module, name, is_numbered) VALUES ('STOCK_ADJUSTMENT', 'inv', 'Stock adjustment', false)");
  await admin.query('CREATE TABLE platform.approval_probe (id uuid PRIMARY KEY, note text NOT NULL, applied boolean NOT NULL DEFAULT false)');
  await admin.query('GRANT SELECT, INSERT, UPDATE ON platform.approval_probe TO hk_app');
  await admin.query("INSERT INTO iam.permission (code, module, description) VALUES ('inv.adjustment.approve', 'inv', 'Approve a stock adjustment')");
  await admin.query("INSERT INTO iam.role_permission (role_id, permission_code, created_by) VALUES ('01900000-0000-7000-8000-000000000102', 'inv.adjustment.approve', $1)", [SYSTEM_PRINCIPAL]);
  await admin.query(
    `INSERT INTO iam.approval_policy (id, kind, approver_permission, created_by, updated_by) VALUES ($1, $2, 'inv.adjustment.approve', $3, $3)`,
    [randomUUID(), KIND, SYSTEM_PRINCIPAL],
  );
  const s = await createUser(database, { name: 'Yaw Boateng', grants: [{ role: 'STOREKEEPER', branchId: dodowa.branchId }] });
  const m = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId: dodowa.branchId }] });
  const k = await createUser(database, { name: 'Esi Arthur', grants: [{ role: 'MANAGER', branchId: kasoa.branchId }] });
  storekeeper = actor(s.principalId, 'Yaw Boateng');
  manager = actor(m.principalId, 'Kwabena Owusu');
  kasoaManager = actor(k.principalId, 'Esi Arthur');
  approvals.registerHandler(KIND, {
    currentPayloadHash: subjectHash,
    async onApproved(tx, request) {
      await tx.query('UPDATE platform.approval_probe SET applied = true WHERE id = $1', [request.subjectDocumentId]);
      effects.push(request.id);
    },
  });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('maker-checker (ADR-0017)', () => {
  it('refuses a checker who lacks the approver permission', async () => {
    const request = await writeOff('Goat G-0142 died of bloat in pen 3');
    const other = actor((await createUser(database, { name: 'Ama Sarpong', grants: [{ role: 'STOREKEEPER', branchId: dodowa.branchId }] })).principalId, 'Ama Sarpong');
    await expect(as(other, (tx) => approvals.decide(tx, other, request.id, 'APPROVED', null))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses the maker as checker with MAKER_CANNOT_CHECK, even when the maker holds the approver permission', async () => {
    const subjectId = randomUUID();
    const note = 'Sheep S-0031 died, heat stress';
    await database
      .pool('admin')
      .query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [subjectId, dodowa.branchId, SYSTEM_PRINCIPAL]);
    await database.pool('admin').query('INSERT INTO platform.approval_probe (id, note) VALUES ($1, $2)', [subjectId, note]);
    const request = await as(manager, (tx) =>
      approvals.request(tx, manager, { kind: KIND, branchId: dodowa.branchId, subjectDocumentId: subjectId, payloadHash: hashOf(note), summary: note }),
    );
    await expect(as(manager, (tx) => approvals.decide(tx, manager, request.id, 'APPROVED', null))).rejects.toMatchObject({ code: 'MAKER_CANNOT_CHECK', status: 422 });
    const { rows } = await database.pool('admin').query<{ status: string }>('SELECT status FROM iam.approval_request WHERE id = $1', [request.id]);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('refuses a manager of another branch, because the approver permission is checked at the request\'s branch', async () => {
    const request = await writeOff('Goat G-0177 culled, broken leg');
    await expect(as(kasoaManager, (tx) => approvals.decide(tx, kasoaManager, request.id, 'APPROVED', null))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('applies the approved action in the same transaction as the approval, and freezes the request', async () => {
    const request = await writeOff('Goat G-0190 died, suspected PPR');
    const decided = await as(manager, (tx) => approvals.decide(tx, manager, request.id, 'APPROVED', null));
    expect(decided.status).toBe('APPROVED');
    expect(effects).toContain(request.id);
    const { rows } = await database.pool('admin').query<{ applied: boolean }>('SELECT applied FROM platform.approval_probe WHERE id = $1', [request.subjectDocumentId]);
    expect(rows[0]!.applied).toBe(true);
    await expect(as(manager, (tx) => approvals.decide(tx, manager, request.id, 'REJECTED', 'second thoughts'))).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' });
    const { rows: event } = await database.pool('admin').query("SELECT 1 FROM platform.outbox_message WHERE event_type = 'iam.ApprovalDecided' AND subject_id = $1", [request.id]);
    expect(event).toHaveLength(1);
  });

  it('voids an approval when the subject changed after the request, so nobody approves something else', async () => {
    const request = await writeOff('Two goats died');
    await database.pool('admin').query("UPDATE platform.approval_probe SET note = 'Twelve goats died' WHERE id = $1", [request.subjectDocumentId]);
    await expect(as(manager, (tx) => approvals.decide(tx, manager, request.id, 'APPROVED', null))).rejects.toMatchObject({ code: 'APPROVAL_SUBJECT_CHANGED' });
    const { rows } = await database.pool('admin').query<{ applied: boolean }>('SELECT applied FROM platform.approval_probe WHERE id = $1', [request.subjectDocumentId]);
    expect(rows[0]!.applied).toBe(false);
  });
});
