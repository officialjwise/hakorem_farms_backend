# ADR-0006: The audit log is insert-only, sealed into a hash chain, and anchored off the server

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires an immutable audit log of every create, update, delete, login, permission change, price override, approval and export, with actor, timestamp, IP address and before and after values. It must be append-only at the database level, with update and delete revoked from the application role, and each row must carry a hash of the previous row so tampering is detectable. The realistic threat is an insider with a valid login, and at worst an insider with database access.

A chain where each row hashes its predecessor needs a total order. If the business transaction computes it, the chain head is a row that every audited transaction in the system reads and writes, which under serializable isolation aborts every overlapping transaction (ADR-0005).

## Options considered

1. **Chain computed synchronously by a trigger in the business transaction.** The simplest reading of the brief. Makes the chain head a global hot row and the whole system effectively single-threaded with constant serialization failures.
2. **One chain per actor or per module.** Reduces contention, does not remove it, and an attacker can drop a whole short chain unnoticed.
3. **Audit rows written in the business transaction; a single sealer process builds the chain shortly afterwards; the chain head is anchored outside the database.** No contention, and tampering by a database superuser is also detectable.

## Decision

Option 3.

**Stage one, in the business transaction: `platform.audit_event`**

- Columns include actor, session, IP address, user agent, correlation id, action, entity type and id, branch, `before` and `after` as canonical JSON bytes, `occurred_at`, `recorded_at`, and `txid` (the PostgreSQL transaction id, `xid8`).
- A `BEFORE INSERT` trigger sets `txid` and `content_hash = sha256(canonical bytes of the row)`. The application cannot supply either.
- The application role has `INSERT` and `SELECT` only. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` for every role.
- Because the audit row is in the same transaction as the change, a change cannot commit without its audit row.
- Personal data inside `before` and `after` is encrypted per data subject before it is written, and secrets are never included (ADR-0022).

**Stage two, the sealer: `platform.audit_chain`**

- One row per audit event: `seq` (gap-free, primary key), `audit_event_id` (unique), `prev_hash`, `chain_hash = sha256(prev_hash || content_hash || seq)`. The first row's `prev_hash` is 32 zero bytes.
- Written only by the sealer, a single worker running under its own database role (`hk_sealer`) at read committed. That role can insert into the chain and read events, and nothing else.
- The sealer seals events whose `txid` is below the oldest transaction still in progress, in order of `txid` then `id`. No transaction with a lower id can still commit, so the order is final and reproducible.
- Each audit event thus carries, through its chain row, the hash of the previous one.

**Stage three, the anchor: `platform.audit_anchor`**

- Once a day, and at every shift close, the sealer records the chain head (`seq`, `chain_hash`) and signs it with a key held outside the database.
- The signed anchor is written to object storage off the server with object lock, and printed on the owner's daily exception report.
- Without an anchor, someone with superuser access could rewrite the events and recompute the whole chain. With it, they would also need the signing key and the off-box copy.

**Verification job**

A nightly job recomputes every content hash and chain hash, compares the head with the latest anchor, and raises an alert for any mismatch, any gap in `seq`, and any event older than five minutes without a chain row.

## Consequences

- Audited writes do not contend with each other.
- There is a window, normally under a few seconds, between an event being written and being sealed. During it the event is protected by privileges and triggers but not yet by the chain. The verifier reports events that stay unsealed, and this is recorded as a residual risk in the threat model.
- A long-running transaction delays sealing for everything behind it. Long transactions are forbidden in command handlers and reported by the health endpoint.
- The table is not partitioned in version one. Retention and archival are set in `docs/OPERATIONS.md` (B1).
- Schema changes made by migrations are outside this log. They are recorded by the migration history table and the pipeline's approval record.
- Binds: `docs/data-model/platform.md`, `docs/security/SECURITY_ARCHITECTURE.md`, the audit interceptor built in B3.

## Verification

- B3: integration tests that the application role cannot update, delete or truncate `platform.audit_event` or `platform.audit_chain`.
- B3: a test that alters one stored event through a superuser connection and asserts the verifier reports the exact `seq`.
- B3: a test that a business change and its audit row commit or roll back together.
- B3: a concurrency test with 20 parallel audited writes showing no serialization failures attributable to auditing.
- B13: the anchor is written off-box and verified from a clean environment.
