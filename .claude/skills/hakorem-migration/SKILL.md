---
name: hakorem-migration
description: "Use when writing, editing, reviewing, rolling back or running a database migration or any DDL: CREATE TABLE, ALTER TABLE, new column, constraint, check, exclusion constraint, index, trigger, trigger function, `SECURITY DEFINER` function, grant or revoke, PostgreSQL domain, seeding a lookup table such as permissions, movement types or reason codes, a Drizzle table definition that must match SQL, a table class (LEDGER, DOCUMENT, MASTER, PROJECTION, LOOKUP, WORK), `pnpm db:migrate` or `pnpm db:rollback`, or checking a migration against `docs/data-model/<schema>.md`. Creating the folders of a module is hakorem-module; a change to a published contract shape is hakorem-endpoint; a release gate on migrations is hakorem-release."
---

# Migrations: plain SQL, reviewed like code

Decisions: `docs/adr/0012-table-classes.md`, `docs/adr/0024-database-roles-and-privileges.md`, `docs/adr/0011-cross-module-foreign-keys-and-document-registry.md`, `docs/adr/0013-uuidv7-identifiers.md`, `docs/adr/0001-money-representation-and-rounding.md`, `docs/adr/0008-module-structure-and-boundary-enforcement.md`. Conventions and the catalogue of database-enforced rules: `docs/DATA_MODEL.md`. The target shape of each table is `docs/data-model/<schema>.md`; if a migration and its dictionary disagree, the migration is wrong. Deployment procedure: `docs/DEPLOYMENT.md`.

## Checklist

1. **Plain SQL, one schema per file.** The file touches one schema only (the module's own, or `platform`). Triggers, constraints and grants belong in the migration that creates the table.
2. **Declare the class.** Every table has one of `LEDGER`, `DOCUMENT`, `MASTER`, `PROJECTION`, `LOOKUP`, `WORK`, stored as a comment on the table. The schema test compares the grants of `hk_app` with the class and fails if they differ.
3. **Grants follow the class** (ADR-0024). `LEDGER`: insert and select, plus triggers rejecting `UPDATE`, `DELETE`, `TRUNCATE` for every role. `DOCUMENT` and `MASTER`: insert, select, update; no delete. `PROJECTION` and `LOOKUP`: select only (projections written by a `SECURITY DEFINER` trigger function owned by `hk_owner` with a fixed `search_path`, or by `hk_worker`). `WORK`: insert, select, update, delete. `PUBLIC` has nothing. No DDL for `hk_app` in any environment.
4. **Standard columns by class.** `LEDGER`: `recorded_at`, `actor_id` (add `occurred_at` when business time differs). `DOCUMENT`: `status`, `branch_id`, `version`, `created_*`, `updated_*`, `posted_*` where there is a posting step, plus a trigger that freezes the row once posted except the listed columns. Use the shared trigger functions rather than writing new ones: `platform.reject_change()` (every `LEDGER` table: `BEFORE UPDATE OR DELETE` per row and `BEFORE TRUNCATE`), `platform.freeze_posted()` (documents; allowed columns are trigger arguments) and `platform.touch_version()` (optimistic locking). `MASTER`: `version`, audit columns, `deleted_at/by/reason` with the all-null-or-all-set check, uniqueness through partial indexes `WHERE deleted_at IS NULL`.
5. **Types.** UUIDv7 `uuid` primary keys unless a natural key is declared (`gen_random_uuid()` only for trigger-created rows). Money in `platform.pesewas` columns named `*_pesewas`; `platform.qty`, `platform.kg`, `platform.percent` for the rest. `TIMESTAMPTZ`, never `TIMESTAMP`. Enumerations are `TEXT` plus `CHECK`, not PostgreSQL enums. `jsonb` for snapshots only, never for a value that is filtered or summed. No `VARCHAR(n)`.
6. **Names.** `snake_case`, singular; indexes `ix_*`, unique `uq_*`, checks `ck_*`, foreign keys `fk_*`, exclusion `ex_*`.
7. **Foreign keys everywhere, no orphans.** Cross-schema foreign keys only to the published keys in `docs/MODULE_BOUNDARIES.md` section 5 (plus the universal `iam.principal`, `mdm.branch`, `mdm.location`), from a higher layer to a lower one, to the primary key, `ON DELETE RESTRICT`, declared in SQL and not as Drizzle relations. "Caused by this document" is `source_document_id` to `platform.business_document`.
8. **Rules in the database.** Balanced journals, gap-free numbers, stock sign, serial uniqueness, maker not equal to checker (`CHECK (decided_by <> requested_by)`), unique idempotency keys and webhook event ids, sign and precision checks on every amount, weight and quantity.
9. **Expand then contract.** Backward compatible for one release: the previous API version must still run against the new schema. Add nullable or defaulted columns first; backfill in a separate step; make `NOT NULL` or drop the old column in a later release. A column that references a table built in a later session is added by an expand migration in that session (`docs/DATA_MODEL.md`, Migrations).
10. **Every migration has a tested rollback or a documented forward fix** recorded in its header. `pnpm db:rollback` must work on it in CI, or the header states why only a forward fix is safe and what it is. Never rewrite history on a ledger table to "roll back"; reverse with new rows.
11. **Lookup seeds are migrations.** Permissions, movement types, reason codes, posting event types and document types change only by migration. A new permission is granted to no role until another migration adds it.
12. **Performance on money paths.** Index the point reads that posting transactions use. Posting transactions must not rely on sequential scans (predicate locks under serializable, ADR-0005).
13. **Run it on staging first.** No migration reaches production before it has run on staging; production migrations wait for manual approval and run as `hk_migrator` in a one-shot container.
14. **No data or secrets in migrations** beyond lookup rows. No production data, ever.

## Correct and incorrect

```sql
-- RIGHT: LEDGER table with class comment, domain types, immutability trigger, grants by class
CREATE TABLE inv.stock_exception (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),     -- trigger-created rows only
  kind         text NOT NULL CONSTRAINT ck_stock_exception_kind CHECK (kind IN ('NEGATIVE_STOCK','BALANCE_DRIFT','SERIAL_CONFLICT')),
  product_id   uuid NOT NULL CONSTRAINT fk_stock_exception_product REFERENCES mdm.product (id) ON DELETE RESTRICT,
  value_pesewas platform.pesewas,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid NOT NULL CONSTRAINT fk_stock_exception_actor REFERENCES iam.principal (id) ON DELETE RESTRICT
);
COMMENT ON TABLE inv.stock_exception IS 'class=LEDGER';
CREATE TRIGGER trg_stock_exception_immutable BEFORE UPDATE OR DELETE ON inv.stock_exception
  FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
CREATE TRIGGER trg_stock_exception_no_truncate BEFORE TRUNCATE ON inv.stock_exception
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
REVOKE ALL ON inv.stock_exception FROM PUBLIC;
GRANT SELECT, INSERT ON inv.stock_exception TO hk_app, hk_worker;
-- Rollback: DROP TABLE inv.stock_exception (safe only before the first row; afterwards forward fix only)
```

```sql
-- WRONG: float money, TIMESTAMP, a native enum, no class, no FK, everything granted
CREATE TABLE inv.stock_exception (
  id serial PRIMARY KEY,
  kind exception_kind,
  value numeric(14,2),
  created timestamp,
  product_id uuid
);
GRANT ALL ON inv.stock_exception TO hk_app;
```

Expand then contract, across two releases:

```sql
-- release N (expand): old API unaffected
ALTER TABLE ord.sales_order ADD COLUMN delivery_id uuid NULL;
-- release N+1 (contract), only after no running version reads the old shape
ALTER TABLE ord.sales_order ADD CONSTRAINT fk_sales_order_delivery
  FOREIGN KEY (delivery_id) REFERENCES del.delivery (id) ON DELETE RESTRICT;
-- WRONG in one release: ALTER TABLE ... DROP COLUMN legacy_ref;  -- the previous API still selects it
```

## Test expectations

Integration against real PostgreSQL in Testcontainers: for every `LEDGER` table, update and delete are rejected; for every `DOCUMENT` table, a posted row cannot be altered outside its allowed columns; the grants schema test; the cross-schema foreign key allow-list check; each constraint and trigger the migration adds has a test that violates it and expects the database to refuse. Use hakorem-tests.
