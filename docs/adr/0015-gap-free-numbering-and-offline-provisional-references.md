# ADR-0015: Gap-free document numbers, and provisional references for offline receipts

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires sequential, gap-free, tamper-evident numbering per document type and per year, generated inside the database transaction from a sequence table with a row lock. It also requires the counter to keep working offline for eight hours, printing receipts. A device that is offline cannot take part in a database transaction, so it cannot be given an official number.

A PostgreSQL sequence cannot be used: it does not roll back, so an aborted transaction leaves a gap.

## Options considered

1. **Lease a block of numbers to each device.** The device numbers its own receipts. Unused numbers at shift end are gaps, which breaks the requirement.
2. **Number per device, with the device as a series of its own, allocated offline.** Gap-free per device, but the number is generated outside the database transaction, and a device that is wiped loses its place.
3. **Two numbers.** Offline, the device prints a provisional reference. The server assigns the official number when the sale syncs.

## Decision

Option 3 for offline, and a locked series table for everything.

**Series**

- `platform.number_series` holds one row per document type, fiscal year, branch and, for receipts, register. It stores a prefix, padding and `next_value`.
- `platform.allocate_number(series_id, document_id)` increments `next_value`, inserts a row into `platform.number_allocation (series_id, value, document_id)` and returns the formatted number. It runs inside the caller's transaction, so a rollback returns the number.
- `platform.number_allocation` is insert-only with primary key (`series_id`, `value`). It is the evidence that every number belongs to exactly one document.
- The fiscal year comes from the posting date in Africa/Accra, so a sale that syncs after year end takes a number in the year it is posted.
- Format: `<PREFIX>-<YEAR>-<BRANCH>-<SEQUENCE>`, for example `INV-2026-ACC-000123`. Receipts add the register: `RCP-2026-ACC-T1-000456`. Prefixes and padding are settings; the allocation mechanism is not.
- Contention is handled as in ADR-0005: series lock before the transaction, number allocated first.

**Tamper evidence**

- A billing document stores the hash of its rendered content, and the archive stores the bytes (ADR-0012, DOC module).
- A nightly job checks, per series, that the count of allocations equals `next_value − 1` and that every allocated document exists. A gap or an orphan raises an alert.

**Offline receipts**

- An offline sale prints a provisional reference: `P-<REGISTER>-<SHIFT SEQUENCE>-<DEVICE COUNTER>`, plus the sale's UUIDv7 as a QR code. The layout states that the official receipt number follows.
- The device counter is gap-free per shift on that device.
- At sync, the server posts the sale in a normal transaction and allocates the official number then. The billing document stores both, and either finds the sale.
- The server checks the device counters for each shift. A missing counter value means a sale was made and not synced, or was removed from the device. It is raised as an exception for the daily exception report.
- A customer who needs the official number receives it by SMS or WhatsApp once the sale syncs, or on reprint.

## Consequences

- Official numbers are gap-free and generated in the database, as required, including for sales made offline.
- A receipt printed offline does not show the official number. Whether the Ghana Revenue Authority accepts a provisional receipt followed by an official one is a compliance question recorded in `docs/ASSUMPTIONS.md` and checked in B1.
- The device counter gives the farm a control it would not otherwise have: a cashier cannot make an offline sale disappear without leaving a hole.
- The production smoke suite uses the test branch's own series (ADR-0007), so it never consumes a real number.
- Binds: `docs/data-model/platform.md`, `docs/data-model/bil.md`, `docs/data-model/pos.md`, the `hakorem-documents` and `hakorem-offline` skills.

## Verification

- B8 gate: 50 concurrent issuers on one series produce a dense sequence with no gap and no duplicate; a transaction that rolls back after allocation leaves no gap.
- B9b gate: 500 queued offline transactions sync exactly once, each with one official number.
- B9b: a missing device counter value produces an exception record.
