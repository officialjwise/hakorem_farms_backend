-- 0321_mdm_van_write_off_reasons
-- B11 continued 4 (FR-DEL-011, the owner's van rule of 2026-11-23, A-360; FR-MDM-011): two reasons the fixed list lacked.
--   UNACCOUNTED_ON_VAN  STOCK_ADJUSTMENT, a note needed: goods that left on a van and that the driver cannot account
--                       for, written off through INV's adjustment path and put on the driver variance report as their own
--                       line (spoiled or damaged goods take a WASTAGE reason instead). Its loss group is SHRINKAGE.
--   DELIVERY_RETURNED   RETURN: the credit note of a failed delivery whose goods came back to stock or were written off
--                       from the van; the customer is not charged for goods they never received.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe while no adjustment, delivery or credit note names a new code.

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('UNACCOUNTED_ON_VAN', 'STOCK_ADJUSTMENT', 'Unaccounted for on the van', true, 'SHRINKAGE'),
  ('DELIVERY_RETURNED', 'RETURN', 'Delivery failed; the goods came back or were written off', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DELETE FROM mdm.reason_code WHERE code IN ('UNACCOUNTED_ON_VAN', 'DELIVERY_RETURNED');
