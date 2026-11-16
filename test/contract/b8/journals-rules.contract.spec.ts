import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, consolePost, createBranch, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** The B08 continued 1b operations answer in the shapes of contract/openapi.yaml. */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
let owner: TotpSession;
let accountant: TotpSession;

const post = (session: TestSession, path: string, body: object = {}) => consolePost(api.server, session, `/v1${path}`).send(body);
const get = (session: TestSession, path: string) => consoleGet(api.server, session, `/v1${path}`);
const accountId = (code: string) => `01900000-0000-7000-8100-00000000${code}`;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

async function stepUp(session: TotpSession): Promise<void> {
  clock.advanceBy(30_000);
  expect((await post(session, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  const branchId = (await createBranch(database)).branchId;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('B08 continued 1b operations answer in the contract shapes', () => {
  it('manual journals and the journal reads: a draft, a change, a submission, a posting, an entry and account activity', async () => {
    const today = toBusinessDate(clock.now());
    const created = await post(accountant, '/finance/manual-journals', {
      kind: 'MANUAL',
      postingDate: today,
      description: 'Accrue electricity for the cold room',
      lines: [
        { accountId: accountId('6200'), side: 'D', amountPesewas: 65_000, memo: 'ECG, November' },
        { accountId: accountId('2020'), side: 'C', amountPesewas: 65_000 },
      ],
    });
    expect(created.status).toBe(201);
    expectShape('ManualJournal', created.body);
    const changed = await request(api.server)
      .patch(`/v1/finance/manual-journals/${created.body.id as string}`)
      .set('Cookie', accountant.jar.header())
      .set('X-CSRF-Token', accountant.csrfToken)
      .set('Origin', TEST_ORIGIN)
      .set('Idempotency-Key', randomUUID())
      .send({ version: 1, description: 'Accrue electricity for the cold room, November' });
    expect(changed.status).toBe(200);
    expectShape('ManualJournal', changed.body);
    const sent = await post(accountant, `/finance/manual-journals/${created.body.id as string}/submit`);
    expect(sent.status).toBe(202);
    expectShape('ApprovalPending', sent.body);
    expectShape('ManualJournalPage', (await get(owner, '/finance/manual-journals?status=PENDING_APPROVAL')).body);
    await stepUp(owner);
    expect((await post(owner, `/iam/approvals/${sent.body.approvalRequestId as string}/approve`, { reason: 'Meter reading agrees' })).status).toBe(200);
    const journal = await get(owner, `/finance/manual-journals/${created.body.id as string}`);
    expectShape('ManualJournal', journal.body);
    const entry = await get(owner, `/finance/journal-entries/${journal.body.journalEntryId as string}`);
    expect(entry.status).toBe(200);
    expectShape('JournalEntry', entry.body);
    expectShape('JournalEntryPage', (await get(owner, '/finance/journal-entries?kind=MANUAL&limit=5')).body);
    const activity = await get(accountant, `/finance/accounts/${accountId('6200')}/activity?from=2026-01-01&to=${today}`);
    expect(activity.status).toBe(200);
    expectShape('AccountActivity', activity.body);
    const unbalanced = await post(accountant, '/finance/manual-journals', { kind: 'MANUAL', postingDate: today, description: 'Wrong', lines: [{ accountId: accountId('6200'), side: 'D', amountPesewas: 1 }, { accountId: randomUUID(), side: 'C', amountPesewas: 1 }] });
    expect(unbalanced.status).toBe(422);
    expectShape('Error', unbalanced.body);
  });

  it('the posting catalogue, rules and determinations, and a change waiting on its checker', async () => {
    expectShape('PostingEventTypePage', (await get(accountant, '/finance/posting-event-types?limit=50')).body);
    expectShape('PostingRulePage', (await get(accountant, '/finance/posting-rules?eventCode=inv.GoodsReceived')).body);
    expectShape('AccountDeterminationPage', (await get(accountant, '/finance/account-determinations?limit=50')).body);
    await stepUp(accountant);
    const tomorrow = toBusinessDate(new Date(clock.now().getTime() + 86_400_000));
    const rule = await post(accountant, '/finance/posting-rules', { eventCode: 'prc.DirectCostIncurred', amountKey: 'value', side: 'C', accountId: accountId('2010'), validFrom: tomorrow });
    expect(rule.status).toBe(202);
    expectShape('ApprovalPending', rule.body);
    const mapping = await post(accountant, '/finance/account-determinations', { determinantType: 'LOSS_GROUP', determinantKey: 'CULL', role: 'LOSS', accountId: accountId('5100'), validFrom: tomorrow });
    expect(mapping.status).toBe(202);
    expectShape('ApprovalPending', mapping.body);
    const refused = await post(accountant, '/finance/posting-rules', { eventCode: 'prc.DirectCostIncurred', amountKey: 'value', side: 'C', accountId: accountId('2000'), validFrom: tomorrow });
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
  });
});
