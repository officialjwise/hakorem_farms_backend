# B04e continued 4: MDM imports and exports

Date: 2026-11-15 · Branch `b04e5-mdm-imports-exports`, from `b04e4-product-images-imports` · Pull request #17 (stacked on #16, not merged) · Status: **phase split** (A-129). The gate passed for the import and export mechanism and the customer sheet. The product, supplier, location and price list entry sheets move to **B04e continued 5**. The opening stock sheet moves to **B5**.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-128 | **Who can do what:**<br>- The Owner and Manager import (`mdm.import.read`, `.create`, `.apply`).<br>- The Owner, Manager and Accountant export (`mdm.export.create`). The Accountant also reads the jobs.<br>- Applying also needs the entity's own create or update permission. Exporting also needs the entity's read permission.<br>**Step-up:** every export needs it, as the contract's `x-requires-step-up` and ADR-0016 say.<br>**Bulk threshold:** 100 rows, per FR-MDM-020 and SEC-009. Above it, the `EXPORT` audit event has `bulk: true`, for B12's `BULK_EXPORT`. SA-02's 1,000 is left to RPT and the owner.<br>**Dry run:**<br>- Runs inside `createImportJob`, at most 5,000 records.<br>- The job is `VALIDATED` with its row errors, or `FAILED` with its errors on row 1. `UPLOADED` is never stored.<br>- Messages never echo a personal value.<br>**Apply:**<br>- It re-checks the rows in its own transaction.<br>- If a row has broken since the dry run, nothing is written, the new errors join the job, and the answer is 422 `IMPORT_NOT_VALIDATED`.<br>**Customer sheet:**<br>- Columns `customerNo`, `kind`, `name`, `phone`, `email`, `tier`.<br>- A blank number creates a customer. A number changes that customer, and a blank cell changes nothing.<br>- The kind never changes.<br>- No TIN, address or consent column.<br>- The export leaves out anonymised customers.<br>**Export files:**<br>- XLSX with text cells, or CSV with a byte order mark and CRLF, formula cells prefixed with `'`.<br>- Stored as a private `EXPORT` file (a new use, no upload accepted), PENDING like any file.<br>- The link comes from `createFileSignedUrl` once the file is scanned. It is not in the response, so ADR-0044 holds.<br>**Job branch:** the head office.<br>**OPENING_STOCK waits for B5:** stock is INV's, and MDM sits below it. Until then, it and the other unbuilt entities answer 422 `IMPORT_ENTITY_NOT_AVAILABLE` | Owner |
| A-129 | **Split:**<br>- Built here: the mechanism and the customer sheet.<br>- B04e continued 5 (`b04e6-mdm-import-sheets`): the product, supplier, location and price list entry sheets.<br>- B5: opening stock | Owner |

**Needs the owner's approval: nothing new.** No dependency was added. ADR-0046 is **Proposed**: it chooses a bounded codec on Node's own `zlib` over `exceljs` 4.4.0, SheetJS `xlsx` 0.18.5 and `read-excel-file` 9.3.17. Nothing was added to pnpm's allowed builds, and the Docker image is unchanged.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B04e continued 4.
2. **Scope:** MDM's imports and exports (FR-MDM-019, FR-MDM-020, SEC-009), over an `IMPORT` file read through the platform FileStore.
3. **Gate:** the seven operations run as follows, and every write refuses the wrong role:
   - a dry run writes nothing;
   - apply writes all rows or none, in one transaction;
   - an export is audited with its row count, needs step-up above the bulk threshold, and is delivered by a signed, expiring link.

## Contract changes

**1.14.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Seven operations are now served by code: 138 from code, 462 planned.

- **`ImportJob`:** gains `rowsToCreate` and `rowsToUpdate`, required in responses only (ADR-0038). This is the FR-MDM-019 preview.
- **`FilePurpose`:** gains `EXPORT`.
- **New 422 code `IMPORT_ENTITY_NOT_AVAILABLE`.**
- **Descriptions, `x-error-codes` and examples:** state the rules.

No field was removed, renamed or retyped. `contract versioning: ok` against the base branch. Redocly lint is clean, and `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Platform | `src/platform/spreadsheet/`:<br>- `zip.ts`: bounded: 200 parts, 50 MB a part, 100 MB in all, and the inflater stops past the limit.<br>- `xlsx.ts`: the first sheet's text cells. No DTD and no entity expansion; formulas are never evaluated.<br>- `csv.ts`.<br>- `spreadsheet.ts`: `readSheet` and `writeSheet`, with CSV formula neutralisation.<br>`FileStore.content` reads only CLEAN files |
| DOC | `EXPORT` in `file-use.ts`: CONFIDENTIAL, empty allow-list |
| MDM domain | `domain/imports.ts`: header matching, records, the apply and cancel rules, the bulk threshold, and customer row checks with their duplicates |
| MDM application | `MdmImports`: list, get, errors, create (dry run), apply, cancel, export.<br>`EntitySheet` and `CustomerSheet`.<br>`PartiesAdmin.createCustomerIn` and `updateCustomerIn`, refactored out of the HTTP handlers, plus `phoneHolder` |
| Infrastructure and interface | `PgImportStore`, `ImportsController`, the seven fragments moved out of the planned file |
| Migrations | `0038`: `EXPORT` purpose.<br>`0039`: `mdm.import_job` (DOCUMENT, HK009 guard, frozen once posted) and `mdm.import_job_error` (WORK).<br>`0040`: permissions.<br>`0041`: grants.<br>Rollback is proved by the migration-runner test |
| Docs | ADR-0046 and its index entry; A-128 and A-129; ADR-0026 Amendments; the changelog; API.md section 16 and the error row; the mdm and platform dictionaries; the platform and MDM cards; THREAT_MODEL row 9; the openers (a new section, B04e continued 5; B5 builds the opening stock sheet) |

## Decisions

- **ADR-0046 (proposed):** no spreadsheet library. Each entity's sheet applies rows through the entity's own service. Exports are scanned `EXPORT` files.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15; unchanged)

- **CR-001:** not this phase: stock is B5.
- **CR-003:** point 2 is B5.
- **CR-004, CR-006, CR-007, CR-008:** answered earlier. `createExportJob` keeps `x-requires-step-up: true`.
- **CR-005:** declined again: one scripted pass when the frontend resumes.

## Deferred

- **To B04e continued 5:** the product, supplier, location and price list entry sheets.
- **To B5:** the `OPENING_STOCK` sheet, through a port MDM defines and INV implements, which needs an ADR.
- **To B12:** projecting `EXPORT` events with `bulk` as `BULK_EXPORT`, and `exportsByUser`.
- **Seed:** nothing seeded. Import jobs are records of actions; the seeded farm has none.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 589 passed. New: `spreadsheet.spec.ts` and `imports.spec.ts`; `file-use.spec.ts` extended |
| Integration | 513 passed. New: `mdm/import-jobs.integration.spec.ts` (12) and `mdm/master-data-export.integration.spec.ts` (4). The handler walk covers 138 routes |
| Coverage, merged | 1,102 passed. Statements 93.59 percent, branches 85.23 percent (gate 80). Every 100 percent gate holds |
| Contract | 45 passed. New: `b4/imports.contract.spec.ts` |
| Lint, type check | Clean |
| End to end | `product-slice.e2e.spec.ts` checks that an unscanned import is 422 `FILE_NOT_CLEAN`, that the cashier is refused imports and exports, and that the job list works. It runs in CI; I did not run it on this machine |

## Gate

**Passed, for the mechanism and the customer sheet.** I proved it by running the two integration specs against real PostgreSQL and the S3 gateway. The scanner port answers CLEAN there; the real ClamAV is proved in `file-store.integration.spec.ts`.

- **FR-MDM-019, 200 rows with 3 bad:**
  - The dry run reports exactly 3 errors: rows 15, 89 and 153, with their columns and messages. It writes zero customers and zero customer audit events.
  - Apply is 422 `IMPORT_NOT_VALIDATED`.
  - The corrected file (XLSX) applies exactly 200 customers with 200 `CREATE` audits.
  - A replay returns the stored job. Both jobs and their errors stay readable.
- **All or none:** a phone taken between the dry run and the apply makes the apply write nothing, and the job shows the new row error.
- **FR-MDM-020 and SEC-009, 150 customers:**
  - Without step-up: 403 `STEP_UP_REQUIRED`.
  - With step-up: 202, and an `EXPORT` audit event by the manager with `rowCount: 150` and `bulk: true`.
  - The file is not linked before it is scanned (`FILE_NOT_CLEAN`). After the scan, the link expires exactly 300 seconds after issue and is logged. It downloads 151 rows, with CSV formula cells neutralised.
- **Wrong roles:** every write refuses the cashier, sales, driver, farm hand, storekeeper and a user with no grant, each refusal audited. The import writes also refuse the accountant. A manager without `mdm.customer.create` cannot apply rows that create customers.
- **Database:** HK009 refuses applying a job with errors, moving a status back and changing what a job is about. HK008 refuses an import of a PENDING file. HK004 refuses a change to a cancelled job.

**Not part of this gate (A-129):** the other four sheets, and opening stock.

## Security review (hakorem-security-review)

- **Boundaries:** TB2 (back office), the file store, the database.
- **SECURE_CODING_STANDARDS, item by item:** all passed. The details are in PR #17:
  - authorise in the handler, plus the entity's own permissions;
  - strict schemas;
  - parameterised SQL;
  - idempotency;
  - only CLEAN files are read;
  - no storage call inside a transaction;
  - audit in the transaction.
- **Abuse case 9:** step-up on every export, with the row count and bulk flag audited.

## Notes for the frontend track

- **Importing:** upload with `IMPORT`, poll `getFile` until `CLEAN`, call `createImportJob`, show the counts and `listImportErrors`, then `applyImportJob`.
- **Exporting:** ask for step-up first. Then poll `getFile` on the returned file until it is `CLEAN`, and call `createFileSignedUrl`.

## Next session

B04e continued 5. The opener is in `docs/prompts/session-openers.md`, section "B04e continued 5 — The remaining MDM import sheets":

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

## CI

The runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`ec97b07`** (the last code and docs commit before this report): push run `43682762401` **success**; pull_request run `43682787579` **success** (the jobs include the contract versioning check against the base branch, the production image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, since a commit cannot name its own runs.
