import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ManualClock } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, rollback } from '../../../src/platform/database/migration-runner';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { documentWorker } from '../../support/documents';
import { relaxRateLimits, testStartTime } from '../../support/iam';
import { startTestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * Migration 0155 rolls back and applies again over archived documents (CI's "the last migration rolls back and applies
 * again", after setup has archived the seeded day): rolling back keeps every content hash and the archive; applying
 * again relinks each hashed document to its archive by that hash, so the both-or-neither check holds.
 */
let database: TestDatabase;
const admin = () => database.pool('admin');
const linked = async () =>
  (await admin().query<{ id: string; archived: string | null; hash: string | null }>("SELECT id, archived_document_id AS archived, encode(content_hash, 'hex') AS hash FROM bil.billing_document WHERE status = 'ISSUED' ORDER BY id")).rows;

beforeAll(async () => {
  database = await createTestDatabase();
  const clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  const api = await startTestApp(database, { clock });
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
  await documentWorker(api, database, clock).settle();
  await api.close();
});

afterAll(async () => {
  await database?.drop();
});

describe('0155 rolls back and applies again over archived documents', () => {
  it('relinks every hashed document to its archive', async () => {
    const before = await linked();
    expect(before).toHaveLength(5);
    expect(before.every((d) => d.archived !== null && d.hash !== null)).toBe(true);
    const migrations = resolve(process.cwd(), 'migrations');
    // The migrations after 0155 roll back first, newest first, then 0155 itself.
    const rolledBack: string[] = [];
    while (rolledBack.at(-1) !== '0155_bil_archive_and_reprints') {
      const step = await rollback(database.url('admin'), migrations);
      if (step.kind !== 'ROLLED_BACK' || rolledBack.length >= 25) throw new Error(`rollback stopped before 0155: ${JSON.stringify(step)} after ${rolledBack.join(', ')}`);
      rolledBack.push(step.name);
    }
    expect(rolledBack).toEqual([
      '0176_pay_store_credit_named_customer',
      '0175_mdm_customer_has_phone',
      '0174_iam_grant_manager_credit_notes',
      '0173_fin_pay_receipt_postings',
      '0172_pay_receipts_store_credit_reversals',
      '0171_iam_grant_pay_receipt_permissions',
      '0170_iam_seed_pay_receipt_permissions',
      '0169_mdm_payment_reversal_reasons',
      '0168_platform_refund_document',
      '0167_fin_pay_provider_postings',
      '0166_pay_provider_webhooks_refunds',
      '0165_iam_grant_pay_permissions',
      '0164_iam_seed_pay_permissions',
      '0163_ord_sales_orders',
      '0162_fin_payment_postings',
      '0161_bil_settlement_allocations',
      '0160_pay_payments',
      '0159_platform_add_order_payment_documents',
      '0158_pur_remittance_document', '0157_doc_remittance_template', '0156_platform_add_remittance_document', '0155_bil_archive_and_reprints']);
    const hashes = (await admin().query<{ hash: string | null }>("SELECT encode(content_hash, 'hex') AS hash FROM bil.billing_document WHERE status = 'ISSUED' ORDER BY id")).rows.map((r) => r.hash);
    expect(hashes).toEqual(before.map((d) => d.hash));
    await migrate(database.url('admin'), migrations);
    expect(await linked()).toEqual(before);
  });
});
