# B06m: the master data contract requests CR-009 to CR-011

Date: 2026-11-15 · Branch `b06m-master-data-requests`, from `main` (`8c9a862`) · Pull request #36 · Status: **gate passed.**
- `previewPriceListVersion` compares a draft with the version in force, line by line by the pricing engine's identity.
- The price list examples agree with one another.
- CR-011 is answered in the contract.
- **B06 continued** (`b06b-livestock-packs`) is next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-156 | **How the preview reads CR-009**, each time the most conservative reading.<br>- **Which versions:** DRAFT and PENDING_APPROVAL only. ACTIVE, SUPERSEDED and REJECTED answer 422 `INVALID_STATE_TRANSITION`, with the status in `details[].code`.<br>- **Compared with:** the ACTIVE version of the same list in force at `comparedAt`. That is the later of the version's `validFrom` and now (ADR-0036 decision 3: activation never starts a version before its approval). If nothing is in force, every line is ADDED.<br>- **Identity:** product, grade, band and quantity break. A line is CHANGED when the basis, the list, floor or ceiling price, or quote-only differs.<br>- **Order and pages:** lines come in identity order. `counts` covers the whole comparison. A cursor is bound to the draft's lock and to the version compared with; once either changes, the cursor answers 400 `INVALID_CURSOR`.<br>- **Scope:** `mdm.price_list.read` at the version's branch, as the opener asked. This is narrower than `getPriceListVersion`: a reader granted only at a second branch cannot preview an all-branch list.<br>- **Writes:** none, and nothing is audited.<br>- **Declined:** the optional draft-priced `resolvePrices` (BL-053). | Owner |
| A-157 | **CR-011, units of measure.**<br>- Units are a fixed lookup seeded by migration, with no write operation. No unit carries a conversion.<br>- `mdm.product_uom_conversion` was never migrated. FR-MDM-003's alternative units are unbuilt: B04d continued deferred them to B5, and B5 did not take them.<br>- **How things are held today:** a crate of 30 eggs is a product counted in `CRATE`. A meat pack is held and priced by the kilogram; `nominalPackKg` is an estimate, never a factor.<br>- **Owner:** **B9a**, the first phase whose table records a quantity with its own unit (`ord.order_line.uom`). B9a builds the conversions in MDM before an order line may carry another unit, or reports that none needs one so the owner can park them. Recorded in ADR-0026 Amendments and the B9a opener. | Owner |

**Needs the owner's approval:**
- **A-157 gives B9a new scope.** B9a has to build the conversions, or explain why no order line needs one. Without an owner they would be declined again, which is what happened to CR-009 to CR-011.
- **A-156's branch scope:** the preview is narrower than the other price list reads.
- **Nothing else:** no new dependency, no migration, no new ADR, no new port or published function. ADR-0047 and ADR-0051 are not touched.

I found no ADR conflict:
- ADR-0004's identity and ADR-0036's activation rule are what the comparison is built on.
- Caught database errors are untouched: the new code catches none.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B06m, the master data contract requests CR-009 to CR-011 (`b06m-master-data-requests`, from `main`).
2. **Scope:** `previewPriceListVersion` (read only, test-first), the price list example fix, and the CR-011 answer. Conversions are not built.
3. **Gate:** the preview answers cursor pages by the engine's identity, with four kinds and `counts`, exact on a seeded list with one line of each kind, and refuses the wrong role. The examples agree and show a change. CR-011 is answered.

## Contract changes

**Version 1.23.0, minor. No existing schema, field, parameter or response shape changed.** The versioning check against `main` passes.

- **New operation, from code:** `previewPriceListVersion`. That makes 207 operations from code, 404 planned and 611 published.
- **New schemas:** `PriceListPreviewPage`, `PriceListPreviewLine`, `PriceListPreviewCounts` and `PriceListPreviewKind`.
- **Examples (CR-010):** the base list's `activeVersion` is version 4 and its `draftVersionId` is version 5, in every price list example.
  - Other lists no longer reuse the base list's version ids.
  - `createPriceList` and `archivePriceList` answer the list their request names.
  - The versions page loses a row numbered 0 and gets plausible creation and activation times.
  - Entry counts and lock versions follow the draft's life.
  - `listPriceListEntries` has two named examples, `activeVersion4` (served by default) and `draftVersion5`. Their differences are exactly the preview example's: 3 added, 2 changed, 1 removed, 33 unchanged.
- **Descriptions (CR-011):** `Uom`, `Product.baseUom`, `Product.saleUom` and `Product.nominalPackKg` now say how units and packs are held.
- **Changelog:** the 1.23.0 entry and the cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md`.
- **Checks:** Redocly lint is clean. `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| MDM domain, 100 percent (pricing gate) | `domain/pricing/price-list-preview.ts`:<br>- `entryIdentity`: product, grade, band, and the quantity break read exactly (`5`, `5.0` and `5.000` are one break); a missing grade or band sorts first.<br>- `comparePriceListVersions`: the four kinds and their counts. It refuses two entries with one identity, which the database already forbids.<br>- `linesAfter`, `previewInstant`, `previewRefusal`. |
| MDM application | `PriceListAdmin.previewVersion`:<br>- authorises first, at the version's branch;<br>- then 404, then the status refusal;<br>- the version in force at `comparedAt`;<br>- both versions' entries read in one statement (one snapshot, read committed);<br>- the cursor bound to `(versionId, version, comparedWith)`. |
| MDM infrastructure | `PgPriceListStore.entryRowsOf` and `activeVersionAt`. The entry SELECT is now shared with `entryRows`. |
| Interface | The `GET price-list-versions/:id/preview` route and the `previewPriceListVersion.yaml` fragment. Eleven price list fragments had their examples corrected. |
| Docs | A-156, A-157; BL-053, BL-054; `docs/API.md` (the pricing section, and the units line under master data); `docs/data-model/mdm.md` (units, and the conversion table marked as not built); the SRS trace for FR-MDM-015; ADR-0026 Amendments; the openers (the B06m row marked built, a line added to the B9a opener). |

**Seed:** unchanged.
- The gate test arranges its own list with one line of each kind.
- A seeded draft would block a manager from drafting that list on a fresh setup (there is one open version per list), so none was added.

## Contract requests

The frontend's `main` lists CR-001 to CR-018.

- **CR-009: implemented**, as `previewPriceListVersion`, exactly the requested shape: `kind`, `current`, `proposed`, `counts` and the summary compared against (`comparedWith`), with `comparedAt` added.
  - **Declined, the optional part:** `resolvePrices` with a `priceListVersionId` is BL-053. The preview already shows every changed price, and pricing from a version not in force would be a second path through the engine, under its 100 percent gate, for a screen that does not exist yet.
- **CR-010: implemented.** The examples agree (see Contract changes). The mock shows a preview with a change in `previewPriceListVersion`'s example, and in `listPriceListEntries` through `Prefer: example=draftVersion5`.
- **CR-011: answered.**
  - Units are seeded only, so the units screen stays read only.
  - No conversion exists today. A crate of 30 eggs is a product counted in CRATE. A meat pack is held and priced by the kilogram, with `nominalPackKg` as an estimate.
  - FR-MDM-003's conversions are not built. B9a owns them (A-157).
- **CR-001 to CR-004, CR-006 to CR-008 and CR-012 to CR-018:** answered in earlier sessions. Nothing new for this phase.
- **CR-005:** a standing decline, as before.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 (the back office) and the database. I ran the skill's minimum groups.
- **Authorisation:** deny by default in the handler, scoped to the version's branch.
  - Wrong-role tests: Cashier, Storekeeper, Farm hand, Driver and Investor all get 403, and so does a Sales user granted at another branch.
  - The handler walk covers the new route and refuses a user with no grant.
- **Input:** strict zod schemas on the path and the query. SQL is parameterised (`ANY($1::uuid[])`). Cursors are signed and bound.
- **Data:** prices are INTERNAL. No personal data, no cost, no writes.
- **Not applicable:** uploads, exports, payments, webhooks.

## Deferred

- **To B9a:** FR-MDM-003's unit conversions (A-157).
- **Backlog:** BL-053 (pricing a basket from a draft), BL-054 (a `kind` filter on the preview).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **779 passed**. New: `mdm/domain/pricing/price-list-preview.spec.ts` (12). |
| Integration | **767 passed**. New: `mdm/price-list-preview.integration.spec.ts` (9). The handler walk lists the new route. Unit and integration together under coverage: **1,546 passed**. |
| Coverage, merged | Statements 94.36 percent, branches 85.02 percent (gate 80). Every 100 percent gate holds; `price-list-preview.ts` sits under `src/modules/mdm/domain/pricing/**` and is at 100 on all four measures. |
| Contract | **59 passed**. New: a `PriceListPreviewPage` shape check in `b4/pricing.contract.spec.ts`. The drift test now counts 611 published operations, 404 of them planned. Every price list example also validates against its schema (an ad hoc check, not committed). |
| Lint (boundaries, schema names), type check, Redocly | Clean |
| End to end | Runs in CI |

**Test first:**
- The domain test was written first and ran red: the module did not exist.
- The integration test, which includes the wrong-role refusals, was written before the route and ran red: 9 of 9 failed.
- I saw no red run other than these intended ones.

## Gate

**Passed.** I proved it by running `test/integration/mdm/price-list-preview.integration.spec.ts` on a list arranged through the API.
- **Nothing in force:** version 1 previews with every line ADDED (`added 3`) and `comparedWith` null.
- **One line of each kind:** version 2, drafted after version 1 was approved, gives exactly 1 ADDED, 1 CHANGED, 1 REMOVED and 1 UNCHANGED:
  - CHANGED: goat grade A, 20 to 25 kg, from 90,000 to 95,000 pesewas (ceiling from 100,000 to 105,000).
  - ADDED: a 10-head break at 85,000.
  - REMOVED: eggs at 6,000.
  - UNCHANGED: the 25 to 45 kg goat at 140,000.
- The draft is compared with version 1 at its future `validFrom`. Pages of 3 join to the whole comparison with the same counts on each page. A stale cursor gets 400.
- A pending version can be previewed and nothing is audited; an ACTIVE version gets 422.
- Every wrong role, and a reader at another branch, gets 403.
- The examples agree, checked against their schemas. CR-011 is answered in the contract and in this report.

## Notes for the frontend track

- **The price list version screen can drop its five-page comparison and its 500-line limit.** Read `previewPriceListVersion` in pages and show `counts` from the first page.
- **If a page answers 400 `INVALID_CURSOR`,** start again without the cursor: the draft changed, or another version came into force.
- **The mock:** `Prefer: example=draftVersion5` on `listPriceListEntries` gives the draft's entries. The preview's example is the comparison of the two versions.
- **Units stay read only,** and no screen should offer a conversion.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`afeadd5`** (`afeadd5a35a85b012cc697bc8a10005485f384b1`, the last commit before this report): push run `43720759659` **success**; pull_request run `43720781658` **success**. The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's commit:** a commit cannot name its own runs, so they are named in the session's closing message.

## Next session

B06 continued. The opener is in `docs/prompts/session-openers.md`, section "B06 continued — Livestock management, packs and labels":

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
