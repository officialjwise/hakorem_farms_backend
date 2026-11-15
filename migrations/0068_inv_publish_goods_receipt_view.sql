-- 0068_inv_publish_goods_receipt_view
-- A published view of goods receipts for the reporting module (ADR-0011, ADR-0023): each receipt's kind, status,
-- branch, location, supplier, when it was received and posted, and its value at cost (the sum of its lines), so the
-- purchases series sums posted purchase receipts per business day without reading inv.goods_receipt (B05x, A-149).
-- Data category: INTERNAL (DC-13); no personal data.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE VIEW inv.pub_goods_receipt AS
SELECT r.id AS goods_receipt_id, r.kind, r.status, r.branch_id, r.location_id, r.supplier_id, r.received_at, r.posted_at,
       COALESCE((SELECT sum(l.value_pesewas) FROM inv.goods_receipt_line l WHERE l.goods_receipt_id = r.id), 0)::bigint AS value_pesewas,
       (SELECT count(*) FROM inv.goods_receipt_line l WHERE l.goods_receipt_id = r.id)::int AS line_count
  FROM inv.goods_receipt r;

GRANT SELECT ON inv.pub_goods_receipt TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW inv.pub_goods_receipt;
