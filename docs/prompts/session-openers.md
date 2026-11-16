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
| B4 continued | `B04c-master-data-continued.md` | `b04c-master-data-continued` | B4 to B12 | The tax calculator's exact cases pass (built; the session split, A-097) |
| B4 continued (d) | `B04d-master-data-promotions.md` | `b04d-master-data-promotions` | B4 to B12 | Promotions stack by their rules and a coupon limit holds under concurrency (built; the session split, A-103) |
| B04d continued | `B04d-continued-master-data.md` | `b04d-continued-master-data` | B4 to B12 | Every catalogue write refuses the wrong role; the catalogue, price lists, tax scheme and promotions are seeded through services, and `calculateTax` answers on a fresh setup (built; the session split, A-108) |
| B04d continued 2 | `B04d2-parties-locations.md` | `b04d2-parties-locations` | B4 to B12 | Every branch, location, customer and assignment write refuses the wrong role; branches, locations and customers are seeded through services, and nothing in the MDM seed is written as SQL (built; the session split, A-114) |
| B04d continued 3 | `B04d3-reference-data.md` | `b04d3-reference-data` | B4 to B12 | Every remaining master data write refuses the wrong role; reason codes are a fixed list; `quoteDelivery` returns a zone's exact fee or "delivery unavailable"; the payment methods, zones and their seed are written through services (built) |
| B4 continued (e) | `B04e-iam-carry-overs.md` | `b04e-iam-carry-overs` | B4 to B12 | User, role-reading and grant administration refuse the wrong role; the IAM seed is written through the IAM services (built; the session split, A-121) |
| B04e continued | `B04e2-auth-approvals.md` | `b04e2-auth-approvals` | B4 to B12 | Role writes, the approval endpoints, customer registration and phone verification, and password reset with CR-004 point 3's error codes are live, each with a wrong-role refusal (built) |
| B04e continued 2 | `B04e3-file-store-imports.md` | `b04e3-file-store-imports` | B4 to B12 | The file store with uploads, the malware scanner and `evidence_file_id` are live, each with a wrong-role refusal (built; the session split, A-125) |
| B04e continued 3 | `B04e4-product-images-imports.md` | `b04e4-product-images-imports` | B4 to B12 | Product images attach through the file store with compressed public variants and a hidden original, each write with a wrong-role refusal (built; the session split, A-127) |
| B04e continued 4 | `B04e5-mdm-imports-exports.md` | `b04e5-mdm-imports-exports` | B4 to B12 | MDM's imports and exports run with a dry run that writes nothing, apply all or none, and audit exports with their row count, step-up above the bulk threshold and a signed expiring link, each write with a wrong-role refusal (built for the customer sheet; the session split, A-129) |
| B04e continued 5 | `B04e6-mdm-import-sheets.md` | `b04e6-mdm-import-sheets` | B4 to B12 | The product, supplier, location and price list entry sheets import with a dry run that writes nothing and apply all or none through each entity's own service, and export audited with their row count, each with a wrong-role refusal (built) |
| B5 | `B05-inventory-ledger.md` | `b05-inventory-ledger` | B4 to B12 | The movement ledger and its database invariants, each proved by its own test; valuation at 100 percent; a lot traces both ways (built; the session split, A-131) |
| B05 continued | `B05b-inventory-documents.md` | `b05b-inventory-documents` | B4 to B12 | On-hand from movements matches a hand count of the seeded farm; a lot traces both ways over the API; every goods receipt write refuses the wrong role (built; the session split, A-138) |
| B05 continued 2 | `B05c-inventory-control.md` | `b05c-inventory-control` | B4 to B12 | Every movement reversal, transfer and adjustment write refuses the wrong role; an adjustment at or above the threshold waits for a different person; a transfer balances received plus variance to dispatched (built; the session split, A-140) |
| B05 continued 3 | `B05d-inventory-counts-holds.md` | `b05d-inventory-counts-holds` | B4 to B12 | A stock take posts its variances from blind counts, overlapping cycle counts are refused, a hold blocks a sale until released, each write with a wrong-role refusal (built; the session split, A-143) |
| B05 continued 3b | `B05d2-inventory-reservations-exceptions.md` | `b05d2-inventory-reservations-exceptions` | B4 to B12 | An expired reservation is released by the job exactly as reserved, under concurrency; one active reservation per animal; an exception is resolved through the adjustment path; each write with a wrong-role refusal (built; ADR-0048 built with it, A-145) |
| B05 continued 4 | `B05e-inventory-cold-chain-opening.md` | `b05e-inventory-cold-chain-opening` | B4 to B12 | The B5 gate in full: on-hand from movements matches a hand count of the seeded farm; stock cannot go negative outside allowed types; a lot traces both ways; every INV write refuses the wrong role |
| B05x | `B05x-dashboard-branches-labels.md` | `b05x-dashboard-branches-labels` | B4 to B12 | getOwnerDashboard answers in one request with its sourceless figures null and listed; every tile whose data exists answers exactly on the seeded farm, the rest are contract-only and scheduled; a branch deactivates with its refusals and lists stay within grants; lot and product label data answers; every operation refuses the wrong role (built) |
| B6 | `B06-livestock-processing.md` | `b06-livestock-processing` | B4 to B12 | A processing order produces lots whose costs sum exactly to input cost plus direct processing cost (built; the session split, A-154) |
| B06m | `B06m-master-data-requests.md` | `b06m-master-data-requests` | B4 to B12 | The draft price list preview answers exactly by the engine's identity and refuses the wrong role; price list examples agree; CR-011 answered (built) |
| B06 continued | `B06b-livestock-packs.md` | `b06b-livestock-packs` | B4 to B12 | Every LIV write built refuses the wrong role; a withdrawal hold blocks sale and processing and nobody releases it early; mortality at or above the threshold waits for a photograph and a different approver; feed and veterinary cost spread by head-days sum exactly to the value issued (built; the session split, A-158) |
| B06 continued 2 | `B06c-livestock-growth-breeding.md` | `b06c-livestock-growth-breeding` | B4 to B12 | Every remaining LIV write refuses the wrong role; a move starts only where the animal is; average daily gain and feed conversion match a hand calculation; a batch closes only when empty; a birth registers its offspring at nil cost linked to the dam; the feed, medicine and ration seed is counted by hand (built) |
| B06 continued 3 | `B06d-packs-labels.md` | `b06d-packs-labels` | B4 to B12 | Pack weights equal the lot weight and a pack label encodes the lot and the weight; a completed order reverses only while its outputs are unsold; every pack write refuses the wrong role; the Farm hand sees no cost on any LIV or PRC operation its grants reach (built) |
| B06u | `B06u-uom-conversions.md` | `b06u-uom-conversions` | B4 to B12 | Alternative units convert exactly, an inexact factor is refused by the database, conversions list in the contract, writes refuse the wrong role (built) |
| B7 | `B07-procurement-suppliers.md` | `b07-procurement-suppliers` | B4 to B12 | Three-way match blocks payment on disagreement (built; the session split, A-165) |
| B07 continued | `B07b-supplier-register.md` | `b07b-supplier-register` | B4 to B12 | A payout change waits for a different approver and the old details stay in force; a disguised document is refused; a rejected requisition cannot be converted; every write refuses the wrong role (built; the session split, A-167) |
| B07 continued 1b | `B07b2-supplier-credit-scores.md` | `b07b2-supplier-credit-scores` | B4 to B12 | A credit note cannot exceed its invoice's uncredited amount; an approved variance lets a mismatched invoice be paid; a payment's remittance data is answered once; the score matches a hand calculation; every write refuses the wrong role (built) |
| B06r | `B06r-processing-reversal-approval.md` | `b06r-processing-reversal-approval` | B4 to B12 | A processing reversal waits for a second approver at or above the threshold and is refused once a pack is sold or moved; a farm hand finds an animal by tag, reports and submits a death with its EVIDENCE photograph, and a manager approves it whatever its value; a reused photograph is flagged (built) |
| B07 continued 2 | `B07c-storefront-checkout.md` | `b07c-storefront-checkout` | B4 to B12 | The shared sort pages without skipping or repeating; checkout reserves stock and releases it on timeout; a live animal cannot be added to a cart; the catalogue exposes no cost; every staff write refuses the wrong role (built; the session split, A-179) |
| B07 continued 3 | `B07c3-console-sort.md` | `b07c3-console-sort` | B4 to B12 | The four console lists sort through the shared keyset by CR-019's fields, each indexed, any other 400, and page without skipping or repeating; every read refuses the wrong role (built; six fields declined, A-181) |
| B8 | `B08-ledger-billing.md` | `b08-ledger-billing` | B4 to B12 | Trial balance sums to zero on a seeded day; an unbalanced journal is rejected by the database; numbering is gap-free under concurrent load (built and passed; the session split after its gate, A-187) |
| B08 continued | `B08c-ledger-interface.md` | `b08c-ledger-interface` | B4 to B12 | An entry written inside a savepoint keeps its lines; every chart and period operation refuses the wrong role and the Owner approving their own reopen; a period locks, closes and refuses postings through the API (built; the session split, A-189) |
| B08 continued 1b | `B08c1b-journals-rules-banks.md` | `b08c1b-journals-rules-banks` | B4 to B12 | Every journal, manual journal, rule and determination operation refuses the wrong role and a maker approving their own manual journal or rule change; a manual journal posts nothing until a different person approves it, then exactly one balanced entry as entered; `fin.ManualJournalApproved` has its matrix row (built; the session split before its bank accounts, A-192) |
| B08 continued 1b2 | `B08c1b2-bank-accounts.md` | `b08c1b2-bank-accounts` | B4 to B12 | Every bank account operation refuses the wrong role; a bank account's number is stored encrypted and shown only as its last four digits; a supplier payment naming a bank account posts to that account's own subledger party (built; ADR-0057, A-193, A-194) |
| B08 continued 1c | `B08c1c-statements-assets.md` | `b08c1c-statements-assets` | B4 to B12 | The four statements tie to the trial balance on the seeded day, each read refusing the wrong role; year close leaves 3200 at zero and 3100 increased by the year's profit; the cash figure answers from the ledger (built; the session split before fixed assets, A-198) |
| B08 continued 1c2 | `B08c1c2-fixed-assets.md` | `b08c1c2-fixed-assets` | B4 to B12 | Depreciation spreads exactly and posts once per period under concurrent runs; every fixed asset write refuses the wrong role; disposal posts its exact gain or loss; the statements still tie on the seeded day |
| B08 continued 2 | `B08c2-billing-documents.md` | `b08c2-billing-documents` | B4 to B12 | A billing document posts exact levy lines and a fourth levy needs data only; numbering stays gap-free under concurrent issue; a reprint is identical with its marker; the trial balance still sums to zero on the seeded day |
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

## B4 continued — The rest of master data, tax, promotions and the B3 carry-overs

Branch `b04c-master-data-continued`. Report `docs/sessions/B04c-master-data-continued.md`. B4 built the pricing sub-domain and passed its gate (`docs/sessions/B04-master-data-pricing.md`); this session finishes MDM and the items B3 left. Gate: the tax calculator's exact cases pass (exclusive and inclusive prices, the GHS 459.00 beef split into 382.50, 57.38, 9.56 and 9.56, a compounding levy, zero-rated and exempt categories, an incomplete scheme version refused); promotions apply only to tier, channel and base prices and stack by their rules, and a coupon limited to 100 refuses the 101st under 20 concurrent redemptions; the A-087 operations are live, each with a wrong-role refusal; the seeded farm is written through the MDM and IAM services.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04-master-data-pricing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0020, ADR-0036 and ADR-0004
(the promotions part). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if
@nestjs/platform-express 11.2.10 has passed the 14-day floor (A-076). Copy the B3 Product slice's shape
for every endpoint, with the fragment moved from the planned file (scripts/contract/move-to-code.ts).
Then execute B04 continued only, on branch b04c-master-data-continued: the A-087 items (the file store
with uploads, the malware scanner and evidence_file_id on iam.approval_request; user and grant
administration; customer registration and phone verification; password reset; approveRequest,
rejectRequest, listApprovals and getApproval over the existing mechanism); the rest of master data
(categories, species, grades, weight bands, customers and addresses, tiers, suppliers, branches,
locations, payment methods, delivery zones, reason codes, assignCustomerPriceList, updateProduct, the
price list listings); promotions and coupons in the engine after the base price; and the tax calculator
with named levies per ADR-0020 with the exact tests above. Regenerate the seeded farm, B3's slice and
B4's, through the new services (A-085), keeping src/seed/reference-pricing.ts as the price definition.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the tax calculator under
src/modules/mdm/domain/tax/ and uncomment its 100 percent gate in vitest.config.mts; put the promotion
rules under src/modules/mdm/domain/pricing/, where B4's gate already covers them. Fill every branch the
gates expose; the gate does not pass on a lowered number.
Stop at the gate and write docs/sessions/B04c-master-data-continued.md.
```

## B4 continued (d) — Promotions, the rest of master data and the MDM seed

**Split on 2026-11-15 (A-103):** B04d built promotions and coupons and passed that part of the gate; the rest of master data and the MDM seed moved to "B04d continued" below, which carries the rest of this gate.

Branch `b04d-master-data-promotions`, from `b04c-master-data-continued` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d-master-data-promotions.md`. B04 continued built the tax sub-domain and split (A-097, ADR-0026 Amendments). Gate: promotions apply only to tier, channel and base prices and stack by their rules (two in one stack group, only the larger applies; an exclusive 10 percent with a 5 percent in another group applies only the exclusive one), and a coupon limited to 100 refuses the 101st under 20 concurrent redemptions without exceeding 100; every master data write refuses the wrong role; the seeded farm's MDM data, its tax scheme version 1 included, is written through the MDM services, and `calculateTax` answers on a fresh `pnpm run setup`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04c-master-data-continued.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0004 (the promotions part),
ADR-0036 and ADR-0039. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the B3 Product slice's shape for every endpoint, with the fragment moved from the
planned file (scripts/contract/move-to-code.ts), and the tax slice's shape for maker-checker documents.
Then execute B04d only, on branch b04d-master-data-promotions, branched from b04c-master-data-continued:
promotions and coupons in the engine after the base price (FR-MDM-018), the promotion rules under
src/modules/mdm/domain/pricing/ where the 100 percent gate already covers them, the coupon limit held by
a row lock in the database, the discount a separate recorded adjustment on the line; the rest of master
data (categories, units of measure with CR-003's displayDecimals, species, grades, weight bands,
customers and addresses, tiers, suppliers, branches, locations, payment methods, delivery zones, reason
codes, assignCustomerPriceList, updateProduct, the price list listings); and the MDM seed through the
new services (A-085), including tax scheme version 1 with the ADR-0020 seed matrix drafted by the
seeded Accountant and approved by the seeded Owner, keeping src/seed/reference-pricing.ts as the price
definition. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's: build
them there or record them as deferred. Write the failing tests first for every money and permission rule.
Stop at the gate, write docs/sessions/B04d-master-data-promotions.md, push, and open a stacked pull
request against b04c-master-data-continued.
```

## B04d continued — The rest of master data and the MDM seed

Branch `b04d-continued-master-data`, from `b04d-master-data-promotions` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d-continued-master-data.md`. B04d built promotions and coupons (FR-MDM-018, ADR-0040, contract 1.6.0) and split at that sub-domain boundary (A-103, ADR-0026 Amendments). Gate: every master data write refuses the wrong role; the seeded farm's MDM data, its tax scheme version 1 included, is written through the MDM services, and `calculateTax` answers on a fresh `pnpm run setup`. When this gate passes, B04d's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d-master-data-promotions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0039 and ADR-0040.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the B3 Product slice's shape for every endpoint, with the fragment moved from the
planned file (scripts/contract/move-to-code.ts), and the promotion slice's shape (B04d) for lists,
updates with a version and maker-checker documents.
Then execute B04d continued only, on branch b04d-continued-master-data, branched from
b04d-master-data-promotions: the rest of master data (categories, units of measure with CR-003's
displayDecimals, species, grades, weight bands, customers and addresses, tiers, suppliers, branches,
locations, payment methods, delivery zones, reason codes, assignCustomerPriceList, updateProduct, the
price list listings), each write with a wrong-role refusal; and the MDM seed through the services (A-085),
including tax scheme version 1 with the ADR-0020 seed matrix drafted by the seeded Accountant and approved
by the seeded Owner, keeping src/seed/reference-pricing.ts as the price definition, and seeded promotions
through Promotions. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's:
build them there or record them as deferred. Write the failing tests first for every money and permission
rule. Stop at the gate, write docs/sessions/B04d-continued-master-data.md, push, and open a stacked pull
request against b04d-master-data-promotions.
```

## B04d continued 2 — Parties, locations and the rest of the MDM seed

Branch `b04d2-parties-locations`, from `b04d-continued-master-data` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d2-parties-locations.md`. B04d continued built the catalogue (categories, units with CR-003, species, grades, weight bands, `updateProduct`; contract 1.7.0) and the seed through services for the catalogue, the price lists, tax scheme version 1 and the promotions (ADR-0041), then split at that sub-domain boundary (A-108, ADR-0026 Amendments). Gate: every remaining master data write refuses the wrong role; branches, locations and customers are seeded through the MDM services, the caterer's contract list is assigned through `assignCustomerPriceList`, and no part of the MDM seed is written as SQL. When this gate passes, B04d's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d-continued-master-data.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0040 and ADR-0041.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the catalogue slice's shape (B04d continued: CatalogueAdmin, PgCatalogueStore,
CatalogueController) for every endpoint, with the fragment moved from the planned file
(scripts/contract/move-to-code.ts).
Then execute B04d continued 2 only, on branch b04d2-parties-locations, branched from
b04d-continued-master-data: customers and addresses (FR-MDM-008, with Ghana phone normalisation), tiers,
suppliers (FR-MDM-007), branches and locations (FR-MDM-006, the parent in the same branch, enforced by the
database too), payment methods (FR-MDM-009), delivery zones and quoteDelivery (FR-MDM-010), reason codes
(FR-MDM-011, a fixed list seeded by migration), the price list listings and updates (listPriceLists,
updatePriceList, archivePriceList, listPriceListVersions, listPriceListEntries), assignCustomerPriceList
(FR-MDM-021) and archiveProduct, each write with a wrong-role refusal; and the rest of the MDM seed
through the services (A-085, ADR-0041): branches, locations and customers move from src/seed/farm-b3.ts
and src/seed/farm-b4.ts into src/seed/farm-mdm.ts, and the caterer's list is assigned through
assignCustomerPriceList, replacing the interim SQL there. Imports and exports (FR-MDM-019, FR-MDM-020)
need the file store, which is B04e's: build them there or record them as deferred. Write the failing
tests first for every money and permission rule. Stop at the gate, write
docs/sessions/B04d2-parties-locations.md, push, and open a stacked pull request against
b04d-continued-master-data.
```

## B04d continued 3 — Suppliers and the reference data

Branch `b04d3-reference-data`, from `b04d2-parties-locations` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04d3-reference-data.md`. B04d continued 2 built branches and locations, customers with their tiers and addresses, and `assignCustomerPriceList` (contract 1.8.0, ADR-0042), and moved the rest of the MDM seed onto the services, then split at that sub-domain boundary (A-114, ADR-0026 Amendments). Gate: every remaining master data write refuses the wrong role; reason codes are a fixed list seeded by migration with no write operation; `quoteDelivery` returns exactly 1,500 pesewas for an address in a zone whose fee is 1,500, and "delivery unavailable" (not zero) for an address in none; payment methods and delivery zones are seeded through the MDM services. When this gate passes, B04d's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d2-parties-locations.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0041 and ADR-0042.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the parties and locations slice's shape (B04d continued 2: AdminKit, PartiesAdmin,
PgPartiesStore, PartiesController) for every endpoint, with the fragment moved from the planned file
(scripts/contract/move-to-code.ts).
Then execute B04d continued 3 only, on branch b04d3-reference-data, branched from
b04d2-parties-locations: suppliers (FR-MDM-007, phones normalised as customers' are), payment methods
(FR-MDM-009), delivery zones and quoteDelivery (FR-MDM-010, with the expand migration that adds
delivery_zone_id to mdm.customer_address and resolves it at save, A-112), reason codes (FR-MDM-011, a fixed
list seeded by migration), the price list listings and updates (listPriceLists, updatePriceList,
archivePriceList, listPriceListVersions, listPriceListEntries) and archiveProduct, each write with a
wrong-role refusal; and their seed through the services (A-085, ADR-0041): the payment methods and a
Dodowa delivery zone. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's:
build them there or record them as deferred. Write the failing tests first for every money and permission
rule (a zone fee is exact pesewas). Stop at the gate, write docs/sessions/B04d3-reference-data.md, push,
and open a stacked pull request against b04d2-parties-locations.
```

## B4 continued (e) — The B3 carry-overs in IAM

**Built, and split (A-121).** B04e built user, role-reading and grant administration and moved the IAM seed onto the services (ADR-0043); the rest moved to the two sections that follow. The opener below is kept as it was run.

Branch `b04e-iam-carry-overs`, from `b04d3-reference-data` (stacked). Report `docs/sessions/B04e-iam-carry-overs.md`. Gate: the A-087 operations are live (the file store with uploads, the malware scanner and `evidence_file_id` on `iam.approval_request`; user and grant administration; customer registration and phone verification; password reset with CR-004 point 3's error codes; `approveRequest`, `rejectRequest`, `listApprovals` and `getApproval` over the existing mechanism), each with a wrong-role refusal; the IAM seed is written through the IAM services. When this gate passes, B04 continued's gate as a whole has passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d3-reference-data.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the IAM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/iam.md, the IAM card in docs/MODULE_BOUNDARIES.md, ADR-0017, ADR-0034, ADR-0035 and A-057
in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are authentication, uploads and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e only, on branch b04e-iam-carry-overs, branched from b04d3-reference-data: the
A-087 items listed in the gate, MDM's imports and exports if B04d continued 3 deferred them, and the IAM seed through
the IAM services (A-085). Write the failing tests first for every permission rule.
Stop at the gate, write docs/sessions/B04e-iam-carry-overs.md, push, and open a stacked pull request
against b04d3-reference-data.
```

## B04e continued — Roles, approvals and the customer realm

**Built** (contract 1.11.0, A-122, A-123): the whole gate, with no split. The opener below is kept as it was run.

Branch `b04e2-auth-approvals`, from `b04e-iam-carry-overs` (stacked; nothing is merged until the owner approves). Report `docs/sessions/B04e2-auth-approvals.md`. B04e built user, role-reading and grant administration (contract 1.10.0, A-120) and moved the IAM seed onto the services (ADR-0043), then split at that sub-domain boundary (A-121, ADR-0026 Amendments). Gate: `createRole` and `updateRole` (step-up, system roles not deletable), `listApprovals`, `getApproval`, `approveRequest`, `rejectRequest` and `cancelApprovalRequest` over the existing mechanism, `registerCustomer` and `verifyCustomerPhone` (FR-IAM-019: an identical answer for a known phone, a 6th wrong code refused even if correct), and `requestPasswordReset` and `resetPassword` (FR-IAM-020, with CR-004 point 3's named error codes for a wrong, used or expired token) are live, each write with a wrong-role refusal.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e-iam-carry-overs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the IAM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/iam.md, the IAM card in docs/MODULE_BOUNDARIES.md, ADR-0017, ADR-0034, ADR-0035 and
ADR-0043. Use docs/prompts/module-build-prompt.md as the recipe, and run hakorem-security-review on every
operation: they are authentication, approvals and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Copy the user and grant slice's shape (B04e: AccessAdmin, PgAccessStore, AccessController) for every
endpoint, with the fragment moved from the planned file (scripts/contract/move-to-code.ts).
Then execute B04e continued only, on branch b04e2-auth-approvals, branched from b04e-iam-carry-overs:
role writes (createRole, updateRole), the approval endpoints over the existing Approvals mechanism
(listApprovals, getApproval, approveRequest, rejectRequest, cancelApprovalRequest), customer registration
and phone verification (FR-IAM-019), and password reset (FR-IAM-020) with CR-004 point 3's error codes.
Notification delivery is B11's: send the codes through the existing notification port and record what
waits. Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e2-auth-approvals.md, push, and open a stacked pull request against b04e-iam-carry-overs.
```

## B04e continued 2 — The file store, uploads and MDM imports

**Built in part** (contract 1.12.0, ADR-0044, A-124): the file store, the scanner and `evidence_file_id`. The session split at the boundary between the file store and its consumers (A-125); product images and the imports and exports are B04e continued 3's. The opener below is kept as it was run.

Branch `b04e3-file-store-imports`, from `b04e2-auth-approvals` (stacked). Report `docs/sessions/B04e3-file-store-imports.md`. Gate: `uploadFile`, `getFile` and `createFileSignedUrl` are live on the platform file store (size cap before the body is read, type by content sniffing, a random key, scan status `PENDING` until the malware scanner (A-057) says `CLEAN`, signed expiring URLs logged), `iam.approval_request.evidence_file_id` exists with its foreign key, product images attach through it, and MDM's imports and exports (FR-MDM-019, FR-MDM-020) run with a dry-run preview, each write with a wrong-role refusal. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e2-auth-approvals.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM and DOC requirement blocks' file and import requirements in docs/SRS.md
(FR-MDM-019, FR-MDM-020 and the DOC upload requirements, nothing else), docs/data-model/iam.md,
docs/data-model/mdm.md, the platform and MDM cards in docs/MODULE_BOUNDARIES.md, ADR-0025, ADR-0032 and
A-057 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 2 only, on branch b04e3-file-store-imports, branched from b04e2-auth-approvals:
the file store with uploadFile, getFile and createFileSignedUrl, the malware scanner (A-057),
evidence_file_id on iam.approval_request, product images, and MDM's imports and exports with a dry run.
Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e3-file-store-imports.md, push, and open a stacked pull request against b04e2-auth-approvals.
```

## B04e continued 3 — Product images and MDM imports and exports

**Built in part** (contract 1.13.0, ADR-0045, A-126): product photographs, their public variants and the gallery operations. The session split at the boundary between the photographs and the spreadsheet imports and exports (A-127); the imports and exports are B04e continued 4's. The opener below is kept as it was run.

Branch `b04e4-product-images-imports`, from `b04e3-file-store-imports` (stacked). Report `docs/sessions/B04e4-product-images-imports.md`. B04e continued 2 built the file store (contract 1.12.0, ADR-0044, A-124): `uploadFile`, `getFile` and `createFileSignedUrl` in the DOC module over the platform `FileStore`, the ClamAV scan in the worker, and `evidence_file_id`, then split at the boundary between the file store and its consumers (A-125, ADR-0026 Amendments). Gate: `addProductImage` (and the other product image operations the contract plans) attaches a CLEAN `PRODUCT_IMAGE` file through `mdm.product_image`, re-encoded into variants at 320, 640 and 1280 pixels (WebP with a JPEG fallback) in `platform.stored_file_variant`, none above 200 KB at 640 pixels for a 4 MB JPEG, the original never served publicly (FR-DOC-005); and MDM's imports and exports (FR-MDM-019, FR-MDM-020: `listImportJobs`, `createImportJob`, `getImportJob`, `listImportErrors`, `applyImportJob`, `cancelImportJob`, `createExportJob`) run with a dry run that writes nothing, apply all or none, and audit exports with their row count, step-up above the bulk threshold and a signed expiring link, each write with a wrong-role refusal. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e3-file-store-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020, FR-DOC-005 and SEC-009 in docs/SRS.md (nothing else),
docs/data-model/mdm.md (product images, import jobs and their errors), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044
and A-124 and A-125 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 3 only, on branch b04e4-product-images-imports, branched from
b04e3-file-store-imports: product images through the file store with their variants (an image library
needs an ADR), and MDM's imports and exports with a dry run (a spreadsheet library needs an ADR). Reuse
the platform FileStore and the DOC upload; do not add a second upload path. Write the failing tests first
for every permission rule. Stop at the gate, write docs/sessions/B04e4-product-images-imports.md, push,
and open a stacked pull request against b04e3-file-store-imports.
```

## B04e continued 4 — MDM imports and exports

**Built in part** (contract 1.14.0, ADR-0046, A-128): the import and export mechanism (the spreadsheet codec, the seven operations, the job rules in the database) with the customer sheet, and that part of the gate passed. The session split at the boundary between the mechanism and the remaining sheets (A-129); those are B04e continued 5's, and opening stock is B5's. The opener below is kept as it was run.

Branch `b04e5-mdm-imports-exports`, from `b04e4-product-images-imports` (stacked). Report `docs/sessions/B04e5-mdm-imports-exports.md`. B04e continued 3 built product photographs (contract 1.13.0, ADR-0045, A-126): the worker's variants in `platform.stored_file_variant`, `addProductImage` and `removeProductImage` over `mdm.product_image`, then split at the boundary between the photographs and the spreadsheet imports (A-127, ADR-0026 Amendments). Gate: MDM's imports and exports (FR-MDM-019, FR-MDM-020: `listImportJobs`, `createImportJob`, `getImportJob`, `listImportErrors`, `applyImportJob`, `cancelImportJob`, `createExportJob`) run over an `IMPORT` file from the file store with a dry run that writes nothing, apply all or none in one transaction, and audit exports with their row count, step-up above the bulk threshold (SEC-009) and a signed expiring link, each write with a wrong-role refusal. `OPENING_STOCK` writes stock, which INV owns and B5 builds: decide with an assumption whether its dry run and apply wait for B5. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e4-product-images-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020 and SEC-009 in docs/SRS.md (nothing else), docs/data-model/mdm.md
(import jobs and their errors, and the tables of the entities an import writes), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044,
ADR-0045 and A-124 to A-127 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and
run hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 4 only, on branch b04e5-mdm-imports-exports, branched from
b04e4-product-images-imports: MDM's imports and exports with a dry run (a spreadsheet library needs an ADR),
reading the IMPORT file through the platform FileStore; do not add a second upload path. Write the failing
tests first for every permission rule. Stop at the gate, write docs/sessions/B04e5-mdm-imports-exports.md,
push, and open a stacked pull request against b04e4-product-images-imports.
```

## B04e continued 5 — The remaining MDM import sheets

**Built** (contract 1.15.0, A-130): the product, supplier, location and price list entry sheets, and the gate passed. With it B04e's and B04 continued's gates as a whole have passed. The opener below is kept as it was run.

Branch `b04e6-mdm-import-sheets`, from `b04e5-mdm-imports-exports` (stacked). Report `docs/sessions/B04e6-mdm-import-sheets.md`. B04e continued 4 built the import and export mechanism (contract 1.14.0, ADR-0046, A-128): `src/platform/spreadsheet/` (XLSX and CSV on Node's zlib, no dependency), `MdmImports` with the seven operations over `mdm.import_job` (HK009), and one `EntitySheet`, `CustomerSheet`, which applies rows through `PartiesAdmin.createCustomerIn` and `updateCustomerIn`; then it split at the boundary between the mechanism and the remaining sheets (A-129, ADR-0026 Amendments). Gate: the `PRODUCT`, `SUPPLIER`, `LOCATION` and `PRICE_LIST_ENTRY` sheets each import with a dry run that writes nothing and apply all rows or none through the entity's own service in the import's transaction (an `...In` method like `createCustomerIn`), and export audited with their row count and a fresh step-up, each with a wrong-role refusal and its own row-error tests; `AVAILABLE_ENTITIES` then lists every entity but `OPENING_STOCK`, which stays 422 `IMPORT_ENTITY_NOT_AVAILABLE` until B5. When this gate passes, B04e's and B04 continued's gates as a whole have passed.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e5-mdm-imports-exports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019 and FR-MDM-020 in docs/SRS.md and the requirements of the entities a sheet
writes (FR-MDM-001 products, the supplier, location and price list entry requirements; nothing else),
docs/data-model/mdm.md (import jobs and the tables of products, suppliers, locations and price list entries),
the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0046 and A-128 and A-129 in docs/ASSUMPTIONS.md. Use
docs/prompts/module-build-prompt.md as the recipe, and run hakorem-security-review on every sheet: they are
imports, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 5 only, on branch b04e6-mdm-import-sheets, branched from
b04e5-mdm-imports-exports: one EntitySheet each for products, suppliers, locations and price list entries
(price list entries into a draft version, never an active one), each writing through the entity's own
service in the import's transaction. Reuse MdmImports and the platform spreadsheet codec; do not add a
dependency. Write the failing tests first for every permission rule and every price. Stop at the gate,
write docs/sessions/B04e6-mdm-import-sheets.md, push, and open a stacked pull request against
b04e5-mdm-imports-exports.
```

## B5 — Inventory and the stock movement ledger

**Built in part; the session split** (A-131, ADR-0026 Amendments): the movement ledger and every database invariant, valuation under its 100 percent gate, `Stock.postIn`, `Lineage` and `BalanceReconciliation`, contract unchanged at 1.15.0. The rest is B05 continued, below. The opener is kept as it was run.

Branch `b05-inventory-ledger`. Report `docs/sessions/B05-inventory-ledger.md`. Gate: on-hand derived from movements matches a hand count, stock cannot go negative outside the allowed movement types, and a lot traces in both directions. B5 also builds the `OPENING_STOCK` import sheet, deferred from B04e continued 4 (A-128).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e6-mdm-import-sheets.md).
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
under hold, update and delete refused). Extend the seed with stock. Build the OPENING_STOCK import sheet
too (A-128): MDM sits below INV, so the sheet is INV's, registered with MdmImports through a port MDM
defines and INV implements (like ProductUsageCheck; a new port needs an ADR), posting OPENING_BALANCE
movements in the import's transaction; read ADR-0046 for the mechanism.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put stock valuation under
src/modules/inv/domain/valuation/ and uncomment its 100 percent gate in vitest.config.mts before the
gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
Stop at the gate and write docs/sessions/B05-inventory-ledger.md.
```

## B05 continued — Stock documents, the INV endpoints, opening stock and the seed

**Built in part; the session split** (A-138, ADR-0026 Amendments): goods receipts (migration 0047, permissions 0048 and 0049, six operations), stock on hand at cost, a stock unit and the trace over HTTP, CR-001 and CR-003 point 2 (contract 1.16.0), and the seed with stock through the services; the hand count of the seeded farm and the two-way trace over the API pass. The rest is B05 continued 2, below. The opener is kept as it was run.

Branch `b05b-inventory-documents`, from `b05-inventory-ledger` (stacked). Report `docs/sessions/B05b-inventory-documents.md`. B5 built the ledger core (A-131): migrations 0042 to 0046, schema `inv` with every stock invariant in the triggers of 0044 (SQLSTATE HK010, the rule as the constraint name), MDM's published functions `location_stock_facts` and `product_tracking` (ADR-0047), `src/modules/inv/domain/valuation/` under its gate, `Stock.postIn` (serializable only; refusals arrive as `INSUFFICIENT_STOCK`, `STOCK_UNIT_NOT_AVAILABLE`, `STOCK_UNIT_ON_HOLD`, `STOCK_UNIT_RESERVED`, `STOCK_MOVEMENT_ALREADY_REVERSED`; the ADR-0003 posting event through the outbox), `Lineage.linkIn` and `trace`, and `BalanceReconciliation.run` (raises `BALANCE_DRIFT`, corrects nothing; not yet scheduled). Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05-inventory-ledger.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0018,
ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128 and A-131 to A-134 in
docs/ASSUMPTIONS.md, and migration 0044. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued only, on branch b05b-inventory-documents, branched from b05-inventory-ledger:
goods receipts, transfers with in-transit and receipt variance, adjustments with approval at the
threshold (maker and checker differ), stock takes with blind counts and cycle counts that refuse
overlapping scopes, the hold, reservation and exception services with the reservation expiry job,
temperature readings with automatic quarantine, reorder and expiry alerts (and the refusal to sell an
expired lot), the scheduling of the nightly recompute, and the INV endpoints of the contract with their
permissions, each write with a wrong-role refusal; answer CR-001 and CR-003 point 2 on the stock lines.
Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK import sheet
(A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV implements
(a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction. Extend the seed
with stock through the services. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05b-inventory-documents.md.
```

## B05 continued 2 — Transfers, adjustments, stock takes, holds, cold chain, alerts and opening stock

**Built in part; the session split** (A-140, ADR-0026 Amendments): the movement reads and their reversal with approval, transfers through in-transit with receipt variance, and adjustments with approval at the threshold (migrations 0050 to 0053, 15 operations, contract 1.17.0). The rest is B05 continued 3 and B05 continued 4, below. The opener is kept as it was run.

Branch `b05c-inventory-control`, from `b05b-inventory-documents` (stacked). Report `docs/sessions/B05c-inventory-control.md`. B05 continued built goods receipts (migration 0047: `inv.goods_receipt`, its lines and `inv.goods_receipt_animal`, frozen once posted; `GoodsReceipts.createIn` and `postIn` posting through `Stock.postIn`), stock on hand at cost with each line's exact share of its pool (`domain/valuation/pool-lines.ts`, under the 100 percent gate), `getStockUnit`, `traceStockUnit`, MDM's `MasterDataRefs`, `Authoriser.scopes` for narrowing lists to a reader's grants, the permissions `inv.stock.read` and `inv.goods_receipt.*` (A-135), contract 1.16.0, and the seed with stock (`src/seed/farm-inv.ts`, its hand count in `SEED_HAND_COUNT`). Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05b-inventory-documents.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128, A-131 to A-138
in docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 2 only, on branch b05c-inventory-control, branched from b05b-inventory-documents:
transfers with in-transit and receipt variance, adjustments with approval at the threshold (maker and
checker differ), stock takes with blind counts and cycle counts that refuse overlapping scopes, the hold,
reservation and exception services with the reservation expiry job, temperature readings with automatic
quarantine, reorder and expiry alerts (and the refusal to sell an expired lot), the scheduling of the
nightly recompute, and the remaining INV endpoints of the contract (movements and their reversal, stock
units and their movements, availability, holds, reservations, exceptions, transfers, adjustments, stock
takes, reorder rules, alerts, temperature readings) with their permissions, each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK
import sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction; then
decide whether a goods receipt of kind OPENING stays refused (A-136). Extend the seed through the services
where these documents need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, stop at
it and write docs/sessions/B05c-inventory-control.md.
```

## B05 continued 3 — Stock takes, holds, reservations and exceptions

Branch `b05d-inventory-counts-holds`, from `b05c-inventory-control` (stacked). Report `docs/sessions/B05d-inventory-counts-holds.md`. B05 continued 2 built movements and their reversal (`StockMovements`, `inv.stock_reversal`, approval kind `STOCK_REVERSAL`), transfers (`StockTransfers`, through the branch's `IN_TRANSIT` location, a shortfall as `ADJUST_LOSS` with a `TRANSFER_VARIANCE` exception) and adjustments (`StockAdjustments`, approval kind `STOCK_WRITE_OFF`, the threshold copied onto the document from `Approvals.judgeIn`), with the shared command and view helpers in `application/stock-command.ts`, the line rules in `domain/stock-documents.ts`, `valueAtAverage` under the valuation gate, migrations 0050 to 0053 and contract 1.17.0 (A-139). Gate: a stock take posts a gain or loss per variance from blind counts and its variance value at or above the threshold waits for approval; a cycle count of an overlapping scope is refused; a hold blocks a sale until released by a named user with a reason, and a withdrawal hold cannot be released; an expired reservation is released by the job; every write refuses the wrong role.

**Split (A-143):** this session built stock takes, cycle counts and holds and passed that part of the gate. Reservations, the expiry job, exceptions, availability and the stock unit list moved to B05 continued 3b below.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05c-inventory-control.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part) and ADR-0047, A-131 to A-140 in
docs/ASSUMPTIONS.md, migrations 0044 and 0051, and src/modules/inv/application/stock-adjustments.ts as the
pattern for a document with approval. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on stock-take variance posting, hold release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3 only, on branch b05d-inventory-counts-holds, branched from b05c-inventory-control:
stock takes (createStockTake through submitStockTake, listStockTakes, getStockTake, listStockTakeLines,
cancelStockTake) with expected figures frozen at start and hidden from the counter, recounts, a variance
report, STOCKTAKE_GAIN and STOCKTAKE_LOSS movements, and approval of a variance value at or above the
threshold (STOCK_WRITE_OFF, maker and checker differ); cycle counts that refuse overlapping scopes; the
hold service (listStockHolds, createStockHold for QUARANTINE and INVESTIGATION, releaseStockHold with a
named user and a reason, a WITHDRAWAL hold never released early) and the in-process Holds interface LIV
will call; the reservation service (listStockReservations, releaseStockReservation, the Reservations
interface with serializable reserve) and the scheduled reservation expiry job publishing
inv.ReservationExpired; the exception service (listStockExceptions, getStockException,
resolveStockException posting any correction through the adjustment path); listStockAvailability and
listStockUnits. Each write with a wrong-role refusal. Post every movement through Stock.postIn; never
write a projection. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05d-inventory-counts-holds.md.
```

## B05 continued 3b — Reservations, exceptions, availability and the stock unit list

Branch `b05d2-inventory-reservations-exceptions`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05d2-inventory-reservations-exceptions.md`. B05 continued 3 built stock takes and cycle counts (`StockTakes`, migration 0054, the `STOCK_WRITE_OFF` approval shared with adjustments through `StockWriteOffs`) and holds (`StockHolds` with `placeIn`, migration 0057), with permissions in 0055, 0056, 0058 and 0059 and contract 1.18.0 (A-141, A-142). Gate: one active reservation per animal and reserved never above available, proved under concurrency; an expired reservation is released by the scheduled job exactly as reserved and `inv.ReservationExpired` is published through the outbox; a stock exception is resolved once with a resolution kind and note, any correction posted through the adjustment path; availability is on hand less reserved less held; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d-inventory-counts-holds.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0010,
ADR-0017, ADR-0019, ADR-0027 (the stock exception part), ADR-0047 and ADR-0048, A-131 to A-143 in
docs/ASSUMPTIONS.md, migrations 0044 and 0057, and src/modules/inv/application/stock-holds.ts and
stock-adjustments.ts as the patterns. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on reservation release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3b only, on branch b05d2-inventory-reservations-exceptions, branched from
main: the reservation service (listStockReservations, releaseStockReservation,
the Reservations interface with serializable reserve and consume, one active reservation per animal,
reserved never above available, proved under concurrency) and the scheduled reservation expiry job
releasing exactly what it reserved and publishing inv.ReservationExpired through the outbox; the
exception service (listStockExceptions, getStockException, resolveStockException with a resolution kind
and note, posting any correction through the adjustment path and its approval); ADR-0048 (owner, 2026-11-15):
receiveStockTransfer stops posting a shortfall as a loss and holds it instead (never sellable, reservable or
transferable; the hand count still reconciles), and resolveStockException clears a TRANSFER_VARIANCE either
by writing it off under the adjustment threshold and step-up (202 ApprovalPending above it, maker never the
checker, threshold copied onto the document) or by recording the goods as found, each test-first; listStockAvailability
(on hand less reserved less held) and listStockUnits. Each write with a wrong-role refusal. Post every
movement through Stock.postIn; never write a projection. Keep the valuation gate and the stock-take and
hold domain gates at 100 percent. Stop at the gate and write
docs/sessions/B05d2-inventory-reservations-exceptions.md.
```

## B05 continued 4 — Cold chain, alerts, opening stock and the B5 gate

Branch `b05e-inventory-cold-chain-opening`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05e-inventory-cold-chain-opening.md`. Gate: the B5 gate in full: on-hand derived from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, and a lot traces in both directions over the API, with every INV write refusing the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d2-inventory-reservations-exceptions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0046, ADR-0047, ADR-0048 and ADR-0049, A-128 and A-131 to the latest INV assumption in
docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on the opening stock import and temperature quarantine.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 4 only, on branch b05e-inventory-cold-chain-opening, branched from
main: temperature readings (listTemperatureReadings, recordTemperatureReading)
with automatic quarantine of every lot in the location in the reading's transaction, a
TEMPERATURE_EXCURSION exception and an event (a location's range is MDM's: read it through MDM's
interface, and a database rule that needs it needs a new proposed ADR, since ADR-0047 is not widened
silently); reorder rules (listReorderRules, createReorderRule, updateReorderRule) and listStockAlerts with
one low-stock alert per crossing; expiry alerts by a daily job and the refusal to sell an expired lot
(A-134 (j)); the scheduling of the nightly recompute (BalanceReconciliation) and the expiry alerts as ScheduledJob entries in
src/worker-app.ts (ADR-0049, as reservation-expiry is); the OPENING_STOCK import
sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction;
then decide whether a goods receipt of kind OPENING stays refused (A-136). Each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Extend the seed through the
services where these need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, with a
walk that every INV write operation refuses the wrong role, stop at it and write
docs/sessions/B05e-inventory-cold-chain-opening.md.
```

## B05x — Dashboard tiles, branch management and label data, pulled forward for the frontend

Branch `b05x-dashboard-branches-labels`, from `main` (each phase is merged into `main` when green, ADR-0026 Amendments). Report `docs/sessions/B05x-dashboard-branches-labels.md`. Inserted by the owner on 2026-11-15 between B5 and B6: the frontend's UI phase needs these endpoints earlier than B12 schedules them. Everything is additive. Gate: getOwnerDashboard answers in one request with its sourceless figures null and listed with their reasons and phases; every tile whose data exists answers from the real API, and in getOwnerDashboard, with exact values on the seeded farm (stock value at cost equal to `listStockOnHand`'s total, the animal count equal to a hand count of serialised live stock units, the low stock count equal to the products at or below their reorder point, the purchases series equal to posted goods receipts at cost per day); the tiles whose data does not exist yet are in the contract, live only on the mock, and named in the openers that will build them; a branch can be deactivated, with its refusals, and branches and locations list only within the caller's grants; label data for a lot and a product answers from the real API; every operation refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is reasonable, record in the report
what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and MDM (branches and locations) requirement blocks of docs/SRS.md and NFR-023
(nothing else from the SRS), the RPT, MDM and INV cards in docs/MODULE_BOUNDARIES.md, ADR-0011 (published
views), ADR-0023 (the reporting read model), ADR-0026 (Amendments), ADR-0042 and ADR-0047, and the planned
contract's getOwnerDashboard and printPackLabels. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05x only, on branch b05x-dashboard-branches-labels, branched from main:
1. Dashboard in RPT, reading only published views (ADR-0011, ADR-0023), scoped to the branches the caller
   holds rpt permissions at, money as integer pesewas, with asOf. Build getOwnerDashboard now (owner,
   2026-11-15: NFR-023 from the start, one call for the frontend to wire, never rewired): it composes the
   figures below, and its response carries a required list naming each figure that has no source yet and
   why (figure, reason, and the phase that makes it live), each such figure null exactly while it is
   listed. B8, B9a and B9b empty that list field by field with no contract change. Making those planned
   OwnerDashboard fields nullable is a change to a published (never implemented) shape: a LOUD changelog
   entry and a line at the top of the cold-read summary. If the contract versioning check calls it breaking,
   do not weaken the check and do not bump the major version: leave getOwnerDashboard out, finish the rest,
   and report the conflict. B12 keeps the caching and the performance budget. Also one operation per tile,
   for tiles embedded on other screens: stock value at cost, animals on hand (serialised live stock units
   on hand, by species), low stock count (products at or below their reorder point, from B05 continued 4's
   published view), and a purchases time series over a period (posted goods receipts at cost, per day in
   Africa/Accra), all live now; today's sales, cash position, outstanding receivables and a sales time
   series in the contract only (mock), never answered from code before their source exists, since a 200
   with a zero is a placeholder. Add a line to the B8, B9a and B9b openers naming the dashboard figures and
   tiles each must make live.
2. Branch and location management where B04d continued 2 left gaps: deactivate (and reactivate) a branch
   with its refusals (not the last active branch, not one holding stock or open documents, not the
   farm's own), and listBranches and listLocations scoped to the caller's grants. Kasoa and KNUST are real
   selling points the owner will create through the API: do not seed them as SEED data.
3. Label data for printing lot and product barcodes, if the contract does not expose it: a read that
   returns what a label prints (code, name, lot, weight, dates, the barcode payload and its symbology),
   no image rendering. printPackLabels stays B6's.
Each operation with a wrong-role refusal, written test-first; update the cold-read summary at the top of
docs/CONTRACT_CHANGELOG.md with every contract change. Record the schedule change in ADR-0026
Amendments.
Stop at the gate, write docs/sessions/B05x-dashboard-branches-labels.md, and merge into main when every
run on the pull request is green.
```

## B6 — Livestock and processing

Branch `b06-livestock-processing`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06-livestock-processing.md`. Gate: a processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus the direct processing cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05x-dashboard-branches-labels.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the LIV and PRC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/liv.md and docs/data-model/prc.md, the LIV and PRC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0018 and ADR-0019. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 only, on branch b06-livestock-processing, branched from main: the animal register, batches, weights and
growth, health events with veterinary withdrawal holds that nobody can release early, breeding,
mortality and culls with photograph and second approver above the threshold, rations and feed with
head-days allocation, processing orders with yield against standard and variance flag, relative-sales-value
cost allocation by largest remainder, packs and labels (printPackLabels, whose barcodes follow B05x's
LabelBarcode: CODE_128, A-151; an animal's weights carry their source, which getStockUnitLabel then shows). Write the allocation test first: outputs'
allocated costs sum exactly to input cost plus direct cost, including an awkward split. Extend the seed.
Stop at the gate and write docs/sessions/B06-livestock-processing.md.
```

## B06m — The master data contract requests CR-009 to CR-011

Branch `b06m-master-data-requests`, from `main`. Report `docs/sessions/B06m-master-data-requests.md`. Inserted on 2026-11-15 (A-155): every master data phase had finished, so three frontend requests about master data were declined by each later phase as "not this phase" and had no owner. Small and additive. Gate: `previewPriceListVersion` answers cursor pages comparing a draft with the version in force, by the pricing engine's own entry identity (product, grade, band, quantity break), each line `ADDED`, `CHANGED`, `REMOVED` or `UNCHANGED` with `counts`, exact on a seeded list with one of each, refusing the wrong role; the price list examples agree with one another and show a change; CR-011 is answered in the contract and the report.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-009, CR-010
and CR-011 above all: implement what is reasonable, record in the report what you declined and why, never
edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (units of measure and price lists only;
nothing else from the SRS), docs/data-model/mdm.md (units, price lists and their entries), the MDM card in
docs/MODULE_BOUNDARIES.md, ADR-0004 and ADR-0036. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06m only, on branch b06m-master-data-requests, branched from main:
1. CR-009: previewPriceListVersion (GET /price-list-versions/{id}/preview, mdm.price_list.read, at the
   version's branch), comparing the version with the one in force at its validFrom by the same identity the
   engine resolves on, in cursor pages of at most 100 with counts for the four kinds and the version
   compared against. Read-only; test-first, including a version with nothing in force (every line ADDED).
2. CR-010: make the price list examples agree (getPriceList.activeVersion the ACTIVE version 4, the draft
   version 5 with one changed price), so the mock shows a preview with a change.
3. CR-011: answer it. Say in the contract whether units are seeded only, and how a conversion is held
   today (a crate of 30 eggs, a pack's nominal kilograms), from what the data model actually has. If the
   brief's "units of measure with conversions" is not built, do not build a new subsystem here: record it
   honestly in docs/BACKLOG.md or as an assumption naming the phase that owns it, and say so in the report.
Every contract change goes in docs/CONTRACT_CHANGELOG.md and the cold-read summary at its top; examples in
farm terms. Stop at the gate, write docs/sessions/B06m-master-data-requests.md, and merge into main when
every run on the pull request is green.
```

## B06 continued — Livestock management, packs and labels

Branch `b06b-livestock-packs`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06b-livestock-packs.md`. Gate: every LIV write refuses the wrong role; a withdrawal hold blocks sale and processing and nobody releases it early; mortality at or above the threshold waits for a photograph and a different approver; feed and veterinary cost spread by head-days sum exactly to the value issued; pack weights equal the lot weight and a pack label encodes the lot and the weight.

**Built and split on 2026-11-15 (A-158):** this phase built the livestock core and passed the gate for it; animal edits, growth, batches and breeding are B06 continued 2's, and packs, labels and the reversing order B06 continued 3's (below).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06m-master-data-requests.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the LIV block and FR-PRC-009 to FR-PRC-011 of docs/SRS.md (nothing else from the SRS),
docs/data-model/liv.md and docs/data-model/prc.md, the LIV and PRC cards in docs/MODULE_BOUNDARIES.md,
and ADR-0018 and ADR-0019. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued only, on branch b06b-livestock-packs, branched from main: the animal register (an animal
record per serialised stock unit, opened from inv.StockUnitRegistered), batches, weights with their source and growth,
health events with veterinary withdrawal holds placed through INV's StockHolds.placeIn that nobody can release early,
breeding and births, mortality and culls with photograph and second approver at or above the threshold (maker never
the checker, threat model abuse case 2), rations and feed with head-days allocation through the kernel's allocate,
the animal's status kept in step with its stock unit (a goat consumed by a B6 processing order becomes SLAUGHTERED),
then PRC's packs and labels (createPacks, listPacks, printPackLabels, whose barcodes follow B05x's LabelBarcode:
CODE_128, A-151) and the reversing order of FR-PRC-011. Decide the Farm hand's PRC access (A-153). Write the money,
weight and permission tests first. Extend the seed. If this does not fit one context, split at the LIV and PRC
boundary as B6 did. Stop at the gate and write docs/sessions/B06b-livestock-packs.md.
```

## B06 continued 2 — Animal edits, growth, batches and breeding

Branch `b06c-livestock-growth-breeding`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06c-livestock-growth-breeding.md`. Inserted on 2026-11-15 when B06 continued split at a LIV sub-domain boundary (A-158). Gate: every remaining LIV write refuses the wrong role; a move starts only where the animal is and changes no cost; average daily gain and feed conversion match a hand calculation (FR-LIV-005, FR-LIV-016); a batch closes only when empty or with a documented reason; a birth registers each live offspring at nil cost linked to its dam, and refuses a dam that was not alive and female; the feed, medicine, store and ration seed is counted by hand in the B5 and B05x hand counts.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06b-livestock-packs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-LIV-002, FR-LIV-003, FR-LIV-005, FR-LIV-006, FR-LIV-010, FR-LIV-011 and FR-LIV-016 of
docs/SRS.md (nothing else from the SRS), docs/data-model/liv.md, the LIV card in docs/MODULE_BOUNDARIES.md, and
ADR-0018. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase
needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued 2 only, on branch b06c-livestock-growth-breeding, branched from main, on top of the
livestock core B06 continued built (src/modules/liv): updateAnimal (purpose decides capitalised or expensed; fixed
attributes refused), moveAnimal (a TRANSFER_INTERNAL movement through INV's Stock.postIn from where the animal is),
listAnimalTimeline, listGrowth (average daily gain per animal, pen and batch over animals present for the whole
window, feed conversion from the feed issued, mortality percent), the batches (liv.batch, a flock's lot as its stock
unit, with an expand migration adding liv.animal.batch_id; a batch's purpose then decides a flock's cost treatment
instead of A-158's GROWING default), and breeding and births (liv.breeding_record, gestation days from data, recordBirth
registering offspring through INV at nil cost with a BIRTH movement and lineage to the dam, and the expand migration
adding liv.animal.breeding_record_id). Extend the seed with feed and medicine products, the Dodowa store, their stock
and rations, and count them by hand into the B5 and B05x hand counts. Write the money, weight and permission tests
first. Stop at the gate and write docs/sessions/B06c-livestock-growth-breeding.md.
```

## B06 continued 3 — Packs, labels and the reversing order

Branch `b06d-packs-labels`, from `main` (ADR-0026 Amendments). Report `docs/sessions/B06d-packs-labels.md`. Inserted on 2026-11-15 with B06 continued 2 (A-158). Gate: first, a Farm hand sees the animal register, rations and health events with their withdrawal holds and never a cost, on every LIV and PRC operation the role can reach (owner, 2026-11-15); then pack weights equal the lot weight and a pack label encodes the lot and the weight; a completed processing order is frozen and reverses only while its outputs are unsold, restoring the animal to its pen at its prior cost; every pack write refuses the wrong role; the Farm hand's PRC access is decided (A-153).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06c-livestock-growth-breeding.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-009 to FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md,
the PRC card in docs/MODULE_BOUNDARIES.md, and ADR-0018, and A-153, A-158 and A-159 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
First, before packs (owner, 2026-11-15, replacing A-158's Farm hand line): the Farm hand reads what animal
work and food safety need, the animal register, feed rations and above all health events with their withdrawal
holds, so a treated animal is never sent to slaughter or sale; and never a cost. Use the codebase's pattern for
cost visibility if there is one; otherwise give that role cost-free read shapes (a separate response shape
without the cost fields), never nullable cost fields. Main today leaks cost to the role: B06 continued 2 granted
liv.animal.update, liv.animal.move, liv.batch.read, liv.batch.create and liv.batch.update (migration 0082), whose
answers carry cost, so close those first. Death records and anything only about money stay refused. Tests,
written first: a Farm hand reads a treated goat's withdrawal hold and its end; and one test that walks every
LIV and PRC route the role's grants reach and asserts no response schema, example or live response carries a
cost or pesewa field. Record the matrix in the assumption that holds it (A-158) as the owner's decision.
Then execute B06 continued 3 only, on branch b06d-packs-labels, branched from main: PRC's packs and labels (prc.pack;
createPacks, listPacks, printPackLabels, whose barcodes follow B05x's LabelBarcode: CODE_128, A-151; the payload
<lot>/<grams, six digits>), the reversing order of FR-PRC-011 (cancelProcessingOrder on a COMPLETED order, reversing
its movements through INV's StockMovements only while every output is unsold; the reversed animal is ALIVE again, which
LIV's register already follows), and the Farm hand's PRC access (A-153). Write the weight and permission tests first.
Extend the seed. Stop at the gate and write docs/sessions/B06d-packs-labels.md.
```

## B06u — Units of measure and their conversions

Branch `b06u-uom-conversions`, from `main`. Report `docs/sessions/B06u-uom-conversions.md`. Inserted by the owner on 2026-11-15 (A-157): FR-MDM-003's alternative units were never built, and they belong before anything sells by a unit other than a product's base unit, not inside B9a. Small and additive. Gate: a product's alternative units convert to its base unit by an exact numerator and denominator, FR-MDM-003's unit test passes, a conversion that is not exact is refused by the database, the conversions list answers in the contract, and every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-011 above all:
implement what is reasonable, record in the report what you declined and why, never edit that file and never
open frontend source.
For this phase, read FR-MDM-003 of docs/SRS.md (nothing else from the SRS), the units and product_uom_conversion
parts of docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md and A-157. Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money and hakorem-stock: a conversion changes a
quantity, and a quantity times a price is money.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06u only, on branch b06u-uom-conversions, branched from main: mdm.product_uom_conversion with
numerator and denominator and the exact-factor rule in the database, FR-MDM-003's unit test, the operations to
list (CR-011's listUomConversions or conversions on Uom, whichever the contract can carry additively) and to
manage a product's conversions with wrong-role refusals, read by other modules through MasterDataRefs. A catch-
weight line is charged by the weighed kilograms, so a pack-to-kilogram factor is never a conversion (A-157).
Write the conversion and permission tests first; examples in farm terms; changelog and cold-read summary.
Stop at the gate, write docs/sessions/B06u-uom-conversions.md, and merge into main when every run on the pull
request is green.
```

## B7 — Procurement and suppliers, and the storefront cart

Branch `b07-procurement-suppliers`. Report `docs/sessions/B07-procurement-suppliers.md`. Gate: three-way match blocks payment where receipt and supplier invoice disagree, and checkout reserves stock and releases it on timeout.

**Built on 2026-11-15 as purchase to pay, and split (A-165, ADR-0026 Amendments):** the rest of procurement is **B07 continued** and the storefront is **B07 continued 2**, both below.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06u-uom-conversions.md).
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
on the supplier invoice lines. A purchase or cart line in a unit other than the product's base unit (feed
bought by the 50 kg bag) converts through MasterDataRefs.toBaseIn (B06u, A-163), never with a factor of its own.
Extend the seed.
Stop at the gate and write docs/sessions/B07-procurement-suppliers.md.
```

## B07 continued — The supplier register and the rest of procurement

Branch `b07b-supplier-register`, from `main`. Report `docs/sessions/B07b-supplier-register.md`. Inserted by the B7 split (A-165, ADR-0026 Amendments). Gate: a payout detail change returns 202 and the old details stay in force until a different person approves, with the stored column ciphertext; a document whose content is not what its name says is refused; a rejected requisition cannot be converted and a converted one links its order; a credit note cannot exceed the invoice's uncredited amount; the supplier score matches FR-PUR-014's hand calculation; every write refuses the wrong role.

**Built on 2026-11-15 as the supplier register and requisitions, and split (A-167, ADR-0026 Amendments):** credit notes, the approved variance, the remittance data and supplier scores are **B07 continued 1b**, below.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07-procurement-suppliers.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PUR requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pur.md
(its "As built in B7" note first), the PUR card in docs/MODULE_BOUNDARIES.md, ADR-0020, ADR-0022 and ADR-0044, and
A-164 and A-165 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money,
hakorem-security-review (payout details, documents, approvals) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued only, on branch b07b-supplier-register, branched from main: supplier profiles with
payment terms (and invoice due dates from them), categories supplied and payout details encrypted (ADR-0022),
decrypted only with a permission and audited, changed only through a SUPPLIER_PAYOUT_CHANGE approval by a different
person (FR-PUR-001, FR-PUR-002); supplier documents through the file store (FR-PUR-003); requisitions and their
conversion to a purchase order (FR-PUR-004); supplier credit notes against an invoice's uncredited amount, with a
supplier-return movement through INV where goods go back (FR-PUR-011); the approved variance that lets a mismatched
invoice be paid (FR-PUR-010); the data of the remittance advice (FR-PUR-013; rendering waits for B8); supplier
scores (FR-PUR-014). Write the permission, money and approval tests first; extend the seed; changelog and cold-read
summary for every contract change. Stop at the gate, write docs/sessions/B07b-supplier-register.md, and merge into
main when every run on the pull request is green.
```

## B07 continued 1b — Credit notes, the approved variance, remittance data and supplier scores

Branch `b07b2-supplier-credit-scores`, from `main`. Report `docs/sessions/B07b2-supplier-credit-scores.md`. Inserted by the B07 continued split (A-167, ADR-0026 Amendments). Gate: a credit note cannot exceed the invoice's uncredited amount (a credit of 11,000 against a 110,000 invoice leaves 99,000 payable; a second credit of 100,000 is refused), in the handler and the database, with a supplier-return movement through INV where goods go back; an approved variance lets a mismatched invoice be paid, and never by its maker; a paid payment's remittance data lists its invoices, amounts and reference once; the supplier score matches FR-PUR-014's hand calculation (91.0); every write refuses the wrong role.

**Built on 2026-11-15** (A-172 to A-174): credit notes with the supplier-return movement, the approved variance, the remittance data and supplier scores, contract 1.30.0. B06r follows.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07b-supplier-register.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PUR-010, FR-PUR-011, FR-PUR-013 and FR-PUR-014 in the PUR block of docs/SRS.md (nothing else
from the SRS), docs/data-model/pur.md (its "As built" notes first), the PUR and INV cards in docs/MODULE_BOUNDARIES.md,
ADR-0017, ADR-0020, ADR-0043 and A-164, A-166 to A-171 in docs/ASSUMPTIONS.md (A-168 to A-171 are the owner's
decisions of 2026-11-15: keep the cross-approval of payout changes and the bar on their maker approving the first
payment after them). Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock (the supplier
return), hakorem-security-review (the variance approval) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 1b only, on branch b07b2-supplier-credit-scores, branched from main: supplier credit notes
(createSupplierInvoice with kind CREDIT_NOTE) against an invoice's uncredited amount, held by the database, reducing
what is payable, with a supplier-return movement through INV's published interface where goods go back and the
ledger event for B8 (FR-PUR-011); the approved variance that lets a mismatched invoice be paid, approved by a different
person (FR-PUR-010); the data of the remittance advice for a paid payment, answered once per payment (FR-PUR-013;
rendering waits for B8); supplier scores from receipts, rejections, lead times and invoice prices with the weights 30,
25, 25 and 20 held as settings (FR-PUR-014). Write the money, permission and approval tests first; extend the seed;
changelog and cold-read summary for every contract change. Stop at the gate, write
docs/sessions/B07b2-supplier-credit-scores.md, and merge into main when every run on the pull request is green.
```

## B06r — The processing reversal and the farm hand's death reports under approval (A-162, F6)

Branch `b06r-processing-reversal-approval`, from `main`. Report `docs/sessions/B06r-processing-reversal-approval.md`. Inserted by the owner on 2026-11-15, answering A-162 and the frontend's F6: reversing a completed processing order moves stock value back, so it follows the transfer write-off pattern of ADR-0048; and a farm hand's death report must be completable by the farm hand as maker, with a person above them confirming every write-off. Small. Gate: a farm hand finds an animal by its exact tag with no cost field; a farm hand reports a death, uploads its photograph (EVIDENCE) and submits it, and a manager approves it, whatever its value (below the direct write-off threshold a supervisor confirms; at or above it the existing second approver with step-up), the farm hand never writing stock off alone; uploads are EVIDENCE only for the role; approval waits for a CLEAN photograph and a rejected one returns the report to its maker; a reused photograph is flagged for the exception report; and a reversal at or above the adjustment threshold waits for a second approver with step-up and the maker is refused as checker; below it the maker's reason is required and the reversal reaches the exception report's sources; a reversal is refused outright, by the domain and the database, once any pack it produced has been sold or moved; the threshold is copied onto the reversal document; every write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md (the reversal),
ADR-0048 (the pattern to copy), A-139, A-153 and A-162 in docs/ASSUMPTIONS.md, and src/modules/inv/application/
stock-exceptions.ts and stock-adjustments.ts as the approval pattern. Load hakorem-stock, hakorem-money and
hakorem-security-review. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Also, before the reversal (owner, 2026-11-15, the frontend's F6 and CR-021):
- CR-021: a cost-free exact tag lookup for the Farm hand (ADR-0052), for example getCareAnimalByTag or an exact
  `tagNo` filter on listCareAnimals, documented as exact, refusing the wrong role.
- Death reports: the farm hand is the maker; they report, upload the photograph and submit, and a manager
  approves. Today the role holds no platform.file.upload, so a report at or above the threshold dead-ends. A farm
  hand may upload EVIDENCE files and nothing else: if the file store cannot restrict upload by purpose, build that
  check (in the application layer, deny by default, with a test that a farm hand's PRODUCT_IMAGE or any other
  purpose is refused) rather than falling back to a broader grant. Below the direct write-off threshold a farm hand must
  not write stock off alone: their submission waits for a supervisor's confirmation (a role that may post a
  write-off) instead of posting at once; other makers keep the direct write-off below the threshold. Maker is
  never the checker. Test-first, including the full farm hand path and a refusal for each wrong role.
- Scan state: a death report may be submitted while its photograph is still PENDING, so nobody waits at the pen;
  approval is refused until the file is CLEAN; if the scan rejects the file (infected or unscannable), the report
  goes back to its maker with a reason. Test all three.
- Reused photographs: every stored file already has its sha256 (migration 0033). If an EVIDENCE photograph with
  the same sha256 is attached to a second death report, it goes on the exception report: build the detection as
  an LIV published view (ADR-0011) or event the daily exception report (B12) reads, with a test, and a line in
  B12's opener. A byte hash catches the same file twice, not a re-saved or cropped copy: say so, and park
  perceptual matching in docs/BACKLOG.md. State it in the contract too: uploadFile's EVIDENCE description and the
  death report operations say that the client should open the camera directly for death evidence (the owner's
  frontend rule, 2026-11-15) as a deterrent, that the server cannot tell a camera photo from a gallery one, and
  that a reused photograph is matched by exact bytes only.
- Record the role matrix change in A-158 as the owner's decision.
Then execute B06r only, on branch b06r-processing-reversal-approval, branched from main: cancelling a COMPLETED
processing order (A-162 as built: Owner and Manager, its own reversal document, refused once an output is sold)
now follows ADR-0048. At or above the adjustment threshold (copied onto the document, never read live) it
answers 202 ApprovalPending and posts only on a different approver's approval with step-up; below it, a reason
is required and the reversal is recorded where the daily exception report (B12) will read it, through a
published view or event, with a line added to B12's opener. Refuse it outright, in the domain and in the
database, once any pack or output it produced has been sold or moved, because putting the carcass back would
hide the stock that left. Each rule test-first, including a mutation check that the database refusal stands
on its own. Stop at the gate, write docs/sessions/B06r-processing-reversal-approval.md, and merge into main when
every run on the pull request is green.
```

## B07 continued 2 — The storefront catalogue, cart and checkout reservation

Branch `b07c-storefront-checkout`, from `main`. Report `docs/sessions/B07c-storefront-checkout.md`. Inserted by the B7 split (A-165, ADR-0026 Amendments). Gate: the shared sort mechanism (CR-019) pages without skipping or repeating a row through ties and concurrent inserts; the second half of B7's: checkout reserves stock and releases it on timeout. Also: a live animal (`REQUEST_TO_BUY`) cannot be added to a cart; the catalogue carries no cost; `del.delivery_slot` exists with slot generation and checkout stores a chosen slot through its foreign key; every staff write refuses the wrong role.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06r-processing-reversal-approval.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the SHP requirement block of docs/SRS.md and FR-DEL-001 (nothing else from the SRS),
docs/data-model/shp.md and del.md, the SHP and DEL cards in docs/MODULE_BOUNDARIES.md, and ADR-0011, ADR-0019,
ADR-0020, ADR-0021, ADR-0026 (the online-store assignment and the delivery split) and SA-13 in docs/ASSUMPTIONS.md.
Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money, hakorem-stock, hakorem-pricing and
hakorem-security-review (the public cart and checkout).
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 2 only, on branch b07c-storefront-checkout, branched from main: the public catalogue
and product page with availability levels and no cost (FR-SHP-001, FR-SHP-002), the cart with server-computed totals
and prices re-resolved by MDM's PricingService, coupons through Promotions (FR-SHP-003, FR-SHP-004), and checkout
reservation through INV's Reservations only (serializable, all lines or none, the 15-minute release by the expiry
job releasing exactly what it reserved, FR-SHP-005, FR-SHP-006), the catch-weight estimate and maximum (FR-SHP-007),
the zone fee (FR-SHP-008), and, as the ADR-0026 delivery split decides, the del.delivery_slot table and slot
generation, with checkout storing a chosen slot through its foreign key but not enforcing capacity (capacity and
cut-offs are B11). A live animal cannot be added to a cart (422 REQUEST_TO_BUY_ONLY). A cart line in a unit other
than the product's base unit converts through MasterDataRefs.toBaseIn, never with a factor of its own. Order
placement and online payment are B09a. Write the reservation, money and permission tests first; extend the seed.
CR-019, server-side sort (owner, 2026-11-15): build the shared sort mechanism once, here, because the
storefront catalogue needs sorting by price and name anyway: an allow-list of sort fields per list (any other
field is 400), each backed by an index, and the cursor carrying the sort key and the id as a tie-breaker, so
pages never skip or repeat a row even when values tie or rows arrive between pages (prove it with a test that
pages through ties and concurrent inserts). Apply it to the storefront catalogue, then to the console lists of
products, stock on hand, lots and movements. If those four console lists make the phase too big, put them in a
small phase right after this one, still before B8, and say so.
Stop at the gate, write docs/sessions/B07c-storefront-checkout.md, and merge into main when every run on the pull
request is green.
```

## B07 continued 3 — Server-side sort on the console lists (CR-019)

Branch `b07c3-console-sort`, from `main`. Report `docs/sessions/B07c3-console-sort.md`. Inserted by the B07 continued 2 split (A-179, ADR-0026 Amendments). Gate: `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` take CR-019's `sort` and `direction` through the shared keyset (ADR-0054), each allowed field backed by an index, any other field 400 `SORT_NOT_ALLOWED`; each list pages without skipping or repeating a row through ties and rows inserted between pages, proved per list; each operation's example shows its default order; every read still refuses the wrong role and the Farm hand still sees no cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07c-storefront-checkout.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read CR-019 in that file, ADR-0054, docs/API.md section 5 and the as-built notes of
docs/data-model/mdm.md and inv.md for the four lists' tables (nothing else from the SRS). Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-endpoint, hakorem-migration and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued 3 only, on branch b07c3-console-sort, branched from main: apply the shared sort of
src/platform/http/keyset-sort.ts (ADR-0054, built and proved in B07 continued 2) to the console lists of products,
stock on hand, lots and movements, with CR-019's fields (listProducts: name, sku, category, status, updatedAt;
listStockOnHand: product name, location name, onHandQty, valueAtCostPesewas; listStockUnits: product name,
identifier, expiresOn, valueAtCostPesewas; listStockMovements: occurredAt, product name, valuePesewas), `sort` and
`direction` query parameters, an index per allowed field in each module's own migration (a field whose value is
computed, such as a value at cost or another module's name, is sorted only if it can be indexed honestly in the
owning schema: otherwise decline that field in the report with the reason), and each list's default order unchanged
and shown in its example. A cost field stays readable only with its cost permission (ADR-0052): sorting by it is
refused to a role that cannot read it. Write a test per list that pages through ties and concurrent inserts.
Stop at the gate, write docs/sessions/B07c3-console-sort.md, and merge into main when every run on the pull
request is green.
```

## B8 — General ledger, billing and document generation

Branch `b08-ledger-billing`. Report `docs/sessions/B08-ledger-billing.md`. **Built and passed; the session split after its gate (A-187): the remainder is B08 continued and B08 continued 2 below.** Gate: the trial balance sums to zero on a seeded trading day, an unbalanced journal is rejected by the database itself, and numbering stays gap-free under concurrent load.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07c3-console-sort.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
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
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): uncomment the 100 percent gate for
src/modules/fin/domain/ in vitest.config.mts before the gate passes. Fill every branch it exposes;
the gate does not pass on a lowered number.
Make the owner dashboard's B8 figures live (B05x, A-149): remove `cash`, `receivablesOutstandingPesewas` and
`receivablesOverduePesewas` from RPT's PENDING_FIGURES (src/modules/rpt/domain/dashboard.ts) and answer them from
the ledger (accounts 1000 to 1130, account 1200) and billing's due dates through published views, and build the
planned tiles getCashPositionTile and getReceivablesTile, each test-first with its wrong-role refusal.
Post PUR's waiting events (pur.SupplierInvoiceMatched, pur.ExpenseInvoiceApproved, pur.SupplierPaymentMade, A-164) and
add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their foreign keys
(docs/DATA_MODEL.md, Migrations), lifting PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal.
Stop at the gate and write docs/sessions/B08-ledger-billing.md.
```

## B08 continued — The ledger's interface, periods, manual journals and the statements

Branch `b08c-ledger-interface`. Report `docs/sessions/B08c-ledger-interface.md`. **Built; the session split after its chart and periods (A-189): the remainder is B08 continued 1b and B08 continued 1c below.** Gate as built: an entry written inside a savepoint keeps its own lines and `SET CONSTRAINTS ALL IMMEDIATE` only makes the balance check earlier; every chart and period operation refuses the wrong role and the Owner approving their own period reopen; a period locks, closes and then refuses postings, proved through the API. (Planned gate, now spread over the three sessions: every FIN write refuses the wrong role (and a maker approving their own manual journal, posting rule change or period reopen); a period locks, closes and then refuses postings, proved through the API; the trial balance, profit and loss, balance sheet and cash flow tie to each other on the seeded trading day to the pesewa; a depreciation run spreads the depreciable amount exactly and posts once per period.)

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08-ledger-billing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-187 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued only, on branch b08c-ledger-interface, building on the ledger core B8 merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the chart
of accounts (FR-FIN-001, FR-FIN-002), bank accounts with encrypted numbers and step-up (`fin.bank_account`), periods with
lock, close and reopen (FR-FIN-009, FR-FIN-010, `PERIOD_REOPEN`), journals read only, manual journals with a different
approver and step-up (FR-FIN-008, the opening balance journal), posting rule and determination changes through
`POSTING_RULE_CHANGE`, the trial balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to
FR-FIN-013), the period balance projection, fixed assets and depreciation (FR-FIN-014, FR-FIN-015), and FIN's ◆ events
(`fin.ManualJournalApproved`, `fin.DepreciationRun`, `fin.YearClosed`) with their matrix rows and exact-amount tests.
List PERIOD_NOT_OPEN, POSTING_RULE_MISSING and SUBLEDGER_REQUIRED in the x-error-codes of every operation that posts
(A-187). Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their
foreign keys (docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account
on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c-ledger-interface.md.
```

## B08 continued 1b — Journals, manual journals, posting rule changes and bank accounts

Branch `b08c1b-journals-rules-banks`. Report `docs/sessions/B08c1b-journals-rules-banks.md`. **Built; the session split before its bank accounts (A-192): the remainder is B08 continued 1b2 below.** Gate as built: every journal, manual journal, posting rule and determination operation refuses the wrong role, and a maker approving their own manual journal or posting rule change is refused; a manual journal posts nothing until a different person approves it with step-up, then exactly one balanced entry with its exact amounts, and `fin.ManualJournalApproved` has its matrix row and exact-amount test. (Planned gate: every journal, manual journal, posting rule, determination and bank account operation refuses the wrong role, and a maker approving their own manual journal or posting rule change is refused; a manual journal posts nothing until a different person approves it with step-up, then exactly one balanced entry with its exact amounts, and `fin.ManualJournalApproved` has its matrix row and exact-amount test; a bank account's number is stored encrypted and shown only as its last four digits; a supplier payment naming a bank account posts to that account's own subledger party.)

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c-ledger-interface.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0005, ADR-0017, ADR-0022 and ADR-0056, and the accountant's
answers on A-024 to A-029 and A-182 to A-189 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b only, on branch b08c1b-journals-rules-banks from main, building on the ledger core and the
chart and periods already merged (do not rewrite them): FIN's planned operations in contract/openapi.yaml, each
test-first with its wrong-role refusal: journals read only (listJournalEntries, getJournalEntry, listAccountActivity);
manual journals with a different approver and step-up (FR-FIN-008, kind MANUAL_JOURNAL, the opening balance journal
against 3900, A-005, OPENING_ALREADY_POSTED), with `fin.ManualJournalApproved` added to fin.posting_event_type with its
matrix row and an exact-amount test; posting rule and determination changes through `POSTING_RULE_CHANGE` with step-up
(listPostingEventTypes, listPostingRules, createPostingRule, listAccountDeterminations, createAccountDetermination),
keeping the boot assertion whole; bank accounts with encrypted numbers and step-up (`fin.bank_account`, ADR-0022).
Add, by an expand migration, pur.supplier_payment.bank_account_id and remittance_document_id with their foreign keys
(docs/DATA_MODEL.md, Migrations), lift PUR's BANK_ACCOUNT_NOT_AVAILABLE refusal and carry the bank account on
pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185).
If the phase does not fit, split at a sub-domain boundary (for example bank accounts) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b-journals-rules-banks.md.
```

## B08 continued 1b2 — Bank accounts and the supplier payment's bank account

Branch `b08c1b2-bank-accounts`. Report `docs/sessions/B08c1b2-bank-accounts.md`. **Built (ADR-0057, A-193, A-194): the number is sealed with a data key of its own; both writes need step-up.** Gate: every bank account operation (listBankAccounts, createBankAccount, updateBankAccount) refuses the wrong role; a bank account's number is stored encrypted and shown only as its last four digits, and adding one needs step-up; a supplier payment naming a bank account posts to that account's own subledger party, and one naming none still posts as A-185 says.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b-journals-rules-banks.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
docs/data-model/pur.md (supplier_payment), the FIN and PUR cards in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0017,
ADR-0022 and ADR-0056, and the accountant's answers on A-182 to A-192 in docs/ASSUMPTIONS.md (if still open, proceed on
them). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b2 only, on branch b08c1b2-bank-accounts from main, building on what is merged (do not
rewrite it): FIN's bank account operations in contract/openapi.yaml (listBankAccounts, createBankAccount with step-up,
updateBankAccount), each test-first with its wrong-role refusal, on `fin.bank_account` with the number encrypted
(ADR-0022: decide first, by ADR or assumption, which key seals a number that belongs to no data subject) and shown only
as its last four digits; the account's GL account (1100 for a bank, 1110 for a wallet) and its own BANK_ACCOUNT subledger
party. Add, by an expand migration, pur.supplier_payment.bank_account_id with its foreign key (docs/DATA_MODEL.md,
Migrations; remittance_document_id waits for doc.archived_document in B08 continued 2, A-192), lift PUR's
BANK_ACCOUNT_NOT_AVAILABLE (a bank account of the payment's method, active; optional, so no client breaks) and carry the
bank account on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185), with its exact-amount test.
If the phase does not fit, follow "If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b2-bank-accounts.md.
```

## B08 continued 1c — The statements, period balances, year close, fixed assets and depreciation

**Built and split on 2026-11-16 (A-198, ADR-0026 Amendments):** the statements, period balances, year close and cash figure were built; fixed assets and depreciation moved to B08 continued 1c2 below.

Branch `b08c1c-statements-assets`. Report `docs/sessions/B08c1c-statements-assets.md`. Gate: the trial balance, profit and loss, balance sheet and cash flow tie to each other on the seeded trading day to the pesewa, each read refusing the wrong role; year close leaves 3200 at zero and 3100 increased by the year's profit, with `fin.YearClosed`'s exact-amount test; a depreciation run spreads the depreciable amount exactly and posts once per period, with `fin.DepreciationRun`'s exact-amount test; every fixed asset write refuses the wrong role; the owner dashboard's cash figure answers from the ledger.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b2-bank-accounts.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005 and ADR-0056, and the accountant's answers on
A-024 to A-029 and A-182 to A-194 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c only, on branch b08c1c-statements-assets from main, building on what is merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the trial
balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to FR-FIN-013), the period balance
projection (`fin.period_balance`, computed at lock and refreshed nightly), year close moving current year earnings to
retained earnings (FR-FIN-010, `fin.YearClosed`), fixed assets and depreciation runs (FR-FIN-014, FR-FIN-015,
`fin.DepreciationRun`, `allocate` so the schedule sums exactly), each ◆ event with its matrix row and exact-amount test.
Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1c-statements-assets.md.
```

## B08 continued 1c2 — Fixed assets and depreciation

Branch `b08c1c2-fixed-assets`. Report `docs/sessions/B08c1c2-fixed-assets.md`. Gate: a depreciation run spreads the depreciable amount exactly with `allocate` (FR-FIN-015's 1,200,000 over 120 months at 10,000, and 1,000,001 over 3 months at 333,334, 333,334 and 333,333) and posts once per period, a second run for the same period refused by a database unique key and proved with concurrent runs, with `fin.DepreciationRun`'s exact-amount test; a run posts only once a different person approves it; every fixed asset write refuses the wrong role; disposal posts its exact gain or loss; the four statements still tie on the seeded trading day with the seeded assets.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c-statements-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005, ADR-0056 and ADR-0058, and the accountant's
answers on A-024 to A-029 and A-182 to A-198 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c2 only, on branch b08c1c2-fixed-assets from main, building on what is merged (do not
rewrite it): FIN's planned fixed asset and depreciation operations in contract/openapi.yaml, each test-first with its
wrong-role refusal: the fixed asset register (FR-FIN-014: listFixedAssets, createFixedAsset, getFixedAsset,
updateFixedAsset, disposeFixedAsset, with disposal posting its gain or loss) and depreciation runs (FR-FIN-015:
listDepreciationRuns, createDepreciationRun, getDepreciationRun, postDepreciationRun, maker and checker never the same
user), the ◆ event `fin.DepreciationRun` (Dr 6500, Cr 1590) with its fin.posting_event_type row, rules and exact-amount
matrix test; `allocate` so each asset's schedule sums exactly to cost less residual, leftover pesewas in the final
months; one run per period held by a database unique key and proved with concurrent runs. Decide first, as an ADR or
an assumption, how an asset's cost reaches 1510 to 1540 (the asset register records; it does not itself post) and
whether disposal is its own ◆ event. Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Extend the seed through the services with the farm's assets (a delivery vehicle, the cold room, pen housing,
equipment), and prove the four statements still tie on the seeded trading day.
If the phase does not fit, split at a sub-domain boundary (for example disposal) and follow "If a session cannot
finish".
Stop at the gate and write docs/sessions/B08c1c2-fixed-assets.md.
```

## B08 continued 2 — Billing documents, document rendering and the archive

Branch `b08c2-billing-documents`. Report `docs/sessions/B08c2-billing-documents.md`. Gate: an invoice, credit note and debit note post exact levy lines through the ledger and a fourth levy added as data only produces four levy lines and four subledger postings; billing numbers stay gap-free under concurrent issue; a reprint is byte-identical apart from its reprint marker and the archive's hash holds; the trial balance still sums to zero on the seeded trading day.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1c2-fixed-assets.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the BIL and DOC requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/bil.md and doc.md, the BIL and DOC cards in docs/MODULE_BOUNDARIES.md, and ADR-0001, ADR-0015,
ADR-0020 and ADR-0056. Read the accountant's answers on A-020, A-033 and A-034 in docs/ASSUMPTIONS.md: if they are
still open, proceed on the stated assumptions, record that in the report, and make each answerable as data.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 2 only, on branch b08c2-billing-documents: billing documents (proforma, invoice, credit
note, debit note, receipt) with levy lines from MDM's tax calculator, numbered through platform.allocate_number in
the issuing transaction, and their ◆ events (bil.InvoiceIssued, bil.CreditNoteIssued, bil.DebitNoteIssued) added to
fin.posting_event_type with their rules and an exact-amount matrix test for each row; the test that adds a fourth levy
as data only; document templates, rendering (HTML to PDF and ESC/POS), the immutable archive with its content hash, and
reprint with the reprint marker; customer statements; DOC's rendering of the supplier remittance advice from
pur.SupplierRemittanceReady (FR-PUR-013). Extend the seed through the services so the seeded trading day carries billing
documents, and prove the trial balance still sums to zero on it.
Make the owner dashboard's receivables figures live (B05x, A-149): remove `receivablesOutstandingPesewas` and
`receivablesOverduePesewas` from RPT's PENDING_FIGURES and answer them from the ledger (account 1200) and billing's due
dates through published views, and build the planned tile getReceivablesTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example rendering and the archive) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c2-billing-documents.md. End the report with B09a's opening message
(ADR-0026 verification).
```

## B9a — Order core and payments, and online order placement

Branch `b09a-order-core-payments`. Report `docs/sessions/B09a-order-core-payments.md`. Gate: every payment edge case in the shared brief passes, and an order on any channel posts stock, document, payment and ledger in one transaction.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B08c2-billing-documents.md).
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
Make the owner dashboard's B9a figures live (B05x, A-149): remove `salesTodayPesewas`, `salesYesterdayPesewas`,
`salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and `topMovers` from RPT's PENDING_FIGURES and answer them
from completed orders through a published view, and build the planned tiles getSalesTodayTile and getSalesSeries,
each test-first with its wrong-role refusal.
Unit conversions are built in B06u (A-157, A-163): an order line in a unit other than the product's base unit
converts through MasterDataRefs.toBaseIn, never with a factor of its own.
Add PAY's ◆ events to fin.posting_event_type with their rules, each with an exact-amount matrix test (ADR-0056), and
declare the journal series lock on the sale command, where tills post at once (A-186).
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
Check that counter sales reach the owner dashboard's sales figures and the getSalesTodayTile and getSalesSeries
tiles B9a made live (B05x, A-149): a seeded counter sale appears in today's sales by channel POS, test-first.
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
Notify the maker of a death report sent back by the malware scan (B06r, A-175): liv.MortalityReturned names
the reporter and the reason; the Farm hand reads no death record, so this message is how they learn of it.
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
The exception report must include order splitting (abuse case 27, owner 2026-11-15, A-168): read
PUR's PurchaseOrders.splitSuspectsIn for the report's day and report each run with its maker, supplier,
orders and total; and the payout changes of case 13 from pur.SupplierPayoutChangeRequested and
pur.SupplierPayoutChanged, with SA-17's payment within 24 hours after a change.
It must include case 28 (B07 continued 1b, A-172): each invoice paid on an approved variance
(pur.SupplierInvoiceMatched or ExpenseInvoiceApproved with varianceApprovalRequestId) and each approved supplier
credit note (pur.SupplierCreditNoteApproved with its returned movements), with maker, approver and amount.
It must include case 2's reused death photographs (B06r, A-175): each liv.MortalityPhotoReused with the record,
the reporter and the earlier records whose photograph had the same bytes; and case 29 (A-176): every processing
reversal from prc.ProcessingOrderReversed with its value, the threshold copied onto it, the maker, the approver
when one was needed, and the reason. Residual risk R18 (B07 continued 2): count the storefront checkouts
started and expired per address a day from shp.CheckoutStarted and shp.CheckoutExpired, as an item when one
address holds stock repeatedly without placing an order.
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
In the security review, treat residual risk R16 in docs/security/THREAT_MODEL.md: price lookup reads
wholesale and contract prices without branch or location scope (ADR-0036); decide with the owner between
scoping lookups to what the caller's role may sell and auditing bulk price reads, and test the choice.
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
