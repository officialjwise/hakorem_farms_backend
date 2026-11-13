# ADR-0023: Reporting reads a separate schema fed by events, plus published views

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires a read model or reporting schema separate from the transactional tables, so a heavy report cannot slow the counter. It requires an owner dashboard, operational and financial reports, export of every report to spreadsheet and PDF, scheduled delivery by email, and audited exports with row counts. Modules may not join across each other's tables. Year-one infrastructure must stay under 150 US dollars a month, which rules out a second database server.

## Options considered

1. **Reports query transactional tables directly.** No extra moving parts, but a report joins across every module and competes with the counter for locks and memory.
2. **A read replica.** Clean isolation, but a second server and replication to operate, beyond the year-one budget.
3. **A reporting schema in the same database, fed asynchronously, with a restricted database role.** Isolation of query shape and privileges now, and the same design moves to a replica later without change.

## Decision

Option 3.

**Fact tables in schema `rpt`**

- Projectors subscribe to outbox events (ADR-0010) and maintain denormalised fact tables: sales, stock position, receivables, payments, deliveries, mortality, feed conversion, quotes, and the exception items that make up the daily exception report.
- Projectors are idempotent through `platform.inbox_message` and record their position in `rpt.projection_checkpoint`.
- Every fact table can be rebuilt from scratch by replaying events or by a backfill through module interfaces. A rebuild is a runbook.
- Dashboards and operational reports read only `rpt`.

**Published views**

- A module may publish `<schema>.pub_<name>` views (ADR-0011). Reports that need figures of record rather than projections read these: stock on hand from inventory, open items from payments.
- Financial statements (trial balance, profit and loss, balance sheet, cash flow) are computed by the FIN module from the ledger and served through its public interface. The reporting module presents and exports them; it does not recompute them.

**Isolation**

- Report queries run under the `hk_report` database role (ADR-0024): `SELECT` on `rpt` and on published views only, with a statement timeout and a lower connection limit.
- Report generation runs in the worker, not in the API process. Large reports are produced as files in the file store and delivered by signed link.
- The health endpoint reports projection lag.

**Exports and schedules**

- Export is a permission. Every run is recorded in `rpt.report_run` with the user, parameters, row count and file, and in the audit log. Bulk exports need step-up authentication.
- `rpt.report_schedule` defines scheduled reports and their recipients.

## Consequences

- A slow report cannot hold locks that the counter needs, and cannot read anything it was not given.
- Dashboard figures lag the transaction by the outbox delay, normally seconds. Each dashboard shows the time of its data.
- Projections can drift if a projector has a bug. Figures of record always come from the owning module, and a nightly comparison of key totals (sales, stock value) between `rpt` and the modules raises an alert.
- Moving reporting to a read replica later means pointing the `hk_report` connection at it. It is parked in `docs/BACKLOG.md`.
- Binds: `docs/data-model/rpt.md`, `docs/data-model/cst.md`, the B12 session.

## Verification

- B12: a test that the `hk_report` role cannot select from a transactional table.
- B12: a rebuild test that drops a fact table, replays events and compares totals with the module of record.
- B13: the k6 run includes a heavy report running during counter sales and the POS latency target still holds.
