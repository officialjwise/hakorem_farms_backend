# Session openers

The exact opening message for each remaining backend session, B2 to B13. Paste one into a fresh Claude Code session **opened in `backend/`** (`~/Desktop/hakorem-farms/backend/`), after the previous session's pull request is merged. Opened there, the session loads the sixteen `hakorem-*` skills from `backend/.claude/skills/`; opened at the workspace root it does not (A-079, confirmed by the owner on 2026-11-14). Every path in an opener is relative to `backend/`; the frontend's contract requests are at `../frontend/docs/CONTRACT_REQUESTS.md`.

Each opener follows the pattern B0 set in `docs/sessions/B00-architecture.md` ("Next session") and the session protocol in `docs/SHARED_BRIEF.md`: read `CLAUDE.md`, the shared brief and only the session's section of `docs/BUILD_PROMPT.md`; read only the latest report in `docs/sessions/`; from B4 onward read the frontend's contract requests; confirm phase, scope and gate in three lines; execute that session only; stop at the gate; write `docs/sessions/<ID>-<slug>.md`.

## How to use this file

1. Open the Claude Code session in `backend/`. Check that the previous session's report exists in `docs/sessions/` and its pull request is merged.
2. Open `docs/sessions/<previous>.md`, section "Next session". **If it differs from the opener here, the report wins**: the previous session knew what actually happened. Update this file afterwards so the two agree.
3. Paste the message from the fenced block, nothing before or after it.
4. When the session ends, check its report's "Next session" message against the next opener here.

## Reference table

| Session | Report | Branch | BUILD_PROMPT section | Gate |
| --- | --- | --- | --- | --- |
| B2 | `B02-foundation.md` | `b02-foundation` | B2 — Foundation | One-command setup works on a clean machine; CI green |
| B3 | `B03-platform-slice.md` | `b03-platform-slice` | B3 — Platform and the first vertical slice | The slice passes all four test layers; the frontend logs in against the real API |
| B4 | `B04-master-data-pricing.md` | `b04-master-data-pricing` | B4 to B12 | A price resolves for every band, channel and tier; an unresolvable request becomes a quote |
| B5 | `B05-inventory-ledger.md` | `b05-inventory-ledger` | B4 to B12 | On-hand from movements matches a hand count; stock cannot go negative outside allowed types; a lot traces both ways |
| B6 | `B06-livestock-processing.md` | `b06-livestock-processing` | B4 to B12 | A processing order produces lots whose costs sum exactly to input cost plus direct processing cost |
| B7 | `B07-procurement-suppliers.md` | `b07-procurement-suppliers` | B4 to B12 | Three-way match blocks payment on disagreement; checkout reserves stock and releases it on timeout |
| B8 | `B08-ledger-billing.md` | `b08-ledger-billing` | B4 to B12 | Trial balance sums to zero on a seeded day; an unbalanced journal is rejected by the database; numbering is gap-free under concurrent load |
| B9a | `B09a-order-core-payments.md` | `b09a-order-core-payments` | B4 to B12 | Every payment edge case in the brief passes; an order on any channel posts stock, document, payment and ledger in one transaction |
| B9b | `B09b-pos-shifts-offline.md` | `b09b-pos-shifts-offline` | B4 to B12 | Shift close reconciles; 500 queued offline transactions sync exactly once |
| B10 | `B10-quotations-wholesale.md` | `b10-quotations-wholesale` | B4 to B12 | Quote revisions are versioned; conversion to invoice preserves every link; a credit limit blocks with an audited override |
| B11 | `B11-fulfilment-delivery.md` | `b11-fulfilment-delivery` | B4 to B12 | A catch-weight order re-prices at pick; cash on delivery lands against the driver; the outbox guarantees the customer notification |
| B12 | `B12-capital-costing-reporting.md` | `b12-capital-costing-reporting` | B4 to B12 | A distribution matches a hand calculation on unit-days and ties exactly to the ledger |
| B13 | `B13-hardening-deploy.md` | `b13-hardening-deploy` | B13 — Hardening, smoke suite and deploy | Every non-functional target met and evidenced on the live server |

The gates come from the amended schedule in `docs/adr/0026-session-schedule-amendment.md`. Its three further assignments were **confirmed by the owner on 2026-11-13, exactly as proposed** (A-040 in `docs/ASSUMPTIONS.md`, resolved): the online store split across B7, B9a and B11; the daily exception report in B12; retention and data-subject requests in B13. The openers below build them that way.

A session takes as long as its phase takes.

---

## B2 — Foundation

Branch `b02-foundation`. Report `docs/sessions/B02-foundation.md`. Gate: one-command setup on a clean machine, CI green.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B2 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (B01's).
For the foundation, also read docs/MODULE_BOUNDARIES.md section 7 (the lint rule and the data checks),
docs/TEST_STRATEGY.md, docs/ENGINEERING_STANDARDS.md, docs/ONBOARDING.md section 4 (what pnpm setup must do),
and ADR-0001, ADR-0008, ADR-0012, ADR-0013, ADR-0024 and ADR-0025.
Do not read any other document unless this phase needs it.

Owner decision of 2026-11-13, so you need not go back through docs/ASSUMPTIONS.md: A-040 is resolved.
All three further assignments in ADR-0026 are confirmed exactly as proposed, with no changes: the online
store in B7 (catalogue, cart, checkout reservation), with order placement and online payment in B9a and
abandoned-cart messaging in B11; retention and data-subject requests in B13; the daily exception report in B12.
SA-13 is also confirmed, with a delivery split recorded in ADR-0026: zones and fees in B4, the slot table and
slot generation in B7, slot capacity and the rest of DEL in B11. The B01 report's "zone and fee only" text
about checkout is stale; ADR-0026 and docs/ASSUMPTIONS.md are current.

Confirm in three lines: the phase, its scope, and its gate.
First, because this is a fresh session, run Run 2 of docs/prompts/SKILLS_VERIFICATION.md (tasks T01 to T32,
one at a time) and record which skill loads for each.
Try once more to verify the Prism mock, bounded rather than as a long-running server: start it in the
background, wait a few seconds, curl one endpoint, then kill it. If that is refused too, say so and
leave it. The frontend verifies it in F2.
Then execute B02 only, on branch b02-foundation, including the two-session advisory-lock test that ADR-0005
and ASSUMPTIONS A-060 require: the kernel first (Money, Weight, Quantity,
Result, UUIDv7, Clock, and allocate, with the ADR-0028 tests 1, 2 and 4 named exactly as the ADR
gives them), then the workspace, typed configuration, Docker Compose, migrations runner, the error
envelope with correlation id, logging and tracing, the test harness and the four test scripts, CI,
and pnpm setup. No module code. Before claiming the gate, delete node_modules and the Docker volumes,
run pnpm setup and watch it come up, and add the CI job that does the same from a fresh checkout.
Stop at the gate and write docs/sessions/B02-foundation.md.
```

## B3 — Platform and the first vertical slice

Branch `b03-platform-slice`. Report `docs/sessions/B03-platform-slice.md`. Gate: the slice passes all four test layers and the frontend can log in against the real API.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B3 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B02-foundation.md).
For the platform, also read docs/security/SECURITY_ARCHITECTURE.md, docs/API.md, and ADR-0006, ADR-0009,
ADR-0010, ADR-0014, ADR-0016, ADR-0017, ADR-0022, ADR-0024 and ADR-0029, and the platform and iam
dictionaries in docs/data-model/. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B03 only, on branch b03-platform-slice: authentication, authorisation with the
maker-checker rule, the audit trail with its hash chain, the outbox and inbox, the ports (observability,
storage, queue, notifications, payments) with one adapter each, and then the Product create, read and
list slice through every layer with unit, integration, contract and end-to-end tests. Keep the slice
small and exemplary: every module session copies its shape. Write the exact login flow into the report,
with token lifetimes and cookie attributes, because the frontend needs it to switch off its stub.
Stop at the gate and write docs/sessions/B03-platform-slice.md.
```

## B4 — Master data and the pricing engine

Branch `b04-master-data-pricing`. Report `docs/sessions/B04-master-data-pricing.md`. Gate: a price resolves for every band, channel and customer tier in the catalogue, and an unresolvable request becomes a quote rather than an error.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B03-platform-slice.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0004, ADR-0020, ADR-0021
and ADR-0001. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate. Confirm that all sixteen hakorem skills are loaded.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day floor
(A-076). Copy the B3 Product slice's shape for every endpoint: domain, application with the policy engine and
idempotency, infrastructure, interface with @Operation, and the operation moved from the planned file into
openapi/<operationId>.yaml (ADR-0031).
Also build what B3 left to B4 (A-087): the file store with uploads, the malware scanner and evidence_file_id on
iam.approval_request; user and grant administration; customer registration and phone verification; password
reset; and the approval endpoints over the existing mechanism. Regenerate the seeded farm through the new MDM and
IAM services (A-085).
Then execute B04 only, on branch b04-master-data-pricing: master data (catalogue, categories, units,
species, grades, weight bands, customers, suppliers, branches, locations, payment methods, delivery
zones, reason codes), price lists in approved effective-dated versions, the pricing engine with the
fixed resolution order and the typed quote-required result, promotions and coupons, and the tax
calculator with named levies per ADR-0020 (exact tests for exclusive and inclusive prices, the
GHS 459.00 beef split into 382.50, 57.38, 9.56 and 9.56, a compounding levy, zero-rated and exempt
categories, and an incomplete scheme version that cannot be activated). Seed the farm.
Stop at the gate and write docs/sessions/B04-master-data-pricing.md.
```

## B5 — Inventory and the stock movement ledger

Branch `b05-inventory-ledger`. Report `docs/sessions/B05-inventory-ledger.md`. Gate: on-hand derived from movements matches a hand count, stock cannot go negative outside the allowed movement types, and a lot traces in both directions.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04-master-data-pricing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, and ADR-0002, ADR-0005,
ADR-0018, ADR-0019 and ADR-0027 (the stock exception part). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 only, on branch b05-inventory-ledger: the append-only movement ledger with the balance
trigger, movement types and reason codes, locations and virtual locations, stock units and lineage,
cost pools with specific identification and weighted average, reservations and holds, goods receipts,
transfers, adjustments with approval, stock take, stock exceptions, and the tests ADR-0002 requires,
each rejection path as its own integration test (negative stock, double sale of a serial unit, sale
under hold, update and delete refused). Extend the seed with stock.
Stop at the gate and write docs/sessions/B05-inventory-ledger.md.
```

## B6 — Livestock and processing

Branch `b06-livestock-processing`. Report `docs/sessions/B06-livestock-processing.md`. Gate: a processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus the direct processing cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05-inventory-ledger.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the LIV and PRC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/liv.md and docs/data-model/prc.md, the LIV and PRC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0018 and ADR-0019. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 only, on branch b06-livestock-processing: the animal register, batches, weights and
growth, health events with veterinary withdrawal holds that nobody can release early, breeding,
mortality and culls with photograph and second approver above the threshold, rations and feed with
head-days allocation, processing orders with yield against standard and variance flag, relative-sales-value
cost allocation by largest remainder, packs and labels. Write the allocation test first: outputs'
allocated costs sum exactly to input cost plus direct cost, including an awkward split. Extend the seed.
Stop at the gate and write docs/sessions/B06-livestock-processing.md.
```

## B7 — Procurement and suppliers, and the storefront cart

Branch `b07-procurement-suppliers`. Report `docs/sessions/B07-procurement-suppliers.md`. Gate: three-way match blocks payment where receipt and supplier invoice disagree, and checkout reserves stock and releases it on timeout.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06-livestock-processing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PUR and SHP requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/pur.md, shp.md and del.md, the PUR, SHP and DEL cards in docs/MODULE_BOUNDARIES.md,
FR-DEL-001, and ADR-0011, ADR-0019, ADR-0020, ADR-0026 (the online-store assignment and the delivery
split) and A-034 and SA-13 in docs/ASSUMPTIONS.md.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 only, on branch b07-procurement-suppliers: suppliers' terms and payout details with
the different-approver rule, requisitions, purchase orders with approval limits, supplier invoices with
the three-way match that blocks payment on disagreement, supplier payments, supplier scores, and, as
ADR-0026 proposes, the public catalogue, cart and checkout reservation with the 15-minute release
(order placement and online payment are B09a), and, as the ADR-0026 delivery split decides, the
del.delivery_slot table and slot generation, with checkout storing a chosen slot through its foreign key
but not enforcing capacity (capacity and cut-offs are B11). Use input levies from ADR-0020 and a reclaimable flag
on the supplier invoice lines. Extend the seed.
Stop at the gate and write docs/sessions/B07-procurement-suppliers.md.
```

## B8 — General ledger, billing and document generation

Branch `b08-ledger-billing`. Report `docs/sessions/B08-ledger-billing.md`. Gate: the trial balance sums to zero on a seeded trading day, an unbalanced journal is rejected by the database itself, and numbering stays gap-free under concurrent load.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07-procurement-suppliers.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN, BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/fin.md, bil.md and doc.md, the FIN, BIL and DOC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0001, ADR-0003, ADR-0005, ADR-0015 and ADR-0020. Read the accountant's answers on A-020, A-024
to A-029, A-033 and A-034 in docs/ASSUMPTIONS.md: if they are still open, proceed on the stated
assumptions, record that in the report, and make each answerable as data. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 only, on branch b08-ledger-billing: the chart of accounts and posting rules as data,
journals with the deferred balance trigger and period lock, subscribers for every event marked as
posting to the ledger (with the boot assertion for a missing subscriber and the nightly reconciliation),
billing documents with levy lines, gap-free numbering, document rendering and archive with the reprint
marker, financial statements. Include the test that adds a fourth levy as data only, and the test that
every row of the ADR-0003 matrix posts exact debit and credit amounts. Regenerate the seed so every
seeded movement has its journal. End the report with B09a's opening message (ADR-0026 verification).
Stop at the gate and write docs/sessions/B08-ledger-billing.md.
```

## B9a — Order core and payments, and online order placement

Branch `b09a-order-core-payments`. Report `docs/sessions/B09a-order-core-payments.md`. Gate: every payment edge case in the shared brief passes, and an order on any channel posts stock, document, payment and ledger in one transaction.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B08-ledger-billing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) and PAY requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/ord.md and pay.md, the ORD and PAY cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 7 (the order state machine), the sale posting sequences in docs/ARCHITECTURE.md, and ADR-0010,
ADR-0014, ADR-0021, ADR-0026 and the abuse cases 1, 4, 5 and 12 in docs/security/THREAT_MODEL.md.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a only, on branch b09a-order-core-payments: the sales order and its state machine for
every channel, the sale posting service (stock issue, billing document and payment in one serializable
transaction), returns against the original sale, voids with a supervisor who is not the cashier, price
variance and override limits, payments and allocations, mobile money and the Paystack adapter against
its sandbox, webhook verification (signature, timestamp window, replay cache, amount re-verification),
refunds, unmatched payments, deposits, store credit and settlement reconciliation, and, as ADR-0026
proposes, online order placement and payment. Write every payment edge case test-first. Point of sale,
shifts and offline sync are B09b: do not start them.
Stop at the gate and write docs/sessions/B09a-order-core-payments.md.
```

## B9b — Point of sale, shifts and offline sync

Branch `b09b-pos-shifts-offline`. Report `docs/sessions/B09b-pos-shifts-offline.md`. Gate: shift close reconciles, and 500 queued offline transactions sync exactly once.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a-order-core-payments.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0015, ADR-0027 and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b only, on branch b09b-pos-shifts-offline: registers and device enrolment, shifts with
the opening float, cash movements and cash drops, X and Z reports, blind close with supervisor sign-off
and over/short posting, held sales, the offline pack, and offline sync: exactly-once by client UUIDv7,
the gap-free device counter, provisional references, occurred-at and recorded-at, cash-only tenders
offline, the stock exception instead of a refusal, price override bounds re-checked at sync. Write
the five conflict tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone
negative, sale in a locked period, missing device counter) and the 500-transaction test with the network
disabled. Run scenario 6 of docs/UAT.md as a dry run and record any difference.
Stop at the gate and write docs/sessions/B09b-pos-shifts-offline.md.
```

## B10 — Quotations, wholesale and credit control

Branch `b10-quotations-wholesale`. Report `docs/sessions/B10-quotations-wholesale.md`. Gate: quote revisions are versioned, conversion to invoice preserves every link, and a credit limit blocks with an audited override.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09b-pos-shifts-offline.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the QUO and WHL requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/quo.md and whl.md, the QUO and WHL cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 5.12, and ADR-0004, ADR-0017 and ADR-0019 (quote reservations), and the abuse case 14 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 only, on branch b10-quotations-wholesale: requests for quote, quotes made of immutable
versions with the margin floor and its approval, reservations for the validity period, acceptance once
through the signed expiring link, conversion to exactly one order with every link kept, business
accounts with credit limit, terms and exposure, the credit override with a different approver, ageing
computed from invoice due dates, statements, dunning, standing orders, overdue hold. Run scenario 2
of docs/UAT.md as a dry run and record any difference, including the two rules that scenario flags
for the owner (credit check and delivery fee on a partial dispatch).
Stop at the gate and write docs/sessions/B10-quotations-wholesale.md.
```

## B11 — Order fulfilment, delivery and notifications

Branch `b11-fulfilment-delivery`. Report `docs/sessions/B11-fulfilment-delivery.md`. Gate: a catch-weight order re-prices at pick, cash on delivery lands against the driver, and the outbox guarantees the customer notification.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B10-quotations-wholesale.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL and NTF cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment)
and the abuse case 6 in docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 only, on branch b11-fulfilment-delivery: pick lists and picking with weight capture,
catch-weight re-pricing and customer consent beyond tolerance, packing, dispatch with the invoice on the
weighed quantity, partial fulfilment and backorders, substitutions, cancellation after confirmation,
delivery slot capacity and booking, zone cut-offs and rescheduling (the slot table and generation
exist from B7, per ADR-0026), routes, drivers, proof of delivery, cash on delivery with the amount due fixed at
dispatch and the driver reconciliation by someone else, the driver's offline sync, notifications through
the outbox (SMS, WhatsApp, email, in-app) with opt-out and templates, and, as ADR-0026 proposes,
abandoned-cart messaging. Run steps 1.11 to 1.16 of docs/UAT.md and the driver case in scenario 5 as a
dry run and record any difference.
Stop at the gate and write docs/sessions/B11-fulfilment-delivery.md.
```

## B12 — Capital, costing, reporting and the public API, and the daily exception report

Branch `b12-capital-costing-reporting`. Report `docs/sessions/B12-capital-costing-reporting.md`. Gate: a distribution matches a hand calculation on unit-days and ties exactly to the ledger.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11-fulfilment-delivery.md).
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
Write the five tests of ADR-0028 under the names the ADR gives them, and run scenario 4 of
docs/UAT.md as a dry run: the net profit for July to September 2026 in the seed is GHS 41,666.70 and
the hand calculation must match the run to the pesewa.
Stop at the gate and write docs/sessions/B12-capital-costing-reporting.md.
```

## B13 — Hardening, smoke suite and deploy

Branch `b13-hardening-deploy`. Report `docs/sessions/B13-hardening-deploy.md`. Gate: every non-functional target met and evidenced on the live server.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B13 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12-capital-costing-reporting.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, also read the non-functional requirements table in docs/SHARED_BRIEF.md,
docs/security/THREAT_MODEL.md sections 4 and 5, docs/UAT.md, docs/OPERATIONS.md, docs/DEPLOYMENT.md,
docs/TEST_STRATEGY.md and ADR-0025, and docs/security/COMPLIANCE.md. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B13 only, on branch b13-hardening-deploy: load tests with k6 against every target in the
non-functional table, with the actual numbers recorded in docs/OPERATIONS.md; every one of the eighteen
abuse cases turned into two tests, one that the control blocks or makes it visible and one that the
attempt appears on GET /exceptions/daily-report under the kind the threat model names, with the actor,
amount, subject document and its case number in abuseCases (a case that is blocked but absent from the
report is a failing test); the OWASP ZAP baseline against staging; the smoke suite under 60 seconds;
the runbooks, one per failure mode; data migration with a dry-run mode; retention jobs and data-subject
requests, as ADR-0026 proposes; provisioning of staging and production; and the restore drill with the
time actually taken. Then run the seven scenarios of docs/UAT.md against staging, with someone
non-technical driving wherever that is possible: anything they cannot complete without a developer is
not finished.
Stop at the gate and write docs/sessions/B13-hardening-deploy.md.
```

---

## If a session cannot finish

Stop at the nearest green commit, push, write the report with a clearly marked "continued" section, and open the next session with the same opener, changing only the report it reads and adding "continued" after the identifier (`B05 continued`). Never split in the middle of a module.

## Keeping this file true

- A session that changes the plan (a split, a moved item, an owner decision on a proposed assignment) updates ADR-0026 or adds an ADR, then updates this file in the same pull request.
- A new document that a later session must read is added to that session's opener.
- The ids, slugs and branches here are the ones used in every report and every branch name. Do not rename one without renaming all three.
