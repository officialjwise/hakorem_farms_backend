---
name: hakorem-stock
description: "Use when code, SQL or tests create, change or read stock movements, stock balances, on-hand quantity, lots, batches, stock units, tag numbers, weights captured at a scale or by hand, locations and pens, transfers, in-transit stock, goods receipts, stock adjustments, stock takes and variances, reservations, holds (withdrawal, quarantine, investigation), cost pools and valuation, feed or veterinary cost capitalised onto animals, processing inputs and outputs, catch-weight packs, mortality, cull, shrinkage or wastage write-offs, or any `inv.*` table or `qty`, `on_hand`, `reserved_qty`, `weight_kg`, `weight_source`, `movement_type`, `reason_code` column. When the stock change arrives from an offline device also apply hakorem-offline; the pesewa arithmetic inside a stock value is hakorem-money; the journal a movement produces is hakorem-ledger."
---

# Stock: an append-only ledger, a trigger-written balance

Decisions: `docs/adr/0002-stock-movement-ledger-and-on-hand.md`, `docs/adr/0018-valuation-and-cost-accumulation.md`, `docs/adr/0019-reservations-and-holds.md`, `docs/adr/0021-catch-weight-repricing.md`, `docs/adr/0005-aggregate-boundaries-and-isolation.md`, `docs/adr/0007-multi-location-from-day-one.md`. Tables: `docs/data-model/inv.md` (and `liv.md`, `prc.md`). Lifecycle diagram: `docs/DOMAIN_MODEL.md` section 6.

## Checklist

1. **Never update a quantity.** No `UPDATE inv.stock_balance`, no `quantity = quantity - 1`, no `DELETE` of a movement. The application role has `INSERT` and `SELECT` on `inv.stock_movement` and `SELECT` only on `inv.stock_balance`, `inv.cost_pool`; triggers reject update, delete and truncate for every role.
2. **One movement is one transfer between two locations.** `from_location_id` and `to_location_id` are both `NOT NULL` and different. The outside world is a virtual location (`SUPPLIER`, `CUSTOMER`, `PRODUCTION`, `PROCESSING`, `CONSUMPTION`, `LOSS`, `ADJUSTMENT`, `OPENING`). In-transit stock is a real location of the farm.
3. **Use a seeded movement type; behaviour lives in `inv.movement_type`** (`allows_negative`, `blocked_by_hold`, `is_value_only`, `requires_reason`, `requires_stock_unit`). A new type is a migration, not a string.
4. **Reason codes are a fixed list** (`mdm.reason_code`), changed only by migration. Mortality, cull, adjustment and stock-take variance need a reason; mortality and large write-offs go through maker-checker (`iam.approval_request`) with evidence before the movement is posted.
5. **Weight carries its source.** Whenever `weight_kg` is present, `weight_source` is `SCALE`, `MANUAL` or `ESTIMATE`. Weight is `NUMERIC(10,3)` kg; quantity `NUMERIC(14,3)`. In TypeScript use kernel `Weight` and `Quantity`, never `number`.
6. **Correct by reversing.** A correction is a new row with source and destination swapped and `reverses_movement_id` set (unique, so once). It carries the value of the movement it reverses.
7. **Trace lots.** Processing outputs write `inv.stock_unit_lineage` so a meat lot traces back to its animal and its supplier and forward to its sale. A serialised animal is one stock unit; the livestock record shares its primary key.
8. **Serial units never move twice.** The trigger locks the stock unit row, requires `from_location_id = current_location_id`, and an animal already sold sits in `CUSTOMER`. A sale takes the explicit row lock (`FOR UPDATE`); placing a hold takes the same lock.
9. **Holds and reservations are inventory's, enforced in the database.** A withdrawal period or quarantine blocks sale, processing and transfer out of the branch for movement types flagged `blocked_by_hold`; pen moves and write-offs are not blocked. One active reservation per serialised unit; reserved cannot exceed on-hand; an outbound movement that names its reservation consumes it. Livestock places `WITHDRAWAL` holds through inventory's `index.ts` in the same transaction as the treatment record.
10. **Negative stock only where allowed.** Only a movement type that `allows_negative` at a location that `allows_negative` may go below zero, and it inserts an `inv.stock_exception`. Never bypass the trigger to force a movement through.
11. **Value travels with the movement.** `value_pesewas` and `cost_element` (`PURCHASE`, `FEED`, `VETERINARY`, `LABOUR`, `OVERHEAD`, `PROCESSING`). Cost is one source: `inv.cost_pool` holds quantity and total value, never a stored rate. Issue is `V` if `q = Q`, else `half_up(V x q / Q)`; a pool that reaches zero quantity must have zero value. Feed across a pen is spread by head-days with `allocate`. Breeding stock is expensed, growing stock capitalised, births enter at nil cost. CST only analyses.
12. **Processing.** Total input cost plus direct cost is split across outputs by `allocate` using weight in grams times reference sale price per kg, snapshotted on the output row; waste has weight zero. The deferred constraint asserts allocated values sum to the total.
13. **Catch-weight.** The invoice is raised on the weighed quantity; the order carries estimate, tolerance and the final-charge rule (ADR-0021). Each pack weighed at pick stores weight and source.
14. **Scope by branch and location.** Every repository query requires the caller's branch filter as a parameter; a storekeeper scoped to one location cannot post from another (ADR-0007, ADR-0017).
15. **Isolation.** Any command that writes a movement or reservation runs at serializable with whole-command retry (up to five attempts, jittered) and asserts `transaction_isolation = 'serializable'`. Keep to primary-key and index point reads; no sequential scans inside the transaction. Contention on one balance row is genuine and is retried, not worked around.
16. **Publish events, no direct ledger call.** `inv.StockIssuedForSale`, `inv.StockWrittenOff` and the rest of the ADR-0003 matrix carry named amounts; FIN posts from them (hakorem-ledger).
17. **Nightly reconciliation recomputes balances and pools from the ledger and reports drift; it never repairs.**

## Correct and incorrect

```sql
-- WRONG: editing quantity in place, bypassing the ledger
UPDATE inv.stock_balance SET on_hand_qty = on_hand_qty - 1 WHERE product_id = $1 AND location_id = $2;
DELETE FROM inv.stock_movement WHERE id = $1;
```

```ts
// RIGHT: the application records a fact; the trigger derives the balance in the same transaction
await uow.run({ isolation: "serializable" }, async (tx) => {
  await inventory.post(tx, {
    movementType: "SALE_ISSUE",
    productId, stockUnitId,                         // serial animal: locks the unit row
    fromLocationId: shopFloor, toLocationId: customerVirtual,
    qtyBase: Quantity.units(1),
    weight: { kg: Weight.kg("24.350"), source: "SCALE" },
    reservationId,                                  // consumes its own reservation
    sourceDocumentId: orderId, actorId, occurredAt: clock.now(),
  });                                               // value comes from the cost pool, not the caller
});
```

```ts
// WRONG: a movement that guesses its own value, with no source and an unrecorded weight
await db.insert(stockMovement).values({ qtyBase: 1, valuePesewas: price * 0.7, weightKg: 24.35 });
```

Correcting a posted movement:

```sql
-- RIGHT: swap source and destination, point at the original
INSERT INTO inv.stock_movement (id, movement_type, product_id, stock_unit_id, from_location_id, to_location_id,
                                qty_base, value_pesewas, reverses_movement_id, reason_code, actor_id, occurred_at)
SELECT $1, movement_type, product_id, stock_unit_id, to_location_id, from_location_id,
       qty_base, value_pesewas, id, $2, $3, $4
FROM inv.stock_movement WHERE id = $5;
```

## Test expectations

Integration tests against real PostgreSQL (the invariants live in triggers, so no unit test reaches them): negative stock, second sale of a serial unit, sale under hold (including a direct SQL insert), serial unit from the wrong location, update and delete attempts, a second active reservation of one unit, reservation above on-hand, reservation expiry, average-cost issue including the issue that empties a pool and a rounding edge case, a feed allocation that sums exactly, and a processing order whose output costs sum exactly to input plus direct cost. The B5 gate is on-hand from movements matching a hand count of the seeded farm. See `docs/TEST_STRATEGY.md`.
