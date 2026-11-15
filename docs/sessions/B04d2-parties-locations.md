# B04d continued 2: Parties, locations and the rest of the MDM seed

Date: 2026-11-15 · Branch `b04d2-parties-locations`, from `b04d-continued-master-data` at `0ee93b7` · Pull request: https://github.com/officialjwise/hakorem_farms_backend/pull/11 (stacked, not merged) · Status: **phase split (A-114)**. This session built branches, locations, customers, tiers and addresses, and `assignCustomerPriceList`. It moved the rest of the MDM seed onto the services, and that part of its gate passed. Suppliers, the reference data, the price list listings and `archiveProduct` move to **B04d continued 3**, which carries the rest of the gate.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-109 | Permissions (migrations 0022 and 0023, no step-up). The Owner and Manager hold all twelve. Sales reads branches and locations, reads, creates and changes customers, and assigns lists. The Accountant and Cashier read branches, locations and customers; the Storekeeper and Farm Hand read branches and locations; the Driver holds none. Branch and location writes are scoped to their branch; customers are not | Owner |
| A-110 | Only the seed can mark the smoke-suite branch: `isTest` is an in-process option, not part of `BranchCreate`. The seeded `TST` branch gets its virtual locations only. Its physical locations wait for B13's smoke suite and a grant at `TST` | Owner |
| A-111 | Location rules: a parent is a live physical location of the same branch, and is not the location itself or anything below it. A virtual location is never changed or archived, and a database trigger enforces this too. A cold room needs `CHILLED` or `FROZEN` and a rising range. A location with live children cannot be archived. The stock check comes in B5 | Owner |
| A-112 | Customer rules: phones are accepted as typed and stored in E.164. A bad phone, an unknown region or a bad digital address is 400 `VALIDATION_FAILED`. A customer with no tier given goes to `RETAIL`. The TIN is encrypted. Customer numbers come from a sequence, so gaps are allowed. An anonymised customer cannot be changed. `hasBusinessAccount` stays false until B10. The address's delivery zone arrives in B04d continued 3 | Owner |
| A-113 | A new assignment replaces whatever its window overlaps. There is no unassign operation: a customer goes back to tier prices when an assignment with a `validTo` ends. A real unassign operation is BL-042 | Owner |
| A-114 | The phase split at a sub-domain boundary. Suppliers move with the reference data to B04d continued 3, because they share no table or rule with customers | Owner |

A-076 was checked again: `@nestjs/platform-express` 11.2.10 was released on 2026-11-12. That is three days ago, inside the 14-day floor, so the multer override stays.

Phase, scope and gate, as confirmed at the start:

1. Phase: B04d continued 2.
2. Scope: parties, branches and locations, the reference data, the price list listings, `assignCustomerPriceList`, `archiveProduct`, each write with a wrong-role refusal; and the rest of the MDM seed through services.
3. Gate: every remaining master data write refuses the wrong role. Branches, locations and customers are seeded through the services, the caterer's list is assigned through `assignCustomerPriceList`, and no part of the MDM seed is written as SQL.

## Why the phase split

The seed could not move onto the services directly:

- Every role grant names a branch, so nobody can be granted permission to create the first branch.
- The location-scoped staff grants need their locations to exist first.

Solving both took a bootstrap decision (ADR-0042) and a four-unit seed order. With branches, locations, customers, addresses and the assignment, this session built twenty-one operations. The reference data and the price list listings (another fourteen operations, three new tables and `quoteDelivery`) would not have reached the gate in this context. So the session stopped at a green commit and split. The split is recorded in ADR-0026 Amendments, A-114, and a new opener section, "B04d continued 3". B04e now branches from `b04d3-reference-data` and reads its report.

## Built

| Area | What |
| --- | --- |
| Domain (`7323b6b`) | `domain/parties.ts` normalises Ghana phones, checks Ghana-format addresses and plans assignment windows. `domain/locations.ts` holds the parent, virtual, cold room and archive rules. Both are under new 100 percent gates and are at 100 on all four measures |
| Application and API (`7323b6b`) | `AdminKit` holds the shape every admin handler shares. `LocationsAdmin` covers branches, locations and the first-branch bootstrap. `PartiesAdmin` covers customers, tiers, addresses and the assignment, with a keyed phone hash, a sealed TIN and encrypted personal audit fields. `PgLocationsStore`, `PgPartiesStore` and two controllers complete the slice. Twenty-one fragments were moved from the planned file |
| Migrations (`7323b6b`) | `0021` adds `mdm.customer_no_seq`, `mdm.customer_address` and the `mdm.location_virtual_fixed` trigger. `0022` adds the twelve permissions and `0023` grants them. All three were rolled back and applied again |
| Seed (`04b5259`) | The units run in this order: `mdm-bootstrap` (Dodowa and its eight virtual locations, as the System), `b3` IAM staff, `mdm-services`, then `iam-location-grants`. In `mdm-services`, the seeded Owner creates TST. The seeded Manager creates Dodowa's six locations (the cold room is FROZEN, -25.0 to -18.0), the four customers (phones typed the local way) with two addresses, and the caterer's assignment. `farm-b4.ts` is removed. A fresh seed writes 239 records; a second run writes 0 |
| Docs (`04b5259`, `f7957af`) | ADR-0042 and its index row, the MDM card, `docs/API.md` (Master data, two error codes), `docs/data-model/mdm.md`, the contract changelog, A-109 to A-114, BL-042, the ADR-0026 amendment and the openers |

## Decisions

- **ADR-0042** (proposed): the farm's first branch is created by MDM's bootstrap as the SYSTEM principal, only while no branch exists. Every later branch is created by someone granted `mdm.branch.create`.

## Contract changes

**1.8.0. Additive** (`docs/CONTRACT_CHANGELOG.md`). Twenty-one operations are now served by the real API, making 82 from code and 518 planned.

- **New `PhoneInput` schema.** It replaces `PhoneNumber` in six request fields (customer, address and branch phones). This widens what clients may send; every 1.7.0 value is still accepted, and responses are unchanged.
- **Two new error codes:** `LOCATION_INVALID` and `PRICE_LIST_ASSIGNMENT_INVALID`.
- **Descriptions and `x-error-codes`** on the new operations now state their rules.

No existing field, schema or response was removed or retyped, and nothing a client sends became required. `scripts/contract/versioning.ts` passes against the base branch.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 1 was done in 1.7.0. Point 2 is B5 |
| CR-004 | Not this phase: point 3 is B04e |
| CR-005 | **Declined again**, for the same reason as before (the frontend is paused; one scripted pass when it resumes is cheaper). The new fragments keep a single example each |
| CR-006 | Not this phase |
| CR-007 | Already in the contract. No new operation needs step-up |
| CR-008 | Answered in an earlier version |

## Deferred

- To **B04d continued 3**:
  - suppliers (FR-MDM-007);
  - payment methods (FR-MDM-009);
  - delivery zones and `quoteDelivery` (FR-MDM-010), with the expand migration for `customer_address.delivery_zone_id`;
  - reason codes (FR-MDM-011);
  - `listPriceLists`, `updatePriceList`, `archivePriceList`, `listPriceListVersions`, `listPriceListEntries` and `archiveProduct`;
  - the payment method and zone seed.
- To **B04e**: imports and exports (FR-MDM-019, FR-MDM-020), product images, the IAM seed through services (staff and grants are still IAM SQL), and production first-run use of the bootstrap.
- To **B5**: the "location holding stock cannot be archived" check (A-111).
- To **B10**: `hasBusinessAccount`.
- To **B13**: physical locations for the TST branch (A-110).
- Noticed, not changed: the `Promise.all` pg deprecation warning from the earlier pricing stores still prints during `db:seed`. The new code queries one at a time.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 467 passed. New: `parties.spec.ts` and `locations.spec.ts` (36 tests). Both files are at 100 percent on all four measures; pricing, tax and catalogue stay at 100 |
| Integration | 371 passed. New: `parties-locations.integration.spec.ts` (30) on the seeded farm. `seed.integration.spec.ts` gained five tests. The handler walk now covers 82 routes |
| Contract | 31 passed. `contract:generate --check` is up to date and the Redocly lint is clean |
| Coverage, merged | 838 passed; 92.42 percent statements, 83.62 percent branches (gate 80). Every `fullCoverage` gate held |
| Lint, type check | Clean |
| End to end | 12 passed, including the new `parties-locations.e2e.spec.ts`. They ran against a dev database rebuilt from empty (bootstrap, migrate, seed), with the API and worker on the host. CI's fresh-clone job runs them on the image |
| Smoke | Passed against the same stack |
| Rollback | `0023`, `0022` and `0021` rolled back and applied again |

## Gate

**This session's part passed. Every branch, location, customer, tier, address and assignment write refuses the wrong role. Branches, locations and customers are seeded through the MDM services, the caterer's list is assigned through `assignCustomerPriceList`, and no part of the MDM seed is written as SQL.** I proved it by running these tests:

- **Wrong roles:** each of the thirteen writes is refused with 403 `FORBIDDEN` for every role that lacks the permission, and each refusal is audited. The roles tried are Sales, the Cashier, the Storekeeper and the Driver.
  - The Driver cannot read customers, branches, locations or tiers.
  - A Manager granted at TST cannot create a location at Dodowa, and a Manager at Dodowa cannot change TST.
  - A user with no grant gets 403 on all 82 routes (the handler walk).
- **Seed through services** (`seed.integration.spec.ts`):
  - Dodowa's `CREATE` audit event belongs to the System, TST's to the seeded Owner (Kwabena Owusu), and the six locations, four customers and two addresses to the seeded Manager (Akosua Boateng). All carry `hakorem-seed`.
  - The one `ASSIGN_PRICE_LIST` event belongs to the seeded Manager.
  - Customer phones are stored as `+2332000002xx` from the local form.
  - The location-scoped grants exist.
  - A static check finds no `INSERT INTO mdm.` or `UPDATE mdm.` in any seed source.
- **Pricing still holds:** the B4 pricing gate still passes over the reseeded farm, including the caterer's contract price of 700.00.
- **Also covered:**
  - `0244123456` is stored as `+233244123456`, and the same number typed three other ways is refused as a duplicate.
  - The database refuses a twin phone hash, an address with no landmark or digital address, an unknown region, a parent in another branch, and any update to a virtual location (23505 or 23514).
  - Assigning CATERERS-2026 changes the next `resolvePrices` to 70,000. Once the assignment's `validTo` passes, prices come from the tier again. A new assignment ends the earlier one.
- **End to end:** the seeded Sales user finds Ama Serwaa by `0200000201` and sees the caterer on CATERERS-2026.

**Not this session's gate (moved to B04d continued 3):** the wrong-role refusals for suppliers, payment methods, delivery zones, the price list updates and `archiveProduct`; reason codes; `quoteDelivery`.

**CI:** the runs on the final head commit are listed in the pull request and in the session's closing message, with their ids and events, as CLAUDE.md step 6 requires.

## Security review (the parts this change touches)

- **Authorisation:** every handler checks its permission in the application layer and denies by default.
  - Branch and location writes are scoped to the branch.
  - A write to an unknown branch or location id is checked without a scope first, so a refusal can still be audited without a foreign key failure. It then gets 404 or 422.
- **Personal data (FR-AUD-011):**
  - The phone is unique through an HMAC under a key derived from `LOOKUP_HMAC_KEY`, so the number is never indexed.
  - The TIN is sealed with the customer's subject key, and responses show only its last four characters.
  - Audit events carry the customer's and address's personal fields encrypted with the subject key.
- **The bootstrap (ADR-0042):** it accepts only the SYSTEM actor, runs only on an empty `mdm.branch`, has no route, and is audited.
- **Seed:** `isTest` cannot be set through the contract. The ADR-0041 step-up waiver is unchanged.
- **SQL:** queries are parameterised, update columns come from whitelists, and `ILIKE` input is escaped.
- **Exception report:** no new path reaches money. Assignment changes are audited with before and after values, so the exception report can read them.

## Notes for the frontend track

- Send phones as typed; show the E.164 value that comes back. On 400 `INVALID_PHONE`, ask the user to check the number.
- Address forms need a region picker with the sixteen regions, and a landmark or a GhanaPostGPS code.
- Location trees: request `includeVirtual=true` only for stock movement screens, and never offer edit on a virtual location.
- To end a contract price, assign with a `validTo`; there is no unassign button yet (BL-042).

## Next session

B04d continued 3. The opener is in `docs/prompts/session-openers.md`, section "B04d continued 3":

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
