# B11u: the UAT scenario 2 corrections (lane B)

Date: 2026-11-24 · Branch `b11u-uat-scenario-2-corrections`, from `main` at `3d4ad3e` (#141, B11 continued 13) · Status: **gate passed locally; CI and the merge are named in the closing message to the parent session.** This closes lane B.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-350 | **The booking (item 1).** The list is the one the quote line recorded at issue (never the engine at conversion); a line the engine did not price keeps its quoted price as list, no variance; **a banded line with no animal is now priced at its band** (the band's lowest weight), so it records that list, and a price below the band's floor now needs the margin approval (LOUD); floor the lowest of engine floor, list and quoted price, ceiling the higher of list and quoted price (no second approval); the variance under `QUOTED_PRICE`, a server-only reason in its own domain; orders converted before 2.43.0 are not rewritten. `sale-posting.ts` and FIN's rules were **not** changed: BIL already books resolved to sales and the difference to 4210. | Owner, Accountant |
| A-351 | **The hold and the tags (items 2 and 4, ADR-0098).** A line of animals naming none holds that many animals by name at issue (INV can only reserve an animal by name; no INV change), oldest first, capped at what is free, of its band (an animal never weighed is not held for a banded line); released by the existing expiry, supersede, decline and withdraw paths in their own transaction; handed to the order at conversion in one transaction; animals given at conversion in place of the held ones release those. The picker names each animal (free or the order's own, never another's, never twice); dispatch or collection writes it onto the line. **A-310 (b) unchanged.** An order short of its hold reserves the rest from any animal of the product at confirmation (no band on an order line, BL-124). | Owner |
| A-352 | **The estimate's tax (item 3).** The fee is a `DELIVERY_SERVICE` line of the version's one calculation, in its pricing mode; issued versions keep their stored figures; the order's estimate (and so its credit check) stays before tax: 17,160.00 where UAT 2.9 reads 17,172.00. | Owner, Accountant |
| A-353 | **The buyer's figure (A-328 (c), the owner's answer).** Base unit, read live, held plus free now, capped at the line's quantity; null for free text and once declined or expired; the request-size limits kept; a buyer whose quote asks more than the farm has sees that product's free stock up to the quote (staff set the quantity; a cap is BL-122). | Owner |
| A-354 | **Withdrawn (A-329 (b), the owner's answer).** A quote cancelled after issue; `withdrawn` and `withdrawnValuePesewas` beside the rate, in neither `issued` nor the rate; `Quote.cancelReason` shown; `quo.QuoteWithdrawn` published (case 65). | Owner |
| A-355 | **The differences that remain in UAT scenario 2 (below), none of the six decided:** conversion to `DELIVERY` refused (A-310 (e)); a backorder not reserved (A-366 (a)); a quote's cost the product's average pool, not the band's; the credit check's fee tax. | Owner |

**For the parent session to schedule (larger than this phase, not started):** BL-123, `convertQuote` to a delivery order and a backorder that keeps its hold, without which UAT scenario 2 steps 2.13 and 2.15 run only as a collection; BL-124, a quote's cost from the animals it holds and the order's estimate with the fee's tax. **The owner's open question, unchanged:** should an accepted quote's hold also end at a set time (A-310 (b))?

**No ADR conflict, and no stop.** ADR-0019 is followed (a reservation never above what is free; a quote's lifetime its validity; one animal once), ADR-0091 (a pick names stock and moves none; it is checked against what is free or the order's own), ADR-0081 (a balance below zero is nothing; online never below zero), ADR-0067 (expiry by the application clock; no new `now()` in business SQL), ADR-0003 (amended to say what the system does). FR-ORD-004 is amended on the owner's decision. **Shared modules, additive only:** MDM (one reason code and its domain, the `listReasonCodes` enum), nothing in INV, FIN, BIL, PAY, POS or IAM; `sale-posting.ts` untouched. ORD and QUO are lane B's.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11u, the UAT scenario 2 corrections, lane B (`b11u-uat-scenario-2-corrections`, from `main` 3d4ad3e), its opener written first (`325ce69`).
2. **Scope:** the owner's four decisions of 2026-11-23 (booking at list, hold by count, the fee's tax, convert without tags), the answers to A-328 (c) and A-329 (b), the margin sweep, the scenario 2 rerun.
3. **Gate:** as the opener states it. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `3d4ad3e`, on a clean extract: **363 files, 4,323 tests passed, none failed or skipped. Statements 94.19 %, branches 83.98 %, functions 97.96 %, lines 97.28 %.**

## Contract changes

**2.43.0, minor** (the entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter removed or retyped; no operation added. **LOUD:**
- A converted order's lines now carry the quote line's recorded list as `resolvedUnitPricePesewas` and a `QUOTED_PRICE` variance (all four prices were the quoted price before); the customer's figures are unchanged.
- A banded quote line with no animal is now priced at its band: `resolvedUnitPricePesewas` filled, and a price below the band's floor needs the margin approval (202 where it issued).
- `issueQuoteVersion` holds a line of animals by count; `heldQuantity` and `availableQuantity` say so (the latter counts only animals of the band).
- `QuoteVersion.taxPesewas` and `grossPesewas` include the delivery fee's tax (and, tax-inclusive, `netPesewas` and the margin net it out).
- `convertQuote` takes no `stockUnitIds` for a line of animals (`ANIMALS_REQUIRED` only when too few are given).

**Additive (always sent):** `PublicQuoteLine.availableNowQuantity`, `availableNowUom`; `PipelineRow.withdrawn`, `withdrawnValuePesewas`; `Quote.cancelReason`; `listReasonCodes?domain` gains `QUOTED_PRICE`. The `cancelQuote` example now answers `CANCELLED`. 567 operations from code, 99 planned. Redocly clean, no warnings; `contract:generate --check` up to date.

## Built

| Item | What |
| --- | --- |
| 1. The booking | ORD domain `quoted-line.ts` (`quotedLinePricing`, 100 percent gate); `Orders.createFromQuoteIn` records the quote line's list as resolved and the difference as a `QUOTED_PRICE` variance; QUO passes each line's recorded list (`priceOf`) and prices a banded line at its band. Migration 0348 (MDM: the domain and reason `QUOTED_PRICE`). ADR-0003 amended. |
| 2. The hold | QUO `reserveLinesIn` holds a line of animals by count through INV's `Reservations.reserveIn`, of its band (`inWeightBand`, `eligibilityIn`); the existing release paths end it; conversion hands it over (`transferHeldByIn`), releasing animals replaced by those given; `quo.QuoteIssued.holds`. |
| 3. The fee's tax | QUO `figuresIn` puts the fee in the version's one `TaxService.calculateIn` as a `DELIVERY_SERVICE` line (MDM's `Storefront.deliveryTaxCategoryIdIn`, now injected into `Quotes`); `versionFigures` takes `deliveryFeeTaxPesewas`. |
| 4. Tags at picking | `convertQuote` makes one unnamed order line a head; ORD `recordPicks` takes the picker's animal for such a line; `Dispatches.nameAnimalsIn` writes it onto the line at dispatch and collection (`FulfilmentStore.nameLineAnimal`). Migration 0349 (`ck_sales_order_line_serial` replaced, `ck_sales_order_line_animal_named` new). |
| A-328 (c) | `PublicQuoteLine.availableNowQuantity` / `availableNowUom` from `availableNowIn` and the domain's `availableToBuyer`. |
| A-329 (b) | `pipelineFigures` counts `CANCELLED` after issue as `withdrawn` (outside `issued` and the rate); `pipelineCells` reads it; `Quote.cancelReason`; `quo.QuoteWithdrawn`. |
| The margin sweep | Every margin in code, the contract and the documents is over the selling price (QUO's `marginOverPricePercent`, CST's planned `MarginRow.marginPercent` and `contributionMarginPercent`, all over revenue; `marginPercent` on `QuoteVersion` stays deprecated as markup, BL-098). One document named markup "margin over cost": `docs/API.md`'s QUO section, corrected. No field renamed. |
| Docs | ADR-0098 (indexed), ADR-0003 Amendments, A-350 to A-355 and the amended A-309, A-310, A-328, A-329; BL-122 to BL-124; abuse cases 64 and 65; FR-ORD-004 and FR-QUO-012; the quo, ord and mdm data model; the QUO and ORD cards; API.md; the 2.43.0 changelog; the openers (B11u inserted and built, B12 reading this report and naming its two exception sources). |

## The gate, proved by running it

`test/integration/quo/uat-scenario-2-corrections.integration.spec.ts` (12 tests, new), over the seeded farm (goats G-0142 to G-0145, all GOAT-M, cost 60,000 each; the QUOTE channel's GOAT-M list 65,000, yam 2,000, a crate 6,000), every figure read from the tables:
- **The booking, above, below and at list, each journal balanced.** A goat quoted at 75,000: the line `65,000 / 75,000 / 10,000 ABOVE QUOTED_PRICE`; the document net 75,000, tax 0, gross 75,000; the journal `1200 D 75,000, 4000 C 65,000, 4210 C 10,000`. Three yams at 1,800: `2,000 / 1,800 / 600 BELOW`; document 5,400; `1200 D 5,400, 4020 C 6,000, 4210 D 600`. Two crates at list: no variance, `1200 D 12,000, 4020 C 12,000`, **no 4210 line**. `QUOTED_PRICE` is not among the `PRICE_OVERRIDE` reasons a seller is offered.
- **The hold.** A GOAT-S line with all four goats free holds none of them; three goats hold G-0142 to G-0144 to the validity, then two hold the last (G-0145, subject to stock, available 1); four active reservations of four distinct animals; `quo.QuoteIssued.holds` names asked 2, held 1. Version 2 of two goats releases version 1's three and holds two in the issuing transaction; the expiry job (application clock) gives the short quote's goat back; withdrawals end the rest: no goat reserved.
- **No gap under concurrency.** An accepted quote holding G-0142 and G-0143 (no expiry, A-310 (b)) is converted while a rival quote for all four goats is issued at the same moment: the order holds exactly G-0142 and G-0143, the rival G-0144 and G-0145 and never either of the first two at any status; the quote's reservations ended `RELEASED` (twice each: at acceptance and at the hand-over).
- **The fee's tax, quote against invoice.** UAT version 1 tax-exclusive (20 goats at 95,000, fee 6,000): quote net 1,906,000, tax 1,200, gross 1,907,200; the receipt BIL issues for the same lines and a `DELIVERY_FEE` line as dispatch builds it (rolled back): the same three figures. Tax-inclusive, three crates and a fee of 6,003: net 23,003, tax 1,000, gross 24,003 on the quote, the buyer's view and the invoice; the whole 20 percent rounded at once would be 1,001, the fee untaxed (as before) 0, taxed on top 1,200.
- **Tags at picking.** Two goats accepted and converted with no tags: two lines, `stockUnit` null, the order holding the quote's two; picks refused with no animal (`STOCK_UNIT_REQUIRED`), with another quote's goat (`STOCK_SHORT`) and with one goat twice (`STOCK_SHORT` twice); G-0143 (held) and G-0145 (free) picked, packed and handed over: the lines name them `FULFILLED`, the issues are those two, the order's promises end; the database refuses a changed animal (HK004), and an unnamed line made fulfilled or not a quote's (HK010).
- **The buyer's figure.** Two crates show `60.000 EGG` with far more there; a quote for five goats with one left shows `1.000 HEAD`, subject to stock, while staff see their issue figures; the full number on hand never appears.
- **Withdrawn.** Esi Appiah's one accepted and one declined: 50.00 before and after her withdrawn quote; `withdrawn` up by one with its 24,000; `issued`, `accepted` and `declined` unchanged; a withdrawal without a reason 400; `quo.QuoteWithdrawn` with the reason, the maker, `ISSUED`, `wasIssued`, 24,000, 120 eggs released, `abuseCase: 65`; `Quote.cancelReason` shown.

Unit, written first and run red: `ord/domain/quoted-line.spec.ts` (6, no module), `quo/domain/quote.spec.ts` (the fee's tax, the band, the buyer's figure: 6 red), `quo/domain/pipeline.spec.ts` (withdrawn: 4 red). Existing specs changed only where they read the replaced rules: `quotes.integration` (a conversion with no animals now 201; too few still `ANIMALS_REQUIRED`; the goat order cancelled before the named-animal case, since it now holds the goats), `quote-document-pipeline.integration` (the pipeline rows with `withdrawn`; the herd held by count; the pipeline's goat quotes withdrawn before the named-animal case; the buyer's figure in place of "never the stock level"), `reference-data.integration` (72 reason codes), the rollback walk (0348, 0349). No expectation was weakened and nothing skipped.

## Mutation checks (each applied alone, the new spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The conversion passes no list (the pre-B11u booking) | red: 2 of 12 (above and below list) |
| M2 | A line of animals holds nothing (the pre-B11u hold) | red: 4 of 12 |
| M3 | The fee left out of the tax calculation | red: 5 of 12 |
| M4 | No band filter | red: 5 of 12 (first survived: the GOAT-S case was issued with no goat free; reordered so it bites) |
| M5 | Dispatch and collection name no animal | red: 3 of 12 |
| M6 | The buyer's figure not capped at the line | red: 1 of 12 |
| M7 | A withdrawn quote counted as closed in the rate | red: 1 of 12 |
| M8 | `ANIMALS_REQUIRED` with no animals given (the pre-B11u conversion) | red: 5 of 12 |

## Test first, as it honestly happened

- The three domain specs were written first and run red, then the code.
- The end-to-end spec was written after the application code; M1, M2, M3 and M8 are the old behaviour of each decision and each turns it red. Its first runs found two faults in the code, both fixed: a banded line with no animal was never priced, so it recorded no list and booked nothing to 4210 (now priced at its band, A-350 (c)); and the staff `Quote` had no `cancelReason` to show the withdrawn quote's reason (added). The rest were the spec's own (a GOAT-S price below cost needing approval, a virtual location's negative balance, holds left by a failed case).

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundaries crossed: TB1 public storefront (the buyer's link and account read a new figure), TB2 back office (issue, convert, picks, the pipeline), the database (two migrations). No new operation, permission, upload, export, payment path or secret.
- **SC-01 input:** no new request field; `stockUnitIds` was already optional in the schema (now honoured); picks keep their strict schema.
- **SC-02 authorisation:** every touched operation keeps its permission check in the application layer (`quo.quote.issue`, `quo.quote.convert`, `ord.fulfilment.pick`, `quo.report.read`); the buyer's figure is reached only by the link's token or the signed-in customer (unchanged). No new read: the wrong-role tests of each operation stand (`quotes`, `quote-document-pipeline`, `fulfilment`).
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas; one half-up per extension in `quotedLinePricing`; the tax from MDM's calculator only; every figure asserted exactly.
- **SC-06 idempotency:** unchanged keys on every write; a replayed issue holds once (existing test).
- **SC-07, SC-08:** no token or phone in the new events (`holds`, `QuoteWithdrawn`).
- **SC-22:** `QUOTED_PRICE` is a lookup row; the new ORD rules are in the database (HK010, HK004, tested).
- **The parent's abuse paths:** (1) **holds used to lock out other buyers:** a hold never above what is free, ended with the quote, published per issue; no cap in the sources, so **BL-122**; **abuse case 64**. (2) **the buyer's view leaking stock levels:** per line, capped at the line's own quantity (tested with far more on hand), set by staff; residual for a quote larger than free stock (A-353 (c)); case 64. (3) **a withdrawn quote hiding a loss:** shown beside the rate with its value and reason, published as `quo.QuoteWithdrawn`; **abuse case 65**.
- **Exception report:** B12 builds it; its opener now names both sources. Findings: none open.

## UAT scenario 2, rerun at the desk (against the built code and its specs; section 3's goats are not the seeded farm's)

- **2.1, 2.4, 2.7, 2.10, 2.11, 2.14, 2.16 to 2.19, 2.21:** as scripted (unchanged since B10 continued 5 and B11 continued 13).
- **2.2:** the line shows list 850.00 (a banded line is now priced at its band) and 950.00; goats 19,000.00 at zero; **delivery 60.00 with VAT 9.00, NHIL 1.50, GETFund 1.50; net 19,060.00, tax 12.00, gross 19,072.00 (fixed)**; margin over the price as scripted, **but** see difference (c).
- **2.3 and 2.6:** **reserved goats rise by 20, then fall to 18 (fixed)**: v1's 20 released and v2's 18 held in the issuing transaction.
- **2.5:** 17,160.00, tax 12.00, gross 17,172.00 (fixed with 2.2).
- **2.8:** **converted with no tags (fixed)**: one order, 18 lines at 950.00; the hold passes to it; a second conversion 409. **But** only as a collection, difference (a).
- **2.9:** refused and the override asked, as scripted, **but** on 17,160.00, difference (d).
- **2.12:** Yaw names G-0201 to G-0210 at picking (fixed: they need not be the animals held).
- **2.13:** the invoice's goats post **8,500.00 to 4000 and 1,000.00 to 4210 (fixed)**; the customer's figures unchanged. **But** differences (a) and (b).
- **2.20:** 4000 8,500.00 and 4210 1,000.00 as the table (fixed); the rest as before.
- **The buyer's figure (A-328 (c)) and the withdrawn outcome (A-329 (b)):** built; the script has no step for them.

**Remaining differences (A-355), none of the six decided:**
- **(a)** `convertQuote` refuses `DELIVERY` (A-310 (e), never lifted when B11 built delivery), so 2.13 and 2.15 run as a collection, not a dispatch to Kasoa with its fee (**BL-123**).
- **(b)** The 8 goats not sent become a backorder confirmed with no reservation (A-366 (a)); 2.13 reads "still reserved" (**BL-123**).
- **(c)** A quote line's estimated cost is the average of every live goat pool at the branch (A-309 (c)); with G-0142, G-0157 and the others in the pens it is not exactly 13,200.00, so the margin is not exactly 30.75 (**BL-124**).
- **(d)** The credit check counts the order's estimate before the fee's tax, 17,160.00 where 2.9 reads 17,172.00 (A-352 (d), **BL-124**).

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

No request is new. **CR-059 to CR-062** are B12's, in its opener (B12's opener now says CR-060's margin per crate is over the selling price, the owner's rule). **CR-063** was answered in 2.35.0, **CR-039** in 2.42.0; **CR-033 point 3 item 3** stays declined (BL-119). Every other request is answered in its phase; none is left without a phase.

## Tests (this machine)

Run with Docker's Testcontainers. CI is below.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `486b5b4`, after the last code, spec and opener change; only this report followed) | **4,350 passed, 365 files, none failed or skipped.** Coverage: statements 94.21 %, branches 84.07 %, functions 97.98 %, lines 97.29 % (baseline 94.19, 83.98, 97.96, 97.28). Every full-coverage gate held, the new `src/modules/ord/domain/quoted-line.ts` at 100 percent. The first whole run, on `da3f564`, was the same (4,350, 365 files, the same figures); a spec assertion was added after it (`3358ec2`, `quo.QuoteIssued.holds`), so the suite was run whole again. |
| The new specs | `uat-scenario-2-corrections` 12; `quoted-line` 6; `quote` and `pipeline` (the new cases); the QUO, ORD and MDM integration specs passing |
| Contract (`pnpm test:contract`) | 139 tests, 55 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate --check` | Clean (567 operations from code, 99 planned) |
| CI on `486b5b4` (before this report) | push run 45382703969 success; pull_request run 45382756704 success |

## Deferred

- **BL-122:** a cap on what one quote or customer may hold. **BL-123:** conversion to a delivery order, and a backorder that keeps its hold. **BL-124:** a quote's cost from its held animals, the order's estimate with the fee's tax, a band on the order line.
- **To B12:** the exception report's items for abuse cases 64 and 65 (`quo.QuoteIssued.holds`, `quo.QuoteWithdrawn`).
- **Seed:** unchanged (the seeded quote is a draft of eggs).

## Questions for the owner

1. **An accepted quote's hold (A-310 (b)):** it lasts until the order takes it or the quote is withdrawn. Should it also end at a set time?
2. **UAT scenario 2's remaining differences (A-355):** schedule BL-123 (conversion to delivery and a backorder's hold) before the UAT on staging? BL-124 (cost by the animals held; the credit check with the fee's tax)?
3. **A banded line below its band's floor (A-350 (c))** now needs the margin approval, as any line below the engine's floor. Agreed?

## Notes for the frontend track

- **2.43.0.** A converted order's lines show their list and a `QUOTED_PRICE` variance beside the quoted price. `convertQuote` may send no `stockUnitIds`: the order's lines of animals then show `stockUnit` null until picked; the pick screen must ask for the animal on such a line. Show `PublicQuoteLine.availableNowQuantity` and `availableNowUom` to the buyer on a subject-to-stock line; the pipeline's `withdrawn` and `withdrawnValuePesewas` beside the rate, never in it; `Quote.cancelReason` on a withdrawn quote. A quote with a delivery fee now shows its tax.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 (`b12-capital-costing-reporting`, from `main`), exactly as `docs/prompts/session-openers.md` carries it (this phase made it read this report as lane B's last, and named B11u's two exception sources):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read the last report of each lane (lane B: docs/sessions/B11u-uat-scenario-2-corrections.md,
the UAT scenario 2 corrections, which closes lane B; lane A: docs/sessions/B09c-card-payment.md); B12 opens only when
both lanes have merged (owner, 2026-11-17).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the CAP, CST, RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/cap.md, cst.md, rpt.md and api.md, the CAP, CST, RPT and API cards in
docs/MODULE_BOUNDARIES.md, and ADR-0018, ADR-0023, ADR-0028 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 only, on branch b12-capital-costing-reporting: investors, capital contributions and
withdrawals with approval, unit holdings with effective dates, distribution runs by unit-days with
largest-remainder allocation, the lifecycle draft to paid with step-up approval, loans and grants,
overhead allocation, cost object summaries, margin and loss facts, the reporting read model with its
projections and checkpoints, report definitions and schedules, the investor portal's read model, the
public API with keys and webhooks, and, as ADR-0026 proposes, the daily exception report:
GET /exceptions/daily-report, with an item kind for every one of the eighteen abuse cases, each item
carrying its abuse case numbers, actor, amount and subject document, so that B13 can assert it.
The exception report must include order splitting (abuse case 27, owner 2026-11-15, A-168): read
PUR's PurchaseOrders.splitSuspectsIn for the report's day and report each run with its maker, supplier,
orders and total; and the payout changes of case 13 from pur.SupplierPayoutChangeRequested and
pur.SupplierPayoutChanged, with SA-17's payment within 24 hours after a change.
It must include case 28 (B07 continued 1b, A-172): each invoice paid on an approved variance
(pur.SupplierInvoiceMatched or ExpenseInvoiceApproved with varianceApprovalRequestId) and each approved supplier
credit note (pur.SupplierCreditNoteApproved with its returned movements), with maker, approver and amount.
It must include PAY's breaks and reversals (the owner, 2026-11-16, B09a continued 1b): every reconciliation break of
every kind (from the provider sweep, from webhooks, from settlement and bank statement matching, and REFUND_FAILED)
read through the published view pay.pub_reconciliation_break, each with its kind, payment or reference, amount, age
and state; every payment mismatch found against Paystack among them; and each pay.PaymentReversalRequested (abuse
case 32) with its maker, amount and reason, beside pay.RefundRequested (case 12) and pay.WebhookRejected (case 5).
It must include case 2's reused death photographs (B06r, A-175): each liv.MortalityPhotoReused with the record,
the reporter and the earlier records whose photograph had the same bytes; and case 29 (A-176): every processing
reversal from prc.ProcessingOrderReversed with its value, the threshold copied onto it, the maker, the approver
when one was needed, and the reason. Residual risk R18 (B07 continued 2): count the storefront checkouts
started and expired per address a day from shp.CheckoutStarted and shp.CheckoutExpired, as an item when one
address holds stock repeatedly without placing an order.
It must include case 34, inflated rejections at the door (B09e continued 3, A-272, ADR-0076): a RECEIPT_CLAIM item for
each pur.SupplierClaimRaised, with the receipt, the receiver, the claim's maker, the supplier, the rejected quantity,
its reason and its value. And every exception source B9b, B09c, B11 and B11u add (their reports name each one; B11u: `quo.QuoteIssued.holds` for case 64 and `quo.QuoteWithdrawn` for case 65), at least
each reused till receipt token (a possible till fault or tampering, owner 2026-11-17) and each supervisor's PIN
sign-out of a locked cashier (CR-032).
Write the five tests of ADR-0028 under the names the ADR gives them, and run scenario 4 of
docs/UAT.md as a dry run: the net profit for July to September 2026 in the seed is GHS 41,666.70 and
the hand calculation must match the run to the pesewa.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the distribution rules under
src/modules/cap/domain/distribution/ and uncomment its 100 percent gate in vitest.config.mts before
the gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES once the daily exception report answers them. runReport must implement
every report code listReportDefinitions lists, SALES_SUMMARY and PURCHASES included (CR-018), each matching its
contract example's columns.
The owner, 2026-11-16 (A-212 (a)): investor capital arrives through the investor module to the bank, never as cash.
The owner, 2026-11-23 (from the frontend's F12 and F10n): build CR-059 to CR-062. Every margin is over the selling price, (price less cost) over price, and anything over cost is markup and named markup (the owner, 2026-11-23), CR-060's margin per crate included. Grant the report and exception
report permissions to the Owner and the Manager (and the Accountant for the financial reports). Give each of these
controls its own exception type: cash drops (witnessed or not), reused photographs, quotes accepted in a staff session,
late cash after a shift closed, and negative stock after an offline sale. Add marking an exception reviewed with a note,
the egg report codes, the VAT return, and the statement and exception report exports. Notes:
- "quotes accepted in a staff session" is the possible staff acceptance of B10 continued 6 (the decision's address and
  browser matched against staff sessions active from the same address in the last 24 hours, never a cookie);
- "reused photographs" means a proof-of-delivery photograph or signature whose content hash matches an earlier upload
  (beside case 2's death photographs); none of B11 continued 6 to 13 recorded that match (B11 continued 13, A-291), so this phase must: record on the proof of delivery whether its photograph or signature matches an earlier upload's SHA-256 in `platform.stored_file` (as liv.MortalityPhotoReused does) and publish it;
- each existing exception kind keeps working, and any rename is LOUD.
Stop at the gate and write docs/sessions/B12-capital-costing-reporting.md.
```
