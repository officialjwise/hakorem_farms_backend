import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, stepUp, type TotpSession } from '../../support/fin';
import { SYSTEM_PRINCIPAL, consoleGet, consolePost, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Depreciation runs over the seeded farm (FR-FIN-015, ADR-0003 row fin.DepreciationRun, ADR-0059, the B08 continued 1c2
 * gate): a run spreads each asset's depreciable amount exactly with allocate (1,000,001 over three months is 333,334,
 * 333,334 and 333,333; the seeded cold room's 4,000,000 over 36 months starts with four months of 111,112), posts once
 * per period, a second run refused by the database's unique key under concurrent requests, posts only when someone
 * other than its maker posts it, never into a locked period, and catches up a month no run charged. Every figure is
 * compared with the journal lines in SQL.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let owner: TotpSession;
let secondOwner: TotpSession;
let accountant: TotpSession;
let branchId: string;
const assets = new Map<string, string>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const post = (who: TestSession, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, who, `/v1${path}`, key).send(body);
const get = (who: TestSession, path: string) => consoleGet(api.server, who, `/v1${path}`);
const patch = (who: TestSession, path: string, body: object) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', who.jar.header()).set('X-CSRF-Token', who.csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', randomUUID()).send(body);

async function periodId(no: number): Promise<string> {
  return (await admin().query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE fiscal_year = 2026 AND period_no = $1', [no])).rows[0]!.id;
}

async function seededAsset(name: string): Promise<string> {
  return (await admin().query<{ id: string }>('SELECT id FROM fin.fixed_asset WHERE name = $1', [name])).rows[0]!.id;
}

/** The lines the ledger posted for a run, straight from the journal: per account code, side and cost object. */
async function postedLines(runId: string): Promise<{ code: string; side: string; amount: bigint; costObjectId: string | null; postingDate: string }[]> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string; cost_object_id: string | null; posting_date: string }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, l.cost_object_id, l.posting_date::text AS posting_date
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
      WHERE e.source_document_id = $1 ORDER BY l.line_no`,
    [runId],
  );
  return rows.map((r) => ({ code: r.code, side: r.side, amount: BigInt(r.amount), costObjectId: r.cost_object_id, postingDate: r.posting_date }));
}

const lineOf = (run: { lines: { fixedAsset: { id: string }; amountPesewas: number }[] }, assetId: string) => run.lines.find((l) => l.fixedAsset.id === assetId)?.amountPesewas;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  const now = () => clock.now();
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  secondOwner = await enrolAndLogin(api.server, await createUser(database, { name: 'Abena Owusu', grants: [{ role: 'OWNER', branchId }] }), now);
  accountant = await enrolAndLogin(api.server, await createUser(database, { name: 'Efua Asante', grants: [{ role: 'ACCOUNTANT', branchId }] }), now);
  const register = async (code: string, body: object) => {
    const created = await post(accountant, '/finance/fixed-assets', { branchId, ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    assets.set(code, created.body.id as string);
  };
  await register('three-month', { name: 'Egg grading table', category: 'EQUIPMENT', acquiredOn: '2026-06-05', costPesewas: 1_000_001, usefulLifeMonths: 3 });
  await register('cold-room', { name: 'Second cold room, 8 m³', category: 'COLD_ROOM', acquiredOn: '2026-08-01', costPesewas: 1_200_000, residualPesewas: 0, usefulLifeMonths: 120 });
  assets.set('seeded-cold-room', await seededAsset('Cold room, 12 m³ (SEED)'));
  const ledger = await ledgerIds(database);
  await postManualJournal(api.server, clock, { maker: accountant, checker: owner }, {
    postingDate: '2026-08-01',
    description: 'The grading table and the second cold room, paid from opening funds',
    lines: [
      { accountId: ledger.account('1540'), side: 'D', amountPesewas: 1_000_001 },
      { accountId: ledger.account('1520'), side: 'D', amountPesewas: 1_200_000 },
      { accountId: ledger.account('3900'), side: 'C', amountPesewas: 2_200_001 },
    ],
  });
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('a run is calculated once per period, and the database holds it (FR-FIN-015)', () => {
  let june: string;

  it('lets exactly one of four concurrent runs for June through, the others 422 DEPRECIATION_RUN_EXISTS', async () => {
    const period = await periodId(6);
    const answers = await Promise.all([0, 1, 2, 3].map(() => post(accountant, '/finance/depreciation-runs', { periodId: period })));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 422, 422, 422]);
    for (const refused of answers.filter((a) => a.status === 422)) expect(refused.body.error.code).toBe('DEPRECIATION_RUN_EXISTS');
    june = answers.find((a) => a.status === 201)!.body.id as string;
    expect((await admin().query('SELECT 1 FROM fin.depreciation_run WHERE period_id = $1', [period])).rows).toHaveLength(1);
    const again = await post(accountant, '/finance/depreciation-runs', { periodId: period });
    expect([again.status, again.body.error.code]).toEqual([422, 'DEPRECIATION_RUN_EXISTS']);
  });

  it('spreads each asset exactly: 333,334 for the first of three months, and the seeded cold room four months of 111,112 caught up', async () => {
    const run = (await get(accountant, `/finance/depreciation-runs/${june}`)).body;
    expect(run.status).toBe('DRAFT');
    expect(run.journalEntryId).toBeNull();
    expect(lineOf(run, assets.get('three-month')!)).toBe(333_334);
    expect(lineOf(run, assets.get('seeded-cold-room')!)).toBe(444_448);
    expect(lineOf(run, assets.get('cold-room')!)).toBeUndefined();
    expect(run.totalPesewas).toBe(run.lines.reduce((sum: number, l: { amountPesewas: number }) => sum + l.amountPesewas, 0));
  });

  it('refuses, in the database, a second run for the period and a run posted by its own maker', async () => {
    const client = await app().connect();
    const refusal = async (sql: string, values: unknown[]) => {
      try {
        await client.query('BEGIN');
        await client.query(sql, values);
        await client.query('COMMIT');
        return null;
      } catch (error) {
        await client.query('ROLLBACK');
        return (error as { constraint?: string }).constraint;
      }
    };
    try {
      const doc = randomUUID();
      await admin().query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'DEPRECIATION_RUN', 'fin', $2, $3)", [doc, branchId, SYSTEM_PRINCIPAL]);
      expect(
        await refusal("INSERT INTO fin.depreciation_run (id, period_id, branch_id, status, total_pesewas, created_by, updated_by) VALUES ($1, $2, $3, 'DRAFT', 1, $4, $4)", [doc, await periodId(6), branchId, SYSTEM_PRINCIPAL]),
      ).toBe('uq_depreciation_run_period');
      const maker = (await admin().query<{ created_by: string }>('SELECT created_by FROM fin.depreciation_run WHERE id = $1', [june])).rows[0]!.created_by;
      const anyEntry = (await admin().query<{ id: string }>('SELECT id FROM fin.journal_entry LIMIT 1')).rows[0]!.id;
      expect(
        await refusal("UPDATE fin.depreciation_run SET status = 'POSTED', journal_entry_id = $2, posted_at = now(), posted_by = $3, updated_by = $3, version = version + 1 WHERE id = $1", [june, anyEntry, maker]),
      ).toBe('ck_depreciation_run_maker_checker');
      const other = SYSTEM_PRINCIPAL;
      expect(
        await refusal("UPDATE fin.depreciation_run SET status = 'POSTED', journal_entry_id = $2, posted_at = now(), posted_by = $3, updated_by = $3, version = version + 1 WHERE id = $1", [june, anyEntry, other]),
      ).toBe('ck_depreciation_run_post');
      expect(await refusal('UPDATE fin.depreciation_line SET amount_pesewas = amount_pesewas + 1 WHERE depreciation_run_id = $1', [june])).not.toBeNull();
    } finally {
      client.release();
    }
  });

  it('refuses its maker posting it (403), and two checkers posting it at once post it once', async () => {
    const own = await post(accountant, `/finance/depreciation-runs/${june}/post`);
    expect([own.status, own.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect(await postedLines(june)).toEqual([]);
    const answers = await Promise.all([post(owner, `/finance/depreciation-runs/${june}/post`), post(secondOwner, `/finance/depreciation-runs/${june}/post`)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 422]);
    expect(answers.find((a) => a.status === 422)!.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const posted = answers.find((a) => a.status === 200)!.body;
    expect(posted.status).toBe('POSTED');
    expect((await admin().query("SELECT 1 FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = 'fin.DepreciationRun'", [june])).rows).toHaveLength(1);
  });

  it('posts Dr 6500 and Cr 1590 per asset at the exact amounts, on 30 June, the asset as cost object (ADR-0003 matrix row)', async () => {
    const run = (await get(owner, `/finance/depreciation-runs/${june}`)).body;
    const lines = await postedLines(june);
    expect(lines).toHaveLength(run.lines.length * 2);
    for (const line of run.lines as { fixedAsset: { id: string }; amountPesewas: number }[]) {
      const own = lines.filter((l) => l.costObjectId === line.fixedAsset.id);
      expect(own.map((l) => [l.code, l.side, l.amount, l.postingDate])).toEqual([
        ['6500', 'D', BigInt(line.amountPesewas), '2026-06-30'],
        ['1590', 'C', BigInt(line.amountPesewas), '2026-06-30'],
      ]);
    }
    expect(lines.filter((l) => l.side === 'D').reduce((sum, l) => sum + l.amount, 0n)).toBe(BigInt(run.totalPesewas));
    expect(run.journalEntryId).toBe((await admin().query<{ id: string }>('SELECT id FROM fin.journal_entry WHERE source_document_id = $1', [june])).rows[0]!.id);
    const event = await admin().query<{ payload: { postingDate: string; lines: { fixedAssetId: string; amountPesewas: number; months: number }[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'fin.DepreciationRun' AND payload->>'depreciationRunId' = $1",
      [june],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]!.payload.postingDate).toBe('2026-06-30');
    expect(event.rows[0]!.payload.lines.find((l) => l.fixedAssetId === assets.get('three-month'))).toMatchObject({ amountPesewas: 333_334, months: 1 });
    const asset = (await get(owner, `/finance/fixed-assets/${assets.get('three-month')!}`)).body;
    expect([asset.accumulatedPesewas, asset.netBookValuePesewas, asset.status]).toEqual([333_334, 666_667, 'IN_USE']);
  });

  it('refuses an asset change while a draft run carries it, and a posted run again', async () => {
    const replay = await post(owner, `/finance/depreciation-runs/${june}/post`);
    expect([replay.status, replay.body.error.code]).toEqual([422, 'INVALID_STATE_TRANSITION']);
    const july = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(7) });
    expect(july.status).toBe(201);
    expect(lineOf(july.body, assets.get('three-month')!)).toBe(333_334);
    expect(lineOf(july.body, assets.get('seeded-cold-room')!)).toBe(111_111);
    const version = (await get(accountant, `/finance/fixed-assets/${assets.get('three-month')!}`)).body.version as number;
    const changed = await patch(accountant, `/finance/fixed-assets/${assets.get('three-month')!}`, { version, usefulLifeMonths: 4 });
    expect([changed.status, changed.body.error.code, changed.body.error.details[0].code]).toEqual([422, 'FIXED_ASSET_INVALID', 'DEPRECIATION_RUN_PENDING']);
    const renamed = await patch(accountant, `/finance/fixed-assets/${assets.get('three-month')!}`, { version, name: 'Egg grading table, steel' });
    expect(renamed.status).toBe(200);
    const posted = await post(owner, `/finance/depreciation-runs/${july.body.id as string}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  });
});

describe('a run never posts into a locked period, and the next run catches the month up (FR-FIN-009, FR-FIN-015)', () => {
  it('refuses to post August once August is locked, applying nothing', async () => {
    const august = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(8) });
    expect(august.status).toBe(201);
    await stepUp(api.server, accountant, clock);
    expect((await post(accountant, `/finance/periods/${await periodId(8)}/lock`)).status).toBe(200);
    const before = (await get(owner, `/finance/fixed-assets/${assets.get('three-month')!}`)).body;
    const refused = await post(owner, `/finance/depreciation-runs/${august.body.id as string}/post`);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'PERIOD_NOT_OPEN']);
    expect(await postedLines(august.body.id as string)).toEqual([]);
    expect((await get(owner, `/finance/fixed-assets/${assets.get('three-month')!}`)).body).toEqual(before);
    const another = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(8) });
    expect([another.status, another.body.error.code]).toEqual([422, 'PERIOD_NOT_OPEN']);
  });

  it('charges September with August caught up: the last of three months 333,333, so the asset sums to 1,000,001 exactly', async () => {
    const september = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(9) });
    expect(september.status).toBe(201);
    expect(lineOf(september.body, assets.get('three-month')!)).toBe(333_333);
    expect(lineOf(september.body, assets.get('cold-room')!)).toBe(20_000);
    expect(lineOf(september.body, assets.get('seeded-cold-room')!)).toBe(222_222);
    expect((await post(owner, `/finance/depreciation-runs/${september.body.id as string}/post`)).status).toBe(200);
    const asset = (await get(owner, `/finance/fixed-assets/${assets.get('three-month')!}`)).body;
    expect([asset.accumulatedPesewas, asset.netBookValuePesewas, asset.status]).toEqual([1_000_001, 0, 'FULLY_DEPRECIATED']);
    const { rows } = await admin().query<{ total: string }>(
      `SELECT sum(l.amount_pesewas)::text AS total FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id
        WHERE a.code = '6500' AND l.side = 'D' AND l.cost_object_id = $1`,
      [assets.get('three-month')],
    );
    expect(BigInt(rows[0]!.total)).toBe(1_000_001n);
  });

  it('refuses a run for a period not yet ended or with nothing left to charge', async () => {
    // The period holding today has not ended, whatever month the suite runs in.
    const current = (await admin().query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE $1::date BETWEEN start_date AND end_date', [toBusinessDate(clock.now())])).rows[0]!.id;
    const unended = await post(accountant, '/finance/depreciation-runs', { periodId: current });
    expect([unended.status, unended.body.error.code, unended.body.error.details[0].code]).toEqual([422, 'DEPRECIATION_RUN_INVALID', 'PERIOD_NOT_ENDED']);
    const february = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(2) });
    expect([february.status, february.body.error.code, february.body.error.details[0].code]).toEqual([422, 'DEPRECIATION_RUN_INVALID', 'NOTHING_TO_DEPRECIATE']);
  });

  it('refuses to post a run that went stale, and leaves the register and the ledger in agreement', async () => {
    const october = await post(accountant, '/finance/depreciation-runs', { periodId: await periodId(10) });
    expect(october.status).toBe(201);
    // A superuser's edit stands in for any change the run did not see (a reopened period, a script).
    await admin().query('UPDATE fin.fixed_asset SET useful_life_months = 60, version = version + 1 WHERE id = $1', [assets.get('cold-room')]);
    const stale = await post(owner, `/finance/depreciation-runs/${october.body.id as string}/post`);
    expect([stale.status, stale.body.error.code, stale.body.error.details[0].code]).toEqual([422, 'DEPRECIATION_RUN_INVALID', 'RUN_STALE']);
    expect(await postedLines(october.body.id as string)).toEqual([]);
    await admin().query('UPDATE fin.fixed_asset SET useful_life_months = 120, version = version + 1 WHERE id = $1', [assets.get('cold-room')]);
    expect((await post(owner, `/finance/depreciation-runs/${october.body.id as string}/post`)).status).toBe(200);
    const report = await api.app.get(LedgerReconciliation).run({ principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null });
    expect(report.sources.filter((s) => s.source.startsWith('fin.'))).toEqual([
      { source: 'fin.fixed-asset-cost', breaks: [], unmapped: [] },
      { source: 'fin.fixed-asset-depreciation', breaks: [], unmapped: [] },
    ]);
    expect(report.clean).toBe(true);
  });
});
