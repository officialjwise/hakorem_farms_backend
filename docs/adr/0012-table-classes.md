# ADR-0012: Every table has a class that fixes how it may change

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

Hard constraint 10 says financial and stock records are never updated in place and never hard deleted, corrections are reversing entries, and everything else uses soft deletion with an actor and a reason. The integrity rules also say aggregates carry a version column and use optimistic locking, which implies updates. Orders, payments and reservations have a status that changes. Without a rule for which tables may change and how, each module session will answer the question differently.

## Options considered

1. **Decide table by table in each session.** Inconsistent, and unreviewable.
2. **Everything is insert-only (full event sourcing).** Uniform, but a large change in how every module is written and queried, and not what the brief specifies.
3. **A small fixed set of table classes, each with its own privileges, triggers and standard columns.** Every table declares its class in the table dictionary.

## Decision

Option 3. Six classes.

| Class | May change how | Enforced by | Examples |
| --- | --- | --- | --- |
| `LEDGER` | Insert only. A correction is a new reversing row | Application role has `INSERT` and `SELECT` only; triggers reject `UPDATE`, `DELETE`, `TRUNCATE` | Stock movements, journal entries and lines, audit events, payment allocations, outbox messages, number allocations |
| `DOCUMENT` | Freely while in a draft status. Frozen when posted or issued: after that only listed status transitions and listed settlement columns may change. Never deleted | A trigger compares old and new rows once the status is a posted one; optimistic `version` | Sales orders, billing documents, payments, goods receipts, processing orders, quotes, distribution runs |
| `MASTER` | Updated in place with optimistic `version`. Soft-deleted with actor and reason. Every change audited with before and after values | `version` check in the repository; soft-delete columns; no `DELETE` privilege | Products, customers, suppliers, locations, price lists, roles |
| `PROJECTION` | Rebuilt or maintained from a ledger. Never written by request-handling code | Application role has `SELECT` only; written by a trigger or a worker role | Stock balances, cost pools, invoice settlement, period balances, reporting facts |
| `LOOKUP` | Changed only by migration | Application role has `SELECT` only | Movement types, permissions, document types, posting event types |
| `WORK` | Mutable operational state with no business meaning of its own. May be purged after a retention period | Ordinary privileges | Outbox delivery state, idempotency keys, render jobs, held sales |

**Standard columns by class**

- All tables: `id UUID PRIMARY KEY` unless the dictionary states a natural or composite key.
- `LEDGER`: `recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `actor_id UUID NOT NULL` referencing `iam.principal`. Tables that record something that happened at a different time than it was stored also carry `occurred_at`.
- `DOCUMENT`: `version`, `status`, `branch_id`, `created_at`, `created_by`, `updated_at`, `updated_by`, and `posted_at`, `posted_by` where the document has a posting step.
- `MASTER`: `version`, `created_at`, `created_by`, `updated_at`, `updated_by`, `deleted_at`, `deleted_by`, `delete_reason`, with a check that the three delete columns are all null or all set.

Uniqueness on `MASTER` tables is declared with partial unique indexes that exclude soft-deleted rows.

**Corrections**

- A posted stock movement or journal entry is corrected by a reversing row that references it.
- A posted document is corrected by another document: a credit note for an invoice, a reversal for a payment, a return for a fulfilled order.
- A draft document may simply be edited or cancelled.

## Consequences

- "Never updated in place" has a precise meaning: it is the `LEDGER` class and the frozen state of the `DOCUMENT` class.
- The class is part of each table's definition in `docs/data-model/`, and the migration skill checks that the privileges and triggers match the class.
- Frozen-document triggers must list the columns that may still change (for example a settlement status). Getting that list wrong blocks legitimate work, so each has an integration test.
- Binds: `docs/DATA_MODEL.md`, the `hakorem-migration` and `hakorem-stock` skills, ADR-0024.

## Verification

- B2: a schema test reads the class of every table from a comment on the table and asserts that the privileges of the application role match it.
- Each module session: an integration test per `LEDGER` table that update and delete are rejected, and per `DOCUMENT` table that a posted row cannot be altered outside its allowed columns.
