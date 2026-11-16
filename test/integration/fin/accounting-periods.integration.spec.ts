import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpAt } from '../../../src/modules/iam/domain/totp';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type RoleCode, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Accounting periods over the API on the seeded farm (FR-FIN-009, FR-FIN-010, A-188, the B08 continued gate): a period
 * locks and an event dated in it posts on the day it is recorded; it closes once every earlier period has closed and
 * is never reopened; with the current period locked a posting operation is refused 422 PERIOD_NOT_OPEN and writes
 * nothing; the Owner asks to reopen it with a reason, the maker cannot approve their own request, and the posting
 * goes through once a different person has approved. Every period operation is refused to the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
type TotpSession = TestSession & { readonly secret: Buffer };
const sessions = new Map<string, TestSession>();
const ids = new Map<string, string>();

const id = (code: string) => ids.get(code)!;
const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, sessions.get(who)!, `/v1${path}`, key).send(body);
const admin = () => database.pool('admin');

interface PeriodBody {
  readonly id: string;
  readonly fiscalYear: number;
  readonly periodNo: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: string;
  readonly lockedAt: string | null;
  readonly lockedBy: { id: string; displayName: string } | null;
  readonly closedAt: string | null;
  readonly closedBy: { id: string; displayName: string } | null;
  readonly version: number;
}

async function stepUp(who: string): Promise<void> {
  clock.advanceBy(30_000);
  const session = sessions.get(who) as TotpSession;
  expect((await post(who, '/auth/step-up', { code: totpAt(session.secret, Math.floor(clock.now().getTime() / 1000)) })).status).toBe(200);
}

async function allPeriods(who: string, query = ''): Promise<PeriodBody[]> {
  const rows: PeriodBody[] = [];
  let cursor: string | null = null;
  do {
    const page = await get(who, `/finance/periods?limit=25${query}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    expect(page.status).toBe(200);
    rows.push(...(page.body.data as PeriodBody[]));
    cursor = page.body.page.nextCursor as string | null;
  } while (cursor !== null);
  return rows;
}

const today = () => toBusinessDate(clock.now());
async function periodOn(date: string): Promise<PeriodBody> {
  return (await allPeriods('accountant', `&fiscalYear=${date.slice(0, 4)}`)).find((p) => p.startDate <= date && date <= p.endDate)!;
}

/** A harvest of yam into the shop, valued 12,000, received at `receivedAt`: its posting publishes a ◆ event. */
async function harvest(receivedAt: Date): Promise<{ status: number; body: { id?: string; error?: { code: string } } }> {
  const created = await post('manager', '/goods-receipts', {
    kind: 'HARVEST',
    locationId: id('location:SHOP'),
    receivedAt: receivedAt.toISOString(),
    lines: [{ productId: id('product:PRD-YAM-TUBER'), qtyReceived: '10.000', valuePesewas: 12_000 }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await post('manager', `/goods-receipts/${created.body.id as string}/post`);
  return { status: posted.status, body: { id: created.body.id as string, ...posted.body } };
}

async function journalsFor(goodsReceiptId: string): Promise<{ posting_date: string; occurred_day: string }[]> {
  const { rows } = await admin().query<{ posting_date: string; occurred_day: string }>(
    `SELECT e.posting_date::text, (e.occurred_at AT TIME ZONE 'Africa/Accra')::date::text AS occurred_day
       FROM fin.journal_entry e JOIN inv.stock_movement m ON m.id = e.event_subject_id WHERE m.source_document_id = $1`,
    [goodsReceiptId],
  );
  return rows;
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  for (const row of (
    await admin().query<{ code: string; id: string }>(
      `SELECT 'branch:' || code AS code, id FROM mdm.branch
       UNION ALL SELECT 'location:' || l.code, l.id FROM mdm.location l JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW'
       UNION ALL SELECT 'product:' || sku, id FROM mdm.product`,
    )
  ).rows) {
    ids.set(row.code, row.id);
  }
  const people: [string, string, RoleCode, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', true],
    ['secondOwner', 'Abena Owusu', 'OWNER', true],
    ['accountant', 'Efua Asante', 'ACCOUNTANT', true],
    ['manager', 'Akosua Boateng', 'MANAGER', true],
    ['storekeeper', 'Kofi Mensah', 'STOREKEEPER', false],
    ['cashier', 'Ama Darko', 'CASHIER', false],
    ['sales', 'Yaw Agyeman', 'SALES', false],
    ['farmHand', 'Kwame Asare', 'FARM_HAND', false],
    ['driver', 'Kojo Antwi', 'DRIVER', false],
  ];
  for (const [name, displayName, role, privileged] of people) {
    const user = await createUser(database, { name: displayName, grants: [{ role, branchId: id('branch:DDW') }] });
    sessions.set(name, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('accounting periods (FR-FIN-009, A-028)', () => {
  it('lists the seeded twelve monthly periods of each year 2026 to 2030, newest first, all open', async () => {
    const all = await allPeriods('accountant');
    expect(all).toHaveLength(60);
    expect(all.map((p) => p.startDate)).toEqual([...all.map((p) => p.startDate)].sort().reverse());
    expect(all.every((p) => p.status === 'OPEN' && p.lockedBy === null && p.closedBy === null)).toBe(true);
    const year = await allPeriods('owner', '&fiscalYear=2026');
    expect(year.map((p) => p.periodNo)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(year.at(-1)).toMatchObject({ startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(await allPeriods('owner', '&status=LOCKED')).toEqual([]);
  });
});

describe('a period locks, closes and then refuses postings, through the API (FR-FIN-009, FR-FIN-010)', () => {
  let current: PeriodBody;
  let previous: PeriodBody;

  it('locks the previous period once, as the accountant, and an event dated in it posts on the day it is recorded', async () => {
    current = await periodOn(today());
    const dayBefore = toBusinessDate(new Date(Date.parse(`${current.startDate}T12:00:00Z`) - 86_400_000));
    previous = (await allPeriods('accountant')).find((p) => p.endDate === dayBefore)!;
    const key = randomUUID();
    const locked = await post('accountant', `/finance/periods/${previous.id}/lock`, {}, key);
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ id: previous.id, status: 'LOCKED', lockedBy: { displayName: 'Efua Asante' }, closedAt: null, version: previous.version + 1 });
    expect((await post('accountant', `/finance/periods/${previous.id}/lock`, {}, key)).body).toEqual(locked.body);
    const again = await post('accountant', `/finance/periods/${previous.id}/lock`);
    expect(again.status).toBe(422);
    expect(again.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'LOCKED' }] });

    const late = await harvest(new Date(Date.parse(`${previous.endDate}T12:00:00Z`)));
    expect(late.status, JSON.stringify(late.body)).toBe(200);
    expect(await journalsFor(late.body.id!)).toEqual([{ posting_date: today(), occurred_day: previous.endDate }]);
  });

  it('closes a period only after it ended and once every earlier one has closed, then never reopens it', async () => {
    await stepUp('accountant');
    const open = await post('accountant', `/finance/periods/${current.id}/close`);
    expect(open.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'OPEN' }] });
    const early = await post('accountant', `/finance/periods/${previous.id}/close`);
    expect(early.status).toBe(422);
    expect(early.body.error.details).toEqual([expect.objectContaining({ code: 'EARLIER_PERIOD_NOT_CLOSED' })]);

    const earlier = (await allPeriods('accountant')).filter((p) => p.startDate < previous.startDate).reverse();
    for (const period of earlier) {
      expect((await post('accountant', `/finance/periods/${period.id}/lock`)).status).toBe(200);
      const closed = await post('accountant', `/finance/periods/${period.id}/close`);
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    }
    const closed = await post('accountant', `/finance/periods/${previous.id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', lockedBy: { displayName: 'Efua Asante' }, closedBy: { displayName: 'Efua Asante' } });
    expect((await allPeriods('owner', '&status=CLOSED')).length).toBe(earlier.length + 1);

    await stepUp('owner');
    const reopenClosed = await post('owner', `/finance/periods/${previous.id}/reopen`, { reason: 'A late supplier invoice' });
    expect(reopenClosed.status).toBe(422);
    expect(reopenClosed.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'CLOSED' }] });
    const { rows } = await admin().query<{ action: string }>("SELECT action FROM platform.audit_event WHERE module = 'fin' AND entity_id = $1 ORDER BY occurred_at", [previous.id]);
    expect(rows.map((r) => r.action)).toEqual(['LOCK', 'CLOSE']);
  });

  it('refuses a posting operation 422 PERIOD_NOT_OPEN once the current period is locked too, and writes nothing', async () => {
    expect((await post('owner', `/finance/periods/${current.id}/lock`)).status).toBe(200);
    await stepUp('accountant');
    const notEnded = await post('accountant', `/finance/periods/${current.id}/close`);
    expect(notEnded.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'PERIOD_NOT_ENDED' }] });
    const movements = async () => (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM inv.stock_movement')).rows[0]!.n;
    const before = await movements();
    const refused = await harvest(new Date(clock.now().getTime() - 3_600_000));
    expect(refused.status).toBe(422);
    expect(refused.body.error!.code).toBe('PERIOD_NOT_OPEN');
    expect(await movements()).toBe(before);
    expect(await journalsFor(refused.body.id!)).toEqual([]);
  });

  it('reopens a locked period only when the Owner asks with a reason and a different person approves', async () => {
    await stepUp('accountant');
    expect((await post('accountant', `/finance/periods/${current.id}/reopen`, { reason: 'Not the owner' })).status).toBe(403);
    expect((await post('owner', `/finance/periods/${current.id}/reopen`, { reason: '   ' })).status).toBe(400);
    await stepUp('owner');
    const asked = await post('owner', `/finance/periods/${current.id}/reopen`, { reason: 'Yam harvest recorded after the lock' });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({ status: 'PENDING_APPROVAL', kind: 'PERIOD_REOPEN', subject: { docType: 'PERIOD_REOPEN', number: null } });
    expect((await periodOn(today())).status).toBe('LOCKED');
    const twice = await post('owner', `/finance/periods/${current.id}/reopen`, { reason: 'Asked twice' });
    expect(twice.body.error).toMatchObject({ code: 'INVALID_STATE_TRANSITION', details: [{ code: 'REOPEN_PENDING' }] });

    const self = await post('owner', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'My own' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('MAKER_CANNOT_CHECK');
    expect((await post('manager', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Not mine to approve' })).status).toBe(403);
    expect((await periodOn(today())).status).toBe('LOCKED');

    await stepUp('accountant');
    const approved = await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/approve`, { reason: 'Checked the harvest sheet' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const reopened = await periodOn(today());
    expect(reopened).toMatchObject({ status: 'OPEN', lockedAt: null, lockedBy: null, version: current.version + 2 });
    const { rows } = await admin().query<{ status: string; decided_by: string; reason: string }>('SELECT status, decided_by, reason FROM fin.period_reopen WHERE id = $1', [asked.body.subject.id]);
    expect(rows[0]).toMatchObject({ status: 'POSTED', reason: 'Yam harvest recorded after the lock' });
    const audit = await admin().query<{ action: string; before: unknown; after: unknown }>("SELECT action, before, after FROM platform.audit_event WHERE module = 'fin' AND entity_id = $1 AND action = 'REOPEN'", [current.id]);
    expect(audit.rows).toHaveLength(1);

    const posted = await harvest(new Date(clock.now().getTime() - 3_600_000));
    expect(posted.status).toBe(200);
    expect(await journalsFor(posted.body.id!)).toEqual([{ posting_date: today(), occurred_day: today() }]);
  });

  it('keeps the period locked when the checker rejects the reopen, and a second Owner may approve the next request', async () => {
    expect((await post('accountant', `/finance/periods/${current.id}/lock`)).status).toBe(200);
    await stepUp('owner');
    const asked = await post('owner', `/finance/periods/${current.id}/reopen`, { reason: 'Correct a receipt' });
    expect(asked.status).toBe(202);
    await stepUp('accountant');
    expect((await post('accountant', `/iam/approvals/${asked.body.approvalRequestId as string}/reject`, { reason: 'Post it next month' })).status).toBe(200);
    expect((await periodOn(today())).status).toBe('LOCKED');
    const { rows } = await admin().query<{ status: string }>('SELECT status FROM fin.period_reopen WHERE id = $1', [asked.body.subject.id]);
    expect(rows[0]!.status).toBe('REJECTED');

    await stepUp('owner');
    const again = await post('owner', `/finance/periods/${current.id}/reopen`, { reason: 'Correct a receipt, agreed' });
    expect(again.status).toBe(202);
    await stepUp('secondOwner');
    expect((await post('secondOwner', `/iam/approvals/${again.body.approvalRequestId as string}/approve`, { reason: 'Agreed' })).status).toBe(200);
    expect((await periodOn(today())).status).toBe('OPEN');
  });
});

describe('every period operation refuses the wrong role (ADR-0017, ADR-0035)', () => {
  for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
    it(`refuses the ${who} every period operation with 403`, async () => {
      const period = randomUUID();
      expect((await get(who, '/finance/periods')).status).toBe(403);
      expect((await post(who, `/finance/periods/${period}/lock`)).status).toBe(403);
      expect((await post(who, `/finance/periods/${period}/close`)).status).toBe(403);
      expect((await post(who, `/finance/periods/${period}/reopen`, { reason: 'Refused' })).status).toBe(403);
    });
  }

  it('needs a fresh step-up to close or reopen', async () => {
    const period = (await periodOn('2030-12-15')).id;
    for (const [name, displayName, role] of [
      ['freshAccountant', 'Esi Quaye', 'ACCOUNTANT'],
      ['freshOwner', 'Nana Owusu', 'OWNER'],
    ] as const) {
      sessions.set(name, await enrolAndLogin(api.server, await createUser(database, { name: displayName, grants: [{ role, branchId: id('branch:DDW') }] }), () => clock.now()));
    }
    clock.advanceBy(310_000); // past the five-minute step-up window, well within a fresh session
    expect((await post('freshAccountant', `/finance/periods/${period}/close`)).body.error.code).toBe('STEP_UP_REQUIRED');
    expect((await post('freshOwner', `/finance/periods/${period}/reopen`, { reason: 'Stale step-up' })).body.error.code).toBe('STEP_UP_REQUIRED');
  });
});
