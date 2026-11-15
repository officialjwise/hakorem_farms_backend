-- 0024_mdm_reference_data
-- What the suppliers and the reference data of B04d continued 3 need in mdm (docs/data-model/mdm.md, FR-MDM-007,
-- FR-MDM-009, FR-MDM-010, FR-MDM-011): supplier identity with the categories it supplies, the payment methods, the
-- delivery zones, the fixed list of reason codes, and the expand step that gives a saved address its resolved delivery
-- zone (A-112). Payment methods and reason codes carry behaviour, so their rows come from this migration: the API changes
-- a payment method's settings and never creates one (A-115), and offers no write on reason codes at all (FR-MDM-011).
-- Data category: CONFIDENTIAL (supplier contact details and TIN are personal data when the supplier is a person, FR-AUD-011).
-- Rollback: tested (`pnpm db:rollback`); safe before the first supplier or zone is saved, afterwards a forward fix only.

-- migrate:up
-- Supplier numbers S-0001 onward. Not a financial document, so a gap left by a rolled-back create is harmless.
CREATE SEQUENCE mdm.supplier_no_seq AS bigint MINVALUE 1;
REVOKE ALL ON SEQUENCE mdm.supplier_no_seq FROM PUBLIC;
GRANT USAGE ON SEQUENCE mdm.supplier_no_seq TO hk_app, hk_worker;

CREATE TABLE mdm.supplier (
  id            uuid PRIMARY KEY,
  supplier_no   text NOT NULL CONSTRAINT uq_supplier_no UNIQUE CONSTRAINT ck_supplier_no CHECK (supplier_no ~ '^S-[0-9]{4,10}$'),
  name          text NOT NULL CONSTRAINT ck_supplier_name CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  contact_name  text NULL CONSTRAINT ck_supplier_contact_name CHECK (length(btrim(contact_name)) BETWEEN 1 AND 160),
  phone_e164    text NULL CONSTRAINT ck_supplier_phone CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_hash    bytea NULL CONSTRAINT ck_supplier_phone_hash CHECK (length(phone_hash) = 32),
  email         text NULL CONSTRAINT ck_supplier_email CHECK (length(email) <= 254 AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  address       text NULL CONSTRAINT ck_supplier_address CHECK (length(address) <= 300),
  tin_enc       bytea NULL,
  status        text NOT NULL CONSTRAINT ck_supplier_status CHECK (status IN ('ACTIVE', 'BLOCKED')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_supplier_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_supplier_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_supplier_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_supplier_phone_pair CHECK ((phone_e164 IS NULL) = (phone_hash IS NULL)),
  CONSTRAINT ck_supplier_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.supplier IS 'class=MASTER';
-- FR-MDM-007: two live suppliers never share a phone, found by keyed hash so the number itself is never indexed.
CREATE UNIQUE INDEX uq_supplier_phone_hash ON mdm.supplier (phone_hash) WHERE deleted_at IS NULL AND phone_hash IS NOT NULL;
CREATE INDEX ix_supplier_name ON mdm.supplier (lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_supplier_version BEFORE UPDATE ON mdm.supplier
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
REVOKE ALL ON mdm.supplier FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.supplier TO hk_app, hk_worker;

-- The catalogue categories a supplier supplies (FR-MDM-007). A category removed from the list is archived, never deleted.
CREATE TABLE mdm.supplier_category (
  id            uuid PRIMARY KEY,
  supplier_id   uuid NOT NULL CONSTRAINT fk_supplier_category_supplier REFERENCES mdm.supplier (id) ON DELETE RESTRICT,
  category_id   uuid NOT NULL CONSTRAINT fk_supplier_category_category REFERENCES mdm.category (id) ON DELETE RESTRICT,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL CONSTRAINT fk_supplier_category_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NOT NULL CONSTRAINT fk_supplier_category_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_supplier_category_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_supplier_category_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.supplier_category IS 'class=MASTER';
CREATE UNIQUE INDEX uq_supplier_category_live ON mdm.supplier_category (supplier_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_supplier_category_category ON mdm.supplier_category (category_id) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_supplier_category_version BEFORE UPDATE ON mdm.supplier_category
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
REVOKE ALL ON mdm.supplier_category FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.supplier_category TO hk_app, hk_worker;

-- FR-MDM-009, ADR-0027. Verification never goes off for mobile money and card; only cash, and mobile money when the
-- setting allows it, may be taken offline. Both are database rules as well as the handler's (SQLSTATE 23514).
CREATE TABLE mdm.payment_method (
  id                             uuid PRIMARY KEY,
  code                           text NOT NULL CONSTRAINT uq_payment_method_code UNIQUE CONSTRAINT ck_payment_method_code CHECK (code ~ '^[A-Z][A-Z_]{1,29}$'),
  name                           text NOT NULL CONSTRAINT ck_payment_method_name CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  kind                           text NOT NULL CONSTRAINT ck_payment_method_kind CHECK (kind IN ('CASH', 'MOBILE_MONEY', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'STORE_CREDIT')),
  requires_provider_verification boolean NOT NULL,
  allowed_offline                boolean NOT NULL DEFAULT false,
  channels                       text[] NOT NULL CONSTRAINT ck_payment_method_channels CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['POS', 'ONLINE', 'WHOLESALE', 'QUOTE']::text[]),
  is_enabled                     boolean NOT NULL DEFAULT true,
  version                        integer NOT NULL DEFAULT 1,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  created_by                     uuid NOT NULL CONSTRAINT fk_payment_method_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  updated_by                     uuid NOT NULL CONSTRAINT fk_payment_method_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at                     timestamptz NULL,
  deleted_by                     uuid NULL CONSTRAINT fk_payment_method_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason                  text NULL,
  CONSTRAINT ck_payment_method_verified CHECK (requires_provider_verification OR kind NOT IN ('MOBILE_MONEY', 'CARD')),
  CONSTRAINT ck_payment_method_offline CHECK (NOT allowed_offline OR kind IN ('CASH', 'MOBILE_MONEY')),
  CONSTRAINT ck_payment_method_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.payment_method IS 'class=MASTER';
CREATE TRIGGER trg_payment_method_version BEFORE UPDATE ON mdm.payment_method
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
REVOKE ALL ON mdm.payment_method FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.payment_method TO hk_app, hk_worker;

-- The seven methods of docs/data-model/mdm.md, written by the System. Every one starts disabled: the farm turns on the
-- ones it takes through updatePaymentMethod, so a method is in use only because someone decided it (A-115).
INSERT INTO mdm.payment_method (id, code, name, kind, requires_provider_verification, allowed_offline, channels, is_enabled, created_by, updated_by) VALUES
  ('01900000-0000-7000-8001-000000000001', 'CASH', 'Cash', 'CASH', false, true, ARRAY['POS', 'WHOLESALE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000002', 'MOMO', 'Mobile money', 'MOBILE_MONEY', true, false, ARRAY['POS', 'ONLINE', 'WHOLESALE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000003', 'CARD', 'Card', 'CARD', true, false, ARRAY['POS', 'ONLINE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000004', 'BANK_TRANSFER', 'Bank transfer', 'BANK_TRANSFER', false, false, ARRAY['WHOLESALE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000005', 'CHEQUE', 'Cheque', 'CHEQUE', false, false, ARRAY['WHOLESALE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000006', 'STORE_CREDIT', 'Store credit', 'STORE_CREDIT', false, false, ARRAY['POS', 'ONLINE', 'WHOLESALE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'),
  ('01900000-0000-7000-8001-000000000007', 'COD', 'Cash on delivery', 'CASH', false, false, ARRAY['ONLINE'], false, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

-- FR-MDM-010. A fee is exact pesewas and may be zero; an address in no zone is "delivery unavailable", never a zero fee.
CREATE TABLE mdm.delivery_zone (
  id                uuid PRIMARY KEY,
  branch_id         uuid NOT NULL CONSTRAINT fk_delivery_zone_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  code              text NOT NULL CONSTRAINT ck_delivery_zone_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  name              text NOT NULL CONSTRAINT ck_delivery_zone_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  areas             text[] NOT NULL CONSTRAINT ck_delivery_zone_areas CHECK (cardinality(areas) BETWEEN 1 AND 100 AND array_position(areas, NULL) IS NULL),
  fee_pesewas       platform.pesewas NOT NULL,
  free_over_pesewas platform.pesewas NULL,
  cutoff_time       time NOT NULL CONSTRAINT ck_delivery_zone_cutoff CHECK (cutoff_time = date_trunc('minute', cutoff_time)),
  is_active         boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_delivery_zone_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_delivery_zone_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at        timestamptz NULL,
  deleted_by        uuid NULL CONSTRAINT fk_delivery_zone_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason     text NULL,
  CONSTRAINT ck_delivery_zone_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.delivery_zone IS 'class=MASTER';
CREATE UNIQUE INDEX uq_delivery_zone_code ON mdm.delivery_zone (branch_id, code) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_delivery_zone_version BEFORE UPDATE ON mdm.delivery_zone
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
REVOKE ALL ON mdm.delivery_zone FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.delivery_zone TO hk_app, hk_worker;

-- Expand (A-112): the zone an address was in when it was saved. Nullable: an address in no zone keeps null.
ALTER TABLE mdm.customer_address ADD COLUMN delivery_zone_id uuid NULL
  CONSTRAINT fk_customer_address_delivery_zone REFERENCES mdm.delivery_zone (id) ON DELETE RESTRICT;

-- FR-MDM-011: the fixed list. Changed only by migration; hk_app reads it and nothing else.
CREATE TABLE mdm.reason_code (
  code               text PRIMARY KEY CONSTRAINT ck_reason_code_code CHECK (code ~ '^[A-Z][A-Z_]{1,39}$'),
  domain             text NOT NULL CONSTRAINT ck_reason_code_domain CHECK (domain IN (
                       'STOCK_ADJUSTMENT', 'MORTALITY', 'CULL', 'WASTAGE', 'PRICE_OVERRIDE', 'VOID', 'REFUND', 'RETURN',
                       'CANCELLATION', 'DELIVERY_FAILURE', 'CASH_MOVEMENT', 'HOLD_RELEASE')),
  description        text NOT NULL CONSTRAINT ck_reason_code_description CHECK (length(btrim(description)) BETWEEN 1 AND 120),
  requires_note      boolean NOT NULL DEFAULT false,
  loss_account_group text NULL CONSTRAINT ck_reason_code_loss_group CHECK (loss_account_group IN ('MORTALITY', 'SHRINKAGE', 'WASTAGE'))
);
COMMENT ON TABLE mdm.reason_code IS 'class=LOOKUP';
CREATE INDEX ix_reason_code_domain ON mdm.reason_code (domain, code);
REVOKE ALL ON mdm.reason_code FROM PUBLIC;
GRANT SELECT ON mdm.reason_code TO hk_app, hk_worker;

INSERT INTO mdm.reason_code (code, domain, description, requires_note, loss_account_group) VALUES
  ('COUNT_ERROR', 'STOCK_ADJUSTMENT', 'Earlier count was wrong', true, 'SHRINKAGE'),
  ('THEFT_SUSPECTED', 'STOCK_ADJUSTMENT', 'Missing, theft suspected', true, 'SHRINKAGE'),
  ('RECEIPT_ERROR', 'STOCK_ADJUSTMENT', 'Goods receipt was booked wrongly', true, NULL),
  ('FOUND_STOCK', 'STOCK_ADJUSTMENT', 'Stock found that was not booked', true, NULL),
  ('DISEASE_SUSPECTED', 'MORTALITY', 'Died, disease suspected', true, 'MORTALITY'),
  ('PREDATOR', 'MORTALITY', 'Killed by a predator', true, 'MORTALITY'),
  ('INJURY', 'MORTALITY', 'Died of an injury', true, 'MORTALITY'),
  ('HEAT_STRESS', 'MORTALITY', 'Died of heat stress', false, 'MORTALITY'),
  ('UNKNOWN_CAUSE', 'MORTALITY', 'Died, cause not known', true, 'MORTALITY'),
  ('CULL_LOW_PRODUCTION', 'CULL', 'Culled for low production', false, 'MORTALITY'),
  ('CULL_ILLNESS', 'CULL', 'Culled because of illness', true, 'MORTALITY'),
  ('CULL_INJURY', 'CULL', 'Culled because of an injury', true, 'MORTALITY'),
  ('EXPIRED', 'WASTAGE', 'Past expiry date', false, 'WASTAGE'),
  ('SPOILED', 'WASTAGE', 'Spoiled before its expiry date', true, 'WASTAGE'),
  ('DAMAGED', 'WASTAGE', 'Damaged in handling', true, 'WASTAGE'),
  ('COLD_CHAIN_FAILURE', 'WASTAGE', 'Cold room or freezer failed', true, 'WASTAGE'),
  ('REGULAR_CUSTOMER', 'PRICE_OVERRIDE', 'Regular customer, agreed price', false, NULL),
  ('BULK_PURCHASE', 'PRICE_OVERRIDE', 'Bulk purchase', false, NULL),
  ('MATCH_MARKET_PRICE', 'PRICE_OVERRIDE', 'Matched the market price', true, NULL),
  ('DAMAGED_GOODS_DISCOUNT', 'PRICE_OVERRIDE', 'Discount for damaged goods', true, NULL),
  ('MANAGER_DISCRETION', 'PRICE_OVERRIDE', 'Manager discretion', true, NULL),
  ('CUSTOMER_CHANGED_MIND', 'VOID', 'Customer changed mind before leaving', false, NULL),
  ('KEYING_ERROR', 'VOID', 'Line keyed in error', false, NULL),
  ('PAYMENT_FAILED', 'VOID', 'Payment did not go through', false, NULL),
  ('DAMAGED_IN_DELIVERY', 'REFUND', 'Damaged in delivery', true, NULL),
  ('WRONG_ITEM', 'REFUND', 'Wrong item supplied', true, NULL),
  ('QUALITY_COMPLAINT', 'REFUND', 'Quality complaint upheld', true, NULL),
  ('OVERCHARGED', 'REFUND', 'Customer was overcharged', true, NULL),
  ('RETURN_QUALITY', 'RETURN', 'Returned for quality', true, NULL),
  ('RETURN_WRONG_ITEM', 'RETURN', 'Returned, wrong item', true, NULL),
  ('RETURN_UNWANTED', 'RETURN', 'Returned unused, not wanted', false, NULL),
  ('CUSTOMER_CANCELLED', 'CANCELLATION', 'Customer cancelled', false, NULL),
  ('OUT_OF_STOCK', 'CANCELLATION', 'Out of stock', false, NULL),
  ('PAYMENT_NOT_RECEIVED', 'CANCELLATION', 'Payment not received in time', false, NULL),
  ('DUPLICATE_ORDER', 'CANCELLATION', 'Duplicate order', false, NULL),
  ('CUSTOMER_NOT_AVAILABLE', 'DELIVERY_FAILURE', 'Customer not available', false, NULL),
  ('ADDRESS_NOT_FOUND', 'DELIVERY_FAILURE', 'Address could not be found', true, NULL),
  ('CUSTOMER_REFUSED', 'DELIVERY_FAILURE', 'Customer refused the delivery', true, NULL),
  ('VEHICLE_BREAKDOWN', 'DELIVERY_FAILURE', 'Vehicle broke down', true, NULL),
  ('FLOAT_TOP_UP', 'CASH_MOVEMENT', 'Float topped up', false, NULL),
  ('BANK_DEPOSIT', 'CASH_MOVEMENT', 'Cash taken to the bank', false, NULL),
  ('CHANGE_PURCHASE', 'CASH_MOVEMENT', 'Coins and small notes bought for change', false, NULL),
  ('FUEL_PAYOUT', 'CASH_MOVEMENT', 'Fuel paid from the till', true, NULL),
  ('SUPPLIER_PAYOUT', 'CASH_MOVEMENT', 'Supplier paid from the till', true, NULL),
  ('OTHER_PAYOUT', 'CASH_MOVEMENT', 'Other payment from the till', true, NULL),
  ('TEST_NEGATIVE', 'HOLD_RELEASE', 'Laboratory test came back negative', true, NULL),
  ('INVESTIGATION_CLOSED', 'HOLD_RELEASE', 'Investigation closed, stock cleared', true, NULL),
  ('QUARANTINE_COMPLETE', 'HOLD_RELEASE', 'Quarantine period completed', true, NULL);

-- migrate:down
DROP TABLE mdm.reason_code;
ALTER TABLE mdm.customer_address DROP COLUMN delivery_zone_id;
DROP TABLE mdm.delivery_zone;
DROP TABLE mdm.payment_method;
DROP TABLE mdm.supplier_category;
DROP TABLE mdm.supplier;
DROP SEQUENCE mdm.supplier_no_seq;
