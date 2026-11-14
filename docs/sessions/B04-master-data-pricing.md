# B04 — Master data and the pricing engine

Date: 2026-11-14 · Branch `b04-master-data-pricing`, from `main` at `3062d39` (pull requests 1 to 5 merged) · Status: **gate passed**. B4 is split: this session built the pricing sub-domain; the rest of MDM, tax, promotions and the A-087 items are **B04 continued** (ADR-0026, Amendments)

## Contract changes

**Version 1.3.0, additive only** (`docs/CONTRACT_CHANGELOG.md`). No existing shape changed: no field, schema, parameter or response was removed, renamed, retyped or made required. A client generated from 1.2.x keeps working. The frontend track is paused, so nothing reviewed this; the changelog entry is written to be read cold when it resumes.

- Seven operations now answer from the real API (24 in all): `resolvePrices`, `createPriceList`, `getPriceList`, `createPriceListVersion`, `getPriceListVersion`, `replacePriceListEntries`, `submitPriceListVersion`. Their schemas are the ones 1.2.0 already published.
- `x-requires-step-up: true` on 30 operations (CR-007). `x-error-codes` on the seven new operations; one new code, `PRICE_ENTRY_INVALID`.
- Example fixes (CR-008): `listBranches`, `listSpeciesList`, `listDeliveryZones` no longer repeat rows; the `submitPriceListVersion` 202 example names the right document type.
- Behaviour without a shape change: `submitPriceListVersion` always answers 202; `promotions` is always `[]`; `couponCode` and `stockUnitId` answer 422 `REFERENCE_NOT_FOUND` until coupons and stock units exist; a late approval moves `validFrom` to the approval time.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`)

| Request | Answer |
| --- | --- |
| **CR-006** TOTP enrolment during first sign-in | **Point 1: answered in B3, option (b)**: `startTotpEnrolment` and `confirmTotpEnrolment` take the `challengeToken` in the body with no cookie and `CsrfTokenOptional`; `confirmTotpEnrolment` sets the session cookies (contract 1.2.0, B3 report "The login flow"). **Point 2, the QR code as a data URI: accepted, not built (A-094).** It needs a QR encoder on the server. I chose `uqr` 0.1.3 (no dependencies of its own, CommonJS build, from the unjs organisation, published 2026-04-03, past the 14-day floor) over `qrcode` 1.5.4 (pulls in yargs and pngjs). The session's permission check refused installing it, and I did not hand-write an encoder instead: one I cannot verify against a decoder is the wrong thing to put between a user and their authenticator secret. **Owner decision needed** (see "Decision needed"). Until then the response carries `otpauthUri` and `secretBase32` only |
| **CR-007** machine-readable step-up | **Implemented.** `x-requires-step-up: true` beside `x-permission` on the 30 operations whose description says "Requires step-up". A contract test keeps the flag and the prose in step; an integration test keeps it equal to `iam.permission.requires_step_up` for all 17 operations whose permission is seeded so far. Approval decisions carry no flag (step-up depends on the kind's policy), so the screen still handles 403 for those |
| **CR-008** repeated example ids | **Implemented** for `listBranches` (the request) and the two other lists the same scan found, `listSpeciesList` and `listDeliveryZones`. A contract test now refuses any response example list that repeats an id |
| CR-001 stock valuation at cost | **Declined for B4, scheduled for B5**, the inventory session that owns stock valuation. Pricing already keeps prices in their own named fields (`listPricePesewas`, `floorPricePesewas`, `ceilingPricePesewas`), never a cost |
| CR-003 unit display precision | **Declined for B4, scheduled for B04 continued** (units of measure and `listUnitsOfMeasure`) and B5 (the stock lines). It adds a field to `Uom` and stock schemas, best done with the code that fills it |
| CR-004 sign-in gaps | Points 1 and 2 **answered in B3**: `changePassword` takes the `challengeToken` (option (b)), and after it the caller signs in again with the new password. Point 3 (reset token error codes) **scheduled for B04 continued** with password reset (A-087) |
| CR-005 named empty examples | **Declined for B4.** The frontend is paused, so no screen uses the mock now, and the conversion to `examples` maps is best done in one scripted pass when it resumes. Proposed for the first backend session after the frontend restarts |

## Decision needed

**CR-006 point 2: may the backend add `uqr@0.1.3` as a dependency?** It renders the `otpauth://` URI as an SVG, returned as `qrCodeDataUri: "data:image/svg+xml;base64,..."` beside `otpauthUri` and `secretBase32` (an additive field on `TotpEnrolment`, contract 1.4.0, with an ADR for the dependency). If yes, B04 continued builds it first. If no, the alternatives are `qrcode` 1.5.4 (three dependencies) or a hand-written encoder verified against a decoder in the tests.

## Built

| Area | What |
| --- | --- |
| Domain | `pricing-engine.ts`: the ADR-0004 walk with specificity and quantity breaks, `quote_only` stopping the walk, the typed `QuoteRequired` (`NO_RULE`, `QUOTE_ONLY`, `MISSING_GRADE_OR_WEIGHT`), half-open weight bands, `judgeAgreedPrice` (FR-MDM-017) and `extendPrice` (one half-up rounding at the line). `price-list.ts`: list slots, version windows, entry rules, `activationWindow`, `planActivation`. 100 percent branch coverage, written test-first with exact pesewas |
| Database | `0010` btree_gist and the `PRICE_LIST_VERSION` document type; `0011` grades, weight bands (exclusion per species), customer tiers (seeded), customers, price lists (one per slot), versions (exclusion on ACTIVE windows, lifecycle guard trigger), entries (frozen outside DRAFT, a definer function to clear a draft), customer assignments (one at a time, CUSTOMER lists only); `0012` five permissions, their grants (A-089), the `PRICE_LIST_ACTIVATION` policy with step-up for the checker. Every rule is violated once in a test; rollback runs in CI |
| Application | `PricingService.resolve` and `resolveIn` (for selling modules, in their transaction); `PriceListAdmin`: create a list, draft a version (optionally copied), replace entries with optimistic locking, submit (202, approval request), and the approval handler that activates or rejects in the approval's transaction. Audit on every write; `mdm.PriceListVersionActivated` in the outbox |
| Interface | Seven endpoints with `@Operation`, zod at the boundary (pesewas become `bigint`, weights are three-place strings), fragments moved from the planned file by `scripts/contract/move-to-code.ts` |
| Platform and IAM | `DocumentRegistry` (platform): modules register business documents without naming the platform table. `PrincipalNames` on IAM's door, for `createdBy` and `activatedBy` |
| Seed | `src/seed/reference-pricing.ts`, one definition of the reference catalogue's prices: 23 products, 7 species with 22 weight bands and goat grades A and B, 4 customers (one per tier and a caterer on a contract list), 7 price lists (base, online, wholesale, two wholesale tier lists, a counter reseller list, the caterer's contract), each version drafted by the seeded Manager and approved by the seeded Owner. `farm-b4.ts` writes it, idempotently |

## Decisions

- **ADR-0036** (Proposed): branch lists come first inside a slot and fall through to the all-branch list; `MISSING_GRADE_OR_WEIGHT` only when the missing attribute could price the line; activation starts no earlier than the approval (the database lets `valid_from` move later, never earlier); activation ends earlier versions and supersedes later overlapping ones; draft entries are cleared by one definer function; `resolvePrices` checks the permission without a location scope.
- **The split.** Recorded in ADR-0026 (Amendments) and the openers. Pricing first because it is this phase's gate; the A-087 items moved with the rest.
- **A bug the gate found:** a 65 kg goat with no grade was answered `MISSING_GRADE_OR_WEIGHT` because grade A was priced for smaller bands. Fixed test-first (`f98cc93`).
- **Money in responses** is a JSON integer from `Money.toJsonInteger`, which refuses anything beyond the exact range; Express cannot serialise a `bigint`.

## Assumptions (all in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-089 | Pricing permissions by role: Owner and Manager administer and approve price lists; Accountant and Sales read and resolve; Cashier resolves | Owner |
| A-090 | A list for every branch registers its versions under the first active non-test branch (Dodowa); no head-office flag yet | Owner |
| A-091 | A walk-in buyer gets no tier list; walk-ins are not the RETAIL tier | Owner |
| A-092 | The seeded prices are SEED values spanning the brief's indicative bands, not the farm's prices | Owner |
| A-093 | Broilers, local chickens and ducks are countable flocks priced per head by weight band; goats, sheep, pigs and rabbits are serialised | Owner |
| A-094 | CR-006 point 2 waits for the dependency decision | Owner |
| A-076 | Checked again: `@nestjs/platform-express` 11.2.10 is two days old, so the multer override stays | B04 continued |
| A-083, A-085, A-087 | Moved to B04 continued | — |

## Deferred to B04 continued

- The A-087 items: uploads with the malware scanner and `evidence_file_id`; user and grant administration; customer registration and phone verification; password reset (and CR-004 point 3); `approveRequest`, `rejectRequest`, `listApprovals`, `getApproval`. Until then a submitted price list version is approved through `Approvals.decide` (seed and tests), not over HTTP.
- The rest of master data: categories, species, grades, weight bands, customers and addresses, tiers, suppliers, branches, locations, payment methods, delivery zones, reason codes, `assignCustomerPriceList`, `updateProduct`, `listPriceLists`, `listPriceListVersions`, `listPriceListEntries`, imports and exports. CR-003.
- Promotions and coupons in the engine (FR-MDM-018); the tax calculator with named levies (FR-MDM-012 to 014, ADR-0020).
- The seed through services (A-085): both seed slices still write SQL.

## Tests

| Layer | Result (local, 2026-11-14) |
| --- | --- |
| Unit | 287 passed, including 35 for the engine and 26 for price list rules |
| Integration (Testcontainers PostgreSQL 17.6, Redis 7.4.6, Versity Gateway 1.10.0) | 221 passed (508 with unit), including the gate (30), the price list lifecycle (17), the pricing schema rules (12) and the step-up consistency check |
| Contract | 24 passed (drift, versioning, request examples, response shapes of the seven new operations, CR-007 and CR-008 checks); Redocly lint clean |
| End to end | `test/e2e/mdm/pricing.e2e.spec.ts` passed in CI's fresh-clone job, on the stack built from the image and seeded by `pnpm run setup`. Not run locally: it needs a freshly set-up stack, and I did not rebuild or reseed the local one |
| Coverage, unit and integration merged | 91.50 percent statements, 82.88 percent branches (gate 80); `pricing-engine.ts` and `price-list.ts` 100 percent branches |
| Lint, type check | Clean, including the money arithmetic rule, the boundary fixtures and the schema-names check |

## Security review (hakorem-security-review, the parts this change touches)

- **Authorisation** in every handler (SC-02): `mdm.price.resolve`, `mdm.price_list.read`, `.create`, `.update`; the checker needs `mdm.price_list.approve` with step-up, at the version's branch. Tests: the cashier and driver refused on `createPriceList`, the cashier refused on `getPriceList`, the driver refused on `resolvePrices`, and the handler walk refusing a user with no grant on all 24 routes.
- **Maker-checker:** the maker approving their own version is refused by the domain and the database (`MAKER_CANNOT_CHECK`, tested). A version cannot become ACTIVE without an approval request (CHECK). Its entries cannot change once submitted, so the payload hash holds.
- **Never a zero price:** a priced entry needs a floor above zero (domain and CHECK); the engine never returns zero.
- **Parameterised SQL only** (SC-03); the entry insert uses arrays with `unnest`, no SQL built from values. The one definer function has a fixed `search_path` and can empty only a draft.
- **No new abuse path** reaches the exception report yet: price overrides (abuse case 3) are judged by `judgeAgreedPrice`, and their recording and approval are B9a and B9b.

## Gate

**A price resolves correctly for every band, channel and customer tier in the catalogue: passed.** `test/integration/mdm/pricing-gate.integration.spec.ts` loads the seeded farm exactly as `pnpm db:seed` does and, as the seeded Sales user over the API, prices 87 lines (every product; every band of every species with and without each grade; each band's lower edge; a weight above and below every band; no weight) on each of the four channels for each of five buyers (walk-in, RETAIL, WHOLESALE, RESELLER, and the caterer with a contract list). Every answer is checked against a walk of the plain seed definition in the ADR-0004 order: list, list code and id, floor, list and ceiling price, basis, band and grade. Pinned exact values check the oracle itself: a 22.400 kg grade A goat is 72,000 at the counter, 64,800 for a wholesale buyer on the wholesale channel (floor 40,500, ceiling 72,000), 70,000 for the caterer on every channel; derived floors rounded half-up once (906.95 to 907, 623.05 to 623); 0.500 kg of online wings at 1,155 a kilogram extends to 578.

**An unresolvable request becomes a quote rather than an error: passed.** Every one answers 200 with `outcome: QUOTE_REQUIRED`: a 65.000 kg goat above every band (`NO_RULE`), a goat with no weight (`MISSING_GRADE_OR_WEIGHT`), a 70.000 kg festival ram (`QUOTE_ONLY`, though smaller sheep have prices), and lettuce, unpriced this season (`NO_RULE` on every channel).

**CI green: passed.** [Run 43620103368](https://github.com/officialjwise/hakorem_farms_backend/actions/runs/43620103368) on commit `1948ab1`, all six jobs successful: lint and type check; unit and integration with the coverage gate; contract; image build and scan; the fresh-clone job (`pnpm run setup` on a clean runner, then the e2e suite including the new pricing test); secret scan, dependency audit and static analysis. The run before it failed lint on one untyped alias in the new e2e test, fixed in `1948ab1`.

## Notes for the frontend track (for when it resumes)

- Regenerate the client from contract 1.3.0 and read its changelog entry first. Switch the seven pricing operations off the mock.
- Use `x-requires-step-up` to ask for the TOTP code before those writes, and keep handling 403 `STEP_UP_REQUIRED` for approvals.
- `resolvePrices` takes `X-CSRF-Token` and no idempotency key. Show `QUOTE_REQUIRED` as "Request a quote", never as an error, and ask for the weight or grade on `MISSING_GRADE_OR_WEIGHT`. Weights are three-place strings.
- Seeded prices to try after `pnpm run setup`: log in as the seeded Cashier and price `LIV-GOAT` at 22.400 kg on POS (65,000) and at 65.000 kg (a quote).
- CR-006 point 2, the QR code, waits for the owner's decision; render `otpauthUri` or show `secretBase32` until then.

## Next session

B04 continued: the rest of master data, tax, promotions and the B3 carry-overs. Open a fresh Claude Code session **in `backend/`** after this pull request is merged, with the opener in `docs/prompts/session-openers.md`, section "B4 continued", which is:

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
Before building: settle CR-006 point 2 (A-094) as the owner decided, and remove the multer override if
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
Stop at the gate and write docs/sessions/B04c-master-data-continued.md.
```

Add at the top of that message the owner's answer to "Decision needed" above. B04 continued carries a lot; if it cannot finish, split again at a module boundary (the A-087 IAM items in one session, MDM in the next).
