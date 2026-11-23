-- 0306_mdm_offline_pack_price_reason
-- B09b continued 4c (CR-052, the owner's clarification on prices of 2026-11-18, A-286 (d)): a till offline charges
-- what its pack priced, and the server re-prices the synced sale from what it knows then (an animal re-weighed since
-- the pack is priced from its latest weight). The price charged always posts and the difference is a variance, which
-- `ck_sales_order_line_variance` holds must carry a reason. The till gave none, because it charged list as it knew it,
-- so the server records the difference under this reason, never refusing the sale (ADR-0027 point 2). It is the
-- server's: the offline pack does not offer it to a cashier. No note: the facts are in the exception it raises.
-- Data category: none (a lookup row).
-- Rollback: tested (`pnpm db:rollback`), safe while no order line names the code (its foreign key restricts the
-- delete; afterwards forward fix only: leave the row).

-- migrate:up
INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('OFFLINE_PACK_PRICE', 'PRICE_OVERRIDE', 'Charged at the offline pack''s price; the server''s price at sync differs', false, NULL)
ON CONFLICT (code) DO NOTHING;

-- migrate:down
DELETE FROM mdm.reason_code WHERE code = 'OFFLINE_PACK_PRICE';
