import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerReconciliation } from '../../../src/modules/fin';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { ledgerIds, postManualJournal, type TotpSession } from '../../support/fin';
import { SYSTEM_PRINCIPAL, consoleGet, consolePost, createUser, enrolAndLogin, login, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, TEST_ORIGIN, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The fixed asset register over the seeded farm (FR-FIN-014, ADR-0059, the B08 continued 1c2 gate): every operation
 * refused to the wrong role and at the wrong branch; registering records and posts nothing; a change of estimate is
 * prospective; disposal posts through the ledger's balanced-entry path its cost and accumulated depreciation out, its
 * proceeds in and its exact gain or loss on 4920 (ADR-0003's new row fin.FixedAssetDisposed), compared with the journal
 * lines in SQL; the database keeps what an asset never changes; and the nightly reconciliation compares the register
 * with 1510 to 1540 and 1590, reporting a difference and correcting nothing.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let branchId: string;
let testBranchId: string;
const sessions = new Map<string, TestSession>();
const admin = () => database.pool('admin');
const app = () => database.pool('app');
const as = (who: string) => sessions.get(who)!;
const post = (who: string, path: string, body: object = {}, key: string = randomUUID()) => consolePost(api.server, as(who), `/v1${path}`, key).send(body);
const get = (who: string, path: string) => consoleGet(api.server, as(who), `/v1${path}`);
const patch = (who: string, path: string, body: object, key: string = randomUUID()) =>
  request(api.server).patch(`/v1${path}`).set('Cookie', as(who).jar.header()).set('X-CSRF-Token', as(who).csrfToken).set('Origin', TEST_ORIGIN).set('Idempotency-Key', key).send(body);
const SYSTEM = { principalId: SYSTEM_PRINCIPAL, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null } as const;

/** The lines the ledger posted with this document as source, straight from the journal. */
async function linesOf(sourceDocumentId: string): Promise<{ code: string; side: string; amount: number; party: string | null; date: string }[]> {
  const { rows } = await admin().query<{ code: string; side: string; amount: string; party: string | null; date: string }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, s.display_name AS party, l.posting_date::text AS date
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE e.source_document_id = $1 ORDER BY l.line_no`,
    [sourceDocumentId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

async function disposalDocumentOf(assetId: string): Promise<string> {
  return (await admin().query<{ disposal_document_id: string }>('SELECT disposal_document_id FROM fin.fixed_asset WHERE id = $1', [assetId])).rows[0]!.disposal_document_id;
}

const scale = { name: 'Platform scale, 150 kg', category: 'EQUIPMENT', acquiredOn: '2026-01-20', costPesewas: 420_000, usefulLifeMonths: 36 };

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(app(), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  const branches = new Map((await admin().query<{ code: string; id: string }>('SELECT code, id FROM mdm.branch')).rows.map((r) => [r.code, r.id] as const));
  branchId = branches.get('DDW')!;
  testBranchId = branches.get('TST')!;
  const people: [string, string, string, string, boolean][] = [
    ['owner', 'Kwabena Owusu', 'OWNER', branchId, true],
    ['accountant', 'Yaw Agyeman', 'ACCOUNTANT', branchId, true],
    ['otherAccountant', 'Ama Mensah', 'ACCOUNTANT', testBranchId, true],
    ['manager', 'Akosua Boateng', 'MANAGER', branchId, true],
    ['storekeeper', 'Kwesi Ofori', 'STOREKEEPER', branchId, false],
    ['cashier', 'Adwoa Darko', 'CASHIER', branchId, false],
    ['sales', 'Esi Appiah', 'SALES', branchId, false],
    ['farmHand', 'Abdul-Rahman Iddrisu', 'FARM_HAND', branchId, false],
    ['driver', 'Selorm Agbeko', 'DRIVER', branchId, false],
  ];
  for (const [who, name, role, branch, privileged] of people) {
    const user = await createUser(database, { name, grants: [{ role: role as 'OWNER', branchId: branch }] });
    sessions.set(who, privileged ? await enrolAndLogin(api.server, user, () => clock.now()) : await login(api.server, user));
  }
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('every fixed asset operation refuses the wrong role (ADR-0017, ADR-0035)', () => {
  it('refuses the Manager, Storekeeper, Cashier, Sales, Farm hand and Driver every read and write', async () => {
    const someAsset = (await admin().query<{ id: string }>('SELECT id FROM fin.fixed_asset LIMIT 1')).rows[0]!.id;
    const period = (await admin().query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE fiscal_year = 2026 AND period_no = 10')).rows[0]!.id;
    for (const who of ['manager', 'storekeeper', 'cashier', 'sales', 'farmHand', 'driver']) {
      expect((await get(who, '/finance/fixed-assets')).status, who).toBe(403);
      expect((await get(who, `/finance/fixed-assets/${someAsset}`)).status, who).toBe(403);
      expect((await post(who, '/finance/fixed-assets', { ...scale, branchId })).status, who).toBe(403);
      expect((await patch(who, `/finance/fixed-assets/${someAsset}`, { version: 1, name: 'Refused' })).status, who).toBe(403);
      expect((await post(who, `/finance/fixed-assets/${someAsset}/dispose`, { disposedOn: '2026-11-10', proceedsPesewas: 0, note: 'Refused' })).status, who).toBe(403);
      expect((await get(who, '/finance/depreciation-runs')).status, who).toBe(403);
      expect((await get(who, `/finance/depreciation-runs/${randomUUID()}`)).status, who).toBe(403);
      expect((await post(who, '/finance/depreciation-runs', { periodId: period })).status, who).toBe(403);
      expect((await post(who, `/finance/depreciation-runs/${randomUUID()}/post`)).status, who).toBe(403);
    }
    expect((await admin().query("SELECT count(*)::int AS n FROM fin.fixed_asset WHERE name LIKE 'Refused%' OR name = $1", [scale.name])).rows[0]!.n).toBe(0);
    expect((await admin().query('SELECT 1 FROM fin.depreciation_run')).rows).toHaveLength(0);
  });

  it('refuses an Accountant of another branch writing an asset of Dodowa', async () => {
    const someAsset = (await admin().query<{ id: string; version: number }>('SELECT id, version FROM fin.fixed_asset LIMIT 1')).rows[0]!;
    expect((await post('otherAccountant', '/finance/fixed-assets', { ...scale, branchId })).status).toBe(403);
    expect((await patch('otherAccountant', `/finance/fixed-assets/${someAsset.id}`, { version: someAsset.version, name: 'Refused' })).status).toBe(403);
    expect((await post('otherAccountant', `/finance/fixed-assets/${someAsset.id}/dispose`, { disposedOn: '2026-11-10', proceedsPesewas: 0, note: 'Refused' })).status).toBe(403);
  });
});

describe('the register records cost, life and residual and posts nothing (FR-FIN-014)', () => {
  it('shows a cold room costing 1,200,000 with no residual over 120 months at a net book value of 1,200,000 at purchase', async () => {
    const entries = (await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry')).rows[0]!.n;
    const key = randomUUID();
    const created = await post('accountant', '/finance/fixed-assets', { name: 'Walk-in cold room, 6 m³', category: 'COLD_ROOM', branchId, acquiredOn: '2026-11-02', costPesewas: 1_200_000, usefulLifeMonths: 120 }, key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Walk-in cold room, 6 m³',
      category: 'COLD_ROOM',
      branch: { id: branchId, code: 'DDW' },
      costPesewas: 1_200_000,
      residualPesewas: 0,
      usefulLifeMonths: 120,
      method: 'STRAIGHT_LINE',
      accumulatedPesewas: 0,
      netBookValuePesewas: 1_200_000,
      status: 'IN_USE',
      disposedOn: null,
      currency: 'GHS',
      version: 1,
    });
    expect(created.body.assetNo).toMatch(/^FA-[0-9]{4}$/);
    expect((await admin().query<{ n: number }>('SELECT count(*)::int AS n FROM fin.journal_entry')).rows[0]!.n).toBe(entries);
    const replay = await post('accountant', '/finance/fixed-assets', { name: 'Walk-in cold room, 6 m³', category: 'COLD_ROOM', branchId, acquiredOn: '2026-11-02', costPesewas: 1_200_000, usefulLifeMonths: 120 }, key);
    expect(replay.body).toEqual(created.body);
    const audit = await admin().query("SELECT 1 FROM platform.audit_event WHERE module = 'fin' AND action = 'CREATE' AND entity_type = 'FixedAsset' AND entity_id = $1", [created.body.id]);
    expect(audit.rows).toHaveLength(1);
    expect((await get('owner', `/finance/fixed-assets/${created.body.id as string}`)).body).toEqual(created.body);
    const listed = (await get('owner', '/finance/fixed-assets?category=COLD_ROOM')).body;
    expect(listed.data.map((a: { name: string }) => a.name)).toEqual(['Cold room, 12 m³ (SEED)', 'Walk-in cold room, 6 m³']);
  });

  it('refuses a residual above the cost, a life outside 1 to 600 months, a future date and an unknown branch', async () => {
    const bad = await post('accountant', '/finance/fixed-assets', { ...scale, branchId, residualPesewas: 420_001, usefulLifeMonths: 0, acquiredOn: '2026-12-01' });
    expect([bad.status, bad.body.error.code]).toEqual([422, 'FIXED_ASSET_INVALID']);
    expect(bad.body.error.details.map((d: { code: string }) => d.code)).toEqual(['RESIDUAL_ABOVE_COST', 'LIFE_OUT_OF_RANGE', 'FUTURE_DATE']);
    const unknown = await post('owner', '/finance/fixed-assets', { ...scale, branchId: randomUUID() });
    expect(unknown.status).toBe(403);
    const filter = await get('owner', '/finance/fixed-assets?category=TRACTOR');
    expect(filter.status).toBe(400);
  });

  it('changes an estimate at the version read, and refuses one that ends the life before the months charged', async () => {
    const created = (await post('accountant', '/finance/fixed-assets', { ...scale, branchId })).body;
    const stale = await patch('accountant', `/finance/fixed-assets/${created.id as string}`, { version: 2, usefulLifeMonths: 48 });
    expect(stale.status).toBe(409);
    const changed = await patch('accountant', `/finance/fixed-assets/${created.id as string}`, { version: 1, usefulLifeMonths: 48, residualPesewas: 20_000 });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ usefulLifeMonths: 48, residualPesewas: 20_000, version: 2, netBookValuePesewas: 420_000 });
    const tooHigh = await patch('accountant', `/finance/fixed-assets/${created.id as string}`, { version: 2, residualPesewas: 420_001 });
    expect([tooHigh.status, tooHigh.body.error.details[0].code]).toEqual([422, 'RESIDUAL_ABOVE_NET_BOOK_VALUE']);
  });
});

describe('disposal posts its exact gain or loss through the balanced-entry path (FR-FIN-014, ADR-0059)', () => {
  let scaleId: string;
  let generatorId: string;

  beforeAll(async () => {
    scaleId = (await post('accountant', '/finance/fixed-assets', { ...scale, name: 'Hanging scale, 50 kg', branchId })).body.id as string;
    generatorId = (await post('accountant', '/finance/fixed-assets', { name: 'Standby generator, 20 kVA', category: 'EQUIPMENT', branchId, acquiredOn: '2026-01-05', costPesewas: 500_000, usefulLifeMonths: 5 })).body.id as string;
    const ledger = await ledgerIds(database);
    const owner = as('owner') as TotpSession;
    await postManualJournal(api.server, clock, { maker: as('accountant'), checker: owner }, {
      postingDate: '2026-01-20',
      description: 'Equipment bought for the farm, against opening funds',
      lines: [
        { accountId: ledger.account('1540'), side: 'D', amountPesewas: 420_000 * 3 + 500_000 },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 420_000 * 3 + 500_000 },
      ],
    });
    // January to October charged by one run: the generator fully, 500,000 over five months; the scale ten months.
    const october = (await admin().query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE fiscal_year = 2026 AND period_no = 10')).rows[0]!.id;
    const run = await post('accountant', '/finance/depreciation-runs', { periodId: october });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect((await post('owner', `/finance/depreciation-runs/${run.body.id as string}/post`)).status).toBe(200);
  });

  it('posts a loss of 153,330 when the scale, 116,670 depreciated, is sold for 150,000 into the bank account named', async () => {
    const scaleNow = (await get('owner', `/finance/fixed-assets/${scaleId}`)).body;
    expect([scaleNow.accumulatedPesewas, scaleNow.netBookValuePesewas]).toEqual([116_670, 303_330]);
    const bank = (await admin().query<{ id: string; name: string }>("SELECT id, name FROM fin.bank_account WHERE kind = 'BANK' LIMIT 1")).rows[0]!;
    const disposed = await post('accountant', `/finance/fixed-assets/${scaleId}/dispose`, { disposedOn: '2026-11-13', proceedsPesewas: 150_000, bankAccountId: bank.id, note: 'Old scale sold to a neighbour' });
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
    expect(disposed.body).toMatchObject({ status: 'DISPOSED', disposedOn: '2026-11-13', accumulatedPesewas: 116_670, netBookValuePesewas: 303_330 });
    expect(await linesOf(await disposalDocumentOf(scaleId))).toEqual([
      { code: '1540', side: 'C', amount: 420_000, party: null, date: '2026-11-13' },
      { code: '1590', side: 'D', amount: 116_670, party: null, date: '2026-11-13' },
      { code: '1100', side: 'D', amount: 150_000, party: bank.name, date: '2026-11-13' },
      { code: '4920', side: 'D', amount: 153_330, party: null, date: '2026-11-13' },
    ]);
    const event = await admin().query<{ payload: { lossPesewas: number; gainPesewas: number; proceedsMethod: string; abuseCases: number[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'fin.FixedAssetDisposed' AND payload->>'fixedAssetId' = $1",
      [scaleId],
    );
    expect(event.rows.map((r) => r.payload)).toMatchObject([{ lossPesewas: 153_330, gainPesewas: 0, proceedsMethod: 'BANK', abuseCases: [30] }]);
    const again = await post('accountant', `/finance/fixed-assets/${scaleId}/dispose`, { disposedOn: '2026-11-13', proceedsPesewas: 150_000, note: 'Twice' });
    expect([again.status, again.body.error.details[0].code]).toEqual([422, 'ASSET_DISPOSED']);
    const renamed = await patch('accountant', `/finance/fixed-assets/${scaleId}`, { version: disposed.body.version as number, name: 'Renamed' });
    expect([renamed.status, renamed.body.error.details[0].code]).toEqual([422, 'ASSET_DISPOSED']);
  });

  it('posts a gain of 50,001 when the fully depreciated generator is sold for cash, into the safe', async () => {
    expect((await get('owner', `/finance/fixed-assets/${generatorId}`)).body).toMatchObject({ accumulatedPesewas: 500_000, netBookValuePesewas: 0, status: 'FULLY_DEPRECIATED' });
    const disposed = await post('accountant', `/finance/fixed-assets/${generatorId}/dispose`, { disposedOn: '2026-11-14', proceedsPesewas: 50_001, note: 'Sold to a chop bar in Dodowa for parts' });
    expect(disposed.status, JSON.stringify(disposed.body)).toBe(200);
    expect(await linesOf(await disposalDocumentOf(generatorId))).toEqual([
      { code: '1540', side: 'C', amount: 500_000, party: null, date: '2026-11-14' },
      { code: '1590', side: 'D', amount: 500_000, party: null, date: '2026-11-14' },
      { code: '1010', side: 'D', amount: 50_001, party: null, date: '2026-11-14' },
      { code: '4920', side: 'C', amount: 50_001, party: null, date: '2026-11-14' },
    ]);
  });

  it('refuses a disposal dated in the future, before a month already depreciated, or to an unknown account', async () => {
    const other = (await post('accountant', '/finance/fixed-assets', { ...scale, name: 'Egg candler', branchId })).body.id as string;
    const future = await post('accountant', `/finance/fixed-assets/${other}/dispose`, { disposedOn: '2026-12-01', proceedsPesewas: 0, note: 'Scrapped' });
    expect([future.status, future.body.error.details[0].code]).toEqual([422, 'FUTURE_DATE']);
    const seeded = (await admin().query<{ id: string }>("SELECT id FROM fin.fixed_asset WHERE name = 'Platform scale, 300 kg (SEED)'")).rows[0]!.id;
    const early = await post('accountant', `/finance/fixed-assets/${seeded}/dispose`, { disposedOn: '2026-09-30', proceedsPesewas: 0, note: 'Scrapped' });
    expect([early.status, early.body.error.details[0].code]).toEqual([422, 'BEFORE_LAST_DEPRECIATION']);
    const unknown = await post('accountant', `/finance/fixed-assets/${other}/dispose`, { disposedOn: '2026-11-10', proceedsPesewas: 10_000, bankAccountId: randomUUID(), note: 'Sold' });
    expect([unknown.status, unknown.body.error.code]).toEqual([422, 'REFERENCE_NOT_FOUND']);
  });

  it('keeps the ledger balanced, and the register in agreement with 1510 to 1540 and 1590, once the candler and the cold room are journaled', async () => {
    const ledger = await ledgerIds(database);
    await postManualJournal(api.server, clock, { maker: as('accountant'), checker: as('owner') as TotpSession }, {
      postingDate: '2026-11-02',
      description: 'The walk-in cold room, the candler and the 150 kg scale bought',
      lines: [
        { accountId: ledger.account('1520'), side: 'D', amountPesewas: 1_200_000 },
        { accountId: ledger.account('3900'), side: 'C', amountPesewas: 1_200_000 },
      ],
    });
    const report = await api.app.get(LedgerReconciliation).run(SYSTEM);
    expect(report.signedSumPesewas).toBe(0n);
    expect(report.sources.filter((s) => s.source.startsWith('fin.'))).toEqual([
      { source: 'fin.fixed-asset-cost', breaks: [], unmapped: [] },
      { source: 'fin.fixed-asset-depreciation', breaks: [], unmapped: [] },
    ]);
  });
});

describe('the database keeps what an asset never changes, and the nightly job reports a register apart (ADR-0059)', () => {
  it('refuses a change of cost, a depreciation moved by hand, a write to a disposed asset, and any delete', async () => {
    const { id } = (await admin().query<{ id: string }>("SELECT id FROM fin.fixed_asset WHERE status = 'IN_USE' LIMIT 1")).rows[0]!;
    const disposed = (await admin().query<{ id: string }>("SELECT id FROM fin.fixed_asset WHERE status = 'DISPOSED' LIMIT 1")).rows[0]!.id;
    const refusal = async (sql: string, values: unknown[]) => {
      try {
        await app().query(sql, values);
        return null;
      } catch (error) {
        return (error as { constraint?: string; code?: string }).constraint ?? (error as { code?: string }).code;
      }
    };
    expect(await refusal('UPDATE fin.fixed_asset SET cost_pesewas = cost_pesewas + 1, version = version + 1 WHERE id = $1', [id])).toBe('ck_fixed_asset_change');
    expect(await refusal('UPDATE fin.fixed_asset SET accumulated_pesewas = 1, depreciated_months = 1, version = version + 1 WHERE id = $1', [id])).toBe('ck_fixed_asset_change');
    expect(await refusal('UPDATE fin.fixed_asset SET name = $2, version = version + 1 WHERE id = $1', [disposed, 'Renamed'])).toBe('ck_fixed_asset_change');
    expect(await refusal("UPDATE fin.fixed_asset SET status = 'DISPOSED', disposed_on = '2026-11-10', version = version + 1 WHERE id = $1", [id])).not.toBeNull();
    expect(await refusal('DELETE FROM fin.fixed_asset WHERE id = $1', [id])).toBe('42501');
  });

  it('reports a register whose cost differs from the ledger, and corrects neither', async () => {
    const { id, cost } = (await admin().query<{ id: string; cost: string }>("SELECT id, cost_pesewas::text AS cost FROM fin.fixed_asset WHERE status = 'IN_USE' AND category = 'HOUSING' LIMIT 1")).rows[0]!;
    const client = await admin().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query('UPDATE fin.fixed_asset SET cost_pesewas = cost_pesewas + 1 WHERE id = $1', [id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const report = await runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler' }, randomUUID(), () => api.app.get(LedgerReconciliation).run(SYSTEM));
    const housing = (await admin().query<{ id: string }>("SELECT id FROM fin.account WHERE code = '1530'")).rows[0]!.id;
    expect(report.clean).toBe(false);
    expect(report.sources.find((s) => s.source === 'fin.fixed-asset-cost')!.breaks).toEqual([
      { accountId: housing, ledgerPesewas: BigInt(cost), subledgerPesewas: BigInt(cost) + 1n, differencePesewas: -1n },
    ]);
    expect((await admin().query<{ cost: string }>('SELECT cost_pesewas::text AS cost FROM fin.fixed_asset WHERE id = $1', [id])).rows[0]!.cost).toBe((BigInt(cost) + 1n).toString());
    const drift = await admin().query<{ payload: { controlBreaks: { source: string; accountCode: string; differencePesewas: number }[] } }>(
      "SELECT payload FROM platform.outbox_message WHERE event_type = 'fin.TrialBalanceDriftDetected'",
    );
    expect(drift.rows.at(-1)!.payload.controlBreaks).toEqual([{ source: 'fin.fixed-asset-cost', accountCode: '1530', ledgerPesewas: Number(cost), subledgerPesewas: Number(cost) + 1, differencePesewas: -1 }]);
  });
});
