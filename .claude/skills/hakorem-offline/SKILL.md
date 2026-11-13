---
name: hakorem-offline
description: "Use when building or changing anything that must survive a dropped connection: the point-of-sale sale queue and sync endpoint, shift handling while offline, driver proof of delivery or cash on delivery captured on a phone, client-generated UUIDv7 ids, idempotent replay of a queued record, provisional receipt references (`P-<REGISTER>-...`), per-shift device counters and gap detection, device enrolment and the device credential, `pos.sale_sync`, `pos.device_enrolment`, the `SALE_ISSUE_OFFLINE` movement type, offline tenders and price override limits, stock conflicts found at sync, sales dated in a locked period, the eight-hour or 500-transaction offline targets, or a test run with the network disabled. Server-side stock invariants themselves are hakorem-stock; the receipt layout is hakorem-documents; the sync endpoint's HTTP shape is hakorem-endpoint."
---

# Offline: the sale already happened, the server records it

Decision: `docs/adr/0027-offline-sync-principles.md`. Rules and worked examples: `docs/OFFLINE_SYNC.md` (written before any offline code). Ids: `docs/adr/0013-uuidv7-identifiers.md`. Idempotency: `docs/adr/0014-idempotency-and-external-references.md`. Provisional references and numbering: `docs/adr/0015-gap-free-numbering-and-offline-provisional-references.md`. Device credential: `docs/adr/0016-authentication.md`. Tables: `docs/data-model/pos.md`, `ord.md`, `inv.md`. Threats: `docs/security/THREAT_MODEL.md` TB3 and TB4, abuse cases 4, 10, 11. The frontend repository keeps its own offline skill for the queue on the device; never edit it from here.

## Checklist (the ten principles, applied)

1. **The server is authoritative.** The device holds a queue of things that happened, not a copy of the truth. Prices, stock and permissions on the device are a cache with an age; the server re-prices and re-checks permissions on every synced sale.
2. **A synced sale is always recorded.** Order, billing document and payment post for every offline sale that passes authentication and integrity checks. Never reject a sale because stock disagrees: the goat has left and the cash is in the till.
3. **A stock conflict becomes an exception, not a failure.** `ord.sales_order_line.stock_movement_id` is nullable, with `stock_exception_id` as the alternative. When the movement would break an invariant, post the line with no movement and an `inv.stock_exception` row naming the conflict. Cost of sales for that line is settled when the exception is resolved.
4. **Countable stock may go negative on sync; a serialised animal never moves twice.** `SALE_ISSUE_OFFLINE` allows negative at sellable locations for untracked and lot stock and raises an exception each time. A serial unit no longer where the sale says it was (sold elsewhere, reserved, on hold) is always an exception with no movement. Never override the trigger.
5. **Exactly-once by identity.** Every offline record carries a client-generated UUIDv7 (sale, proof of delivery, weight capture). The server validates version 7 and that the embedded time is not in the future beyond clock tolerance nor older than the device's offline window. The id is the idempotency identity; re-sending returns the first result. Keep idempotency rows at least 72 hours (longer than the longest offline window).
6. **Both clocks are kept.** `occurred_at` is when the cashier made the sale; `recorded_at` is when the server stored it. The embedded UUID time is never business time. If `occurred_at` falls in a locked period or after the shift was force-closed, post on the first open date, flag it, and keep the original `occurred_at`.
7. **Official numbers come only from the server.** The device prints `P-<REGISTER>-<SHIFT SEQUENCE>-<DEVICE COUNTER>` plus the sale id as a QR code and states the official number follows. The official number is allocated at sync inside the posting transaction; the billing document stores both. The device counter is gap-free per shift; a missing value is raised as `DEVICE_COUNTER_GAP` on the daily exception report (abuse case 10).
8. **Offline tenders are cash only by default.** Mobile money cannot be verified without the network (abuse case 4). A setting allows a manager-approved unverified mobile money tender; it is off by default and any such tender goes to the unmatched payment queue until verified.
9. **Overrides offline are bounded by the cached role limit** and re-checked at sync; an override beyond the server's limit is posted and raised as an exception for approval after the fact.
10. **Nothing is resolved silently.** Every exception appears on the daily exception report with cashier, register, shift and the two conflicting facts.
11. **Authentication offline.** A manager enrols the device and it holds a device credential (`X-Device-Credential`); the cashier unlocks it with a PIN against a locally cached shift. At sync the server authenticates the credential, the batch names cashier and shift, and every permission is re-checked. Local data is limited to the open shift; no customer data cached beyond the sale.
12. **Log every sync attempt** in the insert-only `pos.sale_sync`: device, client sale id, device counter, provisional reference, `occurred_at`, outcome.
13. **Targets.** POS runs 8 hours offline and queues at least 500 transactions; adding an item takes under 100 ms locally with no round trip. The driver device follows the same principles for proof of delivery and cash on delivery.
14. **The contract carries it.** `syncOfflineSales` and `syncDriverEvents` accept batches, are idempotent per record by client id (so they take no `Idempotency-Key` header, only the CSRF token and the device credential), return a per-record outcome (`APPLIED`, `APPLIED_WITH_EXCEPTION`, `DUPLICATE`, `REJECTED_INTEGRITY`) with order number, receipt number and the list of exceptions, report `counterGaps`, and never lose the rest of a batch because one record failed. A change to these shapes is a contract change (hakorem-endpoint).

## Correct and incorrect

```ts
// RIGHT: each queued sale is its own transaction; a duplicate is a replay; a stock conflict is an exception
for (const sale of batch.sales) {
  const outcome = await uow.run({ isolation: "serializable" }, async (tx) => {
    const prior = await idempotency.claim(tx, { scope: device.id, key: sale.id, hash: hashOf(sale) });
    if (prior) return prior.response;                                  // exactly once by identity
    const priced = await pricing.recheck(tx, sale, device.cachedLimits);
    const moved = await inventory.tryPostOffline(tx, sale);            // returns movement or StockExceptionId
    return orders.completeOffline(tx, sale, priced, moved, { occurredAt: sale.occurredAt });
  });
  results.push(outcome);                                               // one failure never loses the others
}
```

```ts
// WRONG: rejects a real sale, trusts the device, forces stock through, loses the other 499
if (balance < sale.qty) throw new Error("insufficient stock");         // the customer already left
await db.execute(sql`UPDATE inv.stock_balance SET on_hand_qty = on_hand_qty - ${sale.qty}`);  // bypasses the ledger
await orders.create({ ...sale, total: sale.totalFromDevice });         // device-computed total trusted
```

## Test expectations

Integration tests against real PostgreSQL, with the network disabled on the client side where a client exists (`docs/TEST_STRATEGY.md`, use hakorem-tests): an offline sale of an animal sold from another till; of an animal placed on hold meanwhile; of countable stock that went negative; of a sale dated in a locked period; a missing device counter value producing an exception; a sale submitted twice with the same client id stored once; a client id outside the allowed window rejected; 500 queued transactions syncing exactly once, each with one official number (B9b gate); an unverified mobile money tender refused unless the setting is on. UAT scenario 6 (`docs/UAT.md`): disconnect for an hour, run fifty transactions, reconnect, everything syncs once and conflicts are flagged, not hidden.
