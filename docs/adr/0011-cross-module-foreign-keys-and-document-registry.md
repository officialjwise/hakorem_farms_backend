# ADR-0011: Cross-module foreign keys reference published root ids only, and source documents use a registry

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief says two things that pull against each other. Modules never reach into each other's tables. And foreign keys are declared everywhere, with no orphan rows permitted. A stock movement needs to point at the sale, the goods receipt or the processing order that caused it, and those live in other modules, some of them in higher layers.

## Options considered

1. **No foreign keys across modules.** Clean boundaries, but orphan rows become possible, which the brief forbids.
2. **Foreign keys freely across modules.** Integrity holds, but any table becomes a dependency and extraction turns into a rewrite.
3. **Foreign keys across modules, restricted to a published allow-list of root keys, plus a registry for document references.** Integrity holds, the coupling is small and listed, and no module references a table in a higher layer.

## Decision

Option 3. A foreign key is a database integrity rule. The module boundary is a code ownership rule. Both hold.

**Cross-schema foreign keys**

- Allowed only to tables on the published-key allow-list in `docs/MODULE_BOUNDARIES.md`. These are aggregate roots whose identity other modules legitimately hold: for example `iam.principal`, `mdm.product`, `mdm.customer`, `mdm.supplier`, `mdm.branch`, `mdm.location`, `inv.stock_unit`, `bil.billing_document`, `platform.business_document`, `platform.stored_file`.
- Always to the primary key, always `ON DELETE RESTRICT`, and only from a higher layer to a lower one.
- Three keys are universal and may be referenced from any schema, including a lower layer: `iam.principal` (who), `mdm.branch` and `mdm.location` (where). Actor and place appear on almost every row in the system, including platform tables such as the audit trail and number series. These are constraints only; no code import follows from them. B3 creates all three tables so the constraints exist from the first module.
- Declared in the SQL migration of the referencing module. They are not declared as relations in Drizzle table objects, so no TypeScript import crosses a boundary and no ORM join is possible.
- Application code never joins across schemas. A module that needs another module's data asks through that module's public interface.

**Published views**

A module may publish read-only SQL views named `<schema>.pub_<name>` as part of its public interface. These are the only cross-schema objects the reporting and costing modules may select from (ADR-0023). A change to a published view is a contract change for its consumers.

**The document registry**

- `platform.business_document (id, doc_type, owner_module, branch_id, created_at)` holds one row per business document of any kind: sales order, billing document, payment, goods receipt, transfer, adjustment, stock take, processing order, purchase order, supplier invoice, quote, journal, distribution run and so on.
- A module creating a document inserts the registry row in the same transaction, with the same id as its own primary key.
- Any table that needs to say "caused by this document" holds `source_document_id` with a real foreign key to the registry. Stock movements, journal entries, approvals, archived documents and number allocations all use it.
- Lower-layer tables therefore never reference a higher-layer table, yet no reference can be orphaned.

## Consequences

- Every reference in the database is enforced, and the complete list of cross-module coupling at the data level is one allow-list that CI checks (ADR-0008).
- Extracting a module means dropping the foreign keys that point at it and replacing them with whatever integrity mechanism the new boundary needs. That is a refactor.
- Resolving a `source_document_id` to its detail takes a lookup of `doc_type` and a call to the owning module. Traceability screens accept this cost.
- The registry row is tiny and insert-only.
- Binds: `docs/DATA_MODEL.md` conventions, `docs/MODULE_BOUNDARIES.md`, the B2 CI checks.

## Verification

- B2: the `pg_constraint` check fails on a cross-schema foreign key that is not on the allow-list (fixture migration).
- B3: a test that a document row cannot be inserted without its registry row, and that a registry row cannot be deleted while referenced.
