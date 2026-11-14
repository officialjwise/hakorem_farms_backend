# ADR-0019: Stock reservations and holds

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires stock reservation at checkout with a timed release, so the shop cannot oversell a single goat. It requires that an animal under a veterinary withdrawal period cannot be sold until it expires, and that a temperature excursion quarantines a meat lot automatically. Health records belong to the livestock module and stock movements to inventory, yet the database itself must enforce the block.

The owner's default is that live animals are not bought directly online: the storefront takes a request to buy, which becomes a quote. Quotes still need to set a particular animal aside.

## Options considered

1. **Reservations in the order module, withdrawal checks in the livestock module.** Each module checks its own rule in code. A script, or a module that forgets to ask, sells the animal anyway.
2. **Reservations and holds as inventory tables that the movement trigger reads.** One place enforces both, in the database.

## Decision

Option 2.

**Reservations: `inv.stock_reservation`**

- Fields: product, optional stock unit, location, quantity, `holder_document_id` (the cart checkout, order or quote), `status` (`ACTIVE`, `CONSUMED`, `RELEASED`, `EXPIRED`), `expires_at`.
- A trigger maintains `inv.stock_balance.reserved_qty` and refuses a reservation that would take reserved above on-hand.
- A partial unique index allows one active reservation per serialised stock unit, so one goat cannot be promised twice.
- Creating a reservation runs at serializable isolation (ADR-0005).
- An outbound movement that names its reservation consumes it. Any other outbound movement cannot reduce on-hand below reserved (ADR-0002).
- A scheduled job expires reservations past `expires_at` and publishes `inv.ReservationExpired`. Default lifetimes are settings: 15 minutes for an online checkout awaiting payment, the quote's validity for a quote, until fulfilment for a confirmed order.
- Available to promise is on-hand minus reserved minus quantity under hold.

**Holds: `inv.stock_hold`**

- Fields: stock unit, `kind` (`WITHDRAWAL`, `QUARANTINE`, `INVESTIGATION`), `starts_at`, `ends_at` (null for open-ended), `source_document_id`, and release fields that can be set once.
- The movement trigger rejects any movement whose type is `blocked_by_hold` while an unreleased hold covers the movement's `occurred_at`. Sale, processing and transfer out of the branch are blocked. Movement between pens and write-off are not.
- The livestock module places a `WITHDRAWAL` hold through inventory's public interface in the same transaction as the treatment record, with `ends_at` computed from the product's withdrawal days.
- A temperature reading outside the location's range places a `QUARANTINE` hold on every lot in that location, raises a stock exception and publishes an event. Release needs a named user and a reason.
- Placing a hold and selling the unit both lock the stock unit row, so the rule holds at any isolation level.

**Online sale mode**

`mdm.product.online_mode` is `HIDDEN`, `LISTED` or `REQUEST_TO_BUY`. Serialised live animals are seeded as `REQUEST_TO_BUY`, which opens a request for quote instead of adding to the cart. Changing a product to `LISTED` needs no schema change; the reservation mechanism already protects a single animal.

## Consequences

- Overselling, selling during withdrawal and selling quarantined meat are impossible at the database level, whichever module or script attempts it.
- The livestock module depends on inventory's interface for holds, which matches the layer order.
- Abandoned checkouts release stock without anyone acting.
- An offline counter sale of an animal that was reserved or put on hold meanwhile is handled by the offline rules in ADR-0027.
- Binds: `docs/data-model/inv.md`, `docs/data-model/liv.md`, `docs/data-model/shp.md`.

## Verification

- B5: tests that a second active reservation of one serial unit is rejected, that a reservation above on-hand is rejected, and that expiry releases stock.
- B6: a test that an animal treated with a product carrying withdrawal days cannot be sold or processed until the hold ends, including through a direct SQL insert.
- B7: the slot 8 gate, checkout reserves stock and releases it on timeout.
