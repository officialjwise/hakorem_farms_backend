-- 0263_whl_ageing_dunning
-- B10 continued 2 (FR-WHL-009, FR-WHL-010, FR-WHL-011, ADR-0089, A-317, A-318): the statement's ageing summary, the
-- dunning policy and the reminders queued from it. Ageing itself is read live (BIL's documents, PAY's allocations,
-- FIN's 1200), so whl.ageing_snapshot is not built.
--   whl.statement           gains the ageing summary as at its period end, set when it is written and frozen with the
--                           rest of it by whl.statement_guard (which compares every column but the archive's): five
--                           buckets and what the statement's 1200 balance holds that no open item explains, owed or
--                           in the customer's favour. Null together on a statement written before this migration
--                           (ck_statement_ageing_set); when set, dated the period end and tied exactly to the closing
--                           balance: the buckets plus not aged less not aged credit equal closing less closing credit
--                           (ck_statement_ageing_ties).
--   whl.dunning_policy      MASTER: the reminder levels, numbered from 1, each firing at its days overdue (1 to 365)
--                           through its channels in order of preference with its NTF template. One live row per level
--                           (uq_dunning_policy_level); a replacement soft-deletes the live rows and writes new ones.
--   whl.dunning_notice      LEDGER, insert-only: a level reaching an invoice or debit note, with what was outstanding,
--                           the channels and template queued to NTF through the outbox (whl.DunningNoticeDue). Each level
--                           reaches a document at most once (uq_dunning_notice_level), and never after a level as high or
--                           higher has (whl.dunning_notice_check, HK010 ck_dunning_notice_order, under the document's
--                           advisory lock), however often the job runs.
-- Additions to docs/data-model/whl.md: the columns and tables above, as built.
-- Data category: CONFIDENTIAL (DC-11: what a customer owes).
-- Rollback: tested (`pnpm db:rollback`), safe before the first notice; afterwards forward fix only (a notice is a
-- record of a reminder sent).

-- migrate:up
ALTER TABLE whl.statement
  ADD COLUMN ageing_as_of                   date NULL,
  ADD COLUMN ageing_current_pesewas         platform.pesewas NULL,
  ADD COLUMN ageing_1_30_pesewas            platform.pesewas NULL,
  ADD COLUMN ageing_31_60_pesewas           platform.pesewas NULL,
  ADD COLUMN ageing_61_90_pesewas           platform.pesewas NULL,
  ADD COLUMN ageing_over_90_pesewas         platform.pesewas NULL,
  ADD COLUMN ageing_not_aged_pesewas        platform.pesewas NULL,
  ADD COLUMN ageing_not_aged_credit_pesewas platform.pesewas NULL;
ALTER TABLE whl.statement
  ADD CONSTRAINT ck_statement_ageing_set CHECK (
    num_nulls(ageing_as_of, ageing_current_pesewas, ageing_1_30_pesewas, ageing_31_60_pesewas, ageing_61_90_pesewas,
              ageing_over_90_pesewas, ageing_not_aged_pesewas, ageing_not_aged_credit_pesewas) IN (0, 8)),
  ADD CONSTRAINT ck_statement_ageing_ties CHECK (
    ageing_as_of IS NULL OR (
      ageing_as_of = period_end
      AND (ageing_not_aged_pesewas = 0 OR ageing_not_aged_credit_pesewas = 0)
      AND ageing_current_pesewas::numeric + ageing_1_30_pesewas + ageing_31_60_pesewas + ageing_61_90_pesewas + ageing_over_90_pesewas
          + ageing_not_aged_pesewas - ageing_not_aged_credit_pesewas
        = closing_pesewas::numeric - closing_credit_pesewas));

CREATE TABLE whl.dunning_policy (
  id            uuid PRIMARY KEY,
  level         integer NOT NULL CONSTRAINT ck_dunning_policy_level CHECK (level BETWEEN 1 AND 10),
  days_overdue  integer NOT NULL CONSTRAINT ck_dunning_policy_days CHECK (days_overdue BETWEEN 1 AND 365),
  channels      text[] NOT NULL CONSTRAINT ck_dunning_policy_channels CHECK (
                  cardinality(channels) BETWEEN 1 AND 3 AND channels <@ ARRAY['SMS', 'EMAIL', 'WHATSAPP']::text[]
                  AND array_position(channels, NULL) IS NULL),
  template_code text NOT NULL CONSTRAINT ck_dunning_policy_template CHECK (template_code ~ '^[A-Z][A-Z0-9_]{1,59}$'),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL,
  created_by    uuid NOT NULL CONSTRAINT fk_dunning_policy_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at    timestamptz NOT NULL,
  updated_by    uuid NOT NULL CONSTRAINT fk_dunning_policy_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at    timestamptz NULL,
  deleted_by    uuid NULL CONSTRAINT fk_dunning_policy_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason text NULL,
  CONSTRAINT ck_dunning_policy_deleted CHECK ((deleted_at IS NULL) = (deleted_by IS NULL) AND (deleted_at IS NULL) = (delete_reason IS NULL))
);
COMMENT ON TABLE whl.dunning_policy IS 'class=MASTER';
CREATE UNIQUE INDEX uq_dunning_policy_level ON whl.dunning_policy (level) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_dunning_policy_version BEFORE UPDATE ON whl.dunning_policy FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE TABLE whl.dunning_notice (
  id                  uuid PRIMARY KEY,
  customer_id         uuid NOT NULL CONSTRAINT fk_dunning_notice_customer REFERENCES mdm.customer (id) ON DELETE RESTRICT,
  billing_document_id uuid NOT NULL CONSTRAINT fk_dunning_notice_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  branch_id           uuid NOT NULL CONSTRAINT fk_dunning_notice_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  level               integer NOT NULL CONSTRAINT ck_dunning_notice_level CHECK (level BETWEEN 1 AND 10),
  days_past_due       integer NOT NULL CONSTRAINT ck_dunning_notice_days CHECK (days_past_due > 0),
  outstanding_pesewas platform.pesewas NOT NULL CONSTRAINT ck_dunning_notice_outstanding CHECK (outstanding_pesewas > 0),
  channels            text[] NOT NULL CONSTRAINT ck_dunning_notice_channels CHECK (cardinality(channels) BETWEEN 1 AND 3 AND channels <@ ARRAY['SMS', 'EMAIL', 'WHATSAPP']::text[]),
  template_code       text NOT NULL,
  notice_date         date NOT NULL,
  queued_at           timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_dunning_notice_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_dunning_notice_level UNIQUE (billing_document_id, level)
);
COMMENT ON TABLE whl.dunning_notice IS 'class=LEDGER';
CREATE INDEX ix_dunning_notice_customer ON whl.dunning_notice (customer_id, queued_at);
CREATE INDEX ix_dunning_notice_branch ON whl.dunning_notice (branch_id, id);
CREATE TRIGGER trg_dunning_notice_immutable BEFORE UPDATE OR DELETE ON whl.dunning_notice FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_dunning_notice_no_truncate BEFORE TRUNCATE ON whl.dunning_notice FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

-- A level never reaches a document that a level as high or higher has reached: under the document's advisory lock,
-- so two runs at once cannot both pass the check.
CREATE FUNCTION whl.dunning_notice_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('whl.dunning_notice:' || NEW.billing_document_id::text, 0));
  IF EXISTS (SELECT 1 FROM whl.dunning_notice n WHERE n.billing_document_id = NEW.billing_document_id AND n.level >= NEW.level) THEN
    RAISE EXCEPTION 'whl.dunning_notice: level % has already been passed for document %', NEW.level, NEW.billing_document_id
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_dunning_notice_order';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION whl.dunning_notice_check() FROM PUBLIC;
CREATE TRIGGER trg_dunning_notice_check BEFORE INSERT ON whl.dunning_notice FOR EACH ROW EXECUTE FUNCTION whl.dunning_notice_check();

REVOKE ALL ON whl.dunning_policy, whl.dunning_notice FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON whl.dunning_policy TO hk_app, hk_worker;
GRANT SELECT, INSERT ON whl.dunning_notice TO hk_app, hk_worker;

-- migrate:down
DROP TABLE whl.dunning_notice;
DROP FUNCTION whl.dunning_notice_check();
DROP TABLE whl.dunning_policy;
ALTER TABLE whl.statement DROP CONSTRAINT ck_statement_ageing_ties, DROP CONSTRAINT ck_statement_ageing_set;
ALTER TABLE whl.statement
  DROP COLUMN ageing_as_of, DROP COLUMN ageing_current_pesewas, DROP COLUMN ageing_1_30_pesewas, DROP COLUMN ageing_31_60_pesewas,
  DROP COLUMN ageing_61_90_pesewas, DROP COLUMN ageing_over_90_pesewas, DROP COLUMN ageing_not_aged_pesewas, DROP COLUMN ageing_not_aged_credit_pesewas;
