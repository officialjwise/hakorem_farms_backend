# B04e continued 5: the remaining MDM import sheets

Date: 2026-11-15 · Branch `b04e6-mdm-import-sheets`, from `b04e5-mdm-imports-exports` · Pull request #18 (stacked on #17, not merged) · Status: **gate passed**. With it, B04e's and B04 continued's gates have passed as a whole. B5 is next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-130 | **The four sheets, read as conservatively as possible.**<br>**Common to all four:**<br>- A blank cell changes nothing.<br>- Each row is written through the entity's own service in the import's transaction.<br>- Codes resolve to live records only.<br>- Two rows that name the same record are refused.<br>**Products:**<br>- Named by `sku`.<br>- A new SKU is created ACTIVE and `HIDDEN` online.<br>- The stock policy, species and units never change by import.<br>- No SEO, status, storage, withdrawal or tolerance column.<br>**Suppliers:**<br>- Named by `supplierNo`.<br>- `categories` holds codes separated by `;` and replaces the supplier's categories.<br>- No TIN or status column.<br>**Locations:**<br>- Named by `branch` and `code`, physical kinds only.<br>- The kind and temperature class never change.<br>- A parent is a live location, or one created by a row above.<br>- No `allowsNegative` column.<br>- Apply is scoped to each branch the file writes.<br>- The export leaves out virtual locations.<br>**Price list entries:**<br>- Prices are integer pesewas (`85000` is GHS 850.00).<br>- Rows go into the list's one `DRAFT` version, never an active or submitted one.<br>- A list with no draft, or with a version pending approval, is a row error. The import never drafts a version.<br>- A row that matches an entry on product, grade, band and minQty replaces it. Any other row adds an entry. Entries the file does not name stay.<br>- Apply is scoped to the version's branch.<br>- The export is each list's version that is active now.<br>**`OPENING_STOCK`** stays 422 until B5 | Owner |

**Needs the owner's approval: nothing new.** No dependency was added, and there is no new ADR, because ADR-0046 already covers this ("a new entity is a new `EntitySheet`"). I found no ADR conflict:
- Imports into a draft only respects ADR-0036.
- Branch scope respects ADR-0017.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B04e continued 5.
2. **Scope:** the `PRODUCT`, `SUPPLIER`, `LOCATION` and `PRICE_LIST_ENTRY` sheets, on the existing `MdmImports` and spreadsheet codec, each writing through its entity's own service.
3. **Gate:** each sheet imports with a dry run that writes nothing, and applies all rows or none through the entity's service in the import's transaction. Each exports audited with its row count and a fresh step-up. Each has a wrong-role refusal and its own row-error tests. `AVAILABLE_ENTITIES` lists everything except `OPENING_STOCK`.

## Contract changes

**1.15.0, additive** (`docs/CONTRACT_CHANGELOG.md`):
- No schema, field, enumeration value or error code changed.
- `createImportJob`, `applyImportJob` and `createExportJob` now accept four `entity` values that the enumeration already listed. They used to answer 422 `IMPORT_ENTITY_NOT_AVAILABLE` for them.
- The descriptions now state each sheet's columns and rules, the entity permissions, and the branch scope.

Checks: Redocly lint is clean, and `contract:generate` is up to date (138 operations from code, 462 planned). No existing shape changed.

## Built

| Area | What |
| --- | --- |
| MDM domain | `domain/import-rows.ts`: the row readers and form checks for the four sheets, `readPesewas` (digits only, a `bigint` up to the `platform.pesewas` maximum), `readMinQty` and `priceBandErrors`.<br>`AVAILABLE_ENTITIES` now lists every entity except `OPENING_STOCK` |
| MDM application | **Sheets:** `ProductSheet`, `SupplierSheet`, `LocationSheet`, `PriceEntrySheet`.<br>**Shared helpers:** `readRows`, `cached` and `EXPORT_PAGE` in `import-sheets.ts`.<br>**The `SheetLookups` port:** finds a live record by its code.<br>**Methods moved out of the handlers, behaviour unchanged:**<br>- `ProductCatalogue`: `createIn`, `updateIn`, plus `createRules` and `updateRules` for the dry run<br>- `ReferenceDataAdmin`: `createSupplierIn`, `updateSupplierIn`, `supplierPhoneTaken`<br>- `LocationsAdmin`: `createLocationIn`, `updateLocationIn`<br>- `PriceListAdmin`: `replaceEntriesIn` |
| Infrastructure | `PgSheetLookups`, which reads only the `mdm` schema and only live rows. Wired in `mdm.module.ts` |
| Interface | Descriptions of `createImportJob`, `applyImportJob` and `createExportJob` |
| Migrations | None |
| Docs | A-130; the changelog; API.md section 16 and its error row; the MDM card; ADR-0046 Verification; ADR-0026 Amendments (closed, no split); the openers (this phase marked built) |

## Decisions

- **No new ADR.** Everything here is a choice that ADR-0046 already allows. The rest is recorded in A-130.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15; unchanged since the last report)

- **CR-001:** not this phase; stock is B5.
- **CR-003:** point 2 is B5.
- **CR-004, CR-006, CR-007, CR-008:** answered earlier.
- **CR-005:** declined again; it is one scripted pass when the frontend resumes.

## Deferred

- **To B5:** the `OPENING_STOCK` sheet, as before (A-128).
- **To B12:** `BULK_EXPORT` on the exception report, as before.
- **Seed:** nothing added. Import jobs are records of actions, and the seeded farm has none.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **606 passed.** New: `import-rows.spec.ts` (17). It checks pesewas at 0, at 9,007,199,254,740,991 and at one more; cedis with a decimal point refused; floor one pesewa above list and ceiling one pesewa below list; a zero floor on a priced entry and on a quote-only one. `imports.spec.ts` was updated |
| Integration | **532 passed.** New: `mdm/import-sheets.integration.spec.ts` (19). `import-jobs` and `master-data-export` now expect only `OPENING_STOCK` to be unavailable |
| Coverage, merged | **1,138 passed.** Statements 93.75 percent, branches 85.57 percent (gate 80). Every 100 percent gate holds |
| Contract | **45 passed** |
| Lint, type check | Clean |
| End to end | Unchanged. It runs in CI; I did not run it on this machine |

## Gate

**Passed.** I proved it against real PostgreSQL and the S3 gateway in `import-sheets.integration.spec.ts`.

**Wrong roles:**
- `createImportJob` for each of the four sheets refuses the accountant, cashier, sales, driver, farm hand, storekeeper and a user with no grant. Each refusal is audited, and no job is written.
- `createExportJob` refuses the same roles, except the accountant, who may export.
- A manager whose role lost the entity's own create permission (`mdm.product.create`, `mdm.supplier.create`, `mdm.location.create`) gets 403 on apply, and nothing is written.
- A location file that writes branch ACC, where the manager holds no grant, gets 403 on apply. Its DDW row is not written either.

**Products:**
- The dry run reports exact row errors, writes no product and no product audit, and apply is refused. The errors are:
  - a LISTED live animal;
  - an unknown category;
  - a duplicate SKU;
  - a NON_STOCK product with a shelf life.
- The corrected file creates 3 products, with 3 `CREATE` audits and 3 `mdm.ProductCreated` events. The tracking, pack weight `15.000` and the tax category inherited from the category are all asserted.
- A change by SKU is applied. A change to the stock policy or a unit is refused, and so is a barcode another product holds.

**Suppliers:**
- The dry run reports four row errors and writes nothing:
  - a phone used twice in the file;
  - a phone another supplier holds;
  - an unknown category;
  - an unknown number.
- The corrected file registers one supplier and changes another's categories.

**Locations:**
- The dry run reports five row errors and writes nothing:
  - an unknown branch;
  - an unknown parent;
  - a cold room without temperatures (two errors, one each for `tempMinC` and `tempMaxC`);
  - a virtual location.
- A site, a pen and a cold room under it, created in one file, apply along with a change to an existing location.

**Price list entries:**
- The dry run reports five row errors and writes no entry:
  - a price typed as `850.00`;
  - a floor above list;
  - an unknown grade;
  - a list with no draft;
  - a duplicate entry.
- Apply writes the exact pesewas into the draft.
- An import against a version pending approval is a row error.
- The owner approves the version.
- A second draft has one entry replaced and one added, and the active version is unchanged to the pesewa.

**Exports:** every sheet exports with a fresh step-up, with an `EXPORT` audit event whose `rowCount` equals the live row count.
- Locations leave out virtual ones.
- Price list entries come from the active version only.

## Security review (hakorem-security-review)

The full finding is in PR #18. All items in `SECURE_CODING_STANDARDS.md` passed:
- **Authorisation:** authorised in the handler, plus the entity's permission, plus branch scope.
- **SQL:** parameterised lookups.
- **Money:** pesewas never pass through a float.
- **Privacy:** messages never echo personal values, and there is no TIN column.
- **Approval:** imported prices still need maker-checker approval.

Abuse case 9 is unchanged, and there is no new abuse path.

## Notes for the frontend track

- **Templates:** each sheet's export is its import template. The columns are in the `createImportJob` description.
- **Price imports:** draft a version first, import, then submit it for approval. Show a row error on `priceList` as "draft a version first".
- **Money:** prices in the sheet are pesewas. Label the template's columns so.

## Next session

B5. The opener is in `docs/prompts/session-openers.md`, section "B5 — Inventory and the stock movement ledger" (unchanged):

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

## CI

The runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`0b3c2c3`** (the last code and docs commit before this report): push run `43684691365` **success**; pull_request run `43684713004` **success** (the jobs include the contract versioning check against the base branch, the production image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.
