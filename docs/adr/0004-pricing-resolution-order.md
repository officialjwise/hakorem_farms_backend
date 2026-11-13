# ADR-0004: Pricing resolution order, and what happens when nothing resolves

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief states that price is a function, not a column. A goat sells between 120 and 3,000 cedis depending on size. The engine must resolve a price from product, grade or weight band, channel, customer tier and any active promotion. Every sale line records the resolved price, the rule that produced it, the agreed price, and who approved any variance and why. Anything the engine cannot resolve becomes a quote. Price lists carry effective dates and need approval before going live. Pricing logic needs 100 percent branch coverage.

## Options considered

1. **Specificity scoring across all lists at once.** Every matching rule gets a score and the highest wins. Nobody can predict the winner by reading the data, and a contract price can lose to a promotion.
2. **Fixed order of lists, first hit wins, with tie-breaking by date and identifier.** Predictable, but a tie-break is a rule nobody remembers until it bites.
3. **Fixed order of lists, first hit wins, with overlapping rules made impossible by a database constraint.** There is never a tie to break.

## Decision

Option 3.

**Data**

- `mdm.price_list` has a `kind`: `CUSTOMER`, `TIER` (customer tier and channel), `CHANNEL` or `BASE`.
- `mdm.price_list_version` is drafted, approved by a second user, then activated with a validity range. Once activated it is immutable, so a sale line's rule reference reproduces the same price forever. Two active versions of one list cannot overlap in time (exclusion constraint).
- `mdm.price_list_entry` holds `product_id`, optional `grade_id`, optional `weight_band_id`, a `basis` (`PER_HEAD`, `PER_KG`, `PER_UNIT`), `list_price_pesewas`, `floor_price_pesewas`, `ceiling_price_pesewas` and a `quote_only` flag. Within one version, the combination of product, grade and band is unique, with missing grade and band treated as values.

**Resolution**

Input: product, optional grade, optional weight (mapped to a weight band), channel, customer (optional), quantity, branch, date and time.

1. If the line originates from an accepted quote, the quoted price is the price and the quote line is the rule reference. The engine is not consulted.
2. Otherwise the engine walks the lists in this order and takes the first that has a matching entry:
   1. the price list assigned to the customer;
   2. the list for the customer's tier and the channel;
   3. the list for the channel;
   4. the base list.
3. Inside a list, the most specific entry wins: product with grade and band, then product with band, then product with grade, then product alone.
4. An entry marked `quote_only` stops the walk. The engine does not fall through to a more general list.
5. Promotions and coupons are applied afterwards, as separately recorded adjustments, and only to prices that came from the tier, channel or base lists. A customer's contract price is never discounted by a public promotion. Stacking follows the promotion's `stack_group`: at most one promotion per group, and an `exclusive` promotion excludes all others.
6. Tax is calculated last (ADR-0020).

**Result**

The engine returns a typed value and never throws for a business outcome:

- `Resolved { list_price, floor_price, ceiling_price, basis, price_list_entry_id }`
- `QuoteRequired { reason }` where reason is `NO_RULE`, `QUOTE_ONLY` or `MISSING_GRADE_OR_WEIGHT`

It never returns zero as a price and never guesses.

**Agreed price and variance**

- The order line stores the resolved list price, floor, ceiling, the rule reference, the agreed unit price, the variance amount and direction, the reason code, and the approval reference if one was needed.
- An agreed price between floor and ceiling is recorded as a variance and needs no approval, provided the variance is within the user's role limit for the shift.
- An agreed price outside the band, or beyond the role limit, needs approval by a different user (ADR-0017).
- Every variance posts to account 4210 (ADR-0003).

**When nothing resolves**

| Channel | Behaviour |
| --- | --- |
| Storefront | The product shows "Request a quote". Submitting creates a request for quote |
| Counter | The line cannot be added to the sale. The cashier raises a counter quote, which a user with quoting authority prices and approves; the accepted quote then converts to the sale |
| Wholesale order entry | The line is saved as needing a quote and the order waits |

The pricing engine lives in the MDM module's pricing sub-domain and never imports the quotation module.

## Consequences

- Anyone can predict a price by reading the lists in order. The engine's result includes the list it stopped at, so support can explain any price.
- Live animals priced in a band (floor to ceiling) give the counter room to negotiate without an approval for every sale, while every negotiated amount is still recorded and posted.
- A product with no price is unsellable at the counter until someone prices it. That is intended: an unpriced sale is the easiest fraud to hide.
- Promotion definitions live with pricing, not with the online store, so the engine does not depend on a sales channel.
- Binds: `docs/data-model/mdm.md`, the `hakorem-pricing` skill, order lines in `docs/data-model/ord.md`.

## Verification

- B4 gate: a price resolves correctly for every band, channel and customer tier in the reference catalogue, and an unresolvable request becomes a quote rather than an error.
- B4: 100 percent branch coverage on the engine; a test per row of the resolution order and per `QuoteRequired` reason.
- B4: an integration test proves two overlapping active versions, and two entries for the same product, grade and band, are rejected by the database.
