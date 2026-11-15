# B04d continued 3: Suppliers and the reference data

Date: 2026-11-15 · Branch `b04d3-reference-data`, from `b04d2-parties-locations` at `cd04b01` · Pull request: https://github.com/officialjwise/hakorem_farms_backend/pull/12 (stacked, not merged) · Status: **gate passed**. With it, B04d's gate as a whole has passed.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-115 | Permissions (migrations 0025 and 0026, no step-up). The Owner and Manager hold all twelve. The Storekeeper reads, creates and changes suppliers. The Accountant reads suppliers, payment methods, zones and reason codes. The Cashier and Sales read payment methods, zones and reason codes, and the Farm Hand reads reason codes. The Driver holds none of them. The seven payment methods are migration rows and all start **disabled**; the seeded Owner enables CASH, MOMO, CARD, BANK_TRANSFER and COD. `listPaymentMethods` lists enabled methods unless `includeDisabled=true`. `PaymentMethodUpdate` gains `requiresProviderVerification`. Mobile money may be offline only under `pos.offline_mobile_money_allowed` | Owner |
| A-116 | Zone matching. An address matches on its area, then its city, ignoring case, against the live, active zones of open, non-test branches. One active zone per area, farm-wide. The SRS's "minimum order value" and "days served" are not in the data model or the contract: `free_over_pesewas` is kept, and days served wait for B11's slots. A saved address keeps the zone it was in when saved (BL-045) | Owner |
| A-117 | Archive checks that need a higher module wait for it: a supplier with open purchase orders (B7) and a product holding stock (B5). `archiveProduct` already refuses a product priced by a pending or active price list version. New events: `mdm.ProductArchived` and `mdm.SupplierRegistered` | Owner |
| A-118 | `updatePriceList` can change `taxInclusive` only while no version of the list has gone for approval. `archivePriceList` is refused while a version is pending or in force now or later, or a customer is assigned the list now or later. Both are scoped to the list's branch | Owner |
| A-119 | `quoteDelivery` is public only. It refuses a `cartId` until carts exist (B7), and `slots` stays empty until B11. The fee is not waived here; `freeOverPesewas` is applied at checkout. The fixed list holds 48 reason codes across twelve domains | Owner |

A-076 was checked again. `@nestjs/platform-express` 11.2.10 was released on 2026-11-12, three days ago, which is inside the 14-day floor. The multer override stays.

Phase, scope and gate, as confirmed at the start:

1. Phase: B04d continued 3.
2. Scope: suppliers, payment methods, delivery zones with `quoteDelivery`, reason codes, the price list listings and updates, and `archiveProduct`, each write with a wrong-role refusal; and their seed through the services.
3. Gate: every remaining master data write refuses the wrong role. Reason codes are a fixed list seeded by migration, with no write operation. `quoteDelivery` returns exactly 1,500 pesewas for an address in a zone whose fee is 1,500, and "delivery unavailable" (not zero) for an address in none. Payment methods and delivery zones are seeded through the MDM services.

## Contract changes

**1.9.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Nineteen more operations are now served by the real API, which makes 101 from code and 499 planned.

- **`PaymentMethodUpdate.requiresProviderVerification`:** a new optional field.
- **`listPaymentMethods` `includeDisabled`:** a new optional query parameter.
- **Supplier phones** in requests use `PhoneInput`.
- **`quoteDelivery`** is public only: `security: {}`, with no CSRF header.
- **Two new error codes:** `PAYMENT_METHOD_INVALID` and `DELIVERY_ZONE_INVALID`.

No field, schema or response was removed or retyped, and nothing a client sends became required. `scripts/contract/versioning.ts` passes against the base branch, and the Redocly lint is clean.

## Built

| Area | What |
| --- | --- |
| Domain (`bcac775`) | `domain/reference-data.ts`, under a new 100 percent gate (100 on all four measures). It holds the payment method flag rules, zone areas with one active zone per area, the zone match, and the quote: the exact fee, or no fee when no zone delivers |
| Application and API (`bcac775`) | `ReferenceDataAdmin` (on `AdminKit`), `PgReferenceDataStore` and `ReferenceDataController` cover suppliers, payment methods, zones, `quoteDelivery` and reason codes. `PriceListAdmin` gains the five list operations, and `ProductCatalogue` gains `archiveProduct`. `PartiesAdmin` resolves an address's zone at save. Nineteen fragments were moved from the planned file |
| Migrations (`bcac775`) | `0024` adds `mdm.supplier` and `mdm.supplier_category` (with `supplier_no_seq`), `mdm.payment_method` (seven rows), `mdm.delivery_zone`, `customer_address.delivery_zone_id` and `mdm.reason_code` (48 rows). `0025` adds the twelve permissions and `0026` grants them. All three were rolled back and applied again |
| Seed (`bcac775`) | In `mdm-services`, the seeded Owner enables five payment methods and the seeded Manager creates the DODOWA zone, before the customers, so Ama Serwaa's Dodowa address is in it. A fresh seed writes 245 records; a second run writes 0 |
| Docs | The contract changelog, `docs/API.md` (Master data and two error codes), `docs/data-model/mdm.md`, the MDM card, the `DOMAIN_MODEL` events, A-115 to A-119, BL-045, and the reference table in the openers |

## Decisions

No new ADR. Every choice is an assumption the owner can reverse cheaply (A-115 to A-119), and none contradicts an accepted ADR. ADR-0041's seed-through-services and ADR-0042's bootstrap were applied unchanged.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 1 was done in 1.7.0. Point 2 is B5 |
| CR-004 | Not this phase: point 3 is B04e |
| CR-005 | **Declined again**, for the reason given before: the frontend is paused, and one scripted pass when it resumes is cheaper. The new fragments keep a single example each |
| CR-006 | Not this phase |
| CR-007 | Already in the contract. No new operation needs step-up |
| CR-008 | Answered in an earlier version |

## Deferred

- **To B04e:**
  - imports and exports (FR-MDM-019, FR-MDM-020), which need the file store;
  - product images;
  - the IAM seed through services.
- **To B5:** refusing to archive a product that holds stock (A-117).
- **To B7:**
  - refusing to archive a supplier with open purchase orders;
  - `Supplier.hasProfile`;
  - the free-over waiver at checkout;
  - a `cartId` in `quoteDelivery`.
- **To B8:** the ledger account each payment method settles to (account determination).
- **To B11:**
  - delivery slots and days served;
  - the Driver's delivery failure reasons.
- **Backlog:** BL-045, re-resolving saved addresses when a zone's areas change.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 491 passed. New: `reference-data.spec.ts` (24 tests), at 100 percent on all four measures. Pricing, tax, catalogue, parties and locations stay at 100 |
| Integration | 407 passed. New: `reference-data.integration.spec.ts` (34 tests), on the seeded farm. `seed.integration.spec.ts` gained two tests. The handler walk now covers 101 routes |
| Contract | 34 passed. New: `b4/reference-data.contract.spec.ts` checks every new response shape. `contract:generate --check` is up to date |
| Coverage, merged | 898 passed. Statements 92.78 percent and branches 84.11 percent (gate 80). Every `fullCoverage` gate held |
| Lint, type check | Clean |
| End to end | 13 passed, including the new `reference-data.e2e.spec.ts` (a public quote with no session). They ran against a dev database rebuilt from empty (bootstrap, migrate, seed), with the API and worker on the host |
| Smoke | Passed against the same stack |
| Rollback | `0026`, `0025` and `0024` rolled back and applied again |

The new e2e file signs nobody in. The existing suites already use about 20 logins, the stack's whole `rate_limit.auth.per_address_15m` budget: a login added there made `product-slice.e2e` hit 429. The payment method seed is proved in integration instead.

## Gate

**Passed.** I proved it by running these tests:

- **Wrong roles:** every one of the nine new writes is refused with 403 `FORBIDDEN` for each role without the permission (Sales, the Cashier, the Storekeeper where it lacks it, the Driver), and every refusal is audited.
  - The writes are `createSupplier`, `updateSupplier`, `archiveSupplier`, `updatePaymentMethod`, `createDeliveryZone`, `updateDeliveryZone`, `updatePriceList`, `archivePriceList` and `archiveProduct`.
  - A Manager granted at TST cannot create or change a Dodowa zone.
  - A user with no grant gets 403 on all 101 routes (the handler walk).
- **Reason codes:**
  - `listReasonCodes` pages through all 48 codes in order and filters by domain.
  - The contract's `/reason-codes` item has only `get`, and a POST to it is 404.
  - `hk_app` is refused INSERT, UPDATE and DELETE on `mdm.reason_code` (42501).
- **`quoteDelivery`:**
  - With no session, an address in Dodowa gets `feePesewas: 1500` exactly, from the seeded zone.
  - An address in Ho gets `deliverable: false, feePesewas: null`.
  - A zone with fee 0 quotes exactly 0 and is still deliverable.
  - The domain tests cover the maximum fee, 9,007,199,254,740,991.
- **Seed through services:**
  - The seeded Owner (Kwabena Owusu) wrote exactly five `PaymentMethod` audit events, all with the `hakorem-seed` user agent.
  - The seeded Manager (Akosua Boateng) created the DODOWA zone at fee 1500 and free-over 50000, with `hakorem-seed`.
  - The static check still finds no `INSERT INTO mdm.` or `UPDATE mdm.` in any seed source.
  - The same assertions passed on the end to end stack, where the e2e quote returned 1500.
- **Also covered:**
  - The database refuses switching verification off on MOMO, a card offline, a negative fee, a zone with no areas and a cut-off with seconds (23514), and a twin supplier phone (23505).
  - An area another active zone covers is refused, naming that zone.
  - A supplier phone typed locally is stored in E.164, and a duplicate is refused.
  - `taxInclusive` cannot change on an approved list, and a list in force cannot be archived.

**CI:** the first push (`85fdf99`) was red in both runs, `push` 43670264073 and `pull_request` 43670288300. The only failing step was `pnpm typecheck`: the new e2e file left a response body untyped, and my last local type check had run before that edit. The commit after it fixes the type; every other job was green in both runs. The runs on the final head commit are listed in the pull request and in the session's closing message, with their ids and events, as CLAUDE.md step 6 requires.

## Security review (the parts this change touches)

- **Authorisation:** every handler authorises in the application layer and denies by default.
  - Zone writes are scoped to the zone's branch, and price list updates and archives to the list's branch.
  - An unknown id is checked without a scope first, so the refusal can still be audited.
- **Payment methods:**
  - The verification and offline rules are both database checks and handler rules.
  - Every change is audited with before and after values.
  - Nothing here records a payment.
- **Personal data:**
  - A supplier phone is unique through a keyed HMAC (`hk-supplier-phone-v1`, derived from `LOOKUP_HMAC_KEY`).
  - The TIN is sealed with the supplier's subject key, and only `tinMasked` is shown.
  - Supplier audit events carry their contact fields encrypted.
- **The public quote:**
  - It is in the `public` rate-limit group and is read-only.
  - It takes no session and returns only the zone's own fee, name and cut-off.
  - Zones of test branches are excluded.
- **SQL:** queries are parameterised, update columns come from whitelists, and `ILIKE` input is escaped.
- **Abuse cases:** no new path to money. Abuse case 13 (payout details) is untouched, because payout details are PUR's. Changes to payment methods and zones are audited, so B12's exception report can read them.

## Notes for the frontend track

- **The checkout delivery step:** show "delivery unavailable" when `deliverable` is false. Never show a free delivery for a null fee.
- **Tender screens:** use `GET /payment-methods` as it is. The settings screen passes `includeDisabled=true` and should not offer turning verification off for mobile money or card.
- **Reason pickers:** filter by `domain`, and require a note when `requiresNote` is true.
- **Supplier forms:** send phones as typed. `categoryIds` replaces the whole list.

## Next session

B4 continued (e). The opener is in `docs/prompts/session-openers.md`, section "B4 continued (e)", unchanged:

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
