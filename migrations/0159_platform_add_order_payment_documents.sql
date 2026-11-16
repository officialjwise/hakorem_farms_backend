-- 0159_platform_add_order_payment_documents
-- B9a (FR-ORD-001, FR-ORD-006, FR-PAY-001, ADR-0011, ADR-0015, A-208): the sales order and the payment are business
-- documents. A sales order is numbered from its own gap-free series per fiscal year and branch when it is placed on the
-- server (`SO-2026-DDW-000001`); a payment carries no number of its own (the receipt it settles is the customer's
-- document), so a till posting a sale queues on no further series (A-186).
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`), safe before the first order or payment; afterwards forward fix only.

-- migrate:up
INSERT INTO platform.document_type (code, owner_module, name, is_numbered, series_prefix) VALUES
  ('SALES_ORDER', 'ord', 'Sales order', true, 'SO'),
  ('PAYMENT', 'pay', 'Payment received', false, NULL);

-- migrate:down
DELETE FROM platform.document_type WHERE code IN ('SALES_ORDER', 'PAYMENT');
