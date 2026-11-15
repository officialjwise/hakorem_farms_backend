import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Approvals } from '../../../src/modules/iam';
import { runWithRequestContext, type Actor } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, ROLE_IDS, SYSTEM_PRINCIPAL, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B04e continued role, approval, customer realm and reset operations answer in the shapes of contract 1.11.0. */
let database: TestDatabase;
let api: TestApp;
let provider: HttpServer;
const sent: Array<{ to: string; text: string }> = [];
let owner: TestSession;
let manager: TestSession;
let makerActor: Actor;
let managerActor: Actor;
let branchId: string;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

const post = (session: TestSession, path: string, body: object) => consolePost(api.server, session, `/v1${path}`, randomUUID()).send(body);
const open = (path: string, body: object) => request(api.server).post(`/v1${path}`).set('Origin', TEST_ORIGIN).send(body);
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

async function smsTo(to: string, pattern: RegExp): Promise<string> {
  for (let tries = 0; tries < 100; tries += 1) {
    const match = sent.filter((message) => message.to === to).map((message) => pattern.exec(message.text)).find((found) => found !== null);
    if (match) return match[1]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no SMS to ${to}`);
}

beforeAll(async () => {
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      sent.push(JSON.parse(body) as { to: string; text: string });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"msg-1"}');
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, {
    clock,
    environment: { MESSAGING_MODE: 'sandbox', SMS_BASE_URL: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`, SMS_API_KEY: 'stub-provider-key-not-secret' },
  });
  ({ branchId } = await createBranch(database));
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  const managerUser = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'MANAGER', branchId }] });
  managerActor = { principalId: managerUser.principalId, kind: 'USER', displayName: 'Kwabena Owusu', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  manager = await enrolAndLogin(api.server, managerUser, () => clock.now());
  const maker = await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] });
  makerActor = { principalId: maker.principalId, kind: 'USER', displayName: 'Akosua Boateng', realm: 'STAFF', sessionId: null, steppedUpAt: null };
  const admin = database.pool('admin');
  await admin.query("INSERT INTO iam.permission (code, module, description) VALUES ('iam.probe.approve', 'iam', 'Approve a test probe request')");
  await admin.query("INSERT INTO iam.role_permission (role_id, permission_code, created_by) VALUES ($1, 'iam.probe.approve', $2)", [ROLE_IDS.MANAGER, SYSTEM_PRINCIPAL]);
  await admin.query("INSERT INTO iam.approval_policy (id, kind, approver_permission, created_by, updated_by) VALUES ($1, 'SALE_VOID', 'iam.probe.approve', $2, $2)", [randomUUID(), SYSTEM_PRINCIPAL]);
  api.app.get(Approvals).registerHandler('SALE_VOID', { currentPayloadHash: async () => hashOf('probe'), onApproved: async () => undefined });
});

afterAll(async () => {
  await api.close();
  await database.drop();
  await new Promise((resolve) => provider.close(resolve));
});

async function pendingRequest(maker: Actor = makerActor): Promise<string> {
  const subjectId = randomUUID();
  await database.pool('admin').query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'STOCK_ADJUSTMENT', 'inv', $2, $3)", [subjectId, branchId, SYSTEM_PRINCIPAL]);
  const uow = api.app.get(UnitOfWork);
  const approvals = api.app.get(Approvals);
  const record = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'contract', actor: maker }, () =>
    uow.run({ isolation: 'serializable' }, (tx) =>
      approvals.request(tx, maker, { kind: 'SALE_VOID', branchId, subjectDocumentId: subjectId, payloadHash: hashOf('probe'), amountPesewas: 58_900n, summary: 'Mortality: goat G-0171' }),
    ),
  );
  return record.id;
}

describe('B04e continued operations in the contract shapes', () => {
  it('createRole and updateRole answer a Role', async () => {
    const created = await post(owner, '/iam/roles', { code: 'SHOP_SUPERVISOR', name: 'Shop supervisor', requiresTotp: false, permissions: ['iam.approval.read'], limits: [{ limitKind: 'PRICE_OVERRIDE_PER_LINE', amountPesewas: 15_000 }] });
    expect(created.status).toBe(201);
    expectShape('Role', created.body);
    const updated = await request(api.server)
      .patch(`/v1/iam/roles/${created.body.id}`)
      .set('Cookie', owner.jar.header())
      .set('X-CSRF-Token', owner.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, limits: [] });
    expect(updated.status).toBe(200);
    expectShape('Role', updated.body);
  });

  it('listApprovals, getApproval, approveRequest, rejectRequest and cancelApprovalRequest answer ApprovalRequest shapes, and a refusal the Error envelope', async () => {
    const [toApprove, toReject] = [await pendingRequest(), await pendingRequest()];
    expectShape('ApprovalRequestPage', (await consoleGet(api.server, manager, '/v1/iam/approvals?status=PENDING&decidableByMe=true')).body);
    expectShape('ApprovalRequest', (await consoleGet(api.server, manager, `/v1/iam/approvals/${toApprove}`)).body);
    const approved = await post(manager, `/iam/approvals/${toApprove}/approve`, { reason: 'Checked the carcass photograph' });
    expect(approved.status).toBe(200);
    expectShape('ApprovalRequest', approved.body);
    const rejected = await post(manager, `/iam/approvals/${toReject}/reject`, { reason: 'This goat was sold' });
    expectShape('ApprovalRequest', rejected.body);
    const cancelled = await post(manager, `/iam/approvals/${await pendingRequest(managerActor)}/cancel`, { reason: 'Counted twice' });
    expect(cancelled.status).toBe(200);
    expectShape('ApprovalRequest', cancelled.body);
    const mine = await post(manager, '/iam/roles', {});
    expect(mine.status).toBe(400);
    expectShape('Error', mine.body);
  });

  it('registerCustomer, verifyCustomerPhone, requestPasswordReset and resetPassword answer their shapes', async () => {
    const phone = '+233249903118';
    const registered = await open('/auth/customer/register', { name: 'Grace Nyarko', phone, password: 'Waakye-on-Sunday-31', marketingConsent: false });
    expect(registered.status).toBe(201);
    expectShape('LoginResult', registered.body);
    const verified = await open('/auth/customer/verify-phone', { challengeToken: registered.body.challengeToken, code: await smsTo(phone, /code is (\d{6})/) });
    expect(verified.status).toBe(200);
    expectShape('LoginResult', verified.body);
    const accepted = await open('/auth/password/reset-request', { identifier: phone, realm: 'CUSTOMER' });
    expect(accepted.status).toBe(202);
    expectShape('Accepted', accepted.body);
    const wrong = await open('/auth/password/reset', { token: `hk1.rs.${'B'.repeat(43)}`, newPassword: 'Mango-Season-2026!' });
    expect(wrong.status).toBe(422);
    expectShape('Error', wrong.body);
    expect(wrong.body.error.code).toBe('RESET_TOKEN_INVALID');
    const token = await smsTo(phone, /reset code is (hk1\.rs\.[A-Za-z0-9_-]+)/);
    expect((await open('/auth/password/reset', { token, newPassword: 'Mango-Season-2026!' })).status).toBe(204);
  });
});
