# Runbook: stock balance drift

Last reviewed: 2026-11-13. Severity: Critical (the books of stock may be wrong). Related: ADR-0002 (movement ledger and on-hand), ADR-0018 (valuation), ADR-0027, `docs/data-model/inv.md`, `docs/runbooks/reconciliation-break.md`, `docs/runbooks/offline-sync-conflicts.md`.

## What drift is

Stock is an **append-only ledger of movements** (`inv.stock_movement`). On-hand quantity per product, stock unit and location is a cache, `inv.stock_balance`, and value per stock unit or per untracked product and branch is another, `inv.cost_pool`. **Only the database trigger on the movement ledger writes them.** The nightly job `stock-balance-recompute` (02:00) recomputes every balance and every pool from the ledger and compares. A difference is **drift**. It is raised as an alert and as an `inv.stock_exception` of kind `BALANCE_DRIFT`, with the offending rows attached, and it is never corrected automatically.

Drift means one of two things, and the whole job is finding out which:

| Which is wrong | What it looks like | What to do |
| --- | --- | --- |
| **The cache** (balance or pool) is wrong; the ledger is right | The ledger sums to the physical stock; the balance row does not | Repair the cache from the ledger, under an incident-log entry (section C) |
| **The ledger** is wrong; a movement is missing, duplicated or mis-signed | The balance row agrees with the ledger arithmetic but the physical count does not | Do not touch the cache. Post a correcting movement through the application (section D) |

Do not decide which by guessing. A physical count decides.

## Symptoms

- Alert: stock balance drift rows (critical, any); `last_stock_recompute` check `DEGRADED`.
- The daily exception report lists `STOCK_EXCEPTION` items with kind `BALANCE_DRIFT`.
- The stock screens disagree with each other (on hand against availability), or a sale is refused with `INSUFFICIENT_STOCK` while the shelf is full, or a negative balance appears where it should not.

## Step 0: is it explained?

Before investigating, rule out the known benign causes.

- **Offline sales** (`SALE_ISSUE_OFFLINE`) may take countable stock negative and raise `NEGATIVE_STOCK` exceptions; negative balance is *not* drift. List them: `GET /stock/exceptions?status=OPEN`.
- **Recent restore.** After a restore the recompute should still agree, because balances are restored with the ledger. Disagreement after a restore is real.
- **A deploy in the last day** that touched inventory triggers or the movement types.

## A. Diagnosis

1. **Read the job summary** for the rows: `SELECT summary FROM platform.job_run WHERE job_name = 'stock-balance-recompute' ORDER BY finished_at DESC LIMIT 1;`. Note the product, stock unit, location and the two figures (cache and recomputed) for each.
2. **Recompute by hand for one row** (read-only):
   ```sql
   -- ledger-derived on-hand for one product, stock unit and location
   SELECT
     coalesce(sum(CASE WHEN to_location_id = :loc THEN qty_base ELSE 0 END), 0)
   - coalesce(sum(CASE WHEN from_location_id = :loc THEN qty_base ELSE 0 END), 0) AS ledger_qty,
     coalesce(sum(CASE WHEN to_location_id = :loc THEN weight_kg ELSE 0 END), 0)
   - coalesce(sum(CASE WHEN from_location_id = :loc THEN weight_kg ELSE 0 END), 0) AS ledger_kg
   FROM inv.stock_movement
   WHERE product_id = :product AND stock_unit_id IS NOT DISTINCT FROM :unit;

   SELECT on_hand_qty, on_hand_weight_kg, reserved_qty, updated_at
   FROM inv.stock_balance
   WHERE product_id = :product AND stock_unit_id IS NOT DISTINCT FROM :unit AND location_id = :loc;
   ```
   Do the same for the cost pool: the sum of `value_pesewas` of the movements into the pool minus those out, against the pool's stored value.
3. **Walk the movements** for that row in time order (`GET /stock/movements?productId=&stockUnitId=&from=&to=` or SQL on `inv.stock_movement ORDER BY occurred_at, recorded_at`), reading the running total. The **first movement at which the running total stops matching the cache's history** is the point of divergence. Note its type, source document, actor and `recorded_at`.
4. **Look for the cause class** at the divergence:

| Cause | How it shows | Notes |
| --- | --- | --- |
| A direct database change (superuser, migration, restore) | `updated_at` of the balance row differs from any movement time; the database log shows the session; no movement matches | Treat as an incident: `incident-response.md`. Triggers should make this impossible for the application role |
| A trigger defect (a code path not updating the balance) | Many rows with the same movement type drift; started with a release | A bug: reproduce in a test, fix, and then repair the cache |
| A movement posted with wrong sign or wrong location | The ledger has a movement that does not match the physical event | The ledger is wrong (section D) |
| A missing movement (a physical event nobody recorded) | The cache and the ledger agree and the shelf does not | The ledger is wrong (section D). This is the usual shrinkage/found-stock case |
| A reservation count error | `reserved_qty` differs, not `on_hand_qty` | Reservation expiry and release path; see `inv.stock_reservation` |
| A concurrency defect | Rare, tied to serialization retries or advisory locking | Bug; include the correlation ids |
| A movement reversed twice or a reversal applied to the wrong original | `reverses_movement_id` chain | The ledger is wrong (section D) |

5. **Establish the truth with a count.** Ask the storekeeper to count that product at that location now (and for an animal, to check it is in the pen the system says). Blind: the counter does not see the expected figure. Record the count with the time. For high-value animals this takes minutes.
6. **Compare the three numbers:** the count, the ledger-derived figure, the cache. Then classify (the table at the top).

## B. Containment while you investigate

- **Do not edit `inv.stock_balance` or `inv.cost_pool`** by hand to make the alert go away. The trigger maintains them, and a hand edit hides the cause.
- **Do not post a stock adjustment to "make the numbers match" before you know which side is wrong.** An adjustment is approved by a second person and changes the ledger permanently.
- If the drift affects what customers can order (a product showing out of stock that is on the shelf), the storekeeper can note it; online listings follow availability. For a serialised animal, the animal register and the pen are the check.
- If the drift is widespread or growing (many rows each night), stop deploying until the cause is found.

## C. The cache is wrong, the ledger is right

1. Open an incident-log entry (superuser use). Record the rows, the two figures, the count, and the evidence from section A.
2. Repair **only** that row (or the few rows), recomputing from the ledger, in a single transaction run by the administrator with a witness. The repair is done by the inventory module's rebuild function (specified for B5, `inv.rebuild_balance(product, stock_unit, location)`), which recomputes the balance and the cost pool for that key from the movement ledger, writes an audit event naming the incident, and refuses to change a key whose recomputed result equals the cache. Until that function exists, the equivalent single statement, run as the superuser with the trigger left enabled and recorded in the incident log, is a recomputing `UPDATE` of that one row with the figures from section A, followed by re-running the recompute.
3. Re-run the recompute for the product (the job can be run by hand) and confirm `SUCCESS`.
4. Fix the cause (code, process). A trigger defect is a high-priority defect: add the failing case to the integration tests against real PostgreSQL, and note the incident in `docs/runbooks/` if the pattern is new.
5. Mark the exception resolved with `POST /stock/exceptions/{id}/resolve` and the note.

## D. The ledger is wrong

1. Decide what physically happened, with the people who were there.
2. Make the correction **through the application, as new records**:
   - A shortage found at count: a stock take (`POST /stock-takes`, counts, review, submit) or a stock adjustment (`POST /stock-adjustments`, reason code from the fixed list, such as `COUNT_ERROR`), above the threshold with approval by a different user.
   - An unrecorded receipt: the goods receipt, or an adjustment gain with a reason.
   - A mis-posted movement (wrong location or sign): reverse it (`POST /stock/movements/{id}/reverse`, once only, may need approval), then post the correct one.
   - A duplicated sale issue: the sale's own reversal path (return, void), not a stock edit.
   - A value error with the quantity right: a value-only cost movement (`COST_CAPITALISE`) or an adjustment as the accountant decides.
3. The correction posts its ledger entries (inventory against shrinkage or gain) through the normal events. The accountant reviews the account effect.
4. Re-run `stock-balance-recompute`; it should agree, because the correction moved ledger and cache together.
5. Resolve the exception with the note and the resolution document.

## E. If the same product drifts again

A second drift in a week on the same product or location is a defect, not a counting problem. Open a bug with the correlation ids of the movements around the divergence, add a test, and tell the owner.

## Verification

- `stock-balance-recompute` run by hand: outcome `SUCCESS`; the health check `last_stock_recompute` is `OK`.
- `GET /stock/exceptions?kind=BALANCE_DRIFT&status=OPEN` is empty; resolved ones carry a note and a resolution document.
- A spot check: the storekeeper's count equals `GET /stock/on-hand` for the product and location, and the value equals the accountant's inventory account for the group (the `subledger-reconcile` job agrees).
- The audit log shows who repaired what (an audit event for the repair, a witness noted in the incident log).

## Escalation

| When | Who |
| --- | --- |
| Any drift not explained within one business day | Owner and accountant |
| Value affected over GHS 1,000 (100,000 pesewas) | Owner |
| Signs of a direct database edit | `incident-response.md` |
| Drift in more than one product after a release | Roll back (`docs/DEPLOYMENT.md` section 7) and open a defect |
