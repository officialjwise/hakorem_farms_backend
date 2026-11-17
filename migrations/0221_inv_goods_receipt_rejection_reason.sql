-- 0221_inv_goods_receipt_rejection_reason
-- B09e continued 2 (the owner's decision 5 of 2026-11-17, A-260, CR-035 point 3): a quantity rejected at the door
-- carries its reason, and a reason that asks for one its note.
--   inv.goods_receipt_line.rejection_reason_code   a reason code (FK mdm.reason_code, a published key), set exactly when
--                           qty_rejected is above zero (ck_goods_receipt_line_rejection). That it is a
--                           GOODS_RECEIPT_REJECTION reason, and that a reason asking for a note has one, is the
--                           handler's rule (GOODS_RECEIPT_INVALID), as for a transfer's variance reason (0051): INV
--                           reads no MDM table.
--   inv.goods_receipt_line.rejection_note          free text, 1 to 500 characters, only beside a reason
--                           (ck_goods_receipt_line_rejection_note)
-- Lines are frozen with their receipt once posted (inv.goods_receipt_part_guard), which covers the new columns.
-- Additions to docs/data-model/inv.md: both columns.
-- Data category: INTERNAL (stock).
-- Rollback: tested (`pnpm db:rollback`), and it keeps the data: it drops the checks and the foreign key, and leaves the
-- columns, which the release before never writes and never reads. Applying 0221 again is safe.

-- migrate:up
ALTER TABLE inv.goods_receipt_line ADD COLUMN IF NOT EXISTS rejection_reason_code text NULL;
ALTER TABLE inv.goods_receipt_line ADD COLUMN IF NOT EXISTS rejection_note text NULL;
ALTER TABLE inv.goods_receipt_line
  ADD CONSTRAINT fk_goods_receipt_line_rejection_reason FOREIGN KEY (rejection_reason_code) REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_goods_receipt_line_rejection CHECK ((qty_rejected > 0) = (rejection_reason_code IS NOT NULL)),
  ADD CONSTRAINT ck_goods_receipt_line_rejection_note CHECK (
    rejection_note IS NULL OR (rejection_reason_code IS NOT NULL AND length(btrim(rejection_note)) BETWEEN 1 AND 500));

-- migrate:down
ALTER TABLE inv.goods_receipt_line
  DROP CONSTRAINT IF EXISTS ck_goods_receipt_line_rejection_note,
  DROP CONSTRAINT IF EXISTS ck_goods_receipt_line_rejection,
  DROP CONSTRAINT IF EXISTS fk_goods_receipt_line_rejection_reason;
