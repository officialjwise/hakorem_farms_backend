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
| B05 continued 2 | `B05c-inventory-control.md` | `b05c-inventory-control` | B4 to B12 | The B5 gate in full: on-hand from movements matches a hand count of the seeded farm; stock cannot go negative outside allowed types; a lot traces both ways; every INV write refuses the wrong role |
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

## B6 — Livestock and processing

Branch `b06-livestock-processing`. Report `docs/sessions/B06-livestock-processing.md`. Gate: a processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus the direct processing cost.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05c-inventory-control.md).
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
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): uncomment the 100 percent gate for
src/modules/fin/domain/ in vitest.config.mts before the gate passes. Fill every branch it exposes;
the gate does not pass on a lowered number.
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
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the distribution rules under
src/modules/cap/domain/distribution/ and uncomment its 100 percent gate in vitest.config.mts before
the gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
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
