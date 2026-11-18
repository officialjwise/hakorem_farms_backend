-- 0257_bil_synced_from_offline
-- B09b continued 2b (the owner's addition (1) to A-200, 2026-11-16; ADR-0027 point 6; A-278 (d)): a receipt for a sale
-- an offline till synced later is issued at the time the sale happened at the till, not the sync time, and says so.
--   bil.billing_document.synced_from_offline   boolean, false for every document already issued and every document
--                                              issued any other way. True only on a RECEIPT that carries the till's
--                                              time (occurred_at): ck_billing_document_offline. Frozen with the rest
--                                              of an issued document by bil.billing_document_guard, which compares
--                                              every column but its listed ones.
-- Additions to docs/data-model/bil.md: the column above.
-- Data category: INTERNAL.
-- Rollback: tested (`pnpm db:rollback`) before the first synced receipt; afterwards the flag is part of an issued
-- document and only a forward fix is safe.

-- migrate:up
ALTER TABLE bil.billing_document ADD COLUMN synced_from_offline boolean NOT NULL DEFAULT false;
ALTER TABLE bil.billing_document ADD CONSTRAINT ck_billing_document_offline
  CHECK (NOT synced_from_offline OR (kind = 'RECEIPT' AND occurred_at IS NOT NULL));

-- migrate:down
ALTER TABLE bil.billing_document DROP CONSTRAINT ck_billing_document_offline;
ALTER TABLE bil.billing_document DROP COLUMN synced_from_offline;
