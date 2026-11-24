-- 0366_bil_publish_document_lines
-- B12 continued 2 (FR-CST-003, FR-CST-004, ADR-0011, ADR-0023): each line of an issued invoice, receipt, credit note or
-- debit note, as costing reads it for margin. The order a credit or debit note belongs to is its original document's.
-- The price variance is BIL's own rule (priceVariance: the resolved price less the agreed one, each extended once,
-- half-up), on an invoice or receipt only, signed as the event carries it (above zero, agreed below resolved).
-- Data category: CONFIDENTIAL (DC-09): trading figures; the customer is an id only.
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
CREATE VIEW bil.pub_document_line AS
SELECT l.id AS line_id, d.id AS document_id, d.kind, d.branch_id, d.customer_id, d.issue_date,
       COALESCE(d.order_document_id, o.order_document_id) AS order_document_id,
       l.line_no, l.line_kind, l.product_id, l.qty, l.uom, l.weight_kg, l.line_net_pesewas AS net_pesewas,
       CASE WHEN d.kind IN ('INVOICE', 'RECEIPT')
            THEN (round(l.resolved_unit_price_pesewas * l.qty) - round(l.unit_price_pesewas * l.qty))::bigint
            ELSE 0::bigint END AS price_variance_pesewas,
       l.order_line_ref, l.credits_line_id
  FROM bil.billing_document_line l
  JOIN bil.billing_document d ON d.id = l.billing_document_id
  LEFT JOIN bil.billing_document o ON o.id = d.original_document_id
 WHERE d.status = 'ISSUED' AND d.kind IN ('INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'DEBIT_NOTE');

GRANT SELECT ON bil.pub_document_line TO hk_app, hk_worker, hk_report;

-- migrate:down
DROP VIEW bil.pub_document_line;
