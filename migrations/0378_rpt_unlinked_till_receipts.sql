-- 0378_rpt_unlinked_till_receipts
-- B12 continued 6 (FR-RPT-007, ADR-0103 Amendments, A-400; the owner, 2026-11-25: "Count them, list only refusals"): a
-- till sale whose receipt text NTF held back for want of a link (`ntf.MessageSuppressed`, template `SALE_RECEIPT`,
-- reason `NO_LINK`: the till sent no receipt token) is no longer its own exception item. The daily report counts them
-- instead, one line per branch and day (abuse case 60). A token sent but refused stays its own item.
--   rpt.unlinked_receipt_fact  PROJECTION: one row per such message: its sale, branch and Africa/Accra day
-- Rules held here:
--   * one row per message (the primary key), so a redelivery or a rebuild counts it once;
--   * written only through rpt.put_unlinked_receipt_fact; the application roles and hk_report read it;
--   * a rebuild empties it with the other projections (rpt.clear_exception_projections, replaced to name it).
-- Data category: CONFIDENTIAL (DC-09): ids only, no contact detail.
-- Rollback: tested (`pnpm db:rollback`): down restores 0370's rpt.clear_exception_projections and drops the table and
-- its function. The fact rebuilds from the outbox, so nothing is lost but what a rebuild makes again.

-- migrate:up
CREATE TABLE rpt.unlinked_receipt_fact (
  message_ref     uuid PRIMARY KEY,
  event_ref       uuid NOT NULL,
  sales_order_ref uuid NOT NULL,
  branch_id       uuid NOT NULL CONSTRAINT fk_unlinked_receipt_fact_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  fact_date       date NOT NULL,
  suppressed_at   timestamptz NOT NULL
);
COMMENT ON TABLE rpt.unlinked_receipt_fact IS 'class=PROJECTION';
CREATE INDEX ix_unlinked_receipt_fact_day ON rpt.unlinked_receipt_fact (fact_date, branch_id);

CREATE FUNCTION rpt.put_unlinked_receipt_fact(p_message uuid, p_event uuid, p_order uuid, p_branch uuid, p_date date, p_at timestamptz) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  INSERT INTO rpt.unlinked_receipt_fact (message_ref, event_ref, sales_order_ref, branch_id, fact_date, suppressed_at)
  VALUES (p_message, p_event, p_order, p_branch, p_date, p_at)
  ON CONFLICT (message_ref) DO NOTHING
$$;

-- 0370's, with the new fact emptied too.
CREATE OR REPLACE FUNCTION rpt.clear_exception_projections() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  DELETE FROM rpt.exception_item;
  DELETE FROM rpt.approval_fact;
  DELETE FROM rpt.checkout_fact;
  DELETE FROM rpt.payout_change_fact;
  DELETE FROM rpt.unlinked_receipt_fact;
$$;

REVOKE ALL ON rpt.unlinked_receipt_fact FROM PUBLIC;
GRANT SELECT ON rpt.unlinked_receipt_fact TO hk_app, hk_worker, hk_report;
REVOKE ALL ON FUNCTION rpt.put_unlinked_receipt_fact(uuid, uuid, uuid, uuid, date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpt.put_unlinked_receipt_fact(uuid, uuid, uuid, uuid, date, timestamptz) TO hk_app, hk_worker;

-- migrate:down
CREATE OR REPLACE FUNCTION rpt.clear_exception_projections() RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  DELETE FROM rpt.exception_item;
  DELETE FROM rpt.approval_fact;
  DELETE FROM rpt.checkout_fact;
  DELETE FROM rpt.payout_change_fact;
$$;
DROP FUNCTION rpt.put_unlinked_receipt_fact(uuid, uuid, uuid, uuid, date, timestamptz);
DROP TABLE rpt.unlinked_receipt_fact;
