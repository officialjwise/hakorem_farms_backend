import { createHash, randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBJECT_STORAGE, type ObjectStorage } from '../../../src/platform/storage/object-storage';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Every issued document of the seeded trading day is archived exactly once (FR-DOC-002, the B08 continued 2b gate):
 * the seed issues its billing documents through BIL, each asks DOC for its rendering in its issuing transaction, and
 * one pass of the worker archives every one of them, each with the SHA-256 of its stored bytes, equal to the billing
 * document's content hash. No issued document is left without its archive, and none has two.
 */
let database: TestDatabase;
let api: TestApp;
const admin = () => database.pool('admin');

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await documentWorker(api, database, clock).settle();
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

describe('the seeded trading day is archived, every document once (FR-DOC-002)', () => {
  it('archives each issued billing document and statement of the seed exactly once, its hash the SHA-256 of its stored bytes', async () => {
    const { rows } = await admin().query<{ id: string; kind: string; document_no: string; content_hash: Buffer | null; archives: string; sha256: Buffer | null; bucket: string | null; object_key: string | null; scan_status: string | null }>(
      `SELECT d.id, d.kind, d.document_no, d.content_hash, count(a.id)::text AS archives, (array_agg(a.sha256))[1] AS sha256,
              max(f.bucket) AS bucket, max(f.object_key) AS object_key, max(f.scan_status) AS scan_status
         FROM bil.billing_document d
         LEFT JOIN doc.archived_document a ON a.business_document_id = d.id
         LEFT JOIN platform.stored_file f ON f.id = a.file_id
        WHERE d.status = 'ISSUED'
        GROUP BY d.id ORDER BY d.document_no`,
    );
    // The seed's five: the invoice, the receipt, the credit note, the debit note and the proforma.
    expect(rows.map((r) => r.kind).sort()).toEqual(['CREDIT_NOTE', 'DEBIT_NOTE', 'INVOICE', 'PROFORMA', 'RECEIPT']);
    const storage = api.app.get<ObjectStorage>(OBJECT_STORAGE);
    for (const row of rows) {
      expect(row.archives, row.document_no).toBe('1');
      expect(row.scan_status, row.document_no).toBe('CLEAN');
      const bytes = await storage.get(row.bucket!, row.object_key!);
      const hash = createHash('sha256').update(bytes).digest();
      expect(hash.equals(row.sha256!), row.document_no).toBe(true);
      expect(row.content_hash?.equals(row.sha256!), row.document_no).toBe(true);
      expect(bytes.toString('latin1'), row.document_no).toContain(row.document_no);
    }
    // The seed's statement (B08 continued 2d) is archived once too, its link set, its hash the stored bytes'.
    const { rows: statements } = await admin().query<{ statement_no: string; archives: string; linked: boolean; sha256: Buffer; bucket: string; object_key: string }>(
      `SELECT s.statement_no, count(a.id)::text AS archives, bool_and(s.archived_document_id = a.id) AS linked, (array_agg(a.sha256))[1] AS sha256,
              max(f.bucket) AS bucket, max(f.object_key) AS object_key
         FROM whl.statement s LEFT JOIN doc.archived_document a ON a.business_document_id = s.id LEFT JOIN platform.stored_file f ON f.id = a.file_id
        WHERE s.status = 'ISSUED' GROUP BY s.id, s.statement_no`,
    );
    expect(statements).toHaveLength(1);
    expect([statements[0]!.archives, statements[0]!.linked]).toEqual(['1', true]);
    const statementBytes = await storage.get(statements[0]!.bucket, statements[0]!.object_key);
    expect(createHash('sha256').update(statementBytes).digest().equals(statements[0]!.sha256)).toBe(true);
    expect(statementBytes.toString('latin1')).toContain(statements[0]!.statement_no);
    // No archive belongs to anything that is not an issued document or statement, and every render job is done.
    const { rows: stray } = await admin().query(
      `SELECT a.id FROM doc.archived_document a
         LEFT JOIN bil.billing_document d ON d.id = a.business_document_id AND d.status = 'ISSUED'
         LEFT JOIN whl.statement s ON s.id = a.business_document_id AND s.status = 'ISSUED'
        WHERE d.id IS NULL AND s.id IS NULL`,
    );
    expect(stray).toEqual([]);
    const { rows: jobs } = await admin().query<{ status: string; n: string }>('SELECT status, count(*)::text AS n FROM doc.render_job GROUP BY status');
    expect(jobs).toEqual([{ status: 'DONE', n: String(rows.length + statements.length) }]);
  });
});
