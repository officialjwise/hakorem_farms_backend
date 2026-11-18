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
      if (step.kind !== 'ROLLED_BACK' || rolledBack.length >= 200) throw new Error(`rollback stopped before 0155: ${JSON.stringify(step)} after ${rolledBack.join(', ')}`);
      rolledBack.push(step.name);
    }
    expect(rolledBack).toEqual([
      '0261_iam_grant_whl_credit_permissions',
      '0260_iam_seed_whl_credit_permissions',
      '0259_whl_credit_control',
      '0258_platform_add_account_change_document',
      '0257_bil_synced_from_offline',
      '0256_pos_sale_sync',
      '0255_iam_grant_quo_permissions',
      '0254_iam_seed_quo_permissions',
      '0253_quo_quotations',
      '0252_platform_add_quotation_documents',
      '0251_pay_payment_order_link',
      '0250_pos_held_sale',
      '0249_mdm_uom_names_and_egg',
      '0248_iam_grant_manager_supplier_invoice_approve',
      '0247_pur_invoice_approver_differs',
      '0246_platform_audit_anchor_request',
      '0245_pos_force_close',
      '0244_iam_grant_whl_permissions',
      '0243_iam_seed_whl_permissions',
      '0242_whl_statements',
      '0241_doc_statement_template',
      '0240_platform_add_statement_document',
      '0239_pay_till_cash_in_open_shift',
      '0238_pos_shift_entry_state',
      '0237_iam_publish_holds_permission',
      '0236_platform_document_entry_state',
      '0235_pos_device_enrolment',
      '0234_iam_grant_pos_device_permissions',
      '0233_iam_seed_pos_device_permissions',
      '0232_pay_refund_paid_from_shift',
      '0231_pos_unwitnessed_drop',
      '0230_iam_grant_pos_permissions',
      '0229_iam_seed_pos_permissions',
      '0228_fin_pos_postings',
      '0227_pay_cash_in_a_shift',
      '0226_pos_registers_shifts',
      '0225_mdm_cash_drop_reason',
      '0224_platform_add_shift_document',
      '0223_pur_supplier_claims',
      '0222_platform_add_supplier_claim_document',
      '0221_inv_goods_receipt_rejection_reason',
      '0220_mdm_receipt_rejection_and_breakage_reasons',
      '0219_inv_reorder_rule_selling_unit',
      '0218_inv_stock_unit_received_at',
      '0217_inv_lines_in_selling_unit',
      '0216_mdm_publish_uom_to_base',
      '0215_mdm_price_per_selling_unit',
      '0214_inv_bought_lot_delivery_cost',
      '0213_ord_order_tracking_token',
      '0212_mdm_party_public_ids',
      '0211_mdm_product_barcode_unused',
      '0210_mdm_server_generated_skus',
      '0209_iam_grant_aud_business_profile_permission',
      '0208_iam_seed_aud_business_profile_permission',
      '0207_pur_number_supplier_payment',
      '0206_ord_publish_completed_sales',
      '0205_shp_checkout_session_order',
      '0204_ord_online_order_source',
      '0203_ord_price_override_approval',
      '0202_iam_grant_ord_price_override_permissions',
      '0201_iam_seed_ord_price_override_permissions',
      '0200_ord_order_return',
      '0199_inv_sale_return_of_issue',
      '0198_mdm_order_return_reason',
      '0197_iam_grant_ord_return_permissions',
      '0196_iam_seed_ord_return_permissions',
      '0195_platform_add_order_return_document',
      '0194_ord_cancel_and_void',
      '0193_pay_reversal_per_payment_approval',
      '0192_mdm_order_reversal_reasons',
      '0191_iam_grant_ord_reversal_permissions',
      '0190_iam_seed_ord_reversal_permissions',
      '0189_iam_grant_ord_permissions',
      '0188_iam_seed_ord_permissions',
      '0187_bil_settlement_as_of',
      '0186_inv_hold_window_app_clock',
      '0185_platform_app_clock',
      '0184_fin_pay_credit_note_refund_postings',
      '0183_pay_credit_note_refunds',
      '0182_bil_credit_note_refunds',
      '0181_fin_pay_settlement_postings',
      '0180_pay_settlement_bank_statements',
      '0179_iam_grant_pay_reconciliation_permissions',
      '0178_iam_seed_pay_reconciliation_permissions',
      '0177_platform_reconciliation_documents',
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
