# ADR-0098: A quote holds its count from issue, its animals are named at picking, and a quoted line books at its list

- **Status:** Proposed (the four decisions are the owner's of 2026-11-23 on UAT scenario 2, approved as recommended; how they are built, A-350 to A-354, is for the owner's review)
- **Date:** 2026-11-24
- **Session:** B11u, the UAT scenario 2 corrections (lane B)
- **Deciders:** the owner (the four decisions and the answers to A-328 (c) and A-329 (b)); backend track built it

## Context

B10 continued 5's dry run of UAT scenario 2 found four differences, which the owner decided on 2026-11-23, verbatim:

1. "Price variance: post list price to sales (4000) and the difference to price variance (4210), above or below list. This reverses A-310 (a) in the booking only; the customer still pays the quoted price."
2. "Reserve by count at issue, capped at what is available, released when the quote expires, is replaced or withdrawn, and passed to the order on conversion. Holds end with the quote, so stock never stays locked by a quote nobody answers."
3. "Tax the delivery fee in the estimate by the invoice's rule, so the quote and the invoice agree to the pesewa."
4. "Convert without tags; tags are named at picking."

Three facts constrain how. INV's reservation of a serialised product must name its animal (`inv.apply_reservation` keeps the reserved quantity on the animal's own balance row, and one animal is promised once, ADR-0019); INV may only be changed additively by lane B. ORD's `ck_sales_order_line_serial` required every line of a serialised product to name its animal from the start (FR-ORD-004). And a pick names stock and moves none, checked against what the pick location holds that nobody else is promised (ADR-0091).

## Options considered

For the hold by count:

1. **A count-only reservation in INV** (a product and a location, no animal). It needs a change to `inv.apply_reservation` and to the movement check, a shared module's existing behaviour.
2. **Hold that many animals by name at issue**, oldest first, chosen by QUO from INV's promisable stock through the existing `Reservations.reserveIn`, and let the picker name whichever animals go, free or the order's own. No INV change; the count is exact; the animals held are not the ones the buyer is promised.

For the tags: (a) name the held animals on the order lines at conversion, which then binds the picker to them; (b) leave each head's line without an animal until the picker names it.

For the booking: (i) a new posting rule for QUOTE lines in FIN; (ii) let the converted line carry its list price beside the quoted one, so BIL's existing variance and FIN's existing 4210 rule book it as any other variance.

## Decision

Option 2, answer (b) and option (ii).

- **The hold.** At issue, a line of animals that names none holds that many animals, oldest first, capped at what is free and never below zero; a line naming a weight band holds only animals whose last weighing is in the band. Every existing end of a quote releases its hold in its own transaction (expiry by the application clock, a new issued version, a decline, a withdrawal); an accepted quote keeps its hold until the order takes it (A-310 (b)). Conversion hands every reservation to the order in its own serializable transaction (`transferHeldByIn`), so nothing is free in between.
- **The tags.** `convertQuote` makes one order line a head with no animal; ORD's guard (migration 0349) lets only a `QUOTE` line wait for its animal while it is open, backordered, cancelled or substituted, and names it once. The picker names each animal (`recordPicks`): of the line's product, at the pick location, free or the order's own, never another's and never twice (ADR-0091's check). Dispatch and collection write the picked animal onto its line before the line is fulfilled.
- **The booking.** The converted line keeps as its resolved price the list its quote line recorded at issue (a banded line priced at its band), as its agreed price the quoted one, and the difference as its variance under `QUOTED_PRICE`, a server-only reason in a domain of its own (migration 0348). BIL credits sales at the resolved price and posts the difference to 4210, as for every line (ADR-0003's `bil.InvoiceIssued` row); FIN's rules and `sale-posting.ts` are unchanged.
- **The tax.** The estimate taxes its delivery fee as a `DELIVERY_SERVICE` line of the version's one tax calculation, in its pricing mode, as dispatch bills it.
- **The owner's answers.** The buyer sees, per line, how much of their own quantity is available now, capped at what the line asks (A-353); a quote withdrawn after issue is its own outcome in the pipeline, outside the win rate, with its reason, published as `quo.QuoteWithdrawn` (A-354).

## Consequences

- "Reserved goats rise by 20" (UAT step 2.3) is true by count; the animals held may be others than those picked. An animal held but not picked is released at dispatch with the rest of the order's promises.
- A picked animal the order does not hold may in principle be promised to another buyer until dispatch, which then refuses (ADR-0091's consequence, unchanged).
- An order whose hold is short reserves the rest at confirmation from any animal of the product (an order line carries no band, BL-124).
- The customer's documents, totals and tax are unchanged by the booking; only the split between sales and 4210 moves. Orders converted before 2.43.0 keep their rows.
- New abuse paths: a quote used to hold stock away from other buyers (case 64) and a withdrawal used to hide a loss from the win rate (case 65), both published for B12's exception report. No cap on a quote's hold exists in the sources (BL-122).
- Binds: `docs/data-model/quo.md`, `docs/data-model/ord.md`, `docs/data-model/mdm.md`, the QUO and ORD cards in `docs/MODULE_BOUNDARIES.md`, ADR-0003 Amendments, A-350 to A-354.

## Verification

`test/integration/quo/uat-scenario-2-corrections.integration.spec.ts` (12 tests) over the seeded farm: the three bookings with their exact journals; holds by count, by band, released at expiry, replacement and withdrawal; the hand-over with no gap while a rival quote asks for every goat at the same moment; a quote and an invoice agreeing to the pesewa (a fee taxed on top, and one taxed inside levy by levy where the whole rate rounded at once differs); a conversion with no tags and the picks that name them, refused for no animal, another's and one twice; the database refusing an unnamed fulfilled line and a changed animal; the buyer's figure; the win rate with and without a withdrawn quote. Unit: `ord/domain/quoted-line.spec.ts` (100 percent gate), `quo/domain/quote.spec.ts`, `quo/domain/pipeline.spec.ts`. Each rule was mutation-checked (the B11u report).
