-- 0227_pay_cash_in_a_shift
-- B9b (the owner's decision on A-212 (a), 2026-11-16): cash enters a till only through a till shift, so every cedi is
-- counted at its close. A cash payment held by a till names the shift it was taken in (ck_payment_cash_shift); the
-- shift is a business document by the column's existing foreign key. That the document is a SHIFT, open and the
-- seller's own is POS's to check under the shift's lock: PAY sits below POS and never reads its tables, nor the
-- platform's document registry. Cash with a driver (B11) names the driver instead, as ck_payment_cash_holder allows.
-- Data category: none (a constraint and an index).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE pay.payment
  ADD CONSTRAINT ck_payment_cash_shift CHECK (method_kind <> 'CASH' OR register_ref IS NULL OR shift_document_id IS NOT NULL);
CREATE INDEX ix_payment_shift ON pay.payment (shift_document_id) WHERE shift_document_id IS NOT NULL;

-- migrate:down
DROP INDEX pay.ix_payment_shift;
ALTER TABLE pay.payment DROP CONSTRAINT ck_payment_cash_shift;
