# B04d continued — The catalogue and the MDM seed through services

Date: 2026-11-15 · Branch `b04d-continued-master-data`, from `b04d-master-data-promotions` at `4808534` · Pull request: see "Gate" · Status: **phase split (A-108)**. This session built the catalogue sub-domain and the seed through services for everything MDM's services already cover, and passed that part of its gate. Parties, branches and locations, the reference data, the price list listings and the rest of the seed move to **B04d continued 2**, which carries the rest of the gate.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-104 | The seed acts as the seeded staff through the real services. The step-up that tax, price list and promotion permissions demand is accepted for the seed's own calls only: only for a seeded person, and only after the Authoriser has found the grant (ADR-0041). Rejected: seeding a TOTP secret, which would remove the first-login enrolment | Owner |
| A-105 | Catalogue permissions (migration 0020). Owner and Manager read and write categories, species, grades, weight bands and products. Accountant, Storekeeper, Cashier, Sales and Farm Hand read them. The Driver holds none. No step-up | Owner |
| A-106 | Product status never returns to `DRAFT`. A category move keeps the product's tax category. A shelf-life change that flips lot tracking is refused (`TRACKING_FIXED`). A grade or band used by a pending or active price list version cannot be archived, and such a band keeps its range. Lists are live records in creation order | Owner |
| A-107 | A countable product of a species kept in lots (broilers, local chickens, ducks) is tracked by lot even without a shelf life. This extends A-082 | Owner |
| A-108 | B04d continued split at a sub-domain boundary inside MDM. This session built the catalogue and the seed through services. **B04d continued 2** builds parties, branches and locations, the reference data, the price list listings, `assignCustomerPriceList`, `archiveProduct`, and the rest of the seed | Owner |

A-076 checked again: `@nestjs/platform-express` 11.2.10 is three days old, inside the 14-day floor, so the multer override stays.

Phase, scope and gate, as confirmed at the start:

1. Phase: B04d continued.
2. Scope: the rest of master data with wrong-role refusals, CR-003, and the MDM seed through services, including tax scheme version 1.
3. Gate: every master data write refuses the wrong role; the MDM seed is written through the services; `calculateTax` answers on a fresh setup.

## Why the phase split

The opener carried about fifteen entities: more than fifty operations, five new tables (supplier, customer address, payment method, delivery zone, reason code), and the seed rebuilt on a new mechanism. This session took the seed mechanism, the catalogue (eighteen operations) and the seed through services to green. The rest would not have reached its gate in this context. So the session stopped at a green commit and split at the sub-domain boundary in `docs/data-model/mdm.md`: Catalogue, Pricing and Tax done here; Parties, Branches and locations and Reference data go next. The split is recorded in ADR-0026 Amendments, A-108, and a new opener section, "B04d continued 2", in `docs/prompts/session-openers.md`. B04e now branches from B04d continued 2 and reads its report.

## Built

| Area | What |
| --- | --- |
| Seed mechanism (`5d2a8d4`) | `SeedUnit` is now `SQL` or `SERVICE`, and `runSeedUnits` runs both. `pnpm db:seed` refuses production as before, then starts the application context on the real clock. `SeedStaff` acts as the seeded Owner, Manager and Accountant, under the `hakorem-seed` user agent and the A-104 waiver. Tax scheme version 1 (ADR-0020 matrix, 21 cells) is drafted by the seeded Accountant and approved by the seeded Owner. All seven price lists are drafted by the seeded Manager and approved by the Owner. Two coupon-only promotions (`WELCOME10`, `XMAS-MEAT-5`) are seeded through Promotions |
| Catalogue (`7c4ecae`) | `domain/catalogue.ts`, under a new 100 percent gate, holds three rules: the category archive guard, the half-open weight band range, and the "in use by live prices" rules. `CatalogueAdmin` with `PgCatalogueStore` covers categories, units, species, grades and bands. `ProductCatalogue.update` publishes `mdm.ProductChanged`. Migration `0019` adds `uom.display_decimals` (CR-003) and unique category names among siblings; `0020` adds the permissions. Two new error codes: `RECORD_IN_USE` and `WEIGHT_BAND_INVALID`. Audit runs on every write |
| Flock tracking (`52eaf84`) | A countable of a LOT species is held in lots (A-107) |
| Catalogue seed (`5ecc066`) | Categories, species, grades, bands and all 23 products go through `CatalogueAdmin` and `ProductCatalogue` as the seeded Manager. The SQL units still draw the ids of the rows that moved, so staff and customers keep their ids. A fresh setup seeds 243 records; a second run seeds 0 |
| Docs (`a0ba5a3`) | ADR-0041; `docs/data-model/mdm.md`; the MDM card; `docs/API.md` (Master data section, error codes); the contract changelog; the split |

## Decisions

- **ADR-0041** (proposed): the seeded farm is written through the services in the application context, as the seeded staff. The only waiver is the step-up a seed cannot give, for the seed's own calls. SQL units remain until their services exist.

## Contract changes

**1.7.0. Additive** (`docs/CONTRACT_CHANGELOG.md`). Eighteen operations now answer from the real API: `listCategories`, `createCategory`, `getCategory`, `updateCategory`, `archiveCategory`, `listUnitsOfMeasure`, `listSpeciesList`, `createSpecies`, `updateSpecies`, `listGrades`, `createGrade`, `updateGrade`, `archiveGrade`, `listWeightBands`, `createWeightBand`, `updateWeightBand`, `archiveWeightBand` and `updateProduct`. That makes 61 from code and 539 planned.

- `Uom` gains a required response field, `displayDecimals` (CR-003). It breaks nothing a client sends (ADR-0038).
- Two new error codes: `RECORD_IN_USE` and `WEIGHT_BAND_INVALID`.
- Descriptions now state the rules. One summary typo is fixed.

No existing field, schema or response was removed or retyped, and nothing a client sends became required.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 stock valuation at cost | Not this phase: stock is B5 |
| CR-003 unit display precision | **Point 1 implemented** in 1.7.0: `Uom.displayDecimals`, required, 0 to 3. **Point 2** (the precision beside `uom` on `StockUnit` and `StockOnHandLine`) goes to B5 with the stock schemas, which nothing implements yet |
| CR-004 sign-in gaps | Not this phase: point 3 is B04e |
| CR-005 named empty examples | **Declined again**, as in B4 and B04d: the frontend is paused, and one scripted pass when it resumes is cheaper. The eighteen new fragments keep the planned single example |
| CR-006 TOTP enrolment | Not this phase |
| CR-007 machine-readable step-up | Already in the contract. No catalogue operation needs step-up |
| CR-008 repeated example ids | Answered in an earlier version |

## Deferred

- To **B04d continued 2**:
  - Customers and addresses, tiers, suppliers, branches and locations, payment methods, delivery zones with `quoteDelivery`, and reason codes, each with its table where missing.
  - The price list listings and updates (`listPriceLists`, `updatePriceList`, `archivePriceList`, `listPriceListVersions`, `listPriceListEntries`), `assignCustomerPriceList` and `archiveProduct`.
  - The seed for branches, locations and customers through services. The caterer's list assignment through `assignCustomerPriceList`, replacing the interim SQL in `farm-mdm.ts`.
- To **B04e**: imports and exports (FR-MDM-019, FR-MDM-020) and product images (FR-MDM-004), which need the file store; the IAM seed through services.
- To **B5**:
  - CR-003 point 2.
  - The stock-policy usage check behind FR-MDM-001. `ProductUpdate` carries no `stockPolicy`, so `updateProduct` cannot change the policy at all.
  - Unit conversions (`mdm.product_uom_conversion`, FR-MDM-003). No operation in the contract writes them.
- Noticed, not changed: `PgPriceListStore.entryReferences`, `PgPromotionStore` and `PricingService` run `Promise.all` over one transaction's client. pg queues the queries, so the results are right, but it prints a deprecation warning. A one-line fix for whichever session next touches those files.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 431 passed. New: `domain/catalogue.spec.ts` (18), the flock case in `product.spec.ts`. `src/modules/mdm/domain/catalogue.ts` is under a new 100 percent gate and is at 100 on all four measures. Pricing and tax stay at 100 |
| Integration | 336 passed. New: `catalogue.integration.spec.ts` (33), which proves the wrong role is refused on all twelve writes, the database refuses the bad rows, and archive, overlap and update behave as specified. `seed.integration.spec.ts` gained six tests on the seed through services. The handler walk covers all 61 routes |
| Contract | 31 passed. `pnpm contract:generate` regenerated (61 from code, 539 planned). Redocly lint clean |
| Coverage, merged | 767 passed; 92.52 percent statements, 83.97 percent branches (gate 80); every `fullCoverage` gate held |
| Lint, type check | Clean |
| End to end | 9 passed against a fresh `pnpm run setup` database, with the API and worker run on the host: the image build could not reach Alpine's mirror and Docker Hub from this machine. CI's fresh-clone job runs it on the image |
| Smoke | Passed against the same stack |
| Rollback | `0020` and `0019` rolled back and applied again |

## Gate

**This session's part: every catalogue write refuses the wrong role, and the catalogue, price lists, tax scheme version 1 and promotions are written through the MDM services, with `calculateTax` answering on a fresh setup. Passed.** I proved it by running these tests:

- **Wrong roles:** the Cashier and Sales get 403 `FORBIDDEN` on each of the twelve catalogue writes, and each refusal is audited (`catalogue.integration.spec.ts`). The Driver cannot read categories, species, grades or bands. A user with no grant gets 403 on all 61 routes (handler walk).
- **Tax scheme through the services:**
  - Version 1 is `ACTIVE` with 21 cells. Its approval request was made by the seeded Accountant (Yaw Agyeman) and decided by the seeded Owner (Kwabena Owusu). Its audit events carry `hakorem-seed`.
  - `calculateTax` as the seeded cashier gives exact pesewas. A meat net of 10,000 gives VAT 1,500, NHIL 250, GETFund 250 and gross 12,000. A goat is zero-rated three times (`seed.integration.spec.ts`).
  - On a fresh `pnpm run setup` database, a GHS 459.00 beef pack splits into 38,250 + 5,738 + 956 + 956 (`pricing.e2e.spec.ts`).
- **Price lists and promotions through the services:** all seven lists are `ACTIVE`, drafted by the seeded Manager and approved by the seeded Owner. The B4 pricing gate still passes against them, all 30 tests. Both promotions are `ACTIVE` with their coupons.
- **Catalogue through the services:** 4 categories, 7 species, the grades, every band and 23 products were created by the seeded Manager under `hakorem-seed`. Broilers are tracked by lot.
- **Also covered:**
  - Archiving Meat with a live child, or Beef with three live products, is `RECORD_IN_USE`. Once the products move, Beef archives and stays readable.
  - Bands 10–20 and 20–30 are accepted. A band from 19.5 to 25 is refused by the API (`OVERLAPS_BAND:GOAT-M`, `GOAT-L`) and by the database (23P01).
  - A band or grade used by an active price list cannot be archived or moved. A free band can widen.
  - `updateProduct` versioning, `DRAFT` refused, policy conflicts, and `mdm.ProductChanged` with `changedFields`.

**Not this session's gate (moved to B04d continued 2):** the remaining master data writes with wrong-role refusals, and "no part of the MDM seed written as SQL". Branches, locations and customers are still SQL, and so is the interim caterer assignment.

**CI:** the runs on the final head commit are listed in the pull request and in the session's closing message, with their ids and events, as CLAUDE.md step 6 requires.

## Security review (the parts this change touches)

- Every handler checks its permission in the application layer: `mdm.category.*`, `mdm.species.*`, `mdm.grade.*`, `mdm.weight_band.*`, `mdm.product.update`, and `mdm.product.read` for units. Deny by default. Wrong-role refusals are tested and audited.
- **The seed's step-up waiver (A-104, ADR-0041):**
  - It is confined to `src/seed/seed-staff.ts`.
  - It applies only inside a `SeedStaff.as` call, only to the seeded principals, and only to `STEP_UP_REQUIRED` and `TOTP_ENROLMENT_REQUIRED`, which the Authoriser raises after a grant was found.
  - It is removed when the call returns. Maker-checker still holds: the Accountant or Manager makes, the Owner checks.
  - `pnpm db:seed` refuses production three ways before the application context starts.
- SQL is parameterised. `PgCatalogueStore.update` sets only whitelisted columns per table, and the table names come from a fixed map.
- No new abuse path reaches money. Catalogue writes are audited with before and after values, so the exception report can read them.

## Notes for the frontend track

- Format quantities with `Uom.displayDecimals`; never infer the precision from `kind`.
- Archive refusals come back as `RECORD_IN_USE`, with the reason in `details[].code`. Show it, and offer to move the products first.
- Weight bands are half-open: show "20.000 to under 30.000 kg".

## Next session

B04d continued 2. The opener is in `docs/prompts/session-openers.md`, section "B04d continued 2":

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
