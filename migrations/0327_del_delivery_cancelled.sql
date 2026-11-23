-- 0327_del_delivery_cancelled
-- B11 continued 6 (FR-ORD-014, FR-DEL-011, A-364 (a)): a dispatched delivery cancelled before it leaves the farm. The
-- guard already lets SCHEDULED or ASSIGNED move to CANCELLED, a posted status (ck_delivery_delivered); this records why
-- and when, exactly when CANCELLED.
--   del.delivery            cancel_reason_code (FK mdm.reason_code, a CANCELLATION reason, judged by the application) and
--                           cancelled_at, set exactly when CANCELLED (ck_delivery_cancelled). The guard freezes both once
--                           the delivery is posted.
-- Data category: CONFIDENTIAL as del.delivery (no new personal data).
-- Rollback: tested (`pnpm db:rollback`), safe before the first cancellation; afterwards forward fix only.

-- migrate:up
ALTER TABLE del.delivery
  ADD COLUMN cancel_reason_code text NULL CONSTRAINT fk_delivery_cancel_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  ADD COLUMN cancelled_at timestamptz NULL;
ALTER TABLE del.delivery ADD CONSTRAINT ck_delivery_cancelled CHECK (
  (status = 'CANCELLED') = (cancel_reason_code IS NOT NULL)
  AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL));

-- migrate:down
ALTER TABLE del.delivery DROP CONSTRAINT ck_delivery_cancelled;
ALTER TABLE del.delivery DROP COLUMN cancelled_at, DROP COLUMN cancel_reason_code;
