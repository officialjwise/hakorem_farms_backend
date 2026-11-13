# ADR-0005: Aggregate boundaries, and which operations run at serializable isolation

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires that one business operation is one database transaction, that stock reservation and ledger posting run at serializable isolation with retry on serialization failure, that everything else runs at read committed, that aggregates carry a version column for optimistic locking, and that the sale of a serialised animal takes a row lock explicitly. It also requires gap-free document numbers generated inside the transaction from a row-locked sequence table, and a hash-chained audit log.

These requirements interact badly if combined naively. In PostgreSQL, at repeatable read and serializable, a transaction that tries to update or lock a row changed by another transaction that committed after its snapshot does not wait and then succeed. It waits and then fails with SQLSTATE 40001. The snapshot is taken at the first query, not at `BEGIN`. A row that every sale touches (a number counter, a chain head, an account balance) therefore aborts every overlapping sale, and under load a bounded retry is exhausted.

## Options considered

1. **Read committed everywhere with explicit row locks.** Avoids the abort problem. Contradicts the brief, and loses protection against write skew that nobody enumerated.
2. **Serializable with retry, and accept the hot rows.** Honours the brief literally. The counter stalls under concurrent load.
3. **Serializable with retry, with the hot rows designed out.** Honours the brief and keeps conflicts to the ones that are real.

## Decision

Option 3.

**Aggregates**

An aggregate has its own repository, is loaded and saved whole, and carries a `version` column. The full list per module is in `docs/DOMAIN_MODEL.md`. The roots are:

Product, PriceListVersion, Promotion, Customer, Supplier, Branch, Location, TaxScheme (MDM); User, Role, ApprovalRequest (IAM); StockUnit, Reservation, StockHold, GoodsReceipt, StockTransfer, StockAdjustment, StockTake (INV); Animal, Batch, BreedingRecord, MortalityRecord (LIV); ProcessingOrder (PRC); PurchaseRequisition, PurchaseOrder, SupplierInvoice, SupplierPayment (PUR); SalesOrder, Fulfilment, OrderReturn (ORD); Shift, Register (POS); BusinessAccount, StandingOrder (WHL); Quote (QUO); Cart (SHP); Delivery, Route, DriverCashReconciliation (DEL); BillingDocument (BIL); Payment, Refund (PAY); Account, AccountingPeriod, ManualJournal, FixedAsset (FIN); Investor, DistributionRun, Financing (CAP).

Stock movements, journal entries, audit events, payment allocations and outbox messages are ledgers, not aggregates. They are insert-only and have no version.

A transaction modifies one aggregate root per module. A business operation that spans modules is one transaction orchestrated by the module that owns the operation (ADR-0010).

**Isolation**

Serializable, with whole-command retry:

- any command that writes a stock movement or a stock reservation;
- any command that publishes an event the ledger posts from, which includes sale completion, invoice issue, payment clearing, goods receipt, processing completion, mortality and adjustment posting;
- accounting period lock and close, shift close, stock-take posting, credit-checked order confirmation, distribution run posting.

Read committed for everything else: master data, health and breeding records, quotes in draft, carts, notifications, reporting.

Rules:

- The outermost command handler declares the isolation level, because it cannot be raised once the transaction has run a query. The stock and ledger entry points assert `current_setting('transaction_isolation') = 'serializable'` and refuse to run otherwise.
- Retry covers SQLSTATE 40001 and 40P01 (deadlock), up to five attempts with jittered backoff. The whole command is re-run from the start, including reads. Side effects are safe to repeat because they go through the outbox (ADR-0010).
- A unique-key violation on an idempotency key is a replay, not a failure, and returns the stored result (ADR-0014).
- No invariant rests on isolation alone. Each also has a constraint, a trigger or a row lock, so a script running at read committed cannot break it.

**Designing out the hot rows**

| Hot row | Design |
| --- | --- |
| Document number counter | Series are keyed by document type, fiscal year, branch and, for receipts, register, so a till contends only with itself. A command declares the series it will use. The unit of work takes a session-level advisory lock on each declared series, in sorted order, before `BEGIN`, and releases it after commit or rollback. Waiters queue and then start with a fresh snapshot, so they do not abort. The number is allocated as the first write of the transaction (ADR-0015) |
| General ledger balances | Not maintained synchronously. Journal lines are inserts and do not conflict. Trial balance is a period snapshot plus lines since |
| Accounting period row | Read by every posting, written only at lock and close. This is the one conflict that must happen: a posting racing a period close fails and retries into the correct state |
| Audit chain head | Business transactions never touch it. A separate sealer builds the chain (ADR-0006) |
| Stock balance row | Contention is per product and location and is genuine. Abort and retry is the correct outcome |
| Serialised animal | The stock unit row is locked `FOR UPDATE` before the sale, as the brief requires |

Posting transactions keep to primary-key and index point reads. A sequential scan under serializable takes a relation-level predicate lock and makes unrelated sales conflict.

The connection pool must give a command the same session for the advisory lock, the transaction and the unlock. A transaction-mode pooler in front of PostgreSQL is therefore not used (ADR-0025). If an unlock fails, the connection is destroyed, which releases the lock.

## Consequences

- The brief's isolation rule is honoured without the counter stalling.
- Command handlers must be re-runnable. Anything that cannot be repeated (an external call) is forbidden inside a transaction and goes through the outbox.
- Sales on one register are serialised by the series lock. A register serves one customer at a time, so this costs nothing.
- Reviewers must watch for scans inside posting transactions. The `hakorem-ledger` and `hakorem-stock` skills carry this as a checklist item.

## Verification

Two claims above are not yet proven in this project and must be tested before any posting code is written:

- B2: a two-session test showing that a session-level advisory lock taken before `BEGIN` makes the second serializable transaction wait and succeed, and that `SELECT pg_advisory_xact_lock(...)` as the first statement inside the transaction does not (because that `SELECT` takes the snapshot before blocking).
- B2: a test that the unit of work retries 40001 and 40P01 and gives up after five attempts with a typed error.
- B8 gate: numbering stays gap-free under concurrent load.
- B13: the k6 run at 50 concurrent users meets the write latency target with a retry rate recorded in `docs/OPERATIONS.md`.
