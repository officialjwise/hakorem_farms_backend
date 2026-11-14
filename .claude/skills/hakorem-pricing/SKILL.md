---
name: hakorem-pricing
description: "Use when working on the pricing engine or anything that decides what a line costs a buyer: price lists, price list versions and entries, `mdm.price_list_*`, grades and weight bands, price bands (floor, list, ceiling), effective dating of prices, activating a price list, customer tiers and assigned lists, promotions, coupons and stacking, the `Resolved` and `QuoteRequired` results, price overrides and agreed price against list price, variance reason codes and approval thresholds, quotes and request-for-quote pricing, quote below margin floor, or the order-line fields that record the resolved price and its rule. Arithmetic on the resulting amounts is hakorem-money; the variance posting to account 4210 is hakorem-ledger; the printed price on a document is hakorem-documents."
---

# Pricing: a function with a fixed order, not a column

Decision: `docs/adr/0004-pricing-resolution-order.md`. Related: `docs/adr/0017-authorisation-and-maker-checker.md` (variance approval), `docs/adr/0020-tax-engine-named-levies.md` (tax comes last), `docs/adr/0019-reservations-and-holds.md` (`REQUEST_TO_BUY`). Tables: `docs/data-model/mdm.md` (pricing and tax), `quo.md`, `ord.md`. The engine lives in the MDM module's pricing sub-domain.

## Checklist

1. **Resolution order is fixed and first hit wins.** (a) A line from an accepted quote takes the quoted price and the quote line is the rule reference; the engine is not consulted. Otherwise walk (b) the customer's assigned list, (c) the list for the customer tier and channel, (d) the channel list, (e) the base list. Inside a list the most specific entry wins: product with grade and band, then product with band, then product with grade, then product alone.
2. **`quote_only` stops the walk.** The engine does not fall through to a more general list.
3. **Promotions come after, as separately recorded adjustments**, only on prices that came from the tier, channel or base lists. A customer's contract price is never discounted by a public promotion. At most one promotion per `stack_group`; an `exclusive` promotion excludes all others.
4. **Tax is calculated last** by the MDM tax calculator (ADR-0020); pricing never embeds a rate.
5. **The engine returns a typed value and never throws for a business outcome.** `Resolved { listPrice, floorPrice, ceilingPrice, basis, priceListEntryId }` or `QuoteRequired { reason }` with reason `NO_RULE`, `QUOTE_ONLY` or `MISSING_GRADE_OR_WEIGHT`. It never returns zero and never guesses. It returns the list it stopped at so support can explain any price.
6. **No overlaps, by constraint, not code.** An exclusion constraint prevents two active versions of one list overlapping in time; a unique key prevents two entries for the same product, grade and band within a version (missing grade and band count as values). Do not add a tie-breaker; make the overlap impossible.
7. **Versions are immutable once active.** Draft, approved by a second user, then activated with a validity range (maker-checker, step-up for activation). A sale line's rule reference must reproduce the same price forever, so never edit an active version (only `status` to `SUPERSEDED` and `valid_to` may change, and its entries are frozen with it); draft a new one.
8. **Order lines record the whole story.** Resolved list price, floor, ceiling, rule reference, agreed unit price, variance amount and direction, reason code, approval reference when needed. Cost and price are separate fields everywhere, including the API.
9. **Variance rules.** An agreed price between floor and ceiling is a recorded variance and needs no approval when within the role's limit for the shift. Outside the band, or beyond the role limit, it needs approval by a different user and returns `202 ApprovalPending`; nothing takes effect until approved. Every variance posts to 4210 with the shift as source.
10. **Unresolved means a quote, never an error and never zero.** Storefront shows "Request a quote". Counter: the line cannot be added; the cashier raises a counter quote, a user with quoting authority prices and approves it, and the accepted quote converts to the sale. Wholesale: the line is saved as needing a quote and the order waits. An unpriced product is unsellable.
11. **Live animals are `REQUEST_TO_BUY` online**, opening a request for quote rather than a cart line.
12. **The engine never imports QUO.** A quoted price is passed in by the caller. Promotions live in MDM, not SHP.
13. **Offline caches are caches.** The device holds prices with an age; the server re-prices every synced sale and raises an exception if an override exceeds the server's limit (hakorem-offline).

## Correct and incorrect

```ts
// RIGHT: a typed result, the caller decides what to do with QuoteRequired
const result = pricing.resolve({ productId, gradeId, weight, channel, customerId, qty, branchId, at: clock.now() });
switch (result.kind) {
  case "Resolved":      return priceLine(result);               // floor/ceiling/list/entryId kept on the line
  case "QuoteRequired": return requireQuote(result.reason);     // NO_RULE | QUOTE_ONLY | MISSING_GRADE_OR_WEIGHT
}
```

```ts
// WRONG: guessing, falling through a quote_only entry, and discounting a contract price
const price = customerList.find(productId)?.listPricePesewas ?? baseList.find(productId)?.listPricePesewas ?? 0n;
if (promo) price = price - promo.amount;   // public promotion applied to a customer's contract price
```

```sql
-- RIGHT: overlap is impossible, so there is never a tie to break
ALTER TABLE mdm.price_list_version
  ADD CONSTRAINT ex_price_list_version_no_overlap
  EXCLUDE USING gist (price_list_id WITH =, tstzrange(valid_from, valid_to) WITH &&) WHERE (status = 'ACTIVE');
```

## Test expectations

100 percent branch coverage on the engine (`docs/TEST_STRATEGY.md`). Written test-first: one test per row of the resolution order, one per `QuoteRequired` reason, one for `quote_only` stopping the walk, one for a promotion refused on a customer list, one per stacking rule, and an integration test proving the database rejects overlapping versions and duplicate entries. The B4 gate: a price resolves correctly for every band, channel and customer tier in the reference catalogue (`docs/SHARED_BRIEF.md`, Reference catalogue), and an unresolvable request becomes a quote. Band values are seeded data configured by the owner, never constants in code.
