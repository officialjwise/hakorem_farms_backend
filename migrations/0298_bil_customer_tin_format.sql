-- 0298_bil_customer_tin_format
-- B09b continued 4b (the owner's addition (2) to A-200, A-285 (c)): a business buyer at the counter may have their name
-- and TIN printed on the receipt without a customer account. The name is printed in the existing customer_name and the
-- TIN in the existing customer_tin snapshot (DC-25, E-1); this holds the TIN's form in the database.
--   ck_billing_document_customer_tin_format  a printed TIN is a GRA TIN (one of P, C, G, Q, V and ten digits) or a
--                                            Ghana Card PIN (GHA-, nine digits, a check digit), as written upper-case.
-- Additive: no column changes, and no existing document carries a TIN (no caller set one before this phase), so the
-- check validates every existing row as it stands.
-- Every time is written by the application from its clock (ADR-0067); nothing here reads now().
-- Additions to docs/data-model/bil.md: the check, as built.
-- Data category: DC-25 (Restricted), as E-1 states for the snapshot; nothing new is stored.
-- Rollback: tested (`pnpm db:rollback`): the check is dropped.

-- migrate:up
ALTER TABLE bil.billing_document ADD CONSTRAINT ck_billing_document_customer_tin_format
  CHECK (customer_tin IS NULL OR customer_tin ~ '^([PCGQV][0-9]{10}|GHA-[0-9]{9}-[0-9])$');

-- migrate:down
ALTER TABLE bil.billing_document DROP CONSTRAINT ck_billing_document_customer_tin_format;
