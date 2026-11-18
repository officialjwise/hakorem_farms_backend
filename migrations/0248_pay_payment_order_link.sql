-- 0248_pay_payment_order_link
-- B09b continued 1c (FR-POS-006, ADR-0079, A-276): a mobile money or card payment the provider cleared at a till, for no
-- order (the cashier charged the customer's phone before the sale was rung up), is taken by one counter sale as its
-- tender. The cleared payment itself is frozen (trg_payment_guard), so the sale is linked to it by an insert-only row
-- here, written in the sale's transaction before the payment is allocated to the sale's receipt; PAY reads an order's
-- payments by their own order and by this link, so ORD's reads, a return and a void see it.
--   pay.payment_order_link  LEDGER, one row per payment (PK payment_id: a payment is taken by one sale, once).
--                           pay.payment_order_link_guard (HK010, ck_payment_order_link, the rule in the error's
--                           detail), under the payment's row lock: a MOBILE_MONEY or CARD payment (NOT_A_PROVIDER_PAYMENT),
--                           CLEARED from the provider's callback or lookup (PAYMENT_NOT_CLEARED), taken for no order and
--                           not yet allocated or refunded by a pesewa (PAYMENT_ALREADY_USED), of the link's branch
--                           (OTHER_BRANCH), customer (OTHER_CUSTOMER) and till shift (OTHER_SHIFT), and that shift still
--                           takes entries from the person linking it (the till rule of 0239, ADR-0077).
-- The shift's state is read through pay.till_shift_refusal (0239), never from pos tables (ADR-0008).
-- Additions to docs/data-model/pay.md: the table above.
-- Data category: CONFIDENTIAL (DC-11: which sale a payment paid).
-- Rollback: tested (`pnpm db:rollback`) before the first link; afterwards forward fix only (a link is a record of money).

-- migrate:up
CREATE TABLE pay.payment_order_link (
  payment_id         uuid PRIMARY KEY CONSTRAINT fk_payment_order_link_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  order_document_id  uuid NOT NULL CONSTRAINT fk_payment_order_link_order REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  shift_document_id  uuid NOT NULL CONSTRAINT fk_payment_order_link_shift REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  customer_id        uuid NULL CONSTRAINT fk_payment_order_link_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  branch_id          uuid NOT NULL CONSTRAINT fk_payment_order_link_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  recorded_at        timestamptz NOT NULL,
  actor_id           uuid NOT NULL CONSTRAINT fk_payment_order_link_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE pay.payment_order_link IS 'class=LEDGER';
CREATE INDEX ix_payment_order_link_order ON pay.payment_order_link (order_document_id);
CREATE TRIGGER trg_payment_order_link_immutable BEFORE UPDATE OR DELETE ON pay.payment_order_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_payment_order_link_no_truncate BEFORE TRUNCATE ON pay.payment_order_link
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pay.payment_order_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
  refusal text;
BEGIN
  SELECT x.status, x.method_kind, x.verification, x.order_document_id, x.allocated_pesewas, x.refunded_pesewas, x.customer_id, x.branch_id, x.shift_document_id
    INTO p FROM pay.payment x WHERE x.id = NEW.payment_id FOR UPDATE;
  refusal := CASE
    WHEN p.method_kind NOT IN ('MOBILE_MONEY', 'CARD') THEN 'NOT_A_PROVIDER_PAYMENT'
    WHEN p.status <> 'CLEARED' OR p.verification NOT IN ('PROVIDER_CALLBACK', 'PROVIDER_LOOKUP') THEN 'PAYMENT_NOT_CLEARED'
    WHEN p.order_document_id IS NOT NULL OR p.allocated_pesewas <> 0 OR p.refunded_pesewas <> 0 THEN 'PAYMENT_ALREADY_USED'
    WHEN p.branch_id <> NEW.branch_id THEN 'OTHER_BRANCH'
    WHEN p.customer_id IS DISTINCT FROM NEW.customer_id THEN 'OTHER_CUSTOMER'
    WHEN p.shift_document_id IS DISTINCT FROM NEW.shift_document_id THEN 'OTHER_SHIFT'
    ELSE pay.till_shift_refusal(NEW.shift_document_id, NEW.branch_id, NULL, NEW.actor_id)
  END;
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION 'pay.payment_order_link: payment % cannot pay order % (%)', NEW.payment_id, NEW.order_document_id, refusal USING ERRCODE = 'HK010', CONSTRAINT = 'ck_payment_order_link', DETAIL = refusal;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_order_link_guard() FROM PUBLIC;
CREATE TRIGGER trg_payment_order_link_guard BEFORE INSERT ON pay.payment_order_link
  FOR EACH ROW EXECUTE FUNCTION pay.payment_order_link_guard();

REVOKE ALL ON pay.payment_order_link FROM PUBLIC;
GRANT SELECT, INSERT ON pay.payment_order_link TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pay.payment_order_link;
DROP FUNCTION pay.payment_order_link_guard();
