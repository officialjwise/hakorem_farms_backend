# B6: processing orders, cost allocation and yield standards (livestock and packs continue in B06 continued)

Date: 2026-11-15 · Branch `b06-livestock-processing`, from `main` (`8071197`) · Pull request #34 · Status: **gate passed; phase split** (A-154). A processing order consumes a goat and produces lots whose costs sum exactly to the input cost plus the direct processing cost, on the seeded farm, over the real API, and the database checks the sums again at commit. **B06 continued** (`b06b-livestock-packs`) is next: all of LIV, packs and labels, and the reversing order.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-153 | **How a processing order runs**, each the most conservative reading where the SRS, the data model and the planned contract differ.<br>- **Statuses:** `PLANNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED` (data model and contract; the SRS says DRAFT).<br>- **Nothing moves until completion.** The planned `startProcessingOrder` text said it consumed the inputs; FR-PRC-003 consumes at completion and FR-PRC-011 cancels an order in progress with no stock effect. Inputs are checked at create, start and completion and consumed only at completion; the description is corrected (LOUD in the changelog).<br>- **Inputs:** live animals (SERIAL units) at the processing location, any physical location that holds stock (the pens on the seeded farm). A carcass lot is refused (`INPUT_NOT_AN_ANIMAL`, BL-051). Until completion an input's `costPesewas` is its whole pool now.<br>- **Reference price:** the counter's (POS) list price per kilogram at the branch at completion, no customer, before promotions; none is `REFERENCE_PRICE_MISSING`.<br>- **Direct costs:** published as `prc.DirectCostIncurred` at completion, so a cancelled order leaves nothing in work in progress.<br>- **Yield:** per output product against the input product's standards when every input is one product; waste never judged.<br>- **Lots:** `PRC-<yymmdd>-<last 8 hex of the order id>-<line>`, produced on the Accra completion date, expiry recorded or from shelf life.<br>- **Permissions:** Owner, Manager, Storekeeper process and read; Owner, Manager manage standards; Accountant reads. **The Farm hand holds none** (an order shows cost, DC-11).<br>- **`orderNo`** null until numbering (B8). | Owner |
| A-154 | **The split.** B6 built the PRC sub-domain that carries the gate. All of LIV, PRC's packs and labels (`createPacks`, `listPacks`, `printPackLabels`) and the reversing order of FR-PRC-011 move to **B06 continued — Livestock management, packs and labels**, inserted before B7 (ADR-0026 Amendments, the openers file). | Owner |

**Needs the owner's approval:**
- **No new dependency.** Nothing was added to `package.json`; the allocation uses the kernel's `allocate`.
- **No new ADR, port or published function.** INV's new `StockUnits` interface is one the INV card already names; ADR-0047 and ADR-0051 are not widened.
- **A-153's Farm hand decision:** the requirements name the Farm hand beside the Storekeeper for processing; holding back the permission until the owner decides on cost visibility is the conservative choice.

I found no ADR conflict:
- ADR-0018 holds exactly: input cost is the consumed pools, plus direct cost, split by `allocate` over grams times reference price, waste zero, a deferred trigger asserting the sum.
- ADR-0019 holds: the movement trigger still refuses PROCESS_CONSUME under a hold; PRC refuses it earlier with the hold's end.
- PRC imports IAM, MDM and INV only, never LIV (the boundary lint passes).

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B6, livestock and processing (`b06-livestock-processing`, from `main`).
2. **Scope:** the opener's list (LIV register to feed, PRC orders to labels). Too large for one context, so split at the PRC sub-domain that carries the gate (A-154).
3. **Gate:** a processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus the direct processing cost.

## Contract changes

**Version 1.22.0, minor. No schema, field, parameter or response shape changed.** The versioning check against `main` passes.
- **From code (12):** `listProcessingOrders`, `getProcessingOrder`, `createProcessingOrder`, `updateProcessingOrder`, `startProcessingOrder`, `recordProcessingOutputs`, `addProcessingCost`, `completeProcessingOrder`, `cancelProcessingOrder`, `listYieldStandards`, `createYieldStandard`, `updateYieldStandard`. 206 from code, 404 planned, 610 published.
- **LOUD, behaviour of planned operations described differently:** `startProcessingOrder` moves no stock; completion consumes. Cancel works from PLANNED or IN_PROGRESS with no stock or cost effect.
- **Descriptions and `x-error-codes`** on every PRC operation; examples consistent with each operation's status (goat G-0098, 29.600 kg, 66,100 + 6,000 split 64,035 and 8,065; expected 59.000, actual 58.446).
- **New error codes:** `PROCESSING_ORDER_INVALID`, `YIELD_STANDARD_INVALID` (docs/API.md 10.3). `STOCK_UNIT_ON_HOLD` now also refuses a processing input, naming the hold kind and its end.
- The cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md` covers 1.22.0. Redocly lint is clean; `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0071:** document type `PROCESSING_ORDER`.<br>**0072:** schema `prc`: `yield_standard`, `processing_order`, `processing_input`, `processing_output`, `processing_cost`; the status guard, the freeze, the part guard (inputs only while PLANNED, outputs and costs while PLANNED or IN_PROGRESS), the deferred `ck_processing_order_costs`, and the two clear functions.<br>**0073, 0074:** five `prc.*` permissions and their grants. |
| PRC domain (100 percent) | `cost-allocation.ts`: `allocateProcessingCost` through the kernel's `allocate`. `yield.ts`: `checkOutputWeights`, `judgeYield`, `parsePercent`. |
| PRC application | `Processing` (list, get, create with `createIn`, update, start, recordOutputs, addCost, complete, cancel); `YieldStandards` (list, create with `createIn`, update). Every handler authorises first, scoped to the order's branch and processing location; every write is idempotent and audited; completion is one serializable transaction publishing `prc.ProcessingOrderCompleted`, `prc.DirectCostIncurred` and, when flagged, `prc.YieldVarianceFlagged` (abuse case 18). |
| PRC infrastructure and interface | `PgProcessingStore`; `ProcessingController` with strict zod schemas; twelve contract fragments; `PrcModule` wired in `app.module.ts`. |
| INV | `StockUnits` (`factsIn`, `activeIdentifiersIn`, `registerLotIn`) and `PgStockUnitStore`, exported through `index.ts`. |
| Seed | `BYP-GOAT-OFFAL` (goat offal, per kg, base price 1,500 a kilogram) and the goat's yield standards (meat 48, offal 11, tolerance 5) through `YieldStandards` as the Manager. No order is seeded, so the B5 and B05x hand counts are unchanged. |
| Docs | A-153, A-154; BL-051, BL-052; ADR-0026 Amendments; the openers (B6 row, new B06 continued section, B7 reads the B06b report); CONTRACT_CHANGELOG; API.md (PRC, 10.3); `data-model/prc.md`; MODULE_BOUNDARIES (INV and PRC cards). |

## Contract requests

The frontend's `main` lists CR-001 to CR-018.
- **CR-001 to CR-004, CR-006 to CR-008, CR-012 to CR-018:** answered in earlier sessions (CR-012 in B05 continued 4, CR-013 to CR-018 in B05x); nothing new for this phase.
- **CR-005: standing decline**, as before.
- **CR-009, CR-010, CR-011 (MDM: price list preview, price list examples, units of measure): declined for this phase.** They are MDM's; this phase builds PRC. Nothing here blocks them.
- **CR-016** (server-rendered labels): still BL-049. `printPackLabels` is B06 continued's.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 back office, and the database. The skill's minimum groups were run; the full standards document was not walked line by line this session.
- **Authorisation:** deny by default in every handler (`Authoriser.authorise`), scoped to branch and processing location; the handler walk covers the 12 new routes; wrong-role tests for Cashier, Sales, Driver, Farm hand, Investor, the Accountant on writes, a Storekeeper scoped to the cold room, and any Storekeeper on yield standards.
- **Input:** strict schemas; parameterised SQL; the one dynamic `SET` list in `PgProcessingStore.touch` takes column names only from the application's own constants.
- **Money and stock:** no value comes from the client except direct costs; input cost is the trigger's; the split is `allocate`; the database re-checks the sums at commit.
- **Data:** no personal data. Cost (DC-11) is shown only to roles that already read stock at cost; the Farm hand gets nothing (A-153).
- **Abuse case 18 (under-recorded yield):** the flag and `prc.YieldVarianceFlagged` carry `abuseCases: [18]`, the actor and the weights; the daily exception report that lists it is B12's.
- Not applicable: uploads, exports, payments, webhooks (none in this change).

## Deferred

- **To B06 continued:** all of LIV; packs and labels; the reversing order of FR-PRC-011; the Farm hand's PRC access.
- **To B8:** posting `prc.DirectCostIncurred`, `inv.StockConsumedInProcessing` and `inv.ProcessingOutputReceived` (ADR-0003 rows 1340, 2020, 1320/1325); `orderNo`.
- **To B12:** `YIELD_VARIANCE` on the daily exception report.
- **Backlog:** carcass lots as inputs (BL-051); reserving inputs while in progress (BL-052).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **767 passed** (new: `prc/domain/cost-allocation.spec.ts` 13, `prc/domain/yield.spec.ts` 12) |
| Integration | **758 passed**; unit and integration together under coverage **1,525 passed**. New: `prc/processing-orders.integration.spec.ts` (18). The handler walk now covers B6; the seed test counts six service units. |
| Coverage, merged | Statements 94.33 percent, branches 84.90 percent (gate 80). Every 100 percent gate holds, including the new one on `src/modules/prc/domain/**`. |
| Contract | **58 passed**, including the new `b6` shapes; the drift test now counts 206 from code and 404 planned, and the request-example test parses the seven PRC request examples. |
| Lint (boundaries, schema names), type check, Redocly | Clean |
| End to end | Runs in CI |

**A red run on this machine, fixed in the code of this change:** the first full run had three failures, all bookkeeping the new routes needed: the handler walk's route list and request bodies, and the seed test's count of service units. The first contract run had two of the same kind (the drift test's operation counts, and the request-example schemas). Each was fixed by updating the test's inventory of routes, not by retrying.

**Test first:** the allocation tests were written first and ran red (`cost-allocation` did not exist). The yield tests were written before their code but run with it, not red first. The gate's integration test was written after the application layer, against the allocation rule already proven red-first; that departs from the rule for the integration layer, recorded here.

## Gate

**Passed**, proven by running `test/integration/prc/processing-orders.integration.spec.ts` on the seeded farm:
- Goat G-0142 (pool 60,000), 28.000 kg, with 4,000 labour and 1,000 consumables: the total is 65,000. Meat 13.400 kg at 2,200 a kilogram and offal 3.100 kg at 1,500 carry **56,144 and 8,856, summing to 65,000**; 9.000 kg of waste carries 0.
- The goat is CONSUMED with an empty pool; PROCESS_CONSUME carried 60,000; each lot sits in the cold room with a pool equal to its allocated cost; the meat lot traces back to the goat.
- **Awkward split:** goat G-0143 with no direct cost: 60,000 over meat 12.000 kg and offal 3.000 kg is 51,262.14 and 8,737.86; the leftover pesewa goes to the larger remainder, **51,262 and 8,738**. Its meat yield, 1.440 kg short of 13.440, is flagged with abuse case 18.
- **The database refuses** a completion written by SQL whose outputs sum to 76,399 against a total of 76,400 (`ck_processing_order_costs`, HK010), and accepts 76,400.
- A goat under a withdrawal hold is refused with `STOCK_UNIT_ON_HOLD` naming the hold and its end, at create and at start.

## Notes for the frontend track

- **Processing screens can switch off the mock** for orders and yield standards. Packs, labels and every livestock screen stay on the mock until B06 continued.
- **Show nothing as allocated before completion:** reference prices, allocation weights and allocated costs are 0, lots null, and `inputCostPesewas`, `totalCostPesewas` and the yields null until `COMPLETED`. Each input's `costPesewas` is what it would carry now.
- **`yieldVarianceFlag`** never blocks completion: show it as "needs investigation".
- **Refusals:** show `details[].code` of `PROCESSING_ORDER_INVALID`; for `STOCK_UNIT_ON_HOLD` show the detail's message, which carries the end of the hold.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`0bb9e6c`** (`0bb9e6c3ebf727d0992c6bbe46506fca8fdfc8e2`, the last commit before this report): push run `43717417109` **success**; pull_request run `43717442737` **success**. The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B06 continued. The opener is in `docs/prompts/session-openers.md`, section "B06 continued — Livestock management, packs and labels":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06-livestock-processing.md).
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
