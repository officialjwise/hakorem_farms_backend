-- 0017_mdm_create_promotions
-- Promotions and coupons (docs/data-model/mdm.md "Pricing and promotions", ADR-0004 point 5, FR-MDM-018): a promotion
-- with its targets, drafted, approved by a second user and then active; coupon codes that unlock one; and the
-- redemption ledger that counts each use.
-- What the database refuses: a value that does not fit the promotion's kind; a window that ends before it starts;
-- a target naming both or neither of a product and a category; any change to a promotion's terms or targets once
-- it leaves DRAFT; a late approval moving a promotion's start earlier; a coupon used beyond its total limit, its
-- per-customer limit or its promotion's limit, checked under a row lock on the promotion and the coupon so that
-- concurrent redemptions cannot pass it; a coupon's use count changed except by a redemption; a release with no
-- use to release; any update or delete of a redemption.
-- Data category: INTERNAL (DC-12).
-- Rollback: tested (`pnpm db:rollback`) while no coupon has been redeemed; afterwards forward fix only.

-- migrate:up
CREATE TABLE mdm.promotion (
  id                   uuid PRIMARY KEY CONSTRAINT fk_promotion_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  code                 text NOT NULL CONSTRAINT ck_promotion_code CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  name                 text NOT NULL CONSTRAINT ck_promotion_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind                 text NOT NULL CONSTRAINT ck_promotion_kind CHECK (kind IN ('PERCENT_OFF', 'AMOUNT_OFF', 'BUNDLE_PRICE', 'FREE_DELIVERY')),
  percent_off          platform.percent NULL CONSTRAINT ck_promotion_percent_off CHECK (percent_off > 0),
  amount_off_pesewas   platform.pesewas NULL CONSTRAINT ck_promotion_amount_off CHECK (amount_off_pesewas > 0),
  bundle_price_pesewas platform.pesewas NULL CONSTRAINT ck_promotion_bundle_price CHECK (bundle_price_pesewas > 0),
  applies_to           text NOT NULL CONSTRAINT ck_promotion_applies_to CHECK (applies_to IN ('LINE', 'ORDER')),
  channel              text NULL CONSTRAINT ck_promotion_channel CHECK (channel IN ('POS', 'ONLINE', 'WHOLESALE', 'QUOTE')),
  min_order_pesewas    platform.pesewas NULL,
  stack_group          text NOT NULL DEFAULT 'DEFAULT' CONSTRAINT ck_promotion_stack_group CHECK (stack_group ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  is_exclusive         boolean NOT NULL DEFAULT false,
  requires_coupon      boolean NOT NULL DEFAULT false,
  max_redemptions      integer NULL CONSTRAINT ck_promotion_max_redemptions CHECK (max_redemptions > 0),
  valid_from           timestamptz NOT NULL,
  valid_to             timestamptz NOT NULL,
  status               text NOT NULL CONSTRAINT ck_promotion_status CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'ENDED', 'REJECTED')),
  approval_request_id  uuid NULL CONSTRAINT fk_promotion_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT,
  activated_at         timestamptz NULL,
  activated_by         uuid NULL CONSTRAINT fk_promotion_activated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL CONSTRAINT fk_promotion_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_promotion_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_promotion_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_promotion_window CHECK (valid_to > valid_from),
  -- Exactly the value its kind needs, and no other (FR-MDM-018).
  CONSTRAINT ck_promotion_value CHECK (
    (kind = 'PERCENT_OFF' AND percent_off IS NOT NULL AND amount_off_pesewas IS NULL AND bundle_price_pesewas IS NULL)
    OR (kind = 'AMOUNT_OFF' AND percent_off IS NULL AND amount_off_pesewas IS NOT NULL AND bundle_price_pesewas IS NULL)
    OR (kind = 'BUNDLE_PRICE' AND percent_off IS NULL AND amount_off_pesewas IS NULL AND bundle_price_pesewas IS NOT NULL)
    OR (kind = 'FREE_DELIVERY' AND percent_off IS NULL AND amount_off_pesewas IS NULL AND bundle_price_pesewas IS NULL AND applies_to = 'ORDER')),
  CONSTRAINT ck_promotion_percent_range CHECK (percent_off <= 100),
  CONSTRAINT ck_promotion_approved CHECK (status NOT IN ('PENDING_APPROVAL', 'ACTIVE', 'ENDED') OR approval_request_id IS NOT NULL),
  CONSTRAINT ck_promotion_activation CHECK ((status IN ('ACTIVE', 'ENDED')) = (activated_at IS NOT NULL AND activated_by IS NOT NULL))
);
COMMENT ON TABLE mdm.promotion IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_promotion_code ON mdm.promotion (code);
CREATE INDEX ix_promotion_active ON mdm.promotion (valid_from, valid_to) WHERE status = 'ACTIVE';
CREATE TRIGGER trg_promotion_version BEFORE UPDATE ON mdm.promotion
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- The promotion lifecycle, as for price list versions (ADR-0036): DRAFT -> PENDING_APPROVAL -> ACTIVE or REJECTED;
-- ACTIVE -> ENDED. Once submitted only the lifecycle columns move; once ACTIVE only status (to ENDED) and an earlier
-- valid_to may change. Activation may move valid_from later, to the moment of approval, never earlier. SQLSTATE HK004.
CREATE FUNCTION mdm.promotion_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  lifecycle text[] := ARRAY['status', 'approval_request_id', 'activated_at', 'activated_by', 'valid_from', 'valid_to', 'version', 'updated_at', 'updated_by'];
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'PENDING_APPROVAL') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - lifecycle)
     OR NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('ACTIVE', 'REJECTED'))
          OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'ENDED')))
     OR (NEW.valid_from IS DISTINCT FROM OLD.valid_from
         AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'ACTIVE' AND NEW.valid_from > OLD.valid_from))
     OR (NEW.valid_to IS DISTINCT FROM OLD.valid_to AND (OLD.status <> 'ACTIVE' OR NEW.valid_to > OLD.valid_to))
     OR (OLD.status = 'ACTIVE' AND (NEW.approval_request_id, NEW.activated_at, NEW.activated_by)
                                   IS DISTINCT FROM (OLD.approval_request_id, OLD.activated_at, OLD.activated_by)) THEN
    RAISE EXCEPTION 'mdm.promotion % is frozen in status %; it cannot become % with these values', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.promotion_guard() FROM PUBLIC;
CREATE TRIGGER trg_promotion_guard BEFORE UPDATE ON mdm.promotion
  FOR EACH ROW EXECUTE FUNCTION mdm.promotion_guard();

CREATE TABLE mdm.promotion_target (
  id           uuid PRIMARY KEY,
  promotion_id uuid NOT NULL CONSTRAINT fk_promotion_target_promotion REFERENCES mdm.promotion (id) ON DELETE RESTRICT,
  product_id   uuid NULL CONSTRAINT fk_promotion_target_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  category_id  uuid NULL CONSTRAINT fk_promotion_target_category REFERENCES mdm.category (id) ON DELETE RESTRICT,
  bundle_qty   platform.qty NULL CONSTRAINT ck_promotion_target_bundle_qty CHECK (bundle_qty > 0),
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL CONSTRAINT fk_promotion_target_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid NOT NULL CONSTRAINT fk_promotion_target_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_promotion_target_one CHECK ((product_id IS NULL) <> (category_id IS NULL))
);
COMMENT ON TABLE mdm.promotion_target IS 'class=MASTER';
CREATE UNIQUE INDEX uq_promotion_target ON mdm.promotion_target (promotion_id, product_id, category_id) NULLS NOT DISTINCT;
CREATE TRIGGER trg_promotion_target_version BEFORE UPDATE ON mdm.promotion_target
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Targets change only while their promotion is a DRAFT; afterwards they are frozen with it. SQLSTATE HK004.
CREATE FUNCTION mdm.promotion_target_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  promotion_status text;
BEGIN
  SELECT p.status INTO promotion_status FROM mdm.promotion p
   WHERE p.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.promotion_id ELSE NEW.promotion_id END;
  IF promotion_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW.promotion_id <> OLD.promotion_id) THEN
    RAISE EXCEPTION 'promotion targets are frozen once their promotion leaves DRAFT (promotion is %)', promotion_status
      USING ERRCODE = 'HK004';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
REVOKE ALL ON FUNCTION mdm.promotion_target_guard() FROM PUBLIC;
CREATE TRIGGER trg_promotion_target_guard BEFORE INSERT OR UPDATE OR DELETE ON mdm.promotion_target
  FOR EACH ROW EXECUTE FUNCTION mdm.promotion_target_guard();

-- updatePromotion replaces a draft's targets. hk_app holds no DELETE on a MASTER table (ADR-0024), so the removal is
-- this one function, owned by hk_owner, which can only empty a DRAFT promotion (the guard above refuses the rest).
CREATE FUNCTION mdm.clear_draft_promotion_targets(p_promotion_id uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM mdm.promotion_target WHERE promotion_id = p_promotion_id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END
$$;
REVOKE ALL ON FUNCTION mdm.clear_draft_promotion_targets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mdm.clear_draft_promotion_targets(uuid) TO hk_app, hk_worker;

CREATE TABLE mdm.coupon (
  id                 uuid PRIMARY KEY,
  promotion_id       uuid NOT NULL CONSTRAINT fk_coupon_promotion REFERENCES mdm.promotion (id) ON DELETE RESTRICT,
  code               text NOT NULL CONSTRAINT ck_coupon_code CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  max_uses           integer NULL CONSTRAINT ck_coupon_max_uses CHECK (max_uses > 0),
  per_customer_limit integer NULL CONSTRAINT ck_coupon_per_customer_limit CHECK (per_customer_limit > 0),
  used_count         integer NOT NULL DEFAULT 0 CONSTRAINT ck_coupon_used_count CHECK (used_count >= 0),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_coupon_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_coupon_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at         timestamptz NULL,
  deleted_by         uuid NULL CONSTRAINT fk_coupon_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason      text NULL,
  -- The backstop of the limit: even a redemption that slipped past the trigger could not commit beyond it.
  CONSTRAINT ck_coupon_within_limit CHECK (max_uses IS NULL OR used_count <= max_uses),
  CONSTRAINT ck_coupon_customer_limit CHECK (per_customer_limit IS NULL OR max_uses IS NULL OR per_customer_limit <= max_uses),
  CONSTRAINT ck_coupon_soft_delete CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE mdm.coupon IS 'class=MASTER';
CREATE UNIQUE INDEX uq_coupon_code ON mdm.coupon (code);
CREATE INDEX ix_coupon_promotion ON mdm.coupon (promotion_id);
CREATE TRIGGER trg_coupon_version BEFORE UPDATE ON mdm.coupon
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- used_count is a projection of the redemption ledger: only the redemption trigger moves it (it runs one trigger level
-- deeper than any statement a role can issue), and a coupon's promotion and code never change. SQLSTATE HK004.
CREATE FUNCTION mdm.coupon_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF (NEW.used_count IS DISTINCT FROM OLD.used_count AND pg_catalog.pg_trigger_depth() < 2)
     OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id OR NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'mdm.coupon %: the use count moves only with a redemption, and the code and promotion never change', OLD.id
      USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.coupon_guard() FROM PUBLIC;
CREATE TRIGGER trg_coupon_guard BEFORE UPDATE ON mdm.coupon
  FOR EACH ROW EXECUTE FUNCTION mdm.coupon_guard();

CREATE TABLE mdm.coupon_redemption (
  id                 uuid PRIMARY KEY,
  coupon_id          uuid NOT NULL CONSTRAINT fk_coupon_redemption_coupon REFERENCES mdm.coupon (id) ON DELETE RESTRICT,
  customer_id        uuid NULL CONSTRAINT fk_coupon_redemption_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  source_document_id uuid NOT NULL CONSTRAINT fk_coupon_redemption_source REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  direction          text NOT NULL CONSTRAINT ck_coupon_redemption_direction CHECK (direction IN ('REDEEM', 'RELEASE')),
  amount_pesewas     platform.pesewas NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_coupon_redemption_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE mdm.coupon_redemption IS 'class=LEDGER';
CREATE INDEX ix_coupon_redemption_coupon_customer ON mdm.coupon_redemption (coupon_id, customer_id);
CREATE INDEX ix_coupon_redemption_source ON mdm.coupon_redemption (source_document_id, coupon_id);
CREATE TRIGGER trg_coupon_redemption_immutable BEFORE UPDATE OR DELETE ON mdm.coupon_redemption
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_coupon_redemption_no_truncate BEFORE TRUNCATE ON mdm.coupon_redemption
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- Each redemption locks its promotion and then its coupon (always in that order, so two redemptions cannot deadlock),
-- checks the limits against what is committed or already counted in this transaction, and moves used_count. A
-- concurrent redemption waits on the lock and then sees the new count, so no limit is passed under any isolation
-- level. A release must undo a use by the same document. Refusal: SQLSTATE HK006, with the refusal in the detail.
CREATE FUNCTION mdm.coupon_redemption_count() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  c mdm.coupon%ROWTYPE;
  promotion_status text;
  promotion_limit integer;
  promotion_used bigint;
  customer_used bigint;
  document_net bigint;
BEGIN
  SELECT p.status, p.max_redemptions INTO promotion_status, promotion_limit
    FROM mdm.promotion p JOIN mdm.coupon k ON k.promotion_id = p.id
   WHERE k.id = NEW.coupon_id
     FOR NO KEY UPDATE OF p;
  SELECT * INTO c FROM mdm.coupon WHERE id = NEW.coupon_id FOR NO KEY UPDATE;
  SELECT COALESCE(sum(CASE r.direction WHEN 'REDEEM' THEN 1 ELSE -1 END), 0) INTO document_net
    FROM mdm.coupon_redemption r WHERE r.coupon_id = NEW.coupon_id AND r.source_document_id = NEW.source_document_id;
  IF NEW.direction = 'RELEASE' THEN
    IF document_net < 1 THEN
      RAISE EXCEPTION 'coupon %: document % holds no use to release', c.code, NEW.source_document_id
        USING ERRCODE = 'HK006', DETAIL = 'NOTHING_TO_RELEASE';
    END IF;
    UPDATE mdm.coupon SET used_count = used_count - 1, version = version + 1, updated_at = now(), updated_by = NEW.actor_id WHERE id = c.id;
    RETURN NEW;
  END IF;
  IF c.deleted_at IS NOT NULL OR promotion_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'coupon % is not usable (promotion %)', c.code, promotion_status
      USING ERRCODE = 'HK006', DETAIL = 'NOT_APPLICABLE';
  END IF;
  IF document_net > 0 THEN
    RAISE EXCEPTION 'coupon % is already used by document %', c.code, NEW.source_document_id
      USING ERRCODE = 'HK006', DETAIL = 'ALREADY_USED';
  END IF;
  IF c.max_uses IS NOT NULL AND c.used_count >= c.max_uses THEN
    RAISE EXCEPTION 'coupon % has reached its limit of %', c.code, c.max_uses
      USING ERRCODE = 'HK006', DETAIL = 'LIMIT_REACHED';
  END IF;
  IF promotion_limit IS NOT NULL THEN
    SELECT COALESCE(sum(k.used_count), 0) INTO promotion_used FROM mdm.coupon k JOIN mdm.coupon k0 ON k0.promotion_id = k.promotion_id WHERE k0.id = c.id;
    IF promotion_used >= promotion_limit THEN
      RAISE EXCEPTION 'the promotion of coupon % has reached its limit of %', c.code, promotion_limit
        USING ERRCODE = 'HK006', DETAIL = 'LIMIT_REACHED';
    END IF;
  END IF;
  IF c.per_customer_limit IS NOT NULL AND NEW.customer_id IS NOT NULL THEN
    SELECT COALESCE(sum(CASE r.direction WHEN 'REDEEM' THEN 1 ELSE -1 END), 0) INTO customer_used
      FROM mdm.coupon_redemption r WHERE r.coupon_id = c.id AND r.customer_id = NEW.customer_id;
    IF customer_used >= c.per_customer_limit THEN
      RAISE EXCEPTION 'customer % has used coupon % % times', NEW.customer_id, c.code, customer_used
        USING ERRCODE = 'HK006', DETAIL = 'ALREADY_USED';
    END IF;
  END IF;
  UPDATE mdm.coupon SET used_count = used_count + 1, version = version + 1, updated_at = now(), updated_by = NEW.actor_id WHERE id = c.id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION mdm.coupon_redemption_count() FROM PUBLIC;
CREATE TRIGGER trg_coupon_redemption_count BEFORE INSERT ON mdm.coupon_redemption
  FOR EACH ROW EXECUTE FUNCTION mdm.coupon_redemption_count();

REVOKE ALL ON mdm.promotion, mdm.promotion_target, mdm.coupon, mdm.coupon_redemption FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mdm.promotion, mdm.promotion_target, mdm.coupon TO hk_app, hk_worker;
GRANT SELECT, INSERT ON mdm.coupon_redemption TO hk_app, hk_worker;

-- migrate:down
DROP TABLE mdm.coupon_redemption;
DROP FUNCTION mdm.coupon_redemption_count();
DROP TABLE mdm.coupon;
DROP FUNCTION mdm.coupon_guard();
DROP FUNCTION mdm.clear_draft_promotion_targets(uuid);
DROP TABLE mdm.promotion_target;
DROP FUNCTION mdm.promotion_target_guard();
DROP TABLE mdm.promotion;
DROP FUNCTION mdm.promotion_guard();
