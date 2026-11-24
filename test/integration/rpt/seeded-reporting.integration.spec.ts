import { randomUUID } from 'node:crypto';
import { ManualClock, toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCEPTION_KINDS } from '../../../src/modules/rpt/domain/exception-kinds';
import { SEED_LABOUR_RUN, SEED_PORTAL_INVESTORS } from '../../../src/seed/farm-rpt';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { consoleGet, createUser, enrolAndLogin, login, relaxRateLimits, setPortalPassword, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The seeded farm's reporting slice (B12 continued 4, A-392), loaded as `pnpm db:seed` loads it: two investors with a
 * portal login and no usable password until the reset, one posted CST labour run, and the daily exception report of
 * the seed's day answering at least one item of every kind, the invented ones marked SEED; a second run writes nothing.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const staffPassword = `Seed-${randomUUID()}`;
const admin = () => database.pool('admin');
const units = () => seedUnits({ SEED_STAFF_PASSWORD: staffPassword }, { tradingDay: true, investors: true, reporting: true });
let owner: TestSession;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock, environment: { AUTH_ACCESS_TTL_SECONDS: '43200' } });
  await runSeedUnits(database.pool('app'), api.app, units());
  await documentWorker(api, database, clock).settle();
  const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
  owner = await enrolAndLogin(api.server, await createUser(database, { name: 'Kwabena Owusu', grants: [{ role: 'OWNER', branchId }] }), () => clock.now());
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the seeded farm for reporting (B12 continued 4)', () => {
  it('answers an item of every exception kind on the seed day, each invented item marked SEED', async () => {
    const today = toBusinessDate(clock.now());
    const report = await consoleGet(api.server, owner, `/v1/exceptions/daily-report?date=${today}`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const items = report.body.items as { kind: string; summary: string; details: Record<string, unknown>; abuseCases: number[] }[];
    const kinds = new Set(items.map((i) => i.kind));
    expect(EXCEPTION_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
    const invented = items.filter((i) => i.details['seed'] === true);
    expect(invented.length).toBeGreaterThan(EXCEPTION_KINDS.length - 3);
    expect(invented.every((i) => i.summary.endsWith('(SEED)'))).toBe(true);
    // The two kinds the sweep raises from the seed's own records, never invented.
    for (const kind of ['ORDER_SPLITTING', 'BULK_EXPORT']) {
      expect(items.some((i) => i.kind === kind && i.details['seed'] !== true), kind).toBe(true);
    }
    // Nothing invented entered the outbox: the ledger, stock and messages never saw it.
    const outbox = await admin().query("SELECT 1 FROM platform.outbox_message WHERE subject_type = 'SeedExceptionSource'");
    expect(outbox.rows).toEqual([]);
  });

  it('gives two seeded investors a portal login that signs in only once the investor sets a password', async () => {
    for (const name of SEED_PORTAL_INVESTORS) {
      const { rows } = await admin().query<{ principal_id: string | null; realm: string; phone_e164: string }>(
        'SELECT i.principal_id, u.realm, u.phone_e164 FROM cap.investor i JOIN iam.user_account u ON u.principal_id = i.principal_id WHERE i.legal_name = $1',
        [name],
      );
      expect(rows, name).toHaveLength(1);
      expect(rows[0]!.realm).toBe('INVESTOR');
      // No password was seeded: the seed's own staff password, or any other, is refused.
      await expect(login(api.server, { principalId: rows[0]!.principal_id!, identifier: rows[0]!.phone_e164, password: staffPassword, realm: 'INVESTOR' })).rejects.toThrow(/gave 401/);
      const portal = await login(api.server, await setPortalPassword(database, rows[0]!.principal_id!), 'Phone');
      const me = await consoleGet(api.server, portal, '/v1/investor/me');
      expect(me.status, JSON.stringify(me.body)).toBe(200);
      expect(me.body.investor.name).toBe(name);
    }
    const others = await admin().query("SELECT count(*)::int AS n FROM cap.investor WHERE principal_id IS NOT NULL");
    expect(others.rows[0].n).toBe(SEED_PORTAL_INVESTORS.length);
  });

  it('posts one CST labour run over the pens, made by the Accountant and posted by the Manager, its lines summing exactly', async () => {
    const runs = await consoleGet(api.server, owner, '/v1/costing/overhead-allocations');
    expect(runs.status, JSON.stringify(runs.body)).toBe(200);
    const [run] = runs.body.data as { status: string; totalPesewas: number; createdBy: { id: string }; postedBy: { id: string } | null; lines: { amountPesewas: number }[]; scopeLocation: { code: string } }[];
    expect(runs.body.data).toHaveLength(1);
    expect([run!.status, run!.totalPesewas, run!.scopeLocation.code]).toEqual(['POSTED', Number(SEED_LABOUR_RUN.totalPesewas), SEED_LABOUR_RUN.location]);
    expect(run!.lines.reduce((sum, l) => sum + l.amountPesewas, 0)).toBe(Number(SEED_LABOUR_RUN.totalPesewas));
    expect(run!.postedBy!.id).not.toBe(run!.createdBy.id);
  });

  it("grants the reports as CR-062 asks: the Owner, the Manager and the Accountant read and export, a bulk export the Owner's alone", async () => {
    const { rows } = await admin().query<{ role: string; codes: string[] }>(
      `SELECT r.code AS role, array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL) AS codes
         FROM iam.role r LEFT JOIN iam.role_permission rp ON rp.role_id = r.id AND (rp.permission_code LIKE 'rpt.report.%' OR rp.permission_code = 'fin.report.read')
        WHERE r.deleted_at IS NULL GROUP BY r.code ORDER BY r.code`,
    );
    const held = Object.fromEntries(rows.map((r) => [r.role, r.codes ?? []]));
    expect(held['OWNER']).toEqual(['fin.report.read', 'rpt.report.export', 'rpt.report.export.bulk', 'rpt.report.read']);
    expect(held['MANAGER']).toEqual(['rpt.report.export', 'rpt.report.read']);
    expect(held['ACCOUNTANT']).toEqual(['fin.report.read', 'rpt.report.export', 'rpt.report.read']);
    for (const role of Object.keys(held).filter((r) => !['OWNER', 'MANAGER', 'ACCOUNTANT'].includes(r))) expect(held[role], role).toEqual([]);
    const bulk = await admin().query<{ requires_step_up: boolean }>("SELECT requires_step_up FROM iam.permission WHERE code = 'rpt.report.export.bulk'");
    expect(bulk.rows[0]!.requires_step_up).toBe(true);
  });

  it('writes nothing on a second run, and the seeded ledger still balances', async () => {
    const count = async () => (await admin().query<{ n: number }>("SELECT (SELECT count(*) FROM rpt.exception_item)::int + (SELECT count(*) FROM pur.purchase_order)::int + (SELECT count(*) FROM fin.journal_entry)::int AS n")).rows[0]!.n;
    const before = await count();
    await runSeedUnits(database.pool('app'), api.app, units());
    expect(await count()).toBe(before);
    const balance = await admin().query<{ d: string; c: string }>("SELECT COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'D'), 0)::text AS d, COALESCE(sum(amount_pesewas) FILTER (WHERE side = 'C'), 0)::text AS c FROM fin.journal_line");
    expect(balance.rows[0]!.d).toBe(balance.rows[0]!.c);
  });
});
