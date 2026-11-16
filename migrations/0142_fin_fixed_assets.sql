-- 0142_fin_fixed_assets
-- B08 continued 1c2 (FR-FIN-014, FR-FIN-015, ADR-0003, ADR-0005, ADR-0059, A-199): the fixed asset register,
-- depreciation runs and disposal. The database holds:
--   ck_fixed_asset_figures       a residual no higher than the cost, accumulated depreciation no higher than cost less
--                                residual, months charged no more than the useful life
--   ck_fixed_asset_status        DISPOSED exactly with its date, document, proceeds, note and journal entry; otherwise
--                                FULLY_DEPRECIATED exactly when accumulated depreciation reaches cost less residual
--   ck_fixed_asset_change        an asset keeps its number, category, branch, acquisition date, cost and method; its
--                                accumulated depreciation and months charged move only when a run posts; it is never
--                                removed, and once disposed of it never changes; a disposal names its own entry
--   uq_depreciation_run_period   one depreciation run per accounting period, ever
--   ck_depreciation_run_maker_checker  the person who posts a run is not the person who calculated it
--   ck_depreciation_run_post     a run posts only with entries of its own, one per branch (uq_journal_entry_depreciation),
--                                whose 6500 debits equal its lines, which equal its total; each line is applied to its
--                                asset only from the month it was computed from (ck_depreciation_line_stale)
--   ck_depreciation_line_draft   a line is written only while its run is a draft; lines are never changed
-- Seeded: account 4920, the determinations ASSET_CATEGORY/ASSET (1510 to 1540) and ASSET_CATEGORY/ACCUMULATED_DEPRECIATION
-- (1590), and the events fin.DepreciationRun and fin.FixedAssetDisposed with their rules (ADR-0059).
-- Data category: CONFIDENTIAL (DC-15): the farm's books.
-- Rollback: tested (`pnpm db:rollback`), safe before the first asset; afterwards forward fix only (a posted run or
-- disposal is never removed).

-- migrate:up
INSERT INTO fin.account (id, code, name, type, normal_side, is_postable, subledger_kind, cash_flow_category, status, created_by, updated_by) VALUES
  ('01900000-0000-7000-8100-000000004920', '4920', 'Gain or loss on disposal of fixed assets', 'INCOME', 'C', true, NULL, 'INVESTING', 'ACTIVE',
   '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001');

ALTER TABLE fin.account_determination DROP CONSTRAINT ck_account_determination_role;
ALTER TABLE fin.account_determination ADD CONSTRAINT ck_account_determination_role
  CHECK (role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE', 'ASSET', 'ACCUMULATED_DEPRECIATION'));
ALTER TABLE fin.posting_rule_change DROP CONSTRAINT ck_posting_rule_change_role;
ALTER TABLE fin.posting_rule_change ADD CONSTRAINT ck_posting_rule_change_role
  CHECK (determinant_role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE', 'ASSET', 'ACCUMULATED_DEPRECIATION'));

INSERT INTO fin.account_determination (id, determinant_type, determinant_key, role, account_id, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8200-' || lpad(d.n::text, 12, '0'))::uuid, 'ASSET_CATEGORY', d.key, d.role, ('01900000-0000-7000-8100-00000000' || d.code)::uuid,
       DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (28, 'VEHICLE', 'ASSET', '1510'),
    (29, 'COLD_ROOM', 'ASSET', '1520'),
    (30, 'HOUSING', 'ASSET', '1530'),
    (31, 'EQUIPMENT', 'ASSET', '1540'),
    (32, 'VEHICLE', 'ACCUMULATED_DEPRECIATION', '1590'),
    (33, 'COLD_ROOM', 'ACCUMULATED_DEPRECIATION', '1590'),
    (34, 'HOUSING', 'ACCUMULATED_DEPRECIATION', '1590'),
    (35, 'EQUIPMENT', 'ACCUMULATED_DEPRECIATION', '1590')
  ) AS d (n, key, role, code);

INSERT INTO fin.posting_event_type (code, owner_module, description, amount_keys) VALUES
  ('fin.DepreciationRun', 'fin', 'A posted depreciation run: each asset''s charge for the months it covers', ARRAY['depreciation']),
  ('fin.FixedAssetDisposed', 'fin', 'A fixed asset disposed of: its cost and accumulated depreciation out, the proceeds in, the gain or loss',
   ARRAY['cost', 'accumulatedDepreciation', 'proceeds', 'gain', 'loss']);

INSERT INTO fin.posting_rule (id, event_code, amount_key, side, account_id, determinant_type, determinant_role, valid_from, created_by, updated_by)
SELECT ('01900000-0000-7000-8300-' || lpad(r.n::text, 12, '0'))::uuid, r.event, r.amount, r.side,
       CASE WHEN r.code IS NULL THEN NULL ELSE ('01900000-0000-7000-8100-00000000' || r.code)::uuid END, r.det_type, r.det_role,
       DATE '2020-01-01', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM (VALUES
    (63, 'fin.DepreciationRun', 'depreciation', 'D', '6500', NULL, NULL),
    (64, 'fin.DepreciationRun', 'depreciation', 'C', NULL, 'ASSET_CATEGORY', 'ACCUMULATED_DEPRECIATION'),
    (65, 'fin.FixedAssetDisposed', 'cost', 'C', NULL, 'ASSET_CATEGORY', 'ASSET'),
    (66, 'fin.FixedAssetDisposed', 'accumulatedDepreciation', 'D', NULL, 'ASSET_CATEGORY', 'ACCUMULATED_DEPRECIATION'),
    (67, 'fin.FixedAssetDisposed', 'proceeds', 'D', NULL, 'PAYMENT_METHOD_KIND', 'PAYOUT'),
    (68, 'fin.FixedAssetDisposed', 'gain', 'C', '4920', NULL, NULL),
    (69, 'fin.FixedAssetDisposed', 'loss', 'D', '4920', NULL, NULL)
  ) AS r (n, event, amount, side, code, det_type, det_role);

-- One entry per run and branch, and one per disposal (ADR-0059).
CREATE UNIQUE INDEX uq_journal_entry_depreciation ON fin.journal_entry (source_document_id, branch_id) WHERE event_code = 'fin.DepreciationRun';
CREATE UNIQUE INDEX uq_journal_entry_disposal ON fin.journal_entry (source_document_id) WHERE event_code = 'fin.FixedAssetDisposed';

CREATE SEQUENCE fin.fixed_asset_no_seq AS integer MINVALUE 1 NO CYCLE;

-- The fixed asset register (FR-FIN-014). Never removed; a disposal is recorded on the asset with its own entry.
CREATE TABLE fin.fixed_asset (
  id                        uuid PRIMARY KEY,
  asset_no                  text NOT NULL DEFAULT ('FA-' || lpad(nextval('fin.fixed_asset_no_seq')::text, 4, '0')) CONSTRAINT uq_fixed_asset_no UNIQUE,
  name                      text NOT NULL CONSTRAINT ck_fixed_asset_name CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category                  text NOT NULL CONSTRAINT ck_fixed_asset_category CHECK (category IN ('VEHICLE', 'COLD_ROOM', 'HOUSING', 'EQUIPMENT')),
  branch_id                 uuid NOT NULL CONSTRAINT fk_fixed_asset_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  acquired_on               date NOT NULL,
  cost_pesewas              platform.pesewas NOT NULL CONSTRAINT ck_fixed_asset_cost CHECK (cost_pesewas > 0),
  residual_pesewas          platform.pesewas NOT NULL DEFAULT 0,
  useful_life_months        integer NOT NULL CONSTRAINT ck_fixed_asset_life CHECK (useful_life_months BETWEEN 1 AND 600),
  method                    text NOT NULL DEFAULT 'STRAIGHT_LINE' CONSTRAINT ck_fixed_asset_method CHECK (method = 'STRAIGHT_LINE'),
  accumulated_pesewas       platform.pesewas NOT NULL DEFAULT 0,
  depreciated_months        integer NOT NULL DEFAULT 0 CONSTRAINT ck_fixed_asset_months CHECK (depreciated_months >= 0),
  status                    text NOT NULL DEFAULT 'IN_USE' CONSTRAINT ck_fixed_asset_status_value CHECK (status IN ('IN_USE', 'FULLY_DEPRECIATED', 'DISPOSED')),
  disposed_on               date NULL,
  disposal_document_id      uuid NULL CONSTRAINT uq_fixed_asset_disposal_document UNIQUE CONSTRAINT fk_fixed_asset_disposal_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  disposal_proceeds_pesewas platform.pesewas NULL,
  disposal_note             text NULL CONSTRAINT ck_fixed_asset_disposal_note CHECK (length(btrim(disposal_note)) BETWEEN 1 AND 300),
  disposal_journal_entry_id uuid NULL CONSTRAINT uq_fixed_asset_disposal_entry UNIQUE CONSTRAINT fk_fixed_asset_disposal_entry REFERENCES fin.journal_entry (id) ON DELETE RESTRICT,
  version                   integer NOT NULL DEFAULT 1,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL CONSTRAINT fk_fixed_asset_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL CONSTRAINT fk_fixed_asset_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  deleted_at                timestamptz NULL,
  deleted_by                uuid NULL CONSTRAINT fk_fixed_asset_deleted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  delete_reason             text NULL,
  CONSTRAINT ck_fixed_asset_never_deleted CHECK (deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL),
  CONSTRAINT ck_fixed_asset_figures CHECK (
    residual_pesewas <= cost_pesewas AND accumulated_pesewas <= cost_pesewas - residual_pesewas AND depreciated_months <= useful_life_months),
  CONSTRAINT ck_fixed_asset_status CHECK (
    (status = 'DISPOSED') = (disposed_on IS NOT NULL)
    AND (disposed_on IS NULL) = (disposal_document_id IS NULL)
    AND (disposed_on IS NULL) = (disposal_proceeds_pesewas IS NULL)
    AND (disposed_on IS NULL) = (disposal_note IS NULL)
    AND (disposed_on IS NULL) = (disposal_journal_entry_id IS NULL)
    AND (disposed_on IS NULL OR disposed_on >= acquired_on)
    AND (status = 'DISPOSED' OR (status = 'FULLY_DEPRECIATED') = (accumulated_pesewas = cost_pesewas - residual_pesewas)))
);
COMMENT ON TABLE fin.fixed_asset IS 'class=MASTER';
ALTER SEQUENCE fin.fixed_asset_no_seq OWNED BY fin.fixed_asset.asset_no;
CREATE INDEX ix_fixed_asset_list ON fin.fixed_asset (asset_no, id);
CREATE TRIGGER trg_fixed_asset_version BEFORE UPDATE ON fin.fixed_asset
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

-- What an asset keeps for good, and who may move its depreciation (ADR-0059). The status follows the figures.
CREATE FUNCTION fin.fixed_asset_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  entry record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.accumulated_pesewas <> 0 OR NEW.depreciated_months <> 0 OR NEW.status = 'DISPOSED' THEN
      PERFORM fin.refuse('ck_fixed_asset_change', format('fixed asset %s starts with no depreciation charged and in use', NEW.id));
    END IF;
  ELSE
    IF OLD.status = 'DISPOSED' THEN
      PERFORM fin.refuse('ck_fixed_asset_change', format('fixed asset %s was disposed of and never changes', OLD.id));
    END IF;
    IF (NEW.asset_no, NEW.category, NEW.branch_id, NEW.acquired_on, NEW.cost_pesewas, NEW.method)
       IS DISTINCT FROM (OLD.asset_no, OLD.category, OLD.branch_id, OLD.acquired_on, OLD.cost_pesewas, OLD.method) THEN
      PERFORM fin.refuse('ck_fixed_asset_change', format('fixed asset %s keeps its number, category, branch, acquisition date, cost and method', OLD.id));
    END IF;
    -- Only fin.depreciation_run_post(), the trigger that posts a run, moves the depreciation charged.
    IF (NEW.accumulated_pesewas, NEW.depreciated_months) IS DISTINCT FROM (OLD.accumulated_pesewas, OLD.depreciated_months) AND pg_trigger_depth() < 2 THEN
      PERFORM fin.refuse('ck_fixed_asset_change', format('the depreciation charged to fixed asset %s moves only when a run posts', OLD.id));
    END IF;
    IF NEW.status = 'DISPOSED' THEN
      SELECT e.source_document_id, e.event_code INTO entry FROM fin.journal_entry e WHERE e.id = NEW.disposal_journal_entry_id;
      IF NOT FOUND OR entry.source_document_id IS DISTINCT FROM NEW.disposal_document_id OR entry.event_code <> 'fin.FixedAssetDisposed' THEN
        PERFORM fin.refuse('ck_fixed_asset_change', format('fixed asset %s is disposed of only with the entry posted for its disposal', OLD.id));
      END IF;
    END IF;
  END IF;
  IF NEW.status <> 'DISPOSED' THEN
    NEW.status := CASE WHEN NEW.accumulated_pesewas = NEW.cost_pesewas - NEW.residual_pesewas THEN 'FULLY_DEPRECIATED' ELSE 'IN_USE' END;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.fixed_asset_guard() FROM PUBLIC;
CREATE TRIGGER trg_fixed_asset_guard BEFORE INSERT OR UPDATE ON fin.fixed_asset
  FOR EACH ROW EXECUTE FUNCTION fin.fixed_asset_guard();

-- A depreciation run: one per accounting period (FR-FIN-015). Calculated by one person, posted by another.
CREATE TABLE fin.depreciation_run (
  id               uuid PRIMARY KEY CONSTRAINT fk_depreciation_run_document REFERENCES platform.business_document (id) ON DELETE RESTRICT,
  period_id        uuid NOT NULL CONSTRAINT uq_depreciation_run_period UNIQUE CONSTRAINT fk_depreciation_run_period REFERENCES fin.accounting_period (id) ON DELETE RESTRICT,
  branch_id        uuid NOT NULL CONSTRAINT fk_depreciation_run_branch REFERENCES mdm.branch (id) ON DELETE RESTRICT,
  status           text NOT NULL CONSTRAINT ck_depreciation_run_status CHECK (status IN ('DRAFT', 'POSTED')),
  total_pesewas    platform.pesewas NOT NULL CONSTRAINT ck_depreciation_run_total_positive CHECK (total_pesewas > 0),
  currency         char(3) NOT NULL DEFAULT 'GHS' CONSTRAINT ck_depreciation_run_currency CHECK (currency = 'GHS'),
  journal_entry_id uuid NULL CONSTRAINT uq_depreciation_run_entry UNIQUE CONSTRAINT fk_depreciation_run_entry REFERENCES fin.journal_entry (id) ON DELETE RESTRICT,
  posted_at        timestamptz NULL,
  posted_by        uuid NULL CONSTRAINT fk_depreciation_run_posted_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL CONSTRAINT fk_depreciation_run_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL CONSTRAINT fk_depreciation_run_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT ck_depreciation_run_posted CHECK (
    (status = 'POSTED') = (journal_entry_id IS NOT NULL) AND (status = 'POSTED') = (posted_at IS NOT NULL) AND (posted_at IS NULL) = (posted_by IS NULL)),
  CONSTRAINT ck_depreciation_run_maker_checker CHECK (posted_by IS NULL OR posted_by <> created_by)
);
COMMENT ON TABLE fin.depreciation_run IS 'class=DOCUMENT';
CREATE INDEX ix_depreciation_run_list ON fin.depreciation_run (id);
CREATE TRIGGER trg_depreciation_run_version BEFORE UPDATE ON fin.depreciation_run
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
CREATE TRIGGER trg_depreciation_run_freeze BEFORE UPDATE ON fin.depreciation_run
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('POSTED');
CREATE TRIGGER trg_depreciation_run_freeze_draft BEFORE UPDATE ON fin.depreciation_run
  FOR EACH ROW EXECUTE FUNCTION platform.freeze_posted('DRAFT', 'status', 'journal_entry_id', 'posted_at', 'posted_by', 'updated_at', 'updated_by', 'version');

-- Depreciation charged to one asset in one run: the months it covers, from the first month not yet charged. Insert only.
CREATE TABLE fin.depreciation_line (
  depreciation_run_id uuid NOT NULL CONSTRAINT fk_depreciation_line_run REFERENCES fin.depreciation_run (id) ON DELETE RESTRICT,
  fixed_asset_id      uuid NOT NULL CONSTRAINT fk_depreciation_line_asset REFERENCES fin.fixed_asset (id) ON DELETE RESTRICT,
  from_month          integer NOT NULL CONSTRAINT ck_depreciation_line_from CHECK (from_month >= 0),
  months              integer NOT NULL CONSTRAINT ck_depreciation_line_months CHECK (months > 0),
  amount_pesewas      platform.pesewas NOT NULL CONSTRAINT ck_depreciation_line_amount CHECK (amount_pesewas > 0),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  actor_id            uuid NOT NULL CONSTRAINT fk_depreciation_line_actor REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT pk_depreciation_line PRIMARY KEY (depreciation_run_id, fixed_asset_id)
);
COMMENT ON TABLE fin.depreciation_line IS 'class=LEDGER';
CREATE INDEX ix_depreciation_line_asset ON fin.depreciation_line (fixed_asset_id);
CREATE TRIGGER trg_depreciation_line_immutable BEFORE UPDATE OR DELETE ON fin.depreciation_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_depreciation_line_no_truncate BEFORE TRUNCATE ON fin.depreciation_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();

CREATE FUNCTION fin.depreciation_line_guard() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fin.depreciation_run r WHERE r.id = NEW.depreciation_run_id AND r.status = 'DRAFT') THEN
    PERFORM fin.refuse('ck_depreciation_line_draft', format('depreciation run %s is not a draft, so it takes no line', NEW.depreciation_run_id));
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.depreciation_line_guard() FROM PUBLIC;
CREATE TRIGGER trg_depreciation_line_guard BEFORE INSERT ON fin.depreciation_line
  FOR EACH ROW EXECUTE FUNCTION fin.depreciation_line_guard();

-- Posting a run (ADR-0059): only with its own entries, which carry exactly its lines, and each line applied to its
-- asset from the month it was computed from, so a stale run cannot post and no month is charged twice.
CREATE FUNCTION fin.depreciation_run_post() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
DECLARE
  line record;
  lines_total numeric;
  entries_total numeric;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'DRAFT' OR NEW.status <> 'POSTED' THEN
    PERFORM fin.refuse('ck_depreciation_run_post', format('depreciation run %s moves only from DRAFT to POSTED', OLD.id));
  END IF;
  IF NEW.posted_by IS NOT DISTINCT FROM NEW.created_by THEN
    PERFORM fin.refuse('ck_depreciation_run_maker_checker', format('depreciation run %s is posted by someone other than the person who calculated it', OLD.id));
  END IF;
  SELECT COALESCE(sum(l.amount_pesewas), 0) INTO lines_total FROM fin.depreciation_line l WHERE l.depreciation_run_id = NEW.id;
  SELECT COALESCE(sum(jl.amount_pesewas), 0) INTO entries_total
    FROM fin.journal_entry e JOIN fin.journal_line jl ON jl.journal_entry_id = e.id JOIN fin.account a ON a.id = jl.account_id
   WHERE e.source_document_id = NEW.id AND e.event_code = 'fin.DepreciationRun' AND jl.side = 'D' AND a.code = '6500';
  IF lines_total <> NEW.total_pesewas OR entries_total <> NEW.total_pesewas
     OR NOT EXISTS (SELECT 1 FROM fin.journal_entry e WHERE e.id = NEW.journal_entry_id AND e.source_document_id = NEW.id AND e.event_code = 'fin.DepreciationRun') THEN
    PERFORM fin.refuse('ck_depreciation_run_post', format('depreciation run %s posts only with its own entries carrying exactly its lines (%s, %s, %s)', NEW.id, NEW.total_pesewas, lines_total, entries_total));
  END IF;
  FOR line IN SELECT l.fixed_asset_id, l.from_month, l.months, l.amount_pesewas FROM fin.depreciation_line l WHERE l.depreciation_run_id = NEW.id ORDER BY l.fixed_asset_id LOOP
    UPDATE fin.fixed_asset a
       SET accumulated_pesewas = a.accumulated_pesewas + line.amount_pesewas, depreciated_months = a.depreciated_months + line.months,
           version = a.version + 1, updated_by = NEW.posted_by
     WHERE a.id = line.fixed_asset_id AND a.depreciated_months = line.from_month AND a.status <> 'DISPOSED';
    IF NOT FOUND THEN
      PERFORM fin.refuse('ck_depreciation_line_stale', format('fixed asset %s has changed since depreciation run %s was calculated', line.fixed_asset_id, NEW.id));
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fin.depreciation_run_post() FROM PUBLIC;
CREATE TRIGGER trg_depreciation_run_post BEFORE UPDATE ON fin.depreciation_run
  FOR EACH ROW EXECUTE FUNCTION fin.depreciation_run_post();

REVOKE ALL ON fin.fixed_asset, fin.depreciation_run, fin.depreciation_line FROM PUBLIC;
REVOKE ALL ON SEQUENCE fin.fixed_asset_no_seq FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON fin.fixed_asset, fin.depreciation_run TO hk_app, hk_worker;
GRANT SELECT, INSERT ON fin.depreciation_line TO hk_app, hk_worker;
GRANT USAGE ON SEQUENCE fin.fixed_asset_no_seq TO hk_app, hk_worker;

-- migrate:down
DROP TABLE fin.depreciation_line;
DROP FUNCTION fin.depreciation_line_guard();
DROP TABLE fin.depreciation_run;
DROP FUNCTION fin.depreciation_run_post();
DROP TABLE fin.fixed_asset;
DROP FUNCTION fin.fixed_asset_guard();
DROP INDEX fin.uq_journal_entry_disposal;
DROP INDEX fin.uq_journal_entry_depreciation;
DELETE FROM fin.posting_rule WHERE event_code IN ('fin.DepreciationRun', 'fin.FixedAssetDisposed');
DELETE FROM fin.posting_event_type WHERE code IN ('fin.DepreciationRun', 'fin.FixedAssetDisposed');
DELETE FROM fin.account_determination WHERE determinant_type = 'ASSET_CATEGORY' AND role IN ('ASSET', 'ACCUMULATED_DEPRECIATION');
ALTER TABLE fin.posting_rule_change DROP CONSTRAINT ck_posting_rule_change_role;
ALTER TABLE fin.posting_rule_change ADD CONSTRAINT ck_posting_rule_change_role
  CHECK (determinant_role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE'));
ALTER TABLE fin.account_determination DROP CONSTRAINT ck_account_determination_role;
ALTER TABLE fin.account_determination ADD CONSTRAINT ck_account_determination_role
  CHECK (role IN ('INVENTORY', 'SALES', 'COST_OF_SALES', 'TENDER', 'PAYOUT', 'OUTPUT', 'INPUT', 'LOSS', 'EXPENSE'));
DELETE FROM fin.account WHERE code = '4920';
