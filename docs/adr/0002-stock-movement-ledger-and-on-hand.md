# ADR-0002: Stock is an append-only movement ledger with a trigger-maintained balance

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires that stock is never a quantity column that gets updated. Movements are immutable, carry a type, quantity, location, source document and actor, and on-hand is derived from them with a materialised balance for speed. Three stock archetypes share one catalogue: serialised live animals, catch-weight lots and countable units. Every movement names a source and a destination, and in-transit stock is still the farm's stock.

The database must also enforce four invariants itself: stock cannot go negative except through movement types allowed to; a serialised animal cannot be sold twice; it cannot be sold during a veterinary withdrawal period; and it cannot be in two locations at once.

## Options considered

1. **Signed single-location rows with a periodically refreshed materialised view.** Simple to write. A stale view cannot enforce non-negative stock or reservations at the moment of writing, so the invariants fall back to application code.
2. **Header and lines in double-entry style.** A header per movement with one negative and one positive line. Conservation is checkable but not structural, and every movement costs three rows.
3. **One row per movement with a source and a destination location, and a balance table written only by a trigger.** Conservation is structural, the balance is transactionally exact, and the invariants live in one place.

## Decision

Option 3.

**Tracked identity: `inv.stock_unit`**

One row per individually tracked thing. `tracking` is `SERIAL` (one animal) or `LOT` (a meat lot, a flock of birds, a dated crate lot). Untracked countables have no stock unit. A `SERIAL` unit holds its single `current_location_id`. The livestock module's animal record shares the stock unit's primary key (`liv.animal.stock_unit_id` is both primary key and foreign key).

**The ledger: `inv.stock_movement`**

One immutable row moves one product, and optionally one stock unit, from one location to another.

- `from_location_id` and `to_location_id` are both `NOT NULL` and different. The outside world is modelled as virtual locations: `SUPPLIER`, `CUSTOMER`, `PRODUCTION`, `PROCESSING`, `CONSUMPTION`, `LOSS`, `ADJUSTMENT`, `OPENING`. `IN_TRANSIT` is a real location owned by the farm.
- `qty_base` is positive in the product's base unit. It is zero only for value-only movement types that capitalise feed, veterinary, labour or overhead cost onto a unit.
- `weight_kg` with a mandatory `weight_source` (`SCALE`, `MANUAL`, `ESTIMATE`) whenever weight is present. `pack_count` for lots sold in packs.
- `value_pesewas` is the cost carried by the movement (ADR-0018). `cost_element` tags what kind of cost it is.
- `movement_type`, `reason_code`, `source_document_id`, `reservation_id`, `actor_id`, `occurred_at` (when it happened) and `recorded_at` (when the server stored it).
- A correction is a new row with source and destination swapped and `reverses_movement_id` set. That column is unique, so a movement can be reversed once.

The application role has `INSERT` and `SELECT` on this table and nothing else. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE`.

**Behaviour lives in `inv.movement_type`**

A lookup table, changed only by migration, carrying `allows_negative`, `blocked_by_hold`, `is_value_only`, `requires_reason`, `requires_stock_unit` and the posting event the ledger receives.

**On-hand: `inv.stock_balance`**

One row per product, stock unit (or none) and location, holding `on_hand_qty`, `on_hand_weight_kg`, `pack_count` and `reserved_qty`. It is a projection. Only the `AFTER INSERT` trigger on `inv.stock_movement` and the trigger on `inv.stock_reservation` write it; the application role has `SELECT` only.

In the same transaction as the movement, the trigger:

1. Locks the stock unit row, if there is one.
2. For a `SERIAL` unit, requires `from_location_id = current_location_id`, then sets `current_location_id` to the destination. An animal already sold sits in `CUSTOMER`, so a second sale fails this check.
3. Rejects the movement if its type is `blocked_by_hold` and an unreleased `inv.stock_hold` covers `occurred_at` (withdrawal period, cold-chain quarantine, investigation).
4. Decrements the source balance and increments the destination balance.
5. If a physical location would go negative: raises an error, unless both the movement type and the location allow negative stock, in which case it inserts an `inv.stock_exception` row.
6. Refuses an outbound movement that would take on-hand below reserved, unless the movement consumes its own reservation.
7. Applies the value to `inv.cost_pool` and asserts that a pool whose quantity reaches zero also has zero value.

**Reconciliation and history**

- A nightly job recomputes every balance from the ledger and compares. Drift raises an alert with the offending rows attached and is never corrected automatically.
- `inv.stock_balance_snapshot` stores month-end balances for as-of queries.

## Consequences

- On-hand reads are a primary-key lookup, and the four invariants hold even against a script that bypasses the application.
- The balance table is updated in place. This does not breach "never update a quantity column": the ledger is the record, the balance is a cache that only the database can write and that is rebuilt and checked nightly.
- Two concurrent sales of the same item contend on one balance row. That is genuine contention and is retried (ADR-0005).
- Trigger logic is SQL in reviewed migrations. It must be covered by integration tests against real PostgreSQL, since no unit test reaches it.
- Lot genealogy (meat lot back to animal) is held in `inv.stock_unit_lineage`, written when processing outputs are created.
- Binds: `docs/data-model/inv.md`, the `hakorem-stock` skill, ADR-0018, ADR-0019.

## Verification

- B5: integration tests for each rejection path: negative stock, double sale of a serial unit, sale under hold, serial unit moved from the wrong location, update and delete attempts.
- B5 gate: on-hand derived from movements matches a hand count of the seeded farm.
- B5: the nightly recompute detects a deliberately corrupted balance row and does not repair it.
