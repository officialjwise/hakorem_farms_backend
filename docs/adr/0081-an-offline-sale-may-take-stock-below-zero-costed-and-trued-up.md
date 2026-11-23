# ADR-0081: An offline sale may take stock below zero, costed at the last known cost and trued up on arrival

- **Status:** Proposed (2026-11-23)
- **Date:** 2026-11-23
- **Session:** B09b continued 3c
- **Deciders:** the owner (decision 2 of 2026-11-18); backend track; the parent session gave leave on 2026-11-23 for the one change to `inv.apply_movement`

## Context

The owner ruled on 2026-11-18 (decision 2, replacing A-278 (f)) that an offline sale may take a location's stock below zero, because the goods were physically sold. The rules are:

- value what was sold at the last known cost;
- true it up when stock arrives;
- flag it on the exception report's source;
- raise a count task for that product at that location;
- online sales keep today's rules.

ADR-0002 keeps the stock-sign rule in the database. A movement may go below zero only if both its type and its location `allows_negative`. The seeded shop floor does not allow it, so until now an offline sale beyond stock moved nothing. Instead it recorded a `NEGATIVE_STOCK` exception in the movement's place.

ADR-0018 said that the quantity an allowed-negative issue takes beyond its pool carries zero value, and that a later stock adjustment corrects cost of sales. That contradicts "valued at the last known cost".

Building this exposed a latent defect in ADR-0018's pool rule. Take a pool at -U with value 0. An arrival of exactly U leaves it at quantity 0 holding the arrival's value. `ck_cost_pool_empty` is an immediate CHECK, which PostgreSQL cannot defer, and it refuses that state inside `inv.add_to_pool`, so the arrival itself is refused. Today only a location that allows negative stock can reach it. The owner's decision makes it an everyday case.

## Options considered

1. **Flip `allows_negative` on every selling location.** No function changes, but it changes existing MDM seed rows, every new location still defaults to false, and the rule would then live in master data that anyone with MDM rights can change back.
2. **Let the pool's value go negative for the uncovered quantity.** The movement would carry the last known cost. That changes `platform.pesewas` and `ck_cost_pool_empty` on a shared table, and 1330 would stop reconciling to the pools.
3. **A value-only true-up after the arrival.** The arrival alone is still refused when it exactly fills the hole (the defect above), and it needs a change to `inv.check_movement`.
4. **Narrow the stock-sign rule to offline sales and keep the cost outside the pool.** On arrival, a nil lift before the arrival and a valued issue after it.

## Decision

Option 4.

- **The sign rule.** `inv.movement_type.negative_anywhere` is true for `SALE_ISSUE_OFFLINE` only (`ck_movement_type_negative_anywhere`: never without `allows_negative`). `inv.apply_movement`'s two "allowed negative" conditions read `(from_location.allows_negative OR mt.negative_anywhere)`; the rest of the function is byte for byte as migration 0044 wrote it.
  - Online `SALE_ISSUE` still refuses (`ck_stock_negative`), and so does every other type.
  - A SERIAL unit never goes negative.
  - `SALE_ISSUE_OFFLINE` is reachable only through `Stock.postOfflineIssueIn`, which only the offline sync calls.
  - `inv.check_movement` is not changed.
- **The cost.** The movement still carries what the branch's pool held (ADR-0018 unchanged). An AFTER trigger on the offline sale's issue, `trg_stock_movement_negative_cost`, writes `inv.negative_stock_cost` (LEDGER, never by hand: `ck_negative_stock_cost`). It records the uncovered quantity at the last known cost, rounded half-up once:
  - the pool's own average when it covered part of the issue;
  - otherwise the latest of an earlier uncovered row's basis and a valued movement of the pool that was not itself short;
  - with no cost ever known, nil, `cost_known` false and the flag URGENT.

  ◆ `inv.NegativeStockCosted` posts it: Dr cost of sales by the product's GL group, Cr **1335 Stock sold ahead of receipt**. 1330 therefore always equals the pools.
- **The true-up.** `Stock.postIn` wraps any arrival into a pool that owes stock. An arrival is a movement that raises a pool: from a virtual location, or a transfer between branches.
  1. `NEGATIVE_TRUE_UP_IN` lifts the owed quantity U at nil value from the branch's ADJUSTMENT location to the arrival's location, so the pool is at zero, never at zero quantity holding value.
  2. The arrival posts unchanged.
  3. `NEGATIVE_TRUE_UP` issues U back out, valued by `inv.check_movement`'s own pool rule. That is exactly half_up(R x U / r), or the whole R for a part arrival.

  The pair nets to zero. `inv.settle_negative_stock` writes `inv.negative_stock_settlement` (LEDGER), oldest uncovered row first and never more than is still uncovered (`ck_negative_stock_settled`, unique per cost row and true-up). The cleared last known cost is cumulative half-up on each row, and the true-up value is split by cumulative half-up on quantity, so both sum exactly. A deferred constraint trigger (`ck_negative_true_up`) refuses at commit a true-up movement that no settlement names, or whose lift and issue differ, or whose settled values do not sum to its value. ◆ `inv.NegativeStockTrueUp` posts:
  - `cleared`: Dr 1335, Cr cost of sales;
  - `trueUp`: Dr cost of sales, Cr inventory.

  Cost of sales moves by exactly the difference, and 1335 is back to zero once everything is settled.
- **The flag and the count.**
  - The `NEGATIVE_STOCK` exception is raised by the trigger as before. It goes to the exception report's source with abuse cases 11 and 36: REVIEW, or URGENT when no cost was known.
  - `trg_stock_exception_count_task` opens one `inv.count_task` (WORK) per product, unit and location, for an offline sale's `NEGATIVE_STOCK`.
- **The latent defect.** `ck_cost_pool_empty` is unchanged, which would need leave. The wrapper means no arrival into an owing pool reaches it. An arrival into a pool that went negative before this migration, with no cost row, is outside the wrapper and still meets today's rule (runbook line in `docs/runbooks/stock-balance-drift.md`).

## Consequences

- The stock-sign rule stays in the database, narrowed to one exception by the owner's decision; every other type keeps its rule (tested, and proved by mutation).
- Every arrival into a pool that owes nothing is exactly as before: one movement and its own journal (tested by comparison).
- The ledger holds two more movement types, which always come in pairs, net to zero, and are named by their settlement. Reports of movements by type see them.
- A partial arrival at a location that is itself still below zero takes it further below zero for a moment inside the transaction. Its issue raises the trigger's own `NEGATIVE_STOCK` exception for the remainder. That is true, and it raises no second count task.
- The trigger's exception note ("the uncovered quantity carried no cost") is now only half true. The cost row and the flag carry the true fact, because the trigger's text is part of the function kept byte for byte.
- Binds `docs/data-model/inv.md` and `docs/data-model/fin.md`, ADR-0002 and ADR-0018 (amended), and ADR-0003 (amended).

## Verification

- `test/integration/pos/negative-stock.integration.spec.ts` covers, every figure by SQL over the movements, pools, cost and settlement rows and journal lines, with 1330 reconciled to the pools after every step:
  - the sync end to end;
  - a dearer arrival, and a cheaper one that overfills;
  - a part arrival of 3 against 5 owed, then the rest;
  - two sales at two last known costs, settled oldest first;
  - no known cost;
  - a transfer between branches that fills exactly, fills part, and overfills;
  - an arrival that owes nothing;
  - the online refusal;
  - the database guards.
- The mutations are recorded in the B09b continued 3c report.
