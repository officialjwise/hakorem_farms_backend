# ADR-0075: A bought lot is valued by its place in the delivery

- **Status:** Accepted (owner, 2026-11-17: option B, chosen after B09e stopped on the conflict with ADR-0018 and reported the options, with two conditions: the rounding mode and cost added to a delivery, both below). Supersedes ADR-0018's issue rule for bought lots only; the rest of ADR-0018 stands.
- **Date:** 2026-11-17
- **Session:** B09e
- **Deciders:** owner; backend track built it

## Context

The business starts with eggs bought from a supplier and resold. The owner's decision 2 of 2026-11-17: keep each delivery's total cost and spread it across its eggs without drift, never rounding cost egg by egg. A crate bought at GHS 47.50 and sold whole posts cost of exactly 4,750 pesewas, and a crate broken into singles posts costs summing exactly to 4,750.

ADR-0018 values an issue of `q` from a pool of `Q` holding `V` at `half_up(V x q / Q)`, and the pool keeps what is left. A lot's pool therefore sums exactly over its life. But each single egg rounds against what the pool holds at that moment, so a whole crate sold after singles from the same delivery drifts. B09e measured this in exact integers:

- **2 crates (9,500 pesewas, 60 eggs):** sell 3 singles, then a crate. The crate posts 4,751.
- **10 crates:** after one single, the next 30 singles sum to 4,740.
- **A random mix of crates and singles:** a whole crate posts up to 6 pesewas off.

The kernel's `allocate` over 300 equal eggs is worse. Ties go to the lowest key, so the first crate of a 10-crate delivery posts 4,770. B09e stopped and reported three options:

- **A.** Keep ADR-0018 and accept the drift.
- **B.** Value each issue by its place in the delivery.
- **C.** Make one lot per crate.

## Decision

Option B, for bought lots only.

- **A bought lot** is a lot-tracked stock unit whose pool a `RECEIPT_PURCHASE` (not a reversal) brought in. That receipt anchors the pool: `inv.cost_pool.anchor_qty` and `anchor_value_pesewas` (Q0 and V0, migration 0214) are set by the database to what the pool then holds. For a new lot, that is the delivery.
- **The issue value.** An issue of `q` from a physical location, with `p = Q0 - Q` (the eggs already gone), carries `half_up(V0 x (p + q) / Q0) - half_up(V0 x p / Q0)`, in exact thousandths. This is the rule ADR-0068 uses for returns.
  - Taking the whole pool (`q >= Q`) still carries all of it.
  - A pool at or below zero still carries nothing (ADR-0018).
  - Because `half_up(x + 4,750) = half_up(x) + 4,750`, a crate whose price is a whole number of pesewas always carries exactly that price, whatever was sold before it. Any 30 eggs in a row carry it too, and the delivery sums to V0.
- **The rounding is half-up, never half-to-even (the owner's first condition).** The running-total rule is exact only if the rounding commutes with adding a whole number: `round(x + n) = round(x) + n`. Round-half-up on non-negative values has that property (`inv.half_up_div(n, d) = div(2n + d, 2d)`, the kernel's `half_up`), and so does floor. Round-half-to-even does not: at an exact half it rounds 2,375.5 up but 7,126.5 down, so a crate at an odd price such as 4,751 would post 4,750 or 4,752. The error hides at 4,750 because every exact half there lands on the same parity. Half-to-even is never used here.
- **On schedule.** A pool is on its delivery's schedule when `p >= 0` and it holds exactly `V0 - half_up(V0 x p / Q0)`. Each issue keeps it there.
- **Reversals.** A reversal carries the value of the movement it reverses (ADR-0018). Reversing the latest issue puts the pool back on schedule. Reversing an earlier one, or reversing the receipt, can leave it off schedule.
- **Value-only additions, gains and returns.** A `COST_CAPITALISE` (or any value-only movement), an adjustment or stock-take gain, or a customer return valued by ADR-0068 adds to the pool as before. If that leaves the pool off schedule, the next issue re-anchors it at what it then holds (`Q0 := Q`, `V0 := V`, `p := 0`), and the rule continues from there. Its issues still sum exactly to what it holds. A whole-crate return of a whole-crate issue keeps the schedule.
- **Cost added to a delivery (the owner's second condition).** Transport, or any value-only addition, joins the delivery's value. If the new total no longer divides evenly by the delivery's crates, a whole crate may be 1 pesewa off the even share, but the delivery still totals exactly. For example, 3 crates at 4,750 plus 100 of transport make 14,350 over 90 eggs. The crates post 4,783, 4,784 and 4,783, summing to exactly 14,350, and none is more than 1 pesewa from 4,783.33. The rule cannot make a non-integer share whole; it only guarantees the exact total and a share at most 1 pesewa away.
- **Transfers.** A transfer within the branch shows the schedule value of the eggs it moves and changes neither the pool nor the schedule. A lot's pool stays at its own branch (ADR-0018).
- **Everything else keeps ADR-0018's rule** on what the pool holds: an untracked product's weighted-average pool, an animal, a lot made by processing, harvest or opening stock.
- **In the database only.** The BEFORE trigger `trg_stock_movement_delivery_cost` sets the value after `trg_stock_movement_check`. The AFTER trigger `trg_stock_movement_pool_anchor` anchors the receipt. No caller's value is ever used.

## Consequences

- A bought lot's cost of sales never drifts against the delivery: whole crates post their price, and singles from a crate sum to it.
- The inventory accounts still equal the pools. The pool is still the one source of stock value, and the anchor is only how the next issue is valued. The nightly reconciliation compares quantity and value as before.
- A pool re-anchored after a gain or a value-only addition may again post a crate a pesewa either side of its price. That is the stated, exact behaviour, and the lot still sums to what it holds.
- Binds: `docs/data-model/inv.md` (the anchor columns), the `hakorem-stock` skill (checklist item 11), the INV card in `docs/MODULE_BOUNDARIES.md`, A-259.

## Verification

- `test/integration/inv/delivery-cost.integration.spec.ts`, written first and seen red (4 of 11 failed on the ADR-0018 rule; the owner's two conditions added 3 more tests):
  - The 3-singles case posts 158, 159 and 158, then the crate at 4,750.
  - The 1-single case posts 3 whole crates at 4,750.
  - A seeded random mix of 120 sales posts every crate at 4,750 and the delivery at 47,500.
  - 30 singles in a row sum to 4,750.
  - Reversal, value-only addition, gain and transfer each behave as above.
  - The untracked pool and an opening-stock lot still post 4,751 (ADR-0018).
  - At 4,751 a crate, after 15 singles (the running total at 2,375.5) the next crate posts exactly 4,751. A 10-crate mix that passes through exact halves posts each of its 7 crates at 4,751, and the delivery at 47,510.
  - 3 crates plus 100 of transport post 4,783, 4,784 and 4,783, summing to 14,350.
- The seeded trading day (eggs counted per egg and sold by the crate) keeps the trial balance at 0 and each inventory account equal to the cost pools (`test/integration/fin/trial-balance.integration.spec.ts`).
- Mutation runs (B09e report), each failing the spec:
  - the anchor never set (4 red);
  - the schedule check dropped (2 red);
  - half-to-even swapped in for half-up (2 red: the two 4,751 tests, while every 4,750 test stays green, which is why the odd price is tested).
