import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingNumberingAudit } from '../../../src/modules/bil';
import { SYSTEM_PRINCIPAL } from '../../support/iam';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * The nightly numbering audit (FR-BIL-003, ADR-0015): on the seeded, archived trading day it is clean; a document row
 * deleted by hand as a superuser is reported as one orphan allocation, an archive hash that disagrees is reported, and
 * a document left unarchived past the grace period is reported; the audit changes nothing.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
const admin = () => database.pool('admin');
const system = { kind: 'SYSTEM' as const, principalId: SYSTEM_PRINCIPAL, displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null };
const audit = () => api.app.get(BillingNumberingAudit).run(system);

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

/** Rows of the tables the audit reads, so a test can show it wrote nothing. */
async function fingerprint(): Promise<string> {
  const { rows } = await admin().query<{ f: string }>(
    `SELECT md5(string_agg(t, '|' ORDER BY t)) AS f FROM (
       SELECT d.id::text || coalesce(encode(d.content_hash, 'hex'), '') || d.version::text AS t FROM bil.billing_document d
       UNION ALL SELECT a.formatted FROM platform.number_allocation a
       UNION ALL SELECT s.id::text || s.next_value::text FROM platform.number_series s) x`,
  );
  return rows[0]!.f;
}

describe('the nightly numbering audit reports and never repairs (FR-BIL-003)', () => {
  it('reports a document still unarchived after an hour, and is clean once the worker has archived the day', async () => {
    clock.advanceBy(2 * 3_600_000);
    const early = await audit();
    expect(early.unarchived).toHaveLength(5);
    expect(early.clean).toBe(false);
    await documentWorker(api, database, clock).settle();
    const report = await audit();
    expect(report).toMatchObject({ gaps: [], orphans: [], unarchived: [], hashMismatches: [], clean: true });
  });

  it('reports one orphan allocation for a document row deleted by hand, and a hash that is not its archive’s', async () => {
    const { rows } = await admin().query<{ id: string; document_no: string }>("SELECT id, document_no FROM bil.billing_document WHERE kind = 'DEBIT_NOTE'");
    const debit = rows[0]!;
    const { rows: others } = await admin().query<{ id: string; document_no: string }>("SELECT id, document_no FROM bil.billing_document WHERE kind = 'PROFORMA'");
    const client = await admin().connect();
    try {
      // As a superuser, past every trigger: what an attacker with the database would do.
      await client.query("SET session_replication_role = 'replica'");
      await client.query('DELETE FROM bil.document_settlement WHERE billing_document_id = $1', [debit.id]);
      await client.query('DELETE FROM bil.billing_document_line_tax WHERE billing_document_line_id IN (SELECT id FROM bil.billing_document_line WHERE billing_document_id = $1)', [debit.id]);
      await client.query('DELETE FROM bil.billing_document_line WHERE billing_document_id = $1', [debit.id]);
      await client.query('DELETE FROM bil.billing_document WHERE id = $1', [debit.id]);
      await client.query("UPDATE bil.billing_document SET content_hash = decode(repeat('ab', 32), 'hex') WHERE id = $1", [others[0]!.id]);
      await client.query("SET session_replication_role = 'origin'");
    } finally {
      client.release();
    }
    const before = await fingerprint();
    const report = await audit();
    expect(report.orphans).toEqual([{ docType: 'DEBIT_NOTE', documentId: debit.id, documentNo: debit.document_no }]);
    expect(report.hashMismatches).toEqual([{ id: others[0]!.id, documentNo: others[0]!.document_no }]);
    expect(report.gaps).toEqual([]);
    expect(report.clean).toBe(false);
    expect(await fingerprint()).toBe(before);
    expect(api.logLines().some((l) => l['msg'] === 'billing numbering audit found a gap, an orphan or an unarchived document')).toBe(true);
  });

  it('runs as a SYSTEM principal only', () => {
    expect(() => api.app.get(BillingNumberingAudit).run({ ...system, kind: 'USER' as 'SYSTEM' })).toThrow(/SYSTEM principal/);
  });
});
