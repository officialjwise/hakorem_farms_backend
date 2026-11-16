-- 0166_pay_provider_webhooks_refunds
-- B09a continued (FR-PAY-003 to FR-PAY-008, FR-PAY-012, FR-PAY-013, ADR-0014, ADR-0010, A-210): the provider port's
-- records, the webhook log, refunds and the reconciliation break queue. The database holds:
--   uq_provider_transaction_reference   our reference is sent to a provider once: a retry reuses it, never a second
--   uq_provider_transaction_charge      one charge per payment
--   trg_provider_transaction_guard      INITIATED to PENDING, SUCCEEDED, FAILED or ABANDONED; PENDING to the last three;
--                                       a settled attempt is frozen; the amount asked for and our reference never change
--   ck_provider_transaction_confirmed   SUCCEEDED carries the amount the provider's own API confirmed, and when
--   trg_payment_provider_confirmed      a mobile money or card payment is CLEARED only when its charge SUCCEEDED for
--                                       exactly its amount, as the provider's API confirmed it: never the webhook's
--                                       word (FR-PAY-004, abuse cases 4 and 5)
--   uq_webhook_event_reference          a validly signed event is processed once, by the provider's reference for the
--                                       event (the owner, 2026-11-16): a second delivery collides and is logged as a
--                                       REPLAYED row with no effect; only an event that reached processing (accepted,
--                                       rejected on its amount, an unknown reference, a lookup deferred) takes the key,
--                                       so neither a forged nor a stale delivery can block the genuine event
--   trg_refund_cap                      a refund draws only on a cleared payment's unallocated money: refunds that are
--                                       not rejected never exceed the amount less what is allocated, kept on
--                                       pay.payment.refunded_pesewas under the payment's row lock (FR-PAY-012)
--   trg_refund_guard                    PENDING_APPROVAL to APPROVED or REJECTED; APPROVED to PROCESSING or PAID;
--                                       PROCESSING to PAID or FAILED; FAILED to APPROVED (a retry) or PAID; PAID and
--                                       REJECTED are frozen, and what was asked for never changes
--   ck_refund_paid                      PAID only with an approval or as an automatic refund, and the payout is never
--                                       recorded by the refund's maker (ck_refund_paid_by)
--   uq_reconciliation_break_open_*      one open break per payment, or per unknown reference, and kind: a sweep run
--                                       twice raises nothing new
-- `pay.webhook_event` and `pay.provider_sweep` are LEDGER (insert-only for every role). A webhook payload is stored as
-- the provider's fields this module reads, never the whole body: no card or personal detail (DC-22). The payer's phone
-- is stored masked only; the full number lives in memory for the one charge request.
-- Data category: CONFIDENTIAL (DC-22).
-- Rollback: tested (`pnpm db:rollback`), safe before the first provider payment; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.payment ADD COLUMN payer_phone_masked text NULL
  CONSTRAINT ck_payment_payer_phone_masked CHECK (payer_phone_masked ~ '^\+233 [0-9]{2} \*\*\* \*[0-9]{3}$');

CREATE TABLE pay.provider_transaction (
  id                uuid PRIMARY KEY,
  payment_id        uuid NOT NULL CONSTRAINT fk_provider_transaction_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  provider          text NOT NULL CONSTRAINT ck_provider_transaction_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  reference         text NOT NULL CONSTRAINT ck_provider_transaction_reference CHECK (reference ~ '^[A-Za-z0-9_-]{8,100}$'),
  kind              text NOT NULL CONSTRAINT ck_provider_transaction_kind CHECK (kind IN ('CHARGE', 'AUTHORISE', 'CAPTURE', 'REFUND')),
  channel           text NULL CONSTRAINT ck_provider_transaction_channel CHECK (channel IN ('MOBILE_MONEY', 'CARD', 'BANK')),
  network           text NULL CONSTRAINT ck_provider_transaction_network CHECK (network IN ('MTN', 'TELECEL', 'AIRTELTIGO')),
  requested_pesewas platform.pesewas NOT NULL CONSTRAINT ck_provider_transaction_requested CHECK (requested_pesewas > 0),
  confirmed_pesewas platform.pesewas NULL,
  status            text NOT NULL CONSTRAINT ck_provider_transaction_status CHECK (status IN ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED')),
  provider_status   text NULL CONSTRAINT ck_provider_transaction_provider_status CHECK (length(provider_status) BETWEEN 1 AND 40),
  fee_pesewas       platform.pesewas NULL,
  verified_at       timestamptz NULL,
  awaited_until     timestamptz NOT NULL,
  released_at       timestamptz NULL,
  last_checked_at   timestamptz NULL,
  branch_id         uuid NOT NULL CONSTRAINT fk_provider_transaction_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL CONSTRAINT fk_provider_transaction_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NOT NULL CONSTRAINT fk_provider_transaction_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_provider_transaction_reference UNIQUE (provider, reference),
  CONSTRAINT ck_provider_transaction_confirmed CHECK ((status = 'SUCCEEDED') <= (confirmed_pesewas IS NOT NULL AND verified_at IS NOT NULL))
);
COMMENT ON TABLE pay.provider_transaction IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_provider_transaction_charge ON pay.provider_transaction (payment_id) WHERE kind = 'CHARGE';
CREATE INDEX ix_provider_transaction_open ON pay.provider_transaction (created_at) WHERE status IN ('INITIATED', 'PENDING');
CREATE TRIGGER trg_provider_transaction_version BEFORE UPDATE ON pay.provider_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION pay.provider_transaction_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INITIATED' OR NEW.confirmed_pesewas IS NOT NULL THEN
      RAISE EXCEPTION 'pay.provider_transaction %: an attempt is written INITIATED with nothing confirmed', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_provider_transaction_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'INITIATED' AND NEW.status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED'))
              OR (OLD.status = 'PENDING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'ABANDONED'))) THEN
    RAISE EXCEPTION 'pay.provider_transaction %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_provider_transaction_transition';
  END IF;
  IF (NEW.payment_id, NEW.provider, NEW.reference, NEW.kind, NEW.requested_pesewas, NEW.branch_id, NEW.created_by)
     IS DISTINCT FROM (OLD.payment_id, OLD.provider, OLD.reference, OLD.kind, OLD.requested_pesewas, OLD.branch_id, OLD.created_by)
     OR (OLD.status IN ('SUCCEEDED', 'FAILED', 'ABANDONED')
         AND (to_jsonb(NEW) - ARRAY['released_at', 'last_checked_at', 'version', 'updated_at', 'updated_by'])
             IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_at', 'last_checked_at', 'version', 'updated_at', 'updated_by'])) THEN
    RAISE EXCEPTION 'pay.provider_transaction %: what was asked for, and a settled attempt, never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_provider_transaction_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.provider_transaction_guard() FROM PUBLIC;
CREATE TRIGGER trg_provider_transaction_guard BEFORE INSERT OR UPDATE ON pay.provider_transaction
  FOR EACH ROW EXECUTE FUNCTION pay.provider_transaction_guard();

-- A provider payment clears only on the provider's own confirmation of exactly its amount.
CREATE FUNCTION pay.payment_provider_confirmed() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'CLEARED' AND OLD.status IS DISTINCT FROM 'CLEARED' AND NEW.method_kind IN ('MOBILE_MONEY', 'CARD')
     AND NOT EXISTS (SELECT 1 FROM pay.provider_transaction t
                      WHERE t.payment_id = NEW.id AND t.kind = 'CHARGE' AND t.status = 'SUCCEEDED' AND t.confirmed_pesewas = NEW.amount_pesewas) THEN
    RAISE EXCEPTION 'pay.payment %: a provider payment clears only on the provider''s confirmation of its amount', NEW.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_provider_confirmed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_provider_confirmed() FROM PUBLIC;
CREATE TRIGGER trg_payment_provider_confirmed BEFORE UPDATE ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION pay.payment_provider_confirmed();
CREATE FUNCTION pay.payment_provider_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status = 'CLEARED' AND NEW.method_kind IN ('MOBILE_MONEY', 'CARD') THEN
    RAISE EXCEPTION 'pay.payment %: a provider payment is written PENDING and cleared by the provider', NEW.id
      USING ERRCODE = 'HK004', CONSTRAINT = 'ck_payment_provider_confirmed';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.payment_provider_insert() FROM PUBLIC;
CREATE TRIGGER trg_payment_provider_insert BEFORE INSERT ON pay.payment
  FOR EACH ROW EXECUTE FUNCTION pay.payment_provider_insert();

CREATE TABLE pay.webhook_event (
  id                 uuid PRIMARY KEY,
  provider           text NOT NULL CONSTRAINT ck_webhook_event_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  event_id           text NULL CONSTRAINT ck_webhook_event_event_id CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type         text NULL CONSTRAINT ck_webhook_event_type CHECK (length(event_type) BETWEEN 1 AND 60),
  signature_valid    boolean NOT NULL,
  within_time_window boolean NULL,
  payload_hash       bytea NOT NULL CONSTRAINT ck_webhook_event_payload_hash CHECK (length(payload_hash) = 32),
  payload            jsonb NOT NULL,
  reference          text NULL CONSTRAINT ck_webhook_event_reference CHECK (length(reference) BETWEEN 1 AND 100),
  payment_id         uuid NULL CONSTRAINT fk_webhook_event_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  outcome            text NOT NULL CONSTRAINT ck_webhook_event_outcome CHECK (outcome IN (
                       'ACCEPTED', 'REJECTED_SIGNATURE', 'REJECTED_STALE', 'REJECTED_AMOUNT', 'REJECTED_MALFORMED',
                       'IGNORED_UNKNOWN_REFERENCE', 'IGNORED_EVENT_TYPE', 'REPLAYED', 'DEFERRED_LOOKUP')),
  source_ip          inet NULL,
  correlation_id     uuid NULL,
  received_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  actor_id           uuid NOT NULL CONSTRAINT fk_webhook_event_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_webhook_event_signed CHECK (NOT signature_valid OR outcome = 'REJECTED_MALFORMED' OR (event_id IS NOT NULL AND event_type IS NOT NULL)),
  CONSTRAINT ck_webhook_event_signature_outcome CHECK (signature_valid = (outcome <> 'REJECTED_SIGNATURE'))
);
COMMENT ON TABLE pay.webhook_event IS 'class=LEDGER';
CREATE UNIQUE INDEX uq_webhook_event_reference ON pay.webhook_event (provider, event_id)
  WHERE signature_valid AND event_id IS NOT NULL AND outcome IN ('ACCEPTED', 'REJECTED_AMOUNT', 'IGNORED_UNKNOWN_REFERENCE', 'DEFERRED_LOOKUP');
CREATE INDEX ix_webhook_event_outcome ON pay.webhook_event (outcome, received_at);
CREATE TRIGGER trg_webhook_event_immutable BEFORE UPDATE OR DELETE ON pay.webhook_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_webhook_event_no_truncate BEFORE TRUNCATE ON pay.webhook_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE TABLE pay.refund (
  id                   uuid PRIMARY KEY CONSTRAINT fk_refund_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  refund_no            text NULL CONSTRAINT uq_refund_no UNIQUE,
  original_payment_id  uuid NOT NULL CONSTRAINT fk_refund_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  amount_pesewas       platform.pesewas NOT NULL CONSTRAINT ck_refund_amount CHECK (amount_pesewas > 0),
  currency             char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_refund_currency CHECK (currency = 'GHS'),
  destination          text NOT NULL CONSTRAINT ck_refund_destination CHECK (destination IN ('ORIGINAL_METHOD', 'STORE_CREDIT', 'CASH')),
  reason_code          text NOT NULL CONSTRAINT fk_refund_reason REFERENCES mdm.reason_code (code) ON DELETE RESTRICT,
  note                 text NULL CONSTRAINT ck_refund_note CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  credit_note_id       uuid NULL CONSTRAINT fk_refund_credit_note REFERENCES bil.billing_document (id) ON DELETE RESTRICT,
  is_automatic         boolean NOT NULL DEFAULT false,
  approval_request_id  uuid NULL CONSTRAINT fk_refund_approval REFERENCES iam.approval_request (id) ON DELETE RESTRICT CONSTRAINT uq_refund_approval UNIQUE,
  provider_reference   text NULL CONSTRAINT uq_refund_provider_reference UNIQUE CONSTRAINT ck_refund_provider_reference CHECK (length(provider_reference) BETWEEN 1 AND 100),
  provider_status      text NULL CONSTRAINT ck_refund_provider_status CHECK (length(provider_status) BETWEEN 1 AND 40),
  external_reference   text NULL CONSTRAINT ck_refund_external_reference CHECK (external_reference = btrim(external_reference) AND length(external_reference) BETWEEN 1 AND 100),
  attempts             integer NOT NULL DEFAULT 0 CONSTRAINT ck_refund_attempts CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at      timestamptz NULL,
  paid_at              timestamptz NULL,
  paid_by              uuid NULL CONSTRAINT fk_refund_paid_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  failure_reason       text NULL CONSTRAINT ck_refund_failure_reason CHECK (length(btrim(failure_reason)) BETWEEN 1 AND 500),
  status               text NOT NULL CONSTRAINT ck_refund_status CHECK (status IN ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED')),
  branch_id            uuid NOT NULL CONSTRAINT fk_refund_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_refund_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_refund_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  posted_at            timestamptz NULL,
  posted_by            uuid NULL CONSTRAINT fk_refund_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_refund_paid CHECK ((status <> 'PAID' OR is_automatic OR approval_request_id IS NOT NULL)
                                   AND (status = 'PAID') = (paid_at IS NOT NULL) AND (paid_at IS NULL) = (posted_at IS NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_refund_paid_by CHECK (paid_by IS NULL OR paid_by <> created_by),
  CONSTRAINT ck_refund_failed CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL),
  CONSTRAINT ck_refund_approval_kind CHECK (is_automatic OR status IN ('REQUESTED', 'PENDING_APPROVAL') OR approval_request_id IS NOT NULL)
);
COMMENT ON TABLE pay.refund IS 'class=DOCUMENT';
CREATE INDEX ix_refund_payment ON pay.refund (original_payment_id);
CREATE INDEX ix_refund_due ON pay.refund (next_attempt_at) WHERE status IN ('APPROVED', 'PROCESSING', 'FAILED');
CREATE INDEX ix_refund_branch ON pay.refund (branch_id, created_at);
CREATE TRIGGER trg_refund_version BEFORE UPDATE ON pay.refund
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- Refunds that are not rejected hold their amount on the payment; a rejection gives it back.
CREATE FUNCTION pay.refund_cap() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  p record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT x.status, x.amount_pesewas, x.allocated_pesewas, x.refunded_pesewas INTO p FROM pay.payment x WHERE x.id = NEW.original_payment_id FOR UPDATE;
    IF p.status IS DISTINCT FROM 'CLEARED' THEN
      RAISE EXCEPTION 'pay.refund: payment % is %, only a cleared payment is refunded', NEW.original_payment_id, p.status USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
    END IF;
    IF p.allocated_pesewas + p.refunded_pesewas + NEW.amount_pesewas > p.amount_pesewas THEN
      RAISE EXCEPTION 'pay.refund: % pesewas exceeds the % payment % has unallocated and unrefunded', NEW.amount_pesewas,
        p.amount_pesewas - p.allocated_pesewas - p.refunded_pesewas, NEW.original_payment_id USING ERRCODE = 'HK010', CONSTRAINT = 'ck_refund_cap';
    END IF;
    UPDATE pay.payment SET refunded_pesewas = refunded_pesewas + NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
  ELSIF NEW.status = 'REJECTED' AND OLD.status IS DISTINCT FROM 'REJECTED' THEN
    UPDATE pay.payment SET refunded_pesewas = refunded_pesewas - NEW.amount_pesewas, version = version + 1 WHERE id = NEW.original_payment_id;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.refund_cap() FROM PUBLIC;
CREATE TRIGGER trg_refund_cap AFTER INSERT OR UPDATE OF status ON pay.refund
  FOR EACH ROW EXECUTE FUNCTION pay.refund_cap();

CREATE FUNCTION pay.refund_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = 'PENDING_APPROVAL' OR (NEW.status = 'APPROVED' AND NEW.is_automatic)) OR NEW.attempts <> 0 OR NEW.paid_at IS NOT NULL THEN
      RAISE EXCEPTION 'pay.refund %: a refund is written PENDING_APPROVAL, or APPROVED only when automatic', NEW.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED'))
              OR (OLD.status = 'APPROVED' AND NEW.status IN ('PROCESSING', 'PAID'))
              OR (OLD.status = 'PROCESSING' AND NEW.status IN ('PAID', 'FAILED'))
              OR (OLD.status = 'FAILED' AND NEW.status IN ('APPROVED', 'PAID'))) THEN
    RAISE EXCEPTION 'pay.refund %: % cannot move to %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  IF OLD.status IN ('PAID', 'REJECTED')
     OR (NEW.original_payment_id, NEW.amount_pesewas, NEW.destination, NEW.reason_code, NEW.note, NEW.credit_note_id, NEW.is_automatic, NEW.branch_id, NEW.created_by)
        IS DISTINCT FROM (OLD.original_payment_id, OLD.amount_pesewas, OLD.destination, OLD.reason_code, OLD.note, OLD.credit_note_id, OLD.is_automatic, OLD.branch_id, OLD.created_by)
     OR (OLD.approval_request_id IS NOT NULL AND NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id)
     OR (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference) THEN
    RAISE EXCEPTION 'pay.refund %: what was asked for, and a paid or rejected refund, never change', OLD.id USING ERRCODE = 'HK004', CONSTRAINT = 'ck_refund_transition';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION pay.refund_guard() FROM PUBLIC;
CREATE TRIGGER trg_refund_guard BEFORE INSERT OR UPDATE ON pay.refund
  FOR EACH ROW EXECUTE FUNCTION pay.refund_guard();

CREATE TABLE pay.reconciliation_break (
  id                 uuid PRIMARY KEY,
  branch_id          uuid NULL CONSTRAINT fk_reconciliation_break_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  kind               text NOT NULL CONSTRAINT ck_reconciliation_break_kind CHECK (kind IN (
                       'UNMATCHED_PAYMENT', 'UNVERIFIED_PAYMENT', 'PROVIDER_AMOUNT_DIFFERS', 'PROVIDER_REFERENCE_UNKNOWN',
                       'PROVIDER_PAYMENT_MISSING', 'SETTLEMENT_AMOUNT_DIFFERS', 'SETTLEMENT_NOT_FOUND', 'BANK_LINE_UNMATCHED',
                       'LEDGER_CASH_DIFFERS', 'REFUND_FAILED')),
  payment_id         uuid NULL CONSTRAINT fk_reconciliation_break_payment REFERENCES pay.payment (id) ON DELETE RESTRICT,
  refund_id          uuid NULL CONSTRAINT fk_reconciliation_break_refund REFERENCES pay.refund (id) ON DELETE RESTRICT,
  provider           text NULL CONSTRAINT ck_reconciliation_break_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  reference          text NULL CONSTRAINT ck_reconciliation_break_reference CHECK (length(reference) BETWEEN 1 AND 100),
  source_document_id uuid NULL CONSTRAINT fk_reconciliation_break_source REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  amount_pesewas     platform.pesewas NULL,
  details            jsonb NOT NULL,
  raised_at          timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'OPEN' CONSTRAINT ck_reconciliation_break_status CHECK (status IN ('OPEN', 'RESOLVED')),
  resolved_by        uuid NULL CONSTRAINT fk_reconciliation_break_resolved_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  resolved_at        timestamptz NULL,
  resolution_note    text NULL CONSTRAINT ck_reconciliation_break_note CHECK (length(btrim(resolution_note)) BETWEEN 1 AND 500),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL CONSTRAINT fk_reconciliation_break_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL CONSTRAINT fk_reconciliation_break_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_reconciliation_break_subject CHECK (payment_id IS NOT NULL OR refund_id IS NOT NULL OR reference IS NOT NULL OR source_document_id IS NOT NULL),
  CONSTRAINT ck_reconciliation_break_resolved CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution_note IS NULL))
);
COMMENT ON TABLE pay.reconciliation_break IS 'class=DOCUMENT';
CREATE UNIQUE INDEX uq_reconciliation_break_open_payment ON pay.reconciliation_break (payment_id, kind) WHERE status = 'OPEN' AND payment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_reconciliation_break_open_refund ON pay.reconciliation_break (refund_id, kind) WHERE status = 'OPEN' AND refund_id IS NOT NULL;
CREATE UNIQUE INDEX uq_reconciliation_break_open_reference ON pay.reconciliation_break (provider, reference, kind) WHERE status = 'OPEN' AND payment_id IS NULL AND refund_id IS NULL AND reference IS NOT NULL;
CREATE INDEX ix_reconciliation_break_open ON pay.reconciliation_break (raised_at) WHERE status = 'OPEN';
CREATE TRIGGER trg_reconciliation_break_version BEFORE UPDATE ON pay.reconciliation_break
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_reconciliation_break_freeze BEFORE UPDATE ON pay.reconciliation_break
  FOR EACH ROW WHEN (OLD.status = 'RESOLVED') EXECUTE FUNCTION platform.reject_change();

-- One row per run of the provider sweep: the window of the provider's transaction list it read. The next run starts
-- where the last one ended (the owner, 2026-11-16).
CREATE TABLE pay.provider_sweep (
  id               uuid PRIMARY KEY,
  provider         text NOT NULL CONSTRAINT ck_provider_sweep_provider CHECK (provider ~ '^[A-Z][A-Z_]{1,29}$'),
  window_from      timestamptz NOT NULL,
  window_to        timestamptz NOT NULL,
  transactions     integer NOT NULL CONSTRAINT ck_provider_sweep_transactions CHECK (transactions >= 0),
  cleared          integer NOT NULL CONSTRAINT ck_provider_sweep_cleared CHECK (cleared >= 0),
  breaks_raised    integer NOT NULL CONSTRAINT ck_provider_sweep_breaks CHECK (breaks_raised >= 0),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  actor_id         uuid NOT NULL CONSTRAINT fk_provider_sweep_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_provider_sweep_window CHECK (window_to > window_from)
);
COMMENT ON TABLE pay.provider_sweep IS 'class=LEDGER';
CREATE INDEX ix_provider_sweep_last ON pay.provider_sweep (provider, window_to DESC);
CREATE TRIGGER trg_provider_sweep_immutable BEFORE UPDATE OR DELETE ON pay.provider_sweep
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_provider_sweep_no_truncate BEFORE TRUNCATE ON pay.provider_sweep
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

REVOKE ALL ON pay.provider_transaction, pay.webhook_event, pay.refund, pay.reconciliation_break, pay.provider_sweep FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON pay.provider_transaction, pay.refund, pay.reconciliation_break TO hk_app, hk_worker;
GRANT SELECT, INSERT ON pay.webhook_event, pay.provider_sweep TO hk_app, hk_worker;

-- migrate:down
DROP TABLE pay.provider_sweep;
DROP TABLE pay.reconciliation_break;
DROP TABLE pay.refund;
DROP FUNCTION pay.refund_guard();
DROP FUNCTION pay.refund_cap();
DROP TABLE pay.webhook_event;
DROP TRIGGER trg_payment_provider_insert ON pay.payment;
DROP FUNCTION pay.payment_provider_insert();
DROP TRIGGER trg_payment_provider_confirmed ON pay.payment;
DROP FUNCTION pay.payment_provider_confirmed();
DROP TABLE pay.provider_transaction;
DROP FUNCTION pay.provider_transaction_guard();
ALTER TABLE pay.payment DROP COLUMN payer_phone_masked;
