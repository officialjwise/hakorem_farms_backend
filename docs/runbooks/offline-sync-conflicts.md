# Runbook: offline sync conflicts

Last reviewed: 2026-11-13. Severity: URGENT items the same day; REVIEW items within two working days. Related: `docs/OFFLINE_SYNC.md` (the rules and the worked examples; read section 9 for any conflict kind), ADR-0027, ADR-0015, `docs/data-model/pos.md`, `docs/runbooks/reconciliation-break.md`, `docs/runbooks/stock-balance-drift.md`, `docs/runbooks/incident-response.md`.

## The idea

When the connection returns, the counter and the drivers send what they did while offline. The server **always records a real sale and its money**. Where the stock side cannot be posted, it records an exception and sends it to a person. Nothing is resolved silently. This runbook is how that person (usually the manager, with the storekeeper and the accountant) works through what arrived.

## The daily routine

1. **Read the daily exception report** (`GET /exceptions/daily-report`, or the console screen) each morning and again before closing. For each item: the kind, the severity, the cashier or driver, the register and shift, the amount, and the two conflicting facts.
2. Sort by severity. **URGENT items are dealt with the same day**, REVIEW items within two working days, INFO items in the weekly review.
3. Every item ends with a resolution recorded in the system (a note, a resolution document, an approval) or an annotation. Nothing is closed by silence.

## Triage table

| Exception (item kind) | What it means | Do this | Section in `OFFLINE_SYNC.md` |
| --- | --- | --- | --- |
| `SERIAL_CONFLICT` (`STOCK_EXCEPTION`, URGENT) | An animal was sold at an offline till after it had already been sold elsewhere | Find which customer has the animal. Refund and return the other sale, or reverse the first. Resolve the exception with the credit note or the reversal (`POST /stock/exceptions/{id}/resolve`) | 9.1 |
| `HOLD_CONFLICT` (`STOCK_EXCEPTION`, URGENT for a withdrawal hold) | An animal under a veterinary hold was sold offline | **Contact the customer the same day**: the animal must not be slaughtered for food until the hold ends. Take it back against a refund, or record that the customer will keep it alive. A withdrawal hold cannot be released early | 9.2 |
| `RESERVATION_CONFLICT` (`STOCK_EXCEPTION`, REVIEW) | The item was reserved for another order | Decide which order keeps the stock; supply the other from other stock or refund | 8 |
| `NEGATIVE_STOCK` (`STOCK_EXCEPTION`, REVIEW) | Countable stock went negative when the sale synced | Ask the storekeeper to count. Book the unrecorded receipt or the loss by a stock adjustment (approval above the threshold). Cost of sales was understated by the uncovered quantity; the adjustment corrects it | 9.3 |
| `PRICE_OVERRIDE` (REVIEW) | A discount exceeded the server's current limit and is waiting for approval | A manager other than the cashier approves or rejects in the approvals inbox (`GET /iam/approvals?decidableByMe=true`). A rejected override stays on the cashier's override report | 9.6 |
| `DEVICE_COUNTER_GAP` (URGENT) | A counter value for the shift never arrived | See "A counter gap" below | 9.5 |
| `UNMATCHED_PAYMENT` from an unverified mobile money tender (REVIEW, URGENT if the method was not permitted offline) | Mobile money taken offline and not yet verified | Match it to the settlement or statement line (`reconciliation-break.md`, `UNVERIFIED_PAYMENT`) | 9.9 |
| `SYNC_REJECTED` (URGENT) | A sale was refused because its payload hash or identity did not match | See "A rejected sale" below | 9.8 |
| `OFFLINE_LATE_POSTING` (REVIEW, URGENT if dated after a force close) | A sale posted on a later date because its period was locked or its shift had been closed | The accountant reads the item; for a locked period decide whether to accept the timing; for a force close, follow "After a forced close" | 9.4 |
| `SHIFT_OVER_SHORT` after a force close | The shift's over is explained by late-synced sales | The accountant clears the cash with an approved manual journal, as in 9.4.2 | 9.4.2 |
| `AUTHORISATION_FAILURE` at sync (URGENT) | The cashier's grant was revoked while the device was offline, and the sale was recorded anyway | Check why the grant was revoked and whether the sale is genuine; this may be an incident | 7 |
| `DRIVER_VARIANCE` | A driver's cash differs from what was due, or a proof conflicted with a delivery that had changed | Compare the proof, the amount due and the reconciliation | 12 |

## A counter gap

A missing device counter means a sale was made and not synced, or was removed from the device. The response to each sync lists the missing values (`counterGaps`).

1. **Wait for the next sync** from that device; if it was queued behind a failed write, the sale arrives and the gap closes by itself (the item resolves).
2. **If it does not arrive** by the end of the shift: ask the cashier, in the presence of the supervisor, about that sale, and ask whether the customer's receipt carries `P-<register>-<shift>-<counter>`. A customer's receipt for that reference is proof the sale happened.
3. **Look at the money.** The blind close will show the drawer over by the amount of the missing sale (cash in, not recorded) or the cash is gone. Compare the closing count with the expected cash.
4. **Decide.** A genuine sale that cannot be recovered from the device is entered by the manager as a new sale (`completeCounterSale`) with a note naming the provisional reference, and the gap item is closed with that note. A sale that was deleted deliberately is an incident (abuse case 10): `incident-response.md`.
5. The gap itself is never erased; the closing note is audited.

## A rejected sale

`REJECTED_INTEGRITY` means the server could not accept the sale: the hash did not match, the id was reused with different content, a counter was reused for two sales, or the id was not a valid UUIDv7 in the window (often a wrong device clock).

1. **Do not retry it.** Resending the same record gets the same refusal.
2. **Read the audit copy.** The full submitted JSON, both hashes and the device are in the audit event for the correlation id. Compare with the customer's printed receipt (it shows the total and the sale id as a QR code) and the drawer.
3. **A wrong device clock:** set the clock correctly and re-enter the sale as in step 4. Check the other sales from that device and the offset (`serverTime` is in every sync response).
4. **Genuine sale:** the manager re-enters it online as a new sale (`completeCounterSale`, a new id) with the original provisional reference in the note, then closes the item.
5. **Amounts differ from the paper receipt, or the record was edited:** it is an incident. Preserve the device and do not let the cashier use it (revoke it: `POST /devices/{id}/revoke`), and go to `incident-response.md`.

## After a forced close

When a manager force-closes a shift because the device cannot be recovered, queued sales on the device are not lost; they post when the device syncs, on the next open date.

1. Force-close with a reason (`POST /shifts/{id}/force-close`) after counting the drawer.
2. When the device returns, sync it under the manager's session if the cashier has gone (`OFFLINE_SYNC.md` 6.5).
3. Expect `OFFLINE_LATE_POSTING` items and a `SHIFT_OVER_SHORT` item for the shift. A sale dated **after** the force close is URGENT: someone kept selling on a closed shift. Ask who, on which device.
4. The accountant clears the drawer difference with an approved journal as in `OFFLINE_SYNC.md` 9.4.2.

## A device that will not sync

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Queue stuck, "unauthorised" | The access token expired and refresh failed (long offline period, session revoked) | Log in again on the device (cashier or supervisor); the queue sends after login |
| 403 `DEVICE_REVOKED` | A manager revoked the device | Confirm it should be revoked; if not, enrol it again as a new device and send the queue under a manager (6.5) |
| 401 `DEVICE_CREDENTIAL_INVALID` | The stored credential was lost or the device was reset | Enrol a new device; recover the queue before resetting anything if you can |
| 400 `SYNC_BATCH_TOO_LARGE` | A batch over 500 sales | The device splits batches; update the console if this repeats |
| 429 | Too many requests | The device waits for `Retry-After` |
| Queue at 500 and tills refusing sales | `maxQueuedSales` reached | Restore connectivity, or close and reopen the shift on another device |
| Time wrong | Device clock drift | Fix the clock, then sync |
| Nothing sends, network fine | A service worker or storage fault | Do not clear the browser's data: that deletes the queue. Export the queue from the device's support screen, then reinstall; ask the administrator |

**Never clear a device's browser data while it has a queue.** That deletes the only copy of unsynced sales.

## Drivers

`POST /driver/sync` returns `APPLIED`, `DUPLICATE` or `REJECTED` per record, with a reason. Routine: each driver reconciles cash at the end of the day with a person who is not the driver (`POST /driver-cash-reconciliations`). A proof synced after the day's reconciliation was posted creates a variance item, not a correction. Compare the proof's cash collected with the amount due and with what the driver handed in. A `REJECTED` proof (not assigned to the driver, no signature or photograph) is returned to the driver for correction while the delivery is checked by phone.

## Queries for the administrator

```sql
-- sync outcomes for a shift, with exceptions
SELECT device_counter, provisional_ref, outcome, exception_count, client_occurred_at, received_at
FROM pos.sale_sync WHERE shift_id = :shift ORDER BY device_counter, received_at;

-- open stock exceptions from offline sales
SELECT id, kind, product_id, stock_unit_id, qty, raised_at, details
FROM inv.stock_exception WHERE status = 'OPEN' AND kind IN ('SERIAL_CONFLICT','HOLD_CONFLICT','RESERVATION_CONFLICT','NEGATIVE_STOCK')
ORDER BY raised_at;

-- devices that have not synced recently
SELECT d.id, d.device_label, d.last_sync_at, s.id AS open_shift
FROM pos.device_enrolment d
LEFT JOIN pos.shift s ON s.register_id = d.register_id AND s.status <> 'CLOSED'
WHERE d.revoked_at IS NULL AND (d.last_sync_at IS NULL OR d.last_sync_at < now() - interval '12 hours');
```

(Reading as the administrator is a logged use; prefer the console screens for routine review.)

## Verification

- The exception report for the day shows each item with a resolution, annotation or an owner and a date.
- For each shift of the day: no outstanding `counterGaps`; the Z report is signed off by a different person; over or short is explained.
- No device has a queue older than 24 hours, or each one is explained.
- Stock exceptions: `GET /stock/exceptions?status=OPEN` has none older than two working days without a note.
- Unverified mobile money breaks are matched or reversed within the window.

## Escalation

| When | Who |
| --- | --- |
| A withdrawal-hold animal sold | Manager, same day, with the vet's guidance; owner informed |
| Any `SYNC_REJECTED` where the paper receipt differs | Owner; `incident-response.md` |
| A counter gap that is not explained | Owner |
| The same cashier with repeated gaps, overrides or rejections | Owner (a pattern, not an event) |
| A device lost with an unsynced queue | Owner; revoke the device, force-close the shift, count the drawer |
