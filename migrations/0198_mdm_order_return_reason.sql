-- 0198_mdm_order_return_reason
-- B09a continued 2d (FR-ORD-015, FR-MDM-011, ADR-0066, A-228): the refund a completed return asks for against its credit
-- note takes the REFUND reason ORDER_RETURNED. It needs no note of its own: the return's reason and note say why.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first return.

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('ORDER_RETURNED', 'REFUND', 'Goods returned against the sale', false, NULL);

-- migrate:down
DELETE FROM mdm.reason_code WHERE code = 'ORDER_RETURNED';
