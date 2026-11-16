import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Dashboards } from '../../../src/modules/rpt';
import type { Actor } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { consoleGet, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession, type TestUser } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The owner dashboard's receivables (FR-RPT-001, B05x, A-149, A-200), live from B08 continued 2: `getReceivablesTile`
 * answers the balance of 1200 from the ledger's published `fin.pub_receivable_balance` and the outstanding amount of
 * documents past their due date from billing's `bil.pub_document`, over the seeded trading day's billing documents,
 * and refuses the wrong role.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
const sessions = new Map<string, TestSession>();
let owner: TestUser;
const get = (who: string, path: string) => consoleGet(api.server, sessions.get(who)!, `/v1${path}`);

/** 1200's balance at the branch, debits less credits, straight from the journal. */
async function receivablesInSql(): Promise<number> {
  const { rows } = await database.pool('admin').query<{ b: string }>(
    "SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS b FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id WHERE a.code = '1200' AND l.branch_id = $1",
    [branchId],
  );
  return Number(rows[0]!.b);
}

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  owner = await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] });
  sessions.set('owner', await enrolAndLogin(api.server, owner, () => clock.now()));
  for (const [who, role] of [
    ['storekeeper', 'STOREKEEPER'],
    ['cashier', 'CASHIER'],
    ['sales', 'SALES'],
    ['farmHand', 'FARM_HAND'],
    ['driver', 'DRIVER'],
  ] as const) {
    sessions.set(who, await login(api.server, await createUser(database, { name: `Seeded ${who}`, grants: [{ role, branchId }] })));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the receivables tile answers 1200 and the part of it past its due date (FR-RPT-001, A-200)', () => {
  it('answers outstanding 109,389, the balance of 1200 in SQL, and nothing overdue on the seeded day', async () => {
    const tile = await get('owner', `/dashboard/tiles/receivables?branchId=${branchId}`);
    expect(tile.status, JSON.stringify(tile.body)).toBe(200);
    // The invoice 124,489 and the walk-in receipt 18,500, less the credit note 36,000, plus the debit note 2,400.
    expect(await receivablesInSql()).toBe(109_389);
    expect(tile.body).toMatchObject({ branchIds: [branchId], outstandingPesewas: 109_389, overduePesewas: 0, currency: 'GHS' });
  });

  it('refuses the Storekeeper, Cashier, Sales, Farm hand and Driver', async () => {
    for (const who of ['storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
      expect((await get(who, '/dashboard/tiles/receivables')).status, who).toBe(403);
    }
  });

  it('answers as overdue the invoice and the debit note once their due date has passed: 88,489 and 2,400', async () => {
    clock.advanceBy(31 * 86_400_000);
    // A month on, the sessions have expired: read through the handler as the Owner, as the endpoint does.
    const actor: Actor = { principalId: owner.principalId, kind: 'USER', displayName: 'Kwabena Owusu', realm: 'STAFF', sessionId: null, steppedUpAt: null };
    const tile = await api.app.get(Dashboards).getReceivablesTile(actor, { branchId });
    // The receipt has no due date and is never overdue; the invoice has 124,489 less the 36,000 credited left.
    expect(tile).toMatchObject({ outstandingPesewas: 109_389, overduePesewas: 88_489 + 2_400 });
  });
});
