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
      if (step.kind !== 'ROLLED_BACK' || rolledBack.length >= 300) throw new Error(`rollback stopped before 0155: ${JSON.stringify(step)} after ${rolledBack.join(', ')}`);
      rolledBack.push(step.name);
    }
    expect(rolledBack).toEqual([
      '0361_iam_cap_financing_permissions',
      '0360_fin_financing_postings',
      '0359_cap_payout_documents_financing',
      '0358_platform_add_financing_documents',
      '0357_doc_distribution_schedule_template',
      '0356_iam_grant_cap_permissions',
      '0355_iam_seed_cap_permissions',
      '0354_fin_capital_postings',
      '0353_cap_capital_and_distributions',
      '0352_platform_add_capital_documents',
      '0351_quo_accepted_hold_lapses',
      '0350_ord_order_line_weight_band',
      '0349_ord_quote_animals_named_at_picking',
      '0348_mdm_quoted_price_reason',
      '0347_shp_selling_units',
      '0346_whl_dunning_deliveries',
      '0345_iam_grant_bil_send_permission',
      '0344_iam_seed_bil_send_permission',
      '0343_ntf_document_sends',
      '0342_doc_document_link',
      '0341_shp_abandoned_cart_notice',
      '0340_pos_receipt_message_link',
      '0339_ntf_message_links',
      '0338_ntf_preferences_opt_outs_triggers',
      '0337_iam_grant_ntf_permissions',
      '0336_iam_seed_ntf_permissions',
      '0335_ntf_create_messages',
      '0334_ord_return_part_of_unit',
      '0333_ord_pick_breakage',
      '0332_ord_order_delivery_slot',
      '0331_iam_grant_delivery_fee_add_permission',
      '0330_iam_seed_delivery_fee_add_permission',
      '0329_ord_backorders',
      '0328_del_part_delivery',
      '0327_del_delivery_cancelled',
      '0326_del_slot_booking',
      '0325_iam_grant_van_way_out_permissions',
      '0324_iam_seed_van_way_out_permissions',
      '0323_ord_delivery_return',
      '0322_del_delivery_written_off',
      '0321_mdm_van_write_off_reasons',
      '0320_iam_grant_del_route_permissions',
      '0319_iam_seed_del_route_permissions',
      '0318_del_routes',
      '0317_iam_grant_del_cash_reconciliation_read',
      '0316_iam_seed_del_cash_reconciliation_read',
      '0315_fin_driver_cash_remitted_postings',
      '0314_del_driver_cash_reconciliation',
      '0313_pay_driver_hand_in_payment',
      '0312_platform_add_driver_cash_reconciliation_document',
      '0311_pay_card_hosted_page',
      '0310_iam_grant_ord_order_read_fulfilment',
      '0309_iam_seed_ord_order_read_fulfilment',
      '0308_quo_quote_link_staff_match',
      '0307_quo_margin_percent_is_markup',
      '0306_mdm_offline_pack_price_reason',
      '0305_fin_cod_collected_postings',
      '0304_ord_fulfilment_issue',
      '0303_del_deliveries',
      '0302_mdm_dispatch_and_cod_reasons',
      '0301_iam_grant_dispatch_delivery_permissions',
      '0300_iam_seed_dispatch_delivery_permissions',
      '0299_platform_add_delivery_document',
      '0298_bil_customer_tin_format',
      '0297_pos_receipt_link_revocation_guard',
      '0296_iam_grant_ord_fulfilment_permissions',
      '0295_iam_seed_ord_fulfilment_permissions',
      '0294_ord_fulfilment',
      '0293_platform_add_fulfilment_document',
      '0292_pos_receipt_link',
      '0291_doc_quote_template',
      '0290_iam_grant_quo_report_permission',
      '0289_iam_seed_quo_report_permission',
      '0288_quo_quote_line_stock',
      '0287_fin_negative_stock_postings',
      '0286_inv_negative_stock_offline',
      '0285_fin_unverified_mobile_money_clearing',
      '0284_pay_unverified_clearing',
      '0283_mdm_mobile_money_not_received_reason',
      '0282_quo_quote_links_revoked_and_decided',
      '0281_fin_pos_late_entry_postings',
      '0280_pos_late_entry',
      '0279_pay_late_entry',
      '0278_quo_margin_approval_issues_nothing',
      '0277_iam_grant_whl_standing_order_bad_debt_permissions',
      '0276_iam_seed_whl_standing_order_bad_debt_permissions',
      '0275_fin_bad_debt_postings',
      '0274_whl_standing_orders_bad_debts',
      '0273_bil_settlement_write_off',
      '0272_platform_add_whl_standing_order_bad_debt_documents',
      '0271_iam_seed_pos_pin_permission',
      '0270_pos_till_pin',
      '0269_whl_automatic_hold_release',
      '0268_doc_statement_template_ageing',
      '0267_iam_grant_whl_ageing_dunning_permissions',
      '0266_iam_seed_whl_ageing_dunning_permissions',
      '0265_whl_ageing_dunning',
      '0264_pay_allocation_business_date',
      '0263_fin_unverified_mobile_money',
      '0262_pos_cash_movement_sync',
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
