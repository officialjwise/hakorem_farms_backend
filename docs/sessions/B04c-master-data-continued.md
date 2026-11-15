# B04 continued — The tax calculator and the tax API

Date: 2026-11-15 · Branch `b04c-master-data-continued`, from `main` at `c802974` · Pull request [#8](https://github.com/officialjwise/hakorem_farms_backend/pull/8) · Status: **gate passed for this session's part**. B04 continued is split (A-097): this session built the tax sub-domain end to end; B04d and B04e build the rest, and B04 continued's gate as a whole passes when theirs do.

This report covers two sittings. The first ran on the owner's laptop and was killed mid-gate, leaving the tax API slice pushed but unverified in two `wip` commits. The second, on a clean VM, ran the full gate, rewrote the history and wrote this report.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-095 | Seeded tax permissions: Owner and Accountant read, calculate and manage; only the Owner approves a scheme version (step-up, never their own); Manager and Sales read and calculate; Cashier calculates; Storekeeper, Farm Hand and Driver hold none. `mdm.tax.manage` needs step-up everywhere | Owner |
| A-096 | `tax.registered` is read as at midnight at the start of the tax date (Africa/Accra is UTC); absent means registered | Accountant |
| A-097 | B04 continued split again: tax here, promotions and the rest of master data in B04d, the A-087 IAM items in B04e; B5 opens after B04e | Owner |
| A-098 | The owner's list "B5 to B13, in order" did not name B04d and B04e. They are read as the next phases, because the amended schedule puts them before B5 and B5's opener reads B04e's report | Owner |

## The six earlier failures, judged fresh

The first sitting recorded six failures. It judged three as real and two as load timeouts; the sixth went unclassified. Nothing in the repository says which tests they were, so I could not re-run them by name. On the clean VM (4 vCPU, 15 GB, Docker 29.9, Testcontainers PostgreSQL 17.6, Redis 7.4.6, Versity 1.10.0) **none of them came back**. The integration suite passed 259 of 259 on four consecutive runs, and the merged coverage run passed 601 of 601. So I have no evidence of any real defect in the slice as pushed. If three failures were real, they were fixed in the work-in-progress commits before the laptop died. I can't confirm that either way. Treat the earlier classification as unverified rather than inherited.

## Built

| Area | What |
| --- | --- |
| Domain (`982da52`, earlier) | `domain/tax/tax-calculator.ts`: the tax-exclusive line, the tax-inclusive split with `allocate` (net first, then levies in calculation order), compounding bases, one half-up rounding per levy, totals from line integers. `domain/tax/tax-scheme.ts`: the matrix, activation window and the version in force. `defineTaxWindow` is removed (`5b06a8a`): a draft has no end date, and activation sets one |
| Database | `0013` the `TAX_SCHEME_VERSION` document type; `0014` levies (VAT, NHIL, GETFund), categories, versions (one open, no overlapping ACTIVE windows, lifecycle guard, ACTIVE only with an approval), cells (rate only on STANDARD, bases only earlier levies of the same category, frozen outside DRAFT, emptied only by a definer function, an incomplete matrix refused at submission); `0015` permissions, grants and the approval policy |
| Application | `TaxAdmin`: levies, categories, draft (optionally copied), replace the whole matrix with optimistic locking, submit (always 202), approval handler that activates in the approval's transaction. `TaxService.calculate` and `calculateIn` (for selling modules, in their transaction). Audit on every write; `mdm.TaxSchemeVersionActivated` in the outbox. `Settings.booleanAt` reads a setting at an instant, uncached |
| Interface | Ten operations (34 from code in all): `listTaxLevies`, `createTaxLevy`, `listTaxCategories`, `createTaxCategory`, `listTaxSchemeVersions`, `createTaxSchemeVersion`, `getTaxSchemeVersion`, `replaceTaxSchemeCells`, `submitTaxSchemeVersion`, `calculateTax`. The handover said eleven operation files; there are ten |

## History rewritten

The two `wip(mdm)` commits and the docs commit between them became five commits, each one concern. Each was checked as follows:

- `5b06a8a refactor(mdm)`: dropped the unused `defineTaxWindow`.
- `e618350 feat(db)`: migrations 0013 and 0014 with their schema tests. Checked alone in a worktree: integration passed 236 of 236.
- `00ed75b feat(mdm)`: the API slice, with 0015 and the contract changelog. 0015 travels with the operations because, committed with the schema, the CR-007 step-up consistency test failed (permissions seeded with no operation checking them). That failure is the reason for the split, not a defect.
- `16c2aea docs`: ADR-0039, the data model and the coverage gate.
- `5c76d66 docs`: the split and A-095 to A-098.

Apart from two doc corrections, the final tree is identical to the old `wip` head `1660261`. The first correction is to the ADR-0026 amendment, which had said the first sitting "stopped at a green commit" when it was in fact interrupted mid-gate. The second adds A-098.

## Decisions

- **ADR-0039** (proposed, from the first sitting): business-date windows; `validTo` is the first day no longer covered; a late approval starts on the day of approval; one open version; step-up on every tax write; registration read on the tax date.

## Contract changes

**1.5.0. Additive, with one loud behaviour change** (`docs/CONTRACT_CHANGELOG.md`). Ten operations answer from the real API. **LOUD: `createTaxSchemeVersion` and `replaceTaxSchemeCells` now require step-up.** Nothing called them before. Two new error codes: `TAX_CELL_INVALID` and `TAX_SCHEME_NOT_IN_FORCE`. `submitTaxSchemeVersion` always answers 202.

## Contract requests

`../frontend/docs/CONTRACT_REQUESTS.md` is not reachable from this environment: the frontend repository is not cloned beside this one. No request was implemented or declined this session. CR-003 (unit display precision) and CR-004 point 3 stay scheduled for B04d and B04e as before.

## Deferred

- To **B04d**: promotions and coupons (FR-MDM-018), the rest of master data, CR-003, and the MDM seed through services, including tax scheme version 1 drafted by the Accountant and approved by the Owner.
- To **B04e**: the A-087 IAM items, CR-004 point 3 and the IAM seed through services.

## Tests (clean VM, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 342 passed |
| Integration | 259 passed, four runs out of four |
| Contract | 30 passed; `pnpm contract:generate` unchanged (34 from code, 566 planned); Redocly lint clean |
| Coverage, merged | 601 passed; 91.85 percent statements, 83.21 percent branches (gate 80). `src/modules/mdm/domain/tax/**`: 100 percent on all four measures, 68 of 68 branches, gated by `fullCoverage` |
| Lint, type check | Clean |
| End to end | Not run locally; CI's fresh-clone job runs it (below) |

## Gate

**The tax calculator at 100 percent coverage, with exact pesewa values: passed.** These cases are in `tax-calculator.spec.ts`, and the API repeats them in `tax.integration.spec.ts`:

- **Tax-exclusive:** a net of 10,000 gives VAT 1,500, NHIL 250 and GETFund 250, gross 12,000. Half-pesewa edges: 20 gives 1, 19 gives 0, 21 gives 1.
- **Tax-inclusive:** GHS 459.00 splits into 382.50 net, 57.38 VAT, 9.56 NHIL and 9.56 GETFund, summing to 459.00 exactly. 10,000 splits into 8,334, 1,250, 208 and 208, where rounding each part on its own would lose a pesewa (9,999).
- **Zero-rated:** a 65,000 goat line has three `ZERO_RATED` rows at 0, reclaimable, and gross equals net.
- **Exempt:** a 4,500 line has three `EXEMPT` rows at 0, not reclaimable, and gross equals net.
- **Also covered:** a compounding levy (VAT 1,575 on a base of 10,500), an incomplete matrix refused (`TAX_MATRIX_INCOMPLETE` naming `EGGS/NHIL`), and maker and checker never the same person.

**CI:** see the pull request. The runs that exist for the head commit, with ids and events, are listed in the pull request comment and in the session's closing message, as CLAUDE.md step 6 requires.

## Security review (the parts this change touches)

- Authorisation in every handler: `mdm.tax.read`, `.manage`, `.calculate` and `.approve`. Wrong-role refusals are tested for the cashier, driver, manager (read but not manage) and accountant (not approve). The handler walk covers all 34 routes.
- Maker-checker: the Owner is refused as checker of their own submission.
- Step-up on every tax write.
- Parameterised SQL only.
- The one definer function has a fixed `search_path` and empties only a draft.

## Next session

B04d. The opener is in `docs/prompts/session-openers.md`, section "B4 continued (d)":

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
