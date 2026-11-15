-- 0085_prc_packs
-- Packs and their labels (docs/data-model/prc.md, FR-PRC-009, FR-PRC-010; A-161): a pack is a weighed piece of a
-- processing output's lot, with its own weight and weight source, and a barcode whose payload is the lot and the weight
-- in grams (`<lot>/<grams, six digits>`). Packs are made once per output, after its order is completed, and their weights
-- sum exactly to the output's weight.
--
-- The database holds the rules itself, whoever writes:
--   prc.pack_guard        a pack is made IN_STOCK for a saleable output of a COMPLETED order, in that output's lot, with
--                         a barcode that ends in its weight in grams (the lot before it is the application's,
--                         from INV); its lot, output, number, weight, source and barcode never
--                         change; its label's first print time is set once; its status moves IN_STOCK <-> PICKED, and to
--                         SOLD, WRITTEN_OFF or REVERSED, which are final (HK004)
--   ck_pack_weights       deferred to commit: an output's packs weigh exactly its weight (HK010)
-- The barcode is not unique: two packs of one lot that weigh the same carry the same payload and are interchangeable
-- (A-161; FR-PRC-010's own example packs a lot as 15.000, 15.000 and 14.600). hk_app holds no DELETE (a MASTER table that
-- is never removed: a reversed order marks its packs REVERSED).
-- Data category: INTERNAL (DC-13).
-- Rollback: tested (`pnpm db:rollback`), safe before the first pack; afterwards forward fix only.

-- migrate:up
CREATE TABLE prc.pack (
  id                   uuid PRIMARY KEY,
  stock_unit_id        uuid NOT NULL CONSTRAINT fk_pack_stock_unit REFERENCES inv.stock_unit (id) ON DELETE RESTRICT,
  processing_output_id uuid NOT NULL CONSTRAINT fk_pack_output REFERENCES prc.processing_output (id) ON DELETE RESTRICT,
  pack_no              integer NOT NULL CONSTRAINT ck_pack_no CHECK (pack_no > 0),
  weight_kg            platform.kg NOT NULL CONSTRAINT ck_pack_weight CHECK (weight_kg > 0 AND weight_kg < 1000),
  weight_source        text NOT NULL CONSTRAINT ck_pack_weight_source CHECK (weight_source IN ('SCALE', 'MANUAL', 'ESTIMATE')),
  barcode              text NOT NULL CONSTRAINT ck_pack_barcode CHECK (barcode ~ '^[^/]+/[0-9]{6}$'),
  label_printed_at     timestamptz NULL,
  status               text NOT NULL DEFAULT 'IN_STOCK' CONSTRAINT ck_pack_status CHECK (status IN ('IN_STOCK', 'PICKED', 'SOLD', 'WRITTEN_OFF', 'REVERSED')),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL CONSTRAINT fk_pack_created_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL CONSTRAINT fk_pack_updated_by REFERENCES iam.principal (id) ON DELETE RESTRICT,
  CONSTRAINT uq_pack_unit_no UNIQUE (stock_unit_id, pack_no)
);
COMMENT ON TABLE prc.pack IS 'class=MASTER';
CREATE INDEX ix_pack_output ON prc.pack (processing_output_id, pack_no);
CREATE INDEX ix_pack_barcode ON prc.pack (barcode) WHERE status IN ('IN_STOCK', 'PICKED');
CREATE TRIGGER trg_pack_version BEFORE UPDATE ON prc.pack
  FOR EACH ROW EXECUTE FUNCTION platform.touch_version();

CREATE FUNCTION prc.pack_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  output_row prc.processing_output;
  order_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO output_row FROM prc.processing_output p WHERE p.id = NEW.processing_output_id;
    SELECT o.status INTO order_status FROM prc.processing_order o WHERE o.id = output_row.processing_order_id;
    IF NEW.status <> 'IN_STOCK' OR NEW.label_printed_at IS NOT NULL THEN
      RAISE EXCEPTION 'prc.pack %: a pack is made IN_STOCK and unprinted', NEW.id USING ERRCODE = 'HK004';
    END IF;
    IF order_status IS DISTINCT FROM 'COMPLETED' OR output_row.output_kind = 'WASTE' OR output_row.stock_unit_id IS DISTINCT FROM NEW.stock_unit_id THEN
      RAISE EXCEPTION 'prc.pack %: a pack is a piece of a saleable output''s lot, after its order is completed', NEW.id USING ERRCODE = 'HK004';
    END IF;
    IF split_part(NEW.barcode, '/', 2) <> lpad((NEW.weight_kg * 1000)::bigint::text, 6, '0') THEN
      RAISE EXCEPTION 'prc.pack %: the barcode carries the pack''s weight in grams', NEW.id USING ERRCODE = 'HK004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stock_unit_id <> OLD.stock_unit_id OR NEW.processing_output_id <> OLD.processing_output_id OR NEW.pack_no <> OLD.pack_no
     OR NEW.weight_kg <> OLD.weight_kg OR NEW.weight_source <> OLD.weight_source OR NEW.barcode <> OLD.barcode
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
     OR (OLD.label_printed_at IS NOT NULL AND NEW.label_printed_at IS DISTINCT FROM OLD.label_printed_at) THEN
    RAISE EXCEPTION 'prc.pack %: lot, output, number, weight, source, barcode and first print never change', OLD.id USING ERRCODE = 'HK004';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'IN_STOCK' AND NEW.status IN ('PICKED', 'SOLD', 'WRITTEN_OFF', 'REVERSED'))
    OR (OLD.status = 'PICKED' AND NEW.status IN ('IN_STOCK', 'SOLD', 'WRITTEN_OFF', 'REVERSED'))) THEN
    RAISE EXCEPTION 'prc.pack %: % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = 'HK004';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION prc.pack_guard() FROM PUBLIC;
CREATE TRIGGER trg_pack_guard BEFORE INSERT OR UPDATE ON prc.pack
  FOR EACH ROW EXECUTE FUNCTION prc.pack_guard();

-- FR-PRC-009 in the database: at commit, an output's packs weigh exactly what the output weighs.
CREATE FUNCTION prc.pack_weights() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
DECLARE
  packed numeric;
  output_weight numeric;
BEGIN
  SELECT p.weight_kg INTO output_weight FROM prc.processing_output p WHERE p.id = NEW.processing_output_id;
  SELECT sum(k.weight_kg) INTO packed FROM prc.pack k WHERE k.processing_output_id = NEW.processing_output_id;
  IF packed <> output_weight THEN
    RAISE EXCEPTION 'prc.processing_output %: its packs weigh % kg, not its % kg', NEW.processing_output_id, packed, output_weight
      USING ERRCODE = 'HK010', CONSTRAINT = 'ck_pack_weights';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION prc.pack_weights() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER trg_pack_weights AFTER INSERT ON prc.pack
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION prc.pack_weights();

REVOKE ALL ON prc.pack FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON prc.pack TO hk_app, hk_worker;

-- migrate:down
DROP TABLE prc.pack;
DROP FUNCTION prc.pack_weights();
DROP FUNCTION prc.pack_guard();
