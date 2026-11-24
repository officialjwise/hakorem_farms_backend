# B11u continued: the rest of UAT scenario 2 (lane B)

Date: 2026-11-24 · Branch `b11u2-uat-scenario-2-rest`, from `main` at `7fd835c` (#142, B11u) · Status: **gate passed locally; CI and the merge are named in the closing message to the parent session.** This closes lane B.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-356 | **Delivery from a quote (BL-123).** `convertQuote` with `DELIVERY` takes the customer's own saved address and its zone exactly as `createOrder` does (A-368 (a)); a slot refused `SLOT_NOT_AVAILABLE`; a quote with no customer cannot be delivered. **The fee is the one the buyer accepted on the quote**, charged once on the first dispatch; the zone's fee is not worked out again (the parent's scope said "the zone's delivery fee": the quote's fee is the zone's fee as estimated at quoting, FR-QUO-004, and recomputing it would change an accepted price; conservative reading). A collection conversion still carries the quote's fee (unchanged). The spec delivers to Dodowa (the seed never holds Kasoa). | Owner |
| A-357 | **The credit estimate's tax (BL-124, replaces A-352 (d)).** A converted tax-exclusive order's `estimatedTotalPesewas` is lines + fee + the accepted version's tax (by the invoice's rule, A-352 (a)): 17,172.00. A version issued before 2.43.0 keeps its stored tax. | Owner, Accountant |
| A-358 | **A quote's cost by the animals it holds (BL-124, replaces A-309 (c) for a line of animals naming none).** The cost pools of the animals held, or that would be held now while a draft, by the same plan the issue holds by; a head it cannot hold at the band's average, else the product's, else unknown (approval). One unit cost a line, half-up once. **A revision now holds its last version's animals first**, then free ones oldest first (A-351 (a) refined). UAT 2.2's 13,200.00 needs the twenty held to be 660.00 goats: section 3 gives no arrival dates, so the spec has the twenty-four bought first; an older free goat of the band would be held first and costed at its own cost. | Owner |
| A-359 | **The band on the order line (BL-124, replaces A-351 (g)).** Migration 0350: `weight_band_id`, never changed (HK004). Confirmation reserves only animals weighed in it; **the picker is refused another (`STOCK_UNIT_OTHER_BAND`)**, by the pick's weighing, else the animal's last (the conservative reading of UAT 2.12's "all in band GOAT-M"). | Owner |
| A-294 | **An accepted quote's hold ends 7 days after acceptance (the owner's decision).** From the acceptance instant by the application clock; the quote-expiry job releases it with its reason, audited, publishing `quo.QuoteExpired` and `quo.AcceptedQuoteLapsed` (case 66); `convertQuote` refuses `ACCEPTANCE_LAPSED` from that instant, even before the job; the quote stands `EXPIRED` with its accepted version (no new status; migration 0351). **In the win and loss rate it counts as expired, so lost (conservative: it was never won)**, listed apart as `lapsedAfterAcceptance`. The 7 days are a constant. | Owner |
| A-295 | **A backorder keeps its first order's hold (BL-123, A-366 (a) amended).** At dispatch or collection what each backorder line still needs of the stock the order held, less the picks, is promised again to the backorder in the same transaction (ended `RELEASED` with `transferredToDocumentId`, taken again with no expiry); never more than held, never twice, never below zero; the rest released. The backorder's hold has no expiry; it ends when it is sent or cancelled. | Owner |
| A-296 | **UAT scenario 2: no difference remains (A-355 resolved).** The spec stands in for section 3 facts the seed does not hold (Emmanuel's contract list and account, section 3's goats, Dodowa for Kasoa) and does not record the deposit or payments (2.11, 2.14, 2.16), which this phase did not change and PAY's specs prove. | Owner |

**For the parent session to schedule:** nothing new. No contract request is open for this phase. **No ADR conflict and no stop.** ADR-0019 (a reservation never above what is free, one animal once), ADR-0091 (a pick names stock, checked against free or the order's own), ADR-0094 (the backorder is the packer's explicit choice; it now keeps the hold, the owner's decision), ADR-0095 (dispatch credit check, unchanged) and ADR-0067 (the 7 days by the application clock; no new `now()` in business SQL) are followed. A-310 (b) is amended by the owner. **Shared modules:** nothing changed in INV, MDM, WHL, BIL, PAY, POS, IAM or FIN; one message key added in `src/platform/i18n/messages.ts` (additive). `sale-posting.ts` untouched. QUO and ORD are lane B's.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11u continued, the rest of UAT scenario 2, lane B (`b11u2-uat-scenario-2-rest`, from `main` 7fd835c), its opener written first (`f5c3ea3`).
2. **Scope:** BL-123 (delivery from a quote; the backorder's hold), BL-124 (the quote's cost; the credit estimate's tax; the band on the order line), and the owner's 7-day hold on an accepted quote.
3. **Gate:** as the opener states it. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `7fd835c`: **365 files, 4,350 tests passed, none failed or skipped. Statements 94.21 %, branches 84.07 %, functions 97.98 %, lines 97.29 %.**

## Contract changes

**2.44.0, minor** (its entry in `docs/CONTRACT_CHANGELOG.md`). No field or parameter removed or retyped; no operation added. **LOUD:**
- `convertQuote` takes `DELIVERY` with `deliveryAddressId` (it was refused `FULFILMENT_NOT_AVAILABLE`); a slot `SLOT_NOT_AVAILABLE`; an accepted quote 7 days after acceptance 422 `INVALID_STATE_TRANSITION` `ACCEPTANCE_LAPSED`.
- `SalesOrder.estimatedTotalPesewas` of an order converted from a tax-exclusive quote includes its tax.
- `QuoteLine.estimatedUnitCostPesewas` of a line of animals is the cost of the animals it holds (and so the version's cost, markup, margin and floor).
- `dispatchFulfilment` and `collectFulfilment`: the backorder keeps its first order's hold.
- `recordPicks`: `STOCK_UNIT_OTHER_BAND`.
- An accepted quote may stand `EXPIRED` (with `acceptedVersionId`); its link opens `EXPIRED`.

**Additive:** `OrderLine.weightBandId` (optional in the schema, always sent), `PipelineRow.lapsedAfterAcceptance` (always sent); events `quo.AcceptedQuoteLapsed`, `backorderHeldQty` on `ord.OrderDispatched` and `ord.OrderCollected`. 567 operations from code, 99 planned. Redocly clean; `contract:generate --check` up to date.

## Built

| Item | What |
| --- | --- |
| 1. Delivery from a quote | QUO `convert` passes the address, slot, the version's tax and each line's band; ORD `createFromQuoteIn` validates and snapshots the address and zone through `staffDeliveryIn` (as `createOrder`), the quote's fee kept; A-310 (e)'s refusal removed. |
| 2. The backorder's hold | ORD domain `backorder-hold.ts` (`keptForBackorder`, 100 percent gate); `Dispatches.endPromisesIn` at dispatch and collection: the backorder is made before the order's promises end, and what it keeps is handed to it in the same transaction. |
| 3. The quote's cost | QUO domain `animalLineUnitCost`; `Quotes.animalPlanIn` plans a line of animals (own holds first, then free oldest first, of its band) for both the cost (`priceLines`) and the hold (`reserveLinesIn`, which now takes the last version's holds first). |
| 4. The credit estimate's tax | ORD domain `quotedOrderEstimate` (100 percent gate). |
| 5. The band on the order line | Migration 0350 (`weight_band_id`, `ck_sales_order_line_weight_band`); `Orders.bandFilterIn` at confirmation; `recordPicks`' `STOCK_UNIT_OTHER_BAND`. |
| 6. The 7-day hold | QUO domain `acceptance.ts` (`acceptanceHoldEndsAt`, `acceptanceLapsed`, `acceptedLapsingBy`); `lockLapsed` takes accepted quotes too; `lapseAcceptedIn`; the conversion's refusal; migration 0351 (the machine's ACCEPTED to EXPIRED, `ck_quote_accepted`); the pipeline's `LAPSED` cell and `lapsedAfterAcceptance`; `linkState` answers `EXPIRED`. |
| Docs | A-356 to A-359, A-294 to A-296 and the amended A-309, A-310, A-351, A-352, A-355, A-366, A-368; BL-123 and BL-124 built; abuse cases 66 and 67; FR-QUO-011, FR-ORD-012; the quo and ord data model; the QUO and ORD cards; the 2.44.0 changelog; the openers (this phase inserted and built; B12 reads this report and names the two new exception sources). |

## The gate, proved by running it

`test/integration/quo/uat-scenario-2-rest.integration.spec.ts` (15 tests, new). The seeded farm with section 3's goats received into its pens (G-0201 to G-0224 at 660.00, bought before the seed's goats; beside them the seed's G-0142 to G-0145 at 600.00, G-0171 and G-0175 of GOAT-M, G-0157 of GOAT-L, G-0163 under a withdrawal hold), Emmanuel Tetteh's account (9,000.00, 30 days) and contract list (GOAT-M 850.00, floor 700.00, ceiling 980.00):
- **2.2:** list 85,000, quoted 95,000, unit cost 66,000; net 1,906,000, tax 1,200, gross 1,907,200, cost 1,320,000, margin 30.75, no approval; the product's average pool would not have given 1,320,000.
- **2.3:** issued, G-0201 to G-0220 held. **2.5 and 2.6:** version 2: net 1,716,000, tax 1,200, gross 1,717,200, cost 1,188,000, margin 30.77; issued holding G-0201 to G-0218 (the same goats).
- **2.8:** refused with no address (`DELIVERY_ADDRESS_REQUIRED`), a slot (`SLOT_NOT_AVAILABLE`), another customer's address (`ADDRESS_NOT_OF_CUSTOMER`), an address to collect (`NOT_FOR_COLLECTION`), and 403 for the Cashier, the Storekeeper and the Driver, writing nothing; then one `DELIVERY` order of 18 lines at 95,000 (resolved 85,000) of band GOAT-M, fee 6,000, estimate 1,717,200, the address and zone snapshotted, the eighteen goats handed over; a second conversion 409.
- **2.9 and 2.10:** confirmation refused; with a reason 202 over the limit by 817,200 on 900,000; Kojo refused his own approval (403); Kwabena approves; confirmed `OVERRIDDEN`; the override list shows exposure 1,717,200.
- **2.12:** G-0157 (GOAT-L, 31.800 kg) refused for a GOAT-M line (`STOCK_UNIT_OTHER_BAND`); G-0201 to G-0210 picked weighed, packed with the eight unpicked lines back-ordered.
- **2.13:** dispatched while a rival quote for 30 goats is issued at the same moment: the invoice net 956,000, tax 1,200, gross 957,200, due day 0 plus 30, one `DELIVERY_FEE` line of 6,000; its journal `1200 D 957,200; 2100 C 1,200; 4000 C 850,000; 4100 C 6,000; 4210 C 100,000`. The backorder: `CONFIRMED`, 8 lines of GOAT-M, no fee, **holding G-0211 to G-0218**; the order holds nothing; eight of its reservations ended "stays held for backorder"; the rival never held any of G-0201 to G-0218 at any status; no physical balance reserved above on hand or below zero; `ord.OrderDispatched.backorderHeldQty` 8.000.
- **2.15:** run started, on the way, proof with a photograph and no cash: the order `DELIVERED`, 10 lines `FULFILLED` naming G-0201 to G-0210, 8 `BACKORDERED`; the cost 660,000 (`5000 D`, `1310 C`); the backorder still holds its eight. Cancelling the backorder releases them.
- **The band at confirmation:** a quote for two GOAT-L goats holds G-0157 only; its order stays `PLACED` short of one (`STOCK_UNAVAILABLE`, `/lines/2`) with GOAT-M goats free; the database refuses a changed band (HK004).
- **The 7 days:** converted at 7 days less a minute with its hold; at 7 days exactly refused `ACCEPTANCE_LAPSED` with nothing written, then the job releases both goats with the reason, `quo.AcceptedQuoteLapsed` (gross 190,000, 2.000 released, case 66), audit `LAPSE_ACCEPTED`, the quote `EXPIRED` with its accepted version; a second run releases nothing. Raced with the job at 7 days less a millisecond: converted with its hold and the job releases nothing; at 7 days: refused and released, never both. The pipeline for Kojo: 4 accepted, 2 expired, 2 lapsed after acceptance, 66.67 percent.

Unit, written first and run red: `quo/domain/quote.spec.ts` (the cost, the link: 6 red), `quo/domain/pipeline.spec.ts` (the lapse: 3 red, two of them the new field on existing rows), `ord/domain/quoted-line.spec.ts` (the estimate: 2 red). `ord/domain/backorder-hold.spec.ts` (6) was written with its code in one draft and passed on its first run: it was not seen red. Existing specs changed only for the new field: `quote-document-pipeline.integration` (`lapsedAfterAcceptance: 0`), `pipeline.spec` (the same), the rollback walk (0350, 0351). No expectation weakened, nothing skipped.

## Mutation checks (each applied alone, the new spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The backorder keeps nothing (the pre-BL-123 release) | red: 1 of 15 |
| M2 | A line of animals costed by the product's average pool (A-309 (c)) | red: 14 of 15 |
| M3 | The estimate without the tax (A-352 (d)) | red: 10 of 15 |
| M4 | No band at confirmation | red: 1 of 15 |
| M5 | No lapse check at conversion | red: 2 of 15 |
| M6 | `DELIVERY` refused at conversion (A-310 (e)) | red: 10 of 15 |
| M7 | A revision planned without the quote's own holds | red: 12 of 15 |
| M8 | No band at picking | red: 8 of 15 |
| M9 | The job never lapses an accepted quote | red: 3 of 15 |

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundaries crossed: TB2 back office (convert, confirm, picks, dispatch, the pipeline), the scheduler (the expiry job), the database (two migrations). No new operation, permission, upload, export, payment path or secret.
- **SC-01 input:** no new request field (`deliveryAddressId` and `deliverySlotId` were already in `QuoteConvert`, now honoured); the address must be the quote's customer's own.
- **SC-02 authorisation:** unchanged checks in the application layer (`quo.quote.convert`, `ord.order.confirm`, `ord.fulfilment.pick`, `ord.fulfilment.dispatch`, `quo.report.read`); the wrong roles refused for the delivery conversion (Cashier, Storekeeper, Driver, tested); Kojo refused his own credit override. No new read; no identifier is a key.
- **SC-03, SC-04:** parameterised SQL only. **SC-05 money:** integer pesewas, one half-up per line cost and per estimate; every figure asserted exactly. **SC-06:** unchanged idempotency keys. **SC-22:** the band and the machine edge are in the database (HK004, `ck_quote_accepted`).
- **The parent's abuse paths:** (1) **a quote converted after its hold lapsed:** refused from the instant (`ACCEPTANCE_LAPSED`), released by the job, raced safely (tested); **case 66** published. (2) **a backorder used to lock stock:** only what the first order held less what was sent, never more, ended with the backorder; **case 67** (`backorderHeldQty`). (3) **a delivery added at conversion to dodge the credit check:** the estimate counts the fee and its tax (17,172.00), and dispatch checks the gross again (ADR-0095). (4) **a band switched at confirmation:** the band is fixed at conversion by the database; confirmation and picking keep to it; **case 67**.
- **Exception report:** B12 builds it; its opener now names both new sources. Findings: none open.

## UAT scenario 2, rerun at the desk (against the built code and its specs)

- **2.1, 2.4, 2.7, 2.11, 2.14, 2.16 to 2.19, 2.21:** as scripted, unchanged since B10 continued 5, B11 continued 13 and B11u.
- **2.2:** 850.00 and 950.00, net 19,060.00, tax 12.00, gross 19,072.00, **estimated cost 13,200.00, margin 30.75 (fixed, with the other goats in the pens).**
- **2.3, 2.6:** reserved goats rise by 20, then fall to 18, **the same goats kept.** **2.5:** 17,160.00, 12.00, 17,172.00, **11,880.00 and 30.77 (fixed).**
- **2.8:** **one delivery order (fixed)**, 18 goats at 950.00, links both ways, a second conversion refused.
- **2.9, 2.10:** **stopped on 17,172.00 (fixed)**; Kojo refused, Kwabena approves; the override list shows the limit 9,000.00 and exposure 17,172.00.
- **2.12:** G-0201 to G-0210 picked and weighed in GOAT-M; another band refused.
- **2.13:** **dispatched as a delivery (fixed):** invoice 9,560.00, 12.00, 9,572.00, due day 0 plus 30; **the 8 goats outstanding, still reserved, on the backorder (fixed)**; the fee not charged again. 2.14's 986.00 follows from 9,572.00 less 8,586.00 as before.
- **2.15:** **delivered by Kwesi with proof, no cash (fixed)**; 10 delivered, 8 outstanding.
- **2.20:** 1200 9,572.00 in, 4000 8,500.00, 4210 1,000.00, 4100 60.00, 2100 12.00, 5000 and 1310 6,600.00, as the table.

**Remaining differences: none.**

## Contract requests (the frontend's `main` at `43acd8f`, unchanged)

No request is new. **CR-059 to CR-062** are B12's, in its opener. Every other request is answered in its phase (CR-063 in 2.35.0, CR-039 in 2.42.0; CR-033 point 3 item 3 stays declined, BL-119); none is left without a phase.

## Tests (this machine)

Run with Docker's Testcontainers. CI is below.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `0909c9a`, after the last code and spec change; only docs followed) | **4,381 passed, 367 files, none failed or skipped.** Coverage: statements 94.25 %, branches 84.17 %, functions 98.00 %, lines 97.31 % (baseline 94.21, 84.07, 97.98, 97.29). Every full-coverage gate held, the new `src/modules/ord/domain/backorder-hold.ts` and the extended `quoted-line.ts` at 100 percent. |
| The new specs | `uat-scenario-2-rest` 15; `backorder-hold` 6; the new cases in `quote`, `pipeline` and `quoted-line` |
| Contract (`pnpm test:contract`) | 139 tests, 55 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean (567 operations from code, 99 planned) |

## Deferred

- Nothing of this phase. **BL-122** (a cap on what one quote or customer may hold) stays parked; a backorder's hold has no age limit (case 67 reports it).
- **To B12:** the exception report's items for abuse cases 66 and 67 (`quo.AcceptedQuoteLapsed`, `backorderHeldQty`).
- **Seed:** unchanged.

## Questions for the owner

1. **The fee on a delivery from a quote (A-356 (b)):** the fee the buyer accepted on the quote, not the zone's fee worked out again. Agreed?
2. **A lapsed acceptance in the win rate (A-294 (d)):** counted as lost (expired), and listed apart. Agreed?
3. **The band at picking (A-359 (c)):** an animal outside the line's band is refused at picking as well as at confirmation. Agreed?

## Notes for the frontend track

- **2.44.0.** `convertQuote` takes `DELIVERY` with one of the customer's saved addresses (no slot); a quote accepted 7 days ago or more answers `ACCEPTANCE_LAPSED` and shows `EXPIRED`. Show `OrderLine.weightBandId` on a converted line; the pick screen may get `STOCK_UNIT_OTHER_BAND`. Show `PipelineRow.lapsedAfterAcceptance` beside the rate (it is inside `expired`). A converted tax-exclusive order's estimate now includes its tax.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B12 (`b12-capital-costing-reporting`, from `main`), exactly as `docs/prompts/session-openers.md` carries it (this phase made it read this report as lane B's last, and named its two exception sources):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read the last report of each lane (lane B: docs/sessions/B11u2-uat-scenario-2-rest.md,
the rest of UAT scenario 2, which closes lane B; lane A: docs/sessions/B09c-card-payment.md); B12 opens only when
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
its reason and its value. And every exception source B9b, B09c, B11 and B11u add (their reports name each one; B11u: `quo.QuoteIssued.holds` for case 64 and `quo.QuoteWithdrawn` for case 65; B11u continued: `quo.AcceptedQuoteLapsed` for case 66 and `backorderHeldQty` on `ord.OrderDispatched` and `ord.OrderCollected` for case 67), at least
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
