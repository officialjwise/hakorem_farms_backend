# B05x: the owner dashboard and its tiles, branch management and label data

Date: 2026-11-15 · Branch `b05x-dashboard-branches-labels`, from `main` (rebased on `43677ed`) · Pull request #32 · Status: **gate passed**. getOwnerDashboard answers in one request, four tiles are live, branch closing works with its refusals, branch and location reads stay within the grants, and label data answers. **B6** (`b06-livestock-processing`) is next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-149 | **How the dashboard reads FR-RPT-001 and NFR-023.**<br>- **Sources:** published views only. Stock value is the sum of the branches' cost pools (`inv.pub_stock_value`). Animals are serialised units with positive on hand at a physical location, by species (`inv.pub_stock_on_hand` with `mdm.pub_product`); broilers kept as a batch are not counted. Low stock is the distinct products at or below a reorder point (`inv.pub_reorder_level`). Purchases are posted receipts of kind `PURCHASE`, by the Accra date the goods were received (`inv.pub_goods_receipt`).<br>- **Connection:** the application connection, at read committed. B12 moves the reads to `hk_report`; a test proves every figure answers as `hk_report`.<br>- **Scope:** the branch asked for, or every branch where the caller holds the permission for the whole branch. A grant at one location adds no branch.<br>- **Permissions:** `rpt.dashboard.owner` for the Owner only; `rpt.tile.read` for the Owner, Manager and Accountant.<br>- **Figures without a source:** null and listed in `pendingFigures`. Sales, the sales series and top movers wait for B9a; cash and receivables for B8; alerts and the exception count for B12.<br>- **Dates:** `date` is never later than today; `period` is `WEEK` (7 days, the default) or `MONTH` (30 days). A tile period is at most 92 days (`REPORT_PERIOD_INVALID`). | Owner |
| A-150 | **How a branch closes, and how branch and location reads are scoped.**<br>- **Closing:** through `updateBranch` with `status` (`CLOSED` or `ACTIVE`). There is no new operation.<br>- **Refusals:** `BRANCH_INVALID` names each reason: `FARM_BRANCH` (the first branch ever created), `LAST_ACTIVE_BRANCH` (the smoke-test branch does not count), `HOLDS_STOCK` and `OPEN_DOCUMENTS`. Reopening is always allowed.<br>- **Archiving a location:** refused with `RECORD_IN_USE` (`HOLDS_STOCK`, `OPEN_DOCUMENTS`). This closes A-111.<br>- **Reads:** lists and single reads answer only within the grants. A location grant reaches that one location only.<br>- **Not yet:** a closed branch does not stop new documents (BL-047). | Owner |
| A-151 | **What a label prints.**<br>- **Symbology:** `CODE_128` everywhere.<br>- **Product label:** encodes the product's barcode, or its SKU when it has none.<br>- **Lot or animal label:** encodes `<SKU>/<batch or tag>`. A lot shows its on-hand weight, summed exactly; an animal its last recorded weight.<br>- **Scope:** a lot is scoped like `getStockUnit`, at its branch with no location. So a location-scoped Storekeeper cannot read a lot's label.<br>- Nothing is rendered. | Owner |
| A-152 | **The frontend requests.** CR-013 to CR-018 were read from the frontend's unmerged branch `busy-ritchie`, at the owner's request relayed by the parent session, and answered as listed under "Contract requests". | Owner, frontend track |

**Needs the owner's approval:**
- **ADR-0051 (proposed):** MDM defines a port, `LocationUsageCheck` (`LocationUsageRegistry.register`). INV implements it from its own schema and its published view `inv.pub_stock_on_hand`. Closing a branch and archiving a location ask the port.
- **No new dependency.** ADR-0050 is untouched; #31 marked it Accepted.

I found no ADR conflict:
- ADR-0011 and ADR-0023 hold: RPT selects only `pub_*` views.
- ADR-0047 is not widened: no new published function.
- MDM still imports nothing above it.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05x, inserted by the owner between B5 and B6.
2. **Scope:** the owner dashboard in one request and one operation per tile; closing and reopening a branch with its refusals; branch and location lists within the grants; label data for lots and products. Added the same day by the owner: realistic examples, CR-018's report codes in the contract, and CR-013 to CR-017.
3. **Gate:**
   - getOwnerDashboard answers in one request, its figures without a source null and listed.
   - Every tile with data answers exactly on the seeded farm. The other tiles are in the contract only, and the openers that build them name them.
   - A branch closes, with its refusals, and lists stay within the grants.
   - Label data answers from the real API.
   - Every operation refuses the wrong role.

## Contract changes

**Version 1.21.0, minor. LOUD: the planned `OwnerDashboard` figures without a source are now nullable.** `getOwnerDashboard` was planned and never implemented, so no client has read a real answer from it. A figure is null exactly while `pendingFigures` lists it.
- The versioning check against `main` passes.
- The cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md` covers 1.21.0 and opens with this change.

**Operations.** Seven now run in code: 194 from code, 416 planned, 610 published.
- RPT: `getOwnerDashboard`, `getStockValueTile`, `getAnimalsOnHandTile`, `getLowStockTile` and `getPurchasesSeries`.
- Labels: `getProductLabel` and `getStockUnitLabel`.
- Four new planned tiles, served only by the mock: `getSalesTodayTile`, `getSalesSeries`, `getCashPositionTile` and `getReceivablesTile`.

**Dashboard shape.**
- New required response properties: `branchIds`, `purchasesTodayPesewas`, `purchasesYesterdayPesewas`, `animalsOnHand`, `lowStockCount`, `purchases`, `salesSeries` (nullable) and `pendingFigures`.
- `branchId` may now be null, when the dashboard covers several branches.
- New query parameter `period`: `WEEK` or `MONTH`.

**Changed behaviour, same shape.**
- `updateBranch` refuses to close a branch with `BRANCH_INVALID`; each of the four reasons has a named example.
- `archiveLocation` refuses with `HOLDS_STOCK` or `OPEN_DOCUMENTS`.
- `listBranches`, `getBranch`, `listLocations` and `getLocation` answer only within the grants.

**New error codes:** `BRANCH_INVALID` and `REPORT_PERIOD_INVALID`.

**Reports (CR-018), contract only:**
- `listReportDefinitions` gains `SALES_SUMMARY` and `PURCHASES`, and says which parameters each report takes.
- `runReport` has one named example per report code, in the seeded farm's terms.

Redocly lint is clean and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0067:** `mdm.pub_product`, and `USAGE` on `mdm` for `hk_report`.<br>**0068:** `inv.pub_goods_receipt`.<br>**0069, 0070:** `rpt.dashboard.owner` and `rpt.tile.read`, with their grants |
| RPT (new module, layer 11) | `domain/dashboard.ts`: periods, the dashboard date and week, pending figures, species, branches. `domain/series.ts`: daily series in pesewas. Both under a 100 percent gate.<br>`Dashboards` (application) authorises in the handler and narrows to the grants.<br>`PgDashboardStore` reads published views only.<br>`DashboardController`, five fragments.<br>Wired in `app.module.ts`. |
| MDM | `planBranchStatus` and the usage rules in `planLocationArchive` (domain, 100 percent).<br>The `LocationUsageRegistry` port.<br>`LocationsAdmin`: the status judgement, and reads scoped to the grants.<br>`BranchInvalidError`.<br>`ProductCatalogue.getLabel` and `getProductLabel`. |
| INV | `InventoryLocationUsage` and `PgInventoryUsageStore`, registered on start.<br>`domain/label.ts` (100 percent).<br>`StockQueries.getStockUnitLabel` and its route. |
| Docs | ADR-0051 and the decision index; A-149 to A-152, with A-111 closed; BL-047 to BL-050; CONTRACT_CHANGELOG; API.md (RPT, MDM, INV, 10.3); the MDM, INV and RPT cards and section 6; `data-model/inv.md` and `mdm.md`; ADR-0026 Amendments; the openers for B6, B8, B9a, B9b and B12. |

The seed is unchanged: Kasoa and KNUST are not seeded. Tests create Kasoa as a test record through the API.

## Contract requests

The frontend's `main` at the time of reading lists CR-001 to CR-008. All were answered earlier, CR-005 by its standing decline. CR-013 to CR-018 were read from the unmerged branch `busy-ritchie`, at the owner's request:
- **CR-013 (dashboard in one response): implemented in part.**
  - One call. Its `unavailable` list is `pendingFigures`, which also carries the source, reason and phase.
  - Built: `animalsOnHand`, `lowStockCount`, the purchases series, `purchasesTodayPesewas`, `purchasesYesterdayPesewas`, and `period` (`WEEK`, `MONTH`).
  - Not built: change arrows, stock health counts, stock by category, alert lists, near-expiry, invoices, payments and the payment method split (BL-050). Their sources do not exist yet, or their definitions are not given.
- **CR-014: answered by a description.** A location never moves to another branch.
- **CR-015: declined for this phase.** It filters INV lists, which is not branch management (BL-048).
- **CR-016: answered with label data instead.** The opener rules out rendering; a server PDF is BL-049.
- **CR-017: implemented.** `BRANCH_INVALID` with four named examples. There is no `BRANCH_HAS_OPEN_SHIFTS` yet: POS shifts are B9b's, and they will register through the usage port.
- **CR-018: implemented in the contract.** `runReport` is built in B12.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 back office, and the database.
- **Authorisation:** every handler calls `Authoriser.authorise`, deny by default.
  - Out-of-scope reads are refused with 403 and audited.
  - The handler walk covers the 7 new routes.
- **Least privilege:** dashboard queries touch only `pub_*` views. A test runs them as `hk_report` and shows that role is refused `inv.cost_pool` and `mdm.product`.
- **Input:** strict zod schemas refuse unknown parameters. Parameterised SQL only.
- **Data:** no personal data in the new views. Label data carries no cost.
- **New abuse path:** closing a branch could hide stock. It is refused while stock or open documents remain. A closed branch still accepts new documents (BL-047): an operational risk, not a money path, for the owner to decide.

## Deferred

- **To B8, B9a and B9b:** the dashboard figures and planned tiles named in their openers.
- **To B12:** alerts and `exceptionsToday`; the dashboard on `hk_report` with caching and its performance budget; `runReport` for every code.
- **To the next INV session:** CR-015 (BL-048) and closed-branch refusals (BL-047).
- **To B6:** pack labels, and weights with their source.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **742 passed** (new: `rpt/domain/dashboard.spec.ts` 12; `mdm/domain/locations.spec.ts` +7; `inv/domain/label.spec.ts` 3; `mdm/domain/label.spec.ts` 2) |
| Integration | **740 passed**. Unit and integration together, under coverage: **1,482 passed**. New:<br>- `rpt/dashboard.integration.spec.ts` (15)<br>- `mdm/branch-management.integration.spec.ts` (8)<br>- `inv/labels.integration.spec.ts` (5)<br>The handler walk now covers B05x. `parties-locations` was updated for scoped reads. |
| Coverage, merged | Statements 94.56 percent, branches 85.47 percent (gate 80). Every 100 percent gate holds, including the new ones on `rpt/domain`, `inv/domain/label.ts` and `mdm/domain/label.ts`. |
| Contract | **56 passed**, including the new `b5x` shapes. The versioning check against `main` passes. |
| Lint, type check, schema names, Redocly | Clean |
| End to end | Runs in CI |

**Test first:**
- `planBranchStatus` and the usage rules were written first and ran red (`planBranchStatus is not a function`).
- The branch suite was proven by removing the status check: 4 of 8 tests went red.
- The dashboard and label suites were written before they were run, but alongside their code, not run red first. That departs from the rule, recorded here. Their first run found one fault in a test (`branchId` is null) and none in the code.

## Gate

**Passed.**
- **getOwnerDashboard answers in one request**, its eleven figures without a source null and listed with source, reason and phase.
- **Every tile with data answers exactly on the seeded farm**, alone and inside the dashboard:
  - Stock value is 1,595,501 pesewas, equal to `listStockOnHand`'s total.
  - Animals are 4 goats and 2 sheep, equal to the tags the seed receives.
  - Low stock is 1 (the eggs: 30 crates against a reorder point of 30).
  - Purchases are 1,535,001 pesewas on 2026-11-10 from 4 receipts, the harvest left out, and 0 on every other day.
- **Tiles without data:** the four sales, cash and receivables tiles are on the mock only and answer 404. The B8, B9a and B9b openers name them.
- **Branches:**
  - Dodowa refuses to close (`FARM_BRANCH`, `HOLDS_STOCK`).
  - Kasoa refuses while a draft receipt names it (`OPEN_DOCUMENTS`), and again while stock stands there (`HOLDS_STOCK`). It then closes, is audited, and reopens.
  - Lists stay within the grants.
- **Labels:** the beef lot (45.000 kg, its expiry, `MEAT-BEEF-15KG/LOT-BEEF-2026-1110`), the goat G-0143, the egg lot and three products answer from the real API.
- **Every operation refuses the wrong role:**
  - The dashboard: Manager, Accountant, Storekeeper, Cashier, Sales, Driver and Farm hand.
  - The tiles: the last five of those.
  - Unit labels: Cashier, Sales, Driver, Farm hand, and a Storekeeper elsewhere.
  - Product labels: an Investor.
  - Branch closing: Accountant, Storekeeper, and a Manager at another branch.

## Notes for the frontend track

- **Dashboard:** wire `getOwnerDashboard` once. Show each figure listed in `pendingFigures` as "no data source yet", using its `reason`.
- **Branch switcher:** `listBranches` now lists only the branches the user may reach.
- **Closing a branch:** show the `details[].code` of a `BRANCH_INVALID` refusal.
- **Labels:** draw `barcode.payload` as Code 128, with `barcode.text` under it.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`66beadc`** (`66beadc8ac74df07de79a96711ca8c6b55ccac40`, the last commit before this report): push run `43712177429` **success**; pull_request run `43712198861` **success**. The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B6. The opener is in `docs/prompts/session-openers.md`, section "B6 — Livestock and processing":

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
