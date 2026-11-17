-- 0220_mdm_receipt_rejection_and_breakage_reasons
-- B09e continued 2 (the owner's decision 5 of 2026-11-17, A-260, CR-035 points 1 and 2; FR-MDM-011): goods rejected
-- at the door carry a reason from the fixed list, and a shop writes off broken stock without a free-text reason.
--   GOODS_RECEIPT_REJECTION   a new domain: CRACKED, BROKEN, DIRTY and SHORT (the owner's four, no note needed) and
--                             WRONG_ITEM_DELIVERED and QUALITY_REJECTED (CR-035's broader two, a note needed). The code
--                             WRONG_ITEM is the REFUND domain's since 0024 and a code is the table's key, so the
--                             receipt's is WRONG_ITEM_DELIVERED (A-269). No loss group: nothing rejected entered stock.
--   STOCK_ADJUSTMENT          BREAKAGE (broken or cracked in store, no note) and RODENT_DAMAGE (a note needed), both
--                             written off to the WASTAGE loss group, as the WASTAGE domain's DAMAGED is.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe while no goods receipt line names one of the new codes (0221's rollback
-- drops its foreign key first, so the walk in CI passes over the seeded farm, which rejects nothing).

-- migrate:up
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL',
  'GOODS_RECEIPT_REJECTION'));

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('CRACKED', 'GOODS_RECEIPT_REJECTION', 'Cracked on arrival', false, NULL),
  ('BROKEN', 'GOODS_RECEIPT_REJECTION', 'Broken on arrival', false, NULL),
  ('DIRTY', 'GOODS_RECEIPT_REJECTION', 'Dirty or soiled on arrival', false, NULL),
  ('SHORT', 'GOODS_RECEIPT_REJECTION', 'Short delivered against the delivery note', false, NULL),
  ('WRONG_ITEM_DELIVERED', 'GOODS_RECEIPT_REJECTION', 'Wrong item delivered', true, NULL),
  ('QUALITY_REJECTED', 'GOODS_RECEIPT_REJECTION', 'Rejected for quality', true, NULL),
  ('BREAKAGE', 'STOCK_ADJUSTMENT', 'Broken or cracked in store', false, 'WASTAGE'),
  ('RODENT_DAMAGE', 'STOCK_ADJUSTMENT', 'Damaged by rodents or pests in store', true, 'WASTAGE')
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DELETE FROM mdm.reason_code WHERE code IN ('CRACKED', 'BROKEN', 'DIRTY', 'SHORT', 'WRONG_ITEM_DELIVERED', 'QUALITY_REJECTED', 'BREAKAGE', 'RODENT_DAMAGE');
ALTER TABLE mdm.reason_code DROP CONSTRAINT ck_reason_code_domain;
ALTER TABLE mdm.reason_code ADD CONSTRAINT ck_reason_code_domain CHECK (domain IN (
  'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
  'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE', 'BILLING_ADJUSTMENT', 'PAYMENT_REVERSAL'));
