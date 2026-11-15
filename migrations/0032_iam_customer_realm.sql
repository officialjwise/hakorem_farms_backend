-- 0032_iam_customer_realm
-- Customer registration and phone verification (FR-IAM-019) and password reset (FR-IAM-020; A-123). A customer account
-- is usable only once its phone is verified, so `phone_verified_at` records when; a phone verification code is kept
-- as a keyed hash beside its challenge, never in the clear. Customer accounts that exist before this migration were
-- made by hand and are taken as verified when they were created.
-- Data category: CONFIDENTIAL (a timestamp about a person's account; a hash of a one-time code).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
ALTER TABLE iam.user_account ADD COLUMN phone_verified_at timestamptz NULL;
UPDATE iam.user_account SET phone_verified_at = created_at, version = version + 1 WHERE realm = 'CUSTOMER' AND phone_e164 IS NOT NULL;
ALTER TABLE iam.verification_token
  ADD COLUMN code_hash bytea NULL CONSTRAINT ck_verification_token_code_hash CHECK (code_hash IS NULL OR length(code_hash) = 32);
CREATE INDEX ix_verification_token_open ON iam.verification_token (principal_id, purpose) WHERE consumed_at IS NULL;

-- migrate:down
DROP INDEX iam.ix_verification_token_open;
ALTER TABLE iam.verification_token DROP COLUMN code_hash;
ALTER TABLE iam.user_account DROP COLUMN phone_verified_at;
