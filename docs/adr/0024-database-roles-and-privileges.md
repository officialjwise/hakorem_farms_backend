# ADR-0024: Database roles and privileges

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires least-privilege database roles, an application role with no DDL rights in production, an audit log with update and delete revoked from the application role, and rules put in the database because application code gets bypassed. The table classes of ADR-0012 need privileges to make them real.

## Options considered

1. **One role that owns everything.** Simple, and every constraint in this design becomes advisory.
2. **Separate roles per concern, with privileges derived from each table's class.**

## Decision

Option 2. Seven roles.

| Role | Used by | Can do |
| --- | --- | --- |
| `hk_owner` | Nobody logs in as it | Owns every schema, table, function and trigger. Trigger functions that write projections run as this role (`SECURITY DEFINER`, fixed `search_path`) |
| `hk_migrator` | The one-shot migration container | Member of `hk_owner` for the duration of a migration. The only login that can run DDL. Its credential exists only in the deployment secrets |
| `hk_app` | The API | Per table class: `LEDGER` insert and select; `DOCUMENT` and `MASTER` insert, select, update; `PROJECTION` and `LOOKUP` select; `WORK` insert, select, update, delete. No DDL, no `TRUNCATE`, no `DELETE` outside `WORK` tables |
| `hk_worker` | The worker process | As `hk_app`, plus the write access projectors need on `rpt` and `cst` fact tables |
| `hk_sealer` | The audit sealer | Select on `aud.audit_event`; insert and select on `aud.audit_chain` and `aud.audit_anchor`. Nothing else |
| `hk_report` | Report queries | Select on `rpt` and on published `pub_` views only. Statement timeout and a low connection limit |
| `hk_backup` | Backup and WAL archiving | Replication and read access for dumps. No writes |

Rules:

- Privileges are granted by migration, from the table's class. A schema test compares the grants with the class recorded on each table (ADR-0012).
- Every `LEDGER` table also has triggers that reject `UPDATE`, `DELETE` and `TRUNCATE` for all roles, so the rule does not depend on privileges alone.
- `PUBLIC` has no privileges on any schema.
- No application process connects as a superuser. Superuser access is for the server administrator, over SSH, and is an event for the incident log.
- Row-level security is not used in version one. Branch and ownership scoping is enforced in the domain layer (ADR-0017) and tested per module.
- Staging and production have separate databases, roles and credentials.
- Connections go directly from the application to PostgreSQL. No transaction-mode pooler is placed between them, because the unit of work relies on session-level advisory locks (ADR-0005).

## Consequences

- A compromised API credential cannot alter history: it cannot update or delete a ledger row, write a balance, change a table or read the audit chain's signing material.
- Running a data fix needs the migrator or the administrator, deliberately. Data fixes are reversing entries made through the application wherever possible.
- Each new table must declare its class, or the schema test fails.
- Without row-level security, a bug in domain scoping could leak across branches. This is a recorded residual risk, mitigated by the repository design in ADR-0007 and the per-module tests.
- Binds: `docs/security/SECURITY_ARCHITECTURE.md`, `docs/DATA_MODEL.md`, the `hakorem-migration` skill, B2's migration runner.

## Verification

- B2: the schema test for grants; a test that `hk_app` cannot run DDL.
- B3: tests that `hk_app` cannot update or delete audit rows, and that `hk_sealer` cannot read or write business tables.
- B12: a test that `hk_report` cannot read transactional tables.
