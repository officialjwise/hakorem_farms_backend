-- 0284_pay_unverified_clearing
-- B09b continued 3c (the owner's decision 3 of 2026-11-18, OFFLINE_SYNC 9.9, ADR-0003 Amendments, A-282): an unverified
-- offline mobile money tender waits in its own clearing account until verified, and moves to the wallet exactly once.
--   pay.break_resolution.posting   gains VERIFIED: the resolution of an UNVERIFIED_PAYMENT break that says the provider
--                                  paid it (a second person's approval, as every resolution)
--   pay.unverified_verification    LEDGER: one row per verified tender, its subject for the move to the wallet
--                                  (pay.UnverifiedPaymentVerified, Dr 1110, Cr 1115): one per payment, per break and per
--                                  resolution; only of a PENDING, UNVERIFIED, mobile money payment, for its whole amount,
--                                  through its own break's approved VERIFIED resolution (ck_unverified_verification)
--   pay.unverified_overdue         LEDGER: one row per open break the window passed, raised URGENT once
--                                  (ck_unverified_overdue: only an UNVERIFIED_PAYMENT break still open, of a payment
--                                  still PENDING and not verified)
--   pay.payment_unverified_bounce  a verified tender is never bounced (ck_payment_verified_bounce): PENDING to FAILED is
--                                  refused once a verification row stands
-- Data category: CONFIDENTIAL (DC-09): the farm's books.
-- Rollback: tested (`pnpm db:rollback`) before the first verification; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.break_resolution DROP CONSTRAINT ck_break_resolution_posting;
ALTER TABLE pay.break_resolution ADD CONSTRAINT ck_break_resolution_posting CHECK (posting IN ('NONE', 'UNIDENTIFIED_RECEIPT', 'VERIFIED'));

CREATE TABLE pay.unverified_verification (
  id             uuid PRIMARY KEY,
  payment_id     uuid NOT NULL CONSTRAINT fk_unverified_verification_payment REFERENCES pay.payment (id) ON DELETE RESTRICT
                   CONSTRAINT uq_unverified_verification_payment UNIQUE,
  break_id       uuid NOT NULL CONSTRAINT fk_unverified_verification_break REFERENCES pay.reconciliation_break (id) ON DELETE RESTRICT
                   CONSTRAINT uq_unverified_verification_break UNIQUE,
  resolution_id  uuid NOT NULL CONSTRAINT fk_unverified_verification_resolution REFERENCES pay.break_resolution (id) ON DELETE RESTRICT
                   CONSTRAINT uq_unverified_verification_resolution UNIQUE,
  branch_id      uuid NOT NULL CONSTRAINT fk_unverified_verification_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  amount_pesewas platform.pesewas NOT NULL CONSTRAINT ck_unverified_verification_amount CHECK (amount_pesewas > 0),
  verified_on    date NOT NULL,
  recorded_at    timestamptz NOT NULL,
  actor_id       uuid NOT NULL CONSTRAINT fk_unverified_verification_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE pay.unverified_verification IS 'class=LEDGER';
CREATE TRIGGER trg_unverified_verification_immutable BEFORE UPDATE OR DELETE ON pay.unverified_verification
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_unverified_verification_no_truncate BEFORE TRUNCATE ON pay.unverified_verification
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pay.unverified_verification_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p pay.payment;
  b pay.reconciliation_break;
  r pay.break_resolution;
BEGIN
  SELECT * INTO p FROM pay.payment WHERE id = NEW.payment_id FOR UPDATE;
  SELECT * INTO b FROM pay.reconciliation_break WHERE id = NEW.break_id;
  SELECT * INTO r FROM pay.break_resolution WHERE id = NEW.resolution_id;
  IF p.method_kind <> 'MOBILE_MONEY' OR p.verification <> 'UNVERIFIED' OR p.status <> 'PENDING' OR p.reverses_payment_id IS NOT NULL
     OR NEW.amount_pesewas <> p.amount_pesewas OR NEW.branch_id <> p.branch_id THEN
    RAISE EXCEPTION 'pay.unverified_verification: payment % is not a pending unverified mobile money tender of % pesewas', NEW.payment_id, NEW.amount_pesewas
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_unverified_verification';
  END IF;
  IF b.kind <> 'UNVERIFIED_PAYMENT' OR b.payment_id IS DISTINCT FROM NEW.payment_id
     OR r.break_id <> NEW.break_id OR r.posting <> 'VERIFIED' OR r.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'pay.unverified_verification: % is not the approved VERIFIED resolution of the break of payment %', NEW.resolution_id, NEW.payment_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_unverified_verification';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.unverified_verification_guard() FROM PUBLIC;
CREATE TRIGGER trg_unverified_verification_guard BEFORE INSERT ON pay.unverified_verification
  FOR EACH ROW EXECUTE FUNCTION pay.unverified_verification_guard();
REVOKE ALL ON pay.unverified_verification FROM PUBLIC;
GRANT SELECT, INSERT ON pay.unverified_verification TO hk_app, hk_worker;

CREATE TABLE pay.unverified_overdue (
  id             uuid PRIMARY KEY,
  break_id       uuid NOT NULL CONSTRAINT fk_unverified_overdue_break REFERENCES pay.reconciliation_break (id) ON DELETE RESTRICT
                   CONSTRAINT uq_unverified_overdue_break UNIQUE,
  payment_id     uuid NOT NULL CONSTRAINT fk_unverified_overdue_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  branch_id      uuid NOT NULL CONSTRAINT fk_unverified_overdue_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  amount_pesewas platform.pesewas NOT NULL,
  urgent_from    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL,
  actor_id       uuid NOT NULL CONSTRAINT fk_unverified_overdue_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_unverified_overdue_due CHECK (recorded_at >= urgent_from)
);
COMMENT ON TABLE pay.unverified_overdue IS 'class=LEDGER';
CREATE TRIGGER trg_unverified_overdue_immutable BEFORE UPDATE OR DELETE ON pay.unverified_overdue
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_unverified_overdue_no_truncate BEFORE TRUNCATE ON pay.unverified_overdue
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION pay.unverified_overdue_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p pay.payment;
  b pay.reconciliation_break;
BEGIN
  SELECT * INTO b FROM pay.reconciliation_break WHERE id = NEW.break_id;
  SELECT * INTO p FROM pay.payment WHERE id = NEW.payment_id;
  IF b.kind <> 'UNVERIFIED_PAYMENT' OR b.status <> 'OPEN' OR b.payment_id IS DISTINCT FROM NEW.payment_id
     OR p.status <> 'PENDING' OR p.verification <> 'UNVERIFIED' OR NEW.amount_pesewas <> p.amount_pesewas
     OR EXISTS (SELECT 1 FROM pay.unverified_verification v WHERE v.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'pay.unverified_overdue: break % is not an open unverified tender still waiting', NEW.break_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_unverified_overdue';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.unverified_overdue_guard() FROM PUBLIC;
CREATE TRIGGER trg_unverified_overdue_guard BEFORE INSERT ON pay.unverified_overdue
  FOR EACH ROW EXECUTE FUNCTION pay.unverified_overdue_guard();
REVOKE ALL ON pay.unverified_overdue FROM PUBLIC;
GRANT SELECT, INSERT ON pay.unverified_overdue TO hk_app, hk_worker;

CREATE FUNCTION pay.payment_unverified_bounce() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pay.unverified_verification v WHERE v.payment_id = OLD.id) THEN
    RAISE EXCEPTION 'pay.payment %: a verified mobile money tender is never bounced', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_verified_bounce';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_unverified_bounce() FROM PUBLIC;
CREATE TRIGGER trg_payment_a_unverified_bounce BEFORE UPDATE ON pay.payment
  FOR EACH ROW WHEN (OLD.verification = 'UNVERIFIED' AND OLD.status = 'PENDING' AND NEW.status = 'FAILED')
  EXECUTE FUNCTION pay.payment_unverified_bounce();

-- migrate:down
DROP TRIGGER trg_payment_a_unverified_bounce ON pay.payment;
DROP FUNCTION pay.payment_unverified_bounce();
DROP TABLE pay.unverified_overdue;
DROP FUNCTION pay.unverified_overdue_guard();
DROP TABLE pay.unverified_verification;
DROP FUNCTION pay.unverified_verification_guard();
ALTER TABLE pay.break_resolution DROP CONSTRAINT ck_break_resolution_posting;
ALTER TABLE pay.break_resolution ADD CONSTRAINT ck_break_resolution_posting CHECK (posting IN ('NONE', 'UNIDENTIFIED_RECEIPT'));
