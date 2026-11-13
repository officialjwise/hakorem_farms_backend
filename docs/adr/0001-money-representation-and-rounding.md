# ADR-0001: Money is integer pesewas, rounded half-up once per line

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief rules that money is never a float, that one representation is used everywhere, that arithmetic never uses JavaScript numbers, and that rounding is half-up and happens once, at the line total. It also fixes "money as integer pesewas" under *Decisions made for you*. What remains open is how unit prices, costs, tax components and split amounts behave so that no pesewa is created or lost.

Three places produce fractions of a pesewa: price times a weighed quantity, a percentage (tax, retention, discount), and a split of one amount across several parties (processing cost across outputs, a distribution across investors, a gross price across net and levies).

## Options considered

1. **Integer pesewas for amounts, `NUMERIC(18,6)` for unit prices and unit costs.** Familiar, but it creates a second money scale. Every conversion between the two is a rounding site, and average-cost stock accumulates residue that never reaches zero.
2. **`NUMERIC(14,2)` cedis everywhere.** Allowed by the brief as an alternative, rejected by *Decisions made for you*. It also permits fractional pesewas to enter through careless arithmetic.
3. **Integer pesewas everywhere, with no stored rates.** Amounts are integers. Anything that looks like a rate (average cost per kilogram, percentage share) is derived on demand from two stored integers and never stored as an authority.

## Decision

Option 3.

**Storage**

- Every monetary amount is stored in a column of the PostgreSQL domain `platform.pesewas`, defined as `BIGINT CHECK (VALUE >= 0 AND VALUE <= 9007199254740991)`. The upper bound is the largest integer JSON and JavaScript can carry exactly.
- Amounts are never negative. Direction is carried by a `side` (`D` or `C`), a `direction` (`IN`, `OUT`, `OVER`, `SHORT`) or the document type.
- Column names end in `_pesewas`.
- Every document header and journal header carries `currency CHAR(3) NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS')`. The API carries money as integer fields named `...Pesewas`, with one `currency` field on each object that carries money (amended in B1 by ADR-0029, which replaced an earlier `{ amount, currency }` object form before any code existed).
- Unit prices are integer pesewas per pricing unit (per head, per kilogram, per crate, per pack).
- No cost rate is stored. Stock value is held as a total value and a quantity (ADR-0018).

**Arithmetic**

- The kernel `Money` type wraps a `bigint`. The TypeScript `number` type is banned for money, quantity and weight by a lint rule delivered in B2.
- Quantities are carried as integer thousandths and weights as integer grams inside the kernel, matching `NUMERIC(14,3)` and `NUMERIC(10,3)`.
- Percentages and other non-integer factors are exact decimals from a decimal library, parsed from strings, never from `number`.
- `half_up(n / d)` for non-negative integers is `(2n + d) div 2d`. Because amounts are never negative, half-up and half-away-from-zero are the same rule.

**The single rounding rule**

Each line has exactly one rounded figure, its *anchor*. Every other figure on the line is derived from the anchor without a second independent rounding of the same quantity.

| Line kind | Anchor | Derived figures |
| --- | --- | --- |
| Tax-exclusive price | `line_net = half_up(unit_price × quantity) − line_discount` | Each levy is `half_up(base × rate)` on an integer base; gross is the sum |
| Tax-inclusive price | `line_gross = half_up(unit_price × quantity) − line_discount` | Net and each levy by largest-remainder allocation of the gross, so the parts sum to it exactly (ADR-0020) |
| Stock issue from a cost pool | `value_out = half_up(pool_value × qty_out / pool_qty)` | The issue that empties the pool takes the whole remaining value |
| Split of one amount | The amount being split | Parts by largest-remainder allocation (below) |

Document totals are sums of line integers. A total is never recomputed from another total.

**Exact-sum allocation**

One kernel function, `allocate(total, weights[])`, is the only way to split an amount:

1. Weights are non-negative integers. Pre-rounded percentages are not accepted as weights.
2. Each part's exact share is `total × w_i / Σw`. Take the floor of each.
3. Hand the leftover pesewas, one each, to the parts with the largest remainders `(total × w_i) mod Σw`.
4. Ties are broken by a stable key supplied by the caller (line number, investor number), lowest first.
5. All weights zero is an error, never an equal split.

A header-level discount is allocated across lines with this function before tax is calculated.

## Consequences

- Float bugs are impossible rather than unlikely, and every stored amount is exact.
- Per-kilogram prices cannot express fractions of a pesewa. This is acceptable: the smallest catalogue price is GHS 35 and a pesewa per kilogram is below any price the farm quotes.
- Cash rounding to the nearest coin is not applied in version one. Tenders are pesewa-exact. It is parked in `docs/BACKLOG.md`.
- Multi-currency is out of scope. The currency column exists so that adding it later is an expand step, not a rewrite.
- The Ghana Revenue Authority's electronic invoicing service may total tax at document level and differ by a pesewa from line sums. Billing documents therefore carry optional certified-total fields (ADR-0020).
- Binds: the `hakorem-money` skill, the kernel package, every `_pesewas` column in `docs/data-model/`.

## Verification

- B2: `Money`, `Weight`, `Quantity` and `allocate` at 100 percent branch coverage, each rounding edge case as a named test (exact half, one below, one above, zero, maximum).
- B2: the allocation test specified in ADR-0028 (three investors, GHS 10,000.01) asserts no pesewa is created or lost.
- B2: a lint rule fails the build on `number` arithmetic in files that import `Money`.
- Database: the `platform.pesewas` domain rejects negative and oversize values in an integration test.
