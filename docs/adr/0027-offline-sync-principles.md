# ADR-0027: Offline sync principles: the server is authoritative, the money always lands, conflicts become exceptions

- **Status:** Proposed (awaiting B0 gate; the full rules and worked examples are written in `docs/OFFLINE_SYNC.md` in B1)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

Hard constraint 9: the counter keeps working when the network does not. Point of sale must run eight hours offline and queue at least 500 transactions, with an idempotent sync, and the conflict rules must be written before any offline code. The brief also says the server is always authoritative and that conflicts are flagged, never silently resolved.

Some of the consequences reach into the data model and cannot be left to B1, because tables designed in B0 must be able to hold them. A sale made offline has already happened: the customer has left with the goat and the cash is in the till. The server cannot refuse it. But the database must still refuse a stock movement that breaks an invariant, such as selling an animal that was sold from another till or put on hold an hour earlier.

## Options considered

1. **Reject a conflicting offline sale at sync.** Keeps the data clean and loses a real sale: the cash exists and the system says it does not. This is exactly the gap a dishonest cashier would use.
2. **Force the stock movement through by overriding the invariant.** Records the sale, and destroys the guarantee that the stock ledger is right.
3. **Always record the sale and the money. Where the stock leg cannot be posted, record an exception in its place and send it to a person.**

## Decision

Option 3.

**Principles**

1. **The server is authoritative.** The device holds a queue of things that happened, not a copy of the truth. Prices, stock and permissions on the device are a cache with an age.
2. **A synced sale is always recorded.** The order, the billing document and the payment are posted for every offline sale that passes authentication and integrity checks.
3. **A stock conflict becomes an exception, not a failure.** Each order line's link to its stock movement is nullable. When the movement would break an invariant, the line is posted with no movement and an `inv.stock_exception` row instead, naming the conflict. The cost of sales for that line is settled when the exception is resolved.
4. **Countable stock may go negative on sync; a serialised animal never moves twice.** The offline sale movement type allows negative balances at sellable locations for untracked and lot stock, raising an exception each time. A serial unit that is no longer where the sale says it was is always an exception without a movement.
5. **Sync is exactly-once by identity.** Each sale carries its client-generated UUIDv7 (ADR-0013). Re-sending is a no-op that returns the first result.
6. **Business time and record time are both kept.** `occurred_at` is when the cashier made the sale; `recorded_at` is when the server stored it. If `occurred_at` falls in a locked accounting period or after the shift was force-closed, the sale posts on the first open date, is flagged, and keeps its original `occurred_at`.
7. **Numbers are official only from the server** (ADR-0015). The device counter is checked for gaps.
8. **Offline tenders are limited.** Offline, the counter takes cash. Mobile money cannot be verified without the network, and the threat model requires that a payment is recorded only from a verified provider callback or lookup. A setting allows a manager-approved unverified mobile money tender offline; it is off by default, and any such tender goes to the unmatched payment queue until verified.
9. **Price overrides offline are bounded by the cached role limit** and re-checked at sync. An override that exceeds the server's limit is posted and raised as an exception for approval after the fact.
10. **Nothing is resolved silently.** Every exception appears on the daily exception report with the cashier, register, shift and the two conflicting facts.

**What the data model must hold**

- `ord.sales_order_line.stock_movement_id` nullable, with `stock_exception_id` as the alternative.
- `inv.stock_exception` with a kind, the product and stock unit, the document that caused it, and resolution fields.
- `pos.sale_sync` as an insert-only log of every sync attempt: device, client sale id, device counter, provisional reference, `occurred_at`, outcome.
- `pos.device_enrolment` with the device credential and last counter seen.
- `occurred_at` and `recorded_at` on orders, payments, movements and journal entries.

The driver's device follows the same principles for proof of delivery and cash on delivery.

## Consequences

- The cash count at shift close reconciles to recorded sales even after an offline period, because no real sale is ever dropped.
- Stock can be wrong for a while after a conflict, visibly: the exception says so and names what to check.
- Offline mode cannot take mobile money by default. This is a real limitation at the counter, chosen because a forged mobile money confirmation is a named abuse case.
- Binds: `docs/OFFLINE_SYNC.md` (B1), `docs/data-model/pos.md`, `docs/data-model/ord.md`, `docs/data-model/inv.md`, the `hakorem-offline` skill.

## Verification

- B1: `docs/OFFLINE_SYNC.md` contains worked examples for each principle.
- B9b gate: 500 queued offline transactions sync exactly once.
- B9b: tests for an offline sale of an animal sold elsewhere, of an animal placed on hold, of countable stock that went negative, of a sale dated in a locked period, and of a missing device counter.
