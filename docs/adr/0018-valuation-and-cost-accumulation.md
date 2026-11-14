# ADR-0018: Stock valuation and cost accumulation live in the inventory module

- **Status:** Proposed (awaiting B0 gate; accounting basis to be confirmed by the accountant before B8)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires valuation by weighted average cost with specific identification for serialised animals, cost accumulation per animal, pen, batch and processing order covering purchase, feed, veterinary, labour and overhead, and processing cost allocated across outputs by relative sales value. The B6 gate is that a processing order produces lots whose costs sum exactly to the input cost plus direct processing cost. ADR-0001 forbids stored cost rates.

The brief lists costing (CST) as its own module. If both inventory and costing held the cost of a goat, the two figures would need reconciling for ever.

## Options considered

1. **Costing module owns cost; inventory owns quantity.** Two sources for the value of stock, and the ledger posting for a sale needs both.
2. **Inventory owns cost as a rate per unit.** One source, but a stored rate reintroduces rounding residue.
3. **Inventory owns cost as a total value per cost pool; costing only analyses.**

## Decision

Option 3.

**Cost pools**

`inv.cost_pool` holds `qty` and `value_pesewas` for:

- each stock unit, wherever it is located: one animal (specific identification) or one lot or flock;
- each untracked product per branch (moving weighted average).

It is a projection maintained by the movement trigger (ADR-0002).

**Movements carry value**

| Movement | Value rule |
| --- | --- |
| Receipt | Adds its value and quantity to the pool. Purchase value is the order line net plus non-reclaimable levies |
| Value-only (`qty_base = 0`) | Adds value to the pool, tagged with a `cost_element`: `PURCHASE`, `FEED`, `VETERINARY`, `LABOUR`, `OVERHEAD`, `PROCESSING` |
| Issue of `q` from a pool of `Q` with value `V` | Carries `V` if `q = Q`, otherwise `half_up(V × q / Q)`. The pool is reduced by exactly that |
| Transfer within a branch | No change to the pool |
| Transfer between branches (untracked product) | Issue from one pool, receipt into the other, at the issue value |
| Reversal | Carries the value of the movement it reverses |

A serialised animal has `Q = 1`, so its sale or death always carries its whole accumulated cost. For a catch-weight lot the base quantity is kilograms, so issues are valued by weight.

If an allowed-negative movement issues more than the pool holds, the uncovered quantity carries zero value and the stock exception record states that cost of sales is understated for that movement. Resolving the exception posts the correction through a stock adjustment.

**Cost accumulation**

- Feed issued to a pen: the livestock module records the consumption, inventory issues the feed, and the feed's value is spread across the stock units in the pen by head-days using `allocate` (ADR-0001), as value-only movements.
- Veterinary products and services: the same, to the animal, batch or pen treated.
- Labour and overhead: the costing module runs a periodic allocation and posts value-only movements through inventory's interface.
- Animals are marked `GROWING` or `BREEDING`. Cost is capitalised onto growing stock and expensed for breeding stock (ADR-0003).
- Births enter at nil cost and accumulate from there.

**Processing**

- Total input cost is the sum of the consumed units' pool values plus direct processing cost.
- Each output's weight for allocation is its weight in grams multiplied by the reference sale price per kilogram, snapshotted on the output row at completion. Waste has weight zero and takes no cost.
- `allocate` splits the total across outputs. Each output lot's pool starts at its allocated value.
- A deferred constraint trigger on the processing order asserts that the allocated values sum exactly to the total input cost.
- Expected against actual yield is recorded and flagged; a yield variance is not posted as a separate figure.

**Costing module**

CST owns no cost of record. It reads inventory's published views and events and builds projections: cost per animal, pen, batch and processing order by element; margin by product, line, channel, customer, salesperson and branch; loss by cause.

## Consequences

- The value of stock has one source, which reconciles to the inventory accounts in the ledger.
- A sold meat lot traces back through `inv.stock_unit_lineage` to its animal, and the animal's value-only movements show its purchase, feed and veterinary cost.
- No pool can be left with value and no quantity.
- The cost model for livestock, nil-cost births and the treatment of breeding stock are accounting choices. They are recorded as assumptions for the accountant.
- Binds: `docs/data-model/inv.md`, `docs/data-model/prc.md`, `docs/data-model/cst.md`, the `hakorem-stock` skill.

## Verification

- B5: exact-value tests for average cost issue, including the issue that empties a pool and a rounding edge case.
- B6 gate: a processing order produces lots whose costs sum exactly to input cost plus direct processing cost.
- B6: a feed allocation across a pen sums exactly to the feed value issued.
- B8: nightly reconciliation of pool values against inventory accounts.
