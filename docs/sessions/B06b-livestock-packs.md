# B06 continued: the livestock core (register, weights, health, mortality and feed)

Date: 2026-11-15 · Branch `b06b-livestock-packs`, from `main` (`6bc5fca`) · Pull request #37 · Status: **phase split; gate passed for what was built.**
- The phase split at a LIV sub-domain boundary (A-158).
- This session built the livestock core and passed its gate.
- **B06 continued 2** (`b06c-livestock-growth-breeding`) is next: animal edits, growth, batches, breeding and the feed seed.
- **B06 continued 3** (`b06d-packs-labels`) follows it: packs, labels, the reversing order and the Farm hand's PRC access.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-158 | **How B06 continued reads LIV**, each time the most conservative reading.<br>- **Split:** 17 operations built here. 15 move to B06 continued 2: `updateAnimal`, `moveAnimal`, `listAnimalTimeline`, `listGrowth`, five batch operations and six breeding operations. Packs, labels, the reversing order and A-153's Farm hand decision move to B06 continued 3.<br>- **Register:** an animal is opened by `inv.StockUnitRegistered`, in the receipt's own transaction.<br>  - Its acquisition cost is the pool value the receipt carried. Its source is PURCHASE when the receipt names a supplier, OPENING otherwise.<br>  - A second live animal with a tag that is already live is refused (`TAG_IN_USE`), and the receipt is refused with it.<br>  - Its status follows the sale, processing, write-off, customer return and supplier return events.<br>  - Any write-off that is not a death or a cull leaves it DEAD. A return, or a reversal of the closing movement, makes it ALIVE again.<br>  - Once closed, it shows the cost it left with (`exit_value_pesewas`) and no location.<br>  - `priceBand` and `weightBand` are what the counter would resolve for it now.<br>- **Weights:** the latest weighing is copied onto the unit's last weight, so the unit's label prints it.<br>- **Health:** medication is an untracked product, issued from the branch STORE.<br>  - The request's `costPesewas` is a veterinary service fee. The event's cost is the medication value plus that fee.<br>  - The cost is spread by head-days, with its own allocation table and deferred check.<br>  - A withdrawal hold ends exactly N days after the event, to the minute. N may be raised above the product's figure, never lowered.<br>- **Head-days:** one day per record. A flock counts its head on hand. The leftover pesewa goes to the lowest tag.<br>  - Flocks count as GROWING until batches exist.<br>  - Breeding stock is expensed through the new `Stock.expenseIn`, which publishes `inv.UpkeepExpensed`.<br>- **Mortality:**<br>  - It has its own approval kind, `MORTALITY_WRITE_OFF`: threshold 50,000, approver `liv.mortality.approve`, step-up required. The contract had said `STOCK_WRITE_OFF`; the enum gains the new value.<br>  - The photograph is a CLEAN EVIDENCE file, given when the record is reported.<br>  - Only the reporter submits.<br>  - Only a record waiting for approval blocks a second report.<br>- **Permissions:** the Farm hand records weights, health, feed and mortality, and reads weights only. The other reads carry cost (DC-11), as A-153 decided for PRC.<br>- **Seed:** this session seeds weights only. The feed, medicine, store and rations are seeded with batches in B06 continued 2. | Owner; accountant for the health cost split and the expensed upkeep |

**Needs the owner's approval:**
- **The split** (A-158, ADR-0026 Amendments): two new phases before B7.
- **The new approval kind `MORTALITY_WRITE_OFF`**, rather than the contract's `STOCK_WRITE_OFF`.
- **The Farm hand's reads:** no reads of the register, health, mortality or feed lists.
- **Nothing else new:** no new dependency, no new ADR and no new port. ADR-0047 and ADR-0051 are not touched.

I found no ADR conflict:
- ADR-0018 says cost is accumulated in INV's pools; every capitalisation is a value-only movement.
- ADR-0019 says the hold is INV's, placed through `StockHolds.placeIn`.
- ADR-0017 says there is one approval mechanism; mortality is one more kind with its own handler.
- Caught database errors are read only through `databaseErrorOf`: one place, the ration name.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B06 continued, livestock management, packs and labels (`b06b-livestock-packs`, from `main`).
2. **Scope:** LIV. This phase is too large for one context, so it is built up to the sub-domain boundary and split (A-158). PRC's packs, labels and reversal go to a later phase.
3. **Gate, for what is built:** every LIV write built refuses the wrong role. A withdrawal hold blocks sale and processing, and nobody releases it early. Mortality at or above the threshold waits for a photograph and a different approver. Feed and veterinary cost spread by head-days sum exactly to the value issued.

## Contract changes

**Version 1.24.0, minor. No existing schema, field, parameter or response shape changed.** The versioning check against `main` passes.

- **Seventeen operations now from code:**
  - `listAnimals`, `getAnimal`
  - `listWeightRecords`, `recordWeights`
  - `listHealthEvents`, `recordHealthEvent`, `getHealthEvent`
  - `listMortalityRecords`, `reportMortality`, `getMortalityRecord`, `submitMortalityRecord`
  - `listRations`, `createRation`, `updateRation`
  - `listFeedConsumption`, `recordFeedConsumption`, `getFeedConsumption`
- **Counts:** 224 operations from code, 387 planned, 611 published.
- **`ApprovalKind` gains `MORTALITY_WRITE_OFF`.** This is a new enum value in a response, so it is called out as LOUD in the changelog.
- **`submitMortalityRecord`:** its description is corrected and its 202 example now agrees with `reportMortality`'s example (G-0171, 58,900 pesewas).
- **`x-error-codes`** on all seventeen operations. New codes: `LIVESTOCK_RECORD_INVALID`, `MORTALITY_PHOTO_REQUIRED`, `RATION_INVALID`.
- **Changelog:** the 1.24.0 entry and the cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md`.
- **Checks:** Redocly lint is clean. `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0075:** document types `HEALTH_EVENT`, `MORTALITY_RECORD`, `FEED_CONSUMPTION`.<br>**0076:** schema `liv`, with these tables:<br>- `animal`: partial unique live tag, plus a guard on fixed attributes and status moves.<br>- `weight_record`, `health_event`, `health_cost_allocation`, `feed_cost_allocation`: LEDGER tables.<br>- `mortality_record`: status guard, freeze, `ck_mortality_record_approved`, and a photograph check through `platform.require_clean_file`.<br>- `ration`.<br>- `feed_consumption`.<br>The two spreads (feed, health) each have a deferred check that they sum exactly.<br>**0077:** eleven permissions and the `MORTALITY_WRITE_OFF` policy.<br>**0078:** grants. |
| LIV domain, 100 percent (new gate) | - `cost-spread.ts`: `spreadByHeadDays` through the kernel's `allocate`, `headOf`, `treatmentOf`.<br>- `health.ts`: withdrawal end and withdrawal days, event shape.<br>- `mortality.ts`: report checks, `judgeWriteOff`, the status after a loss.<br>- `animal.ts`: status after a movement, source, weighing checks.<br>- `feed.ts`: expected consumption.<br>Each was written test-first. |
| LIV application | - `Animals`: two transactional subscribers, plus list and get.<br>- `Weighing`.<br>- `HealthRecords`.<br>- `MortalityRecords`: also the approval handler.<br>- `Feeding`: rations and consumption.<br>- `CostSpreader`.<br>All are serializable, idempotent, audited, and publish `liv.*` events through the outbox. |
| INV and MDM | - `StockUnits`: facts gain pool quantity, grade, last weighing and reservation; new `onHandAtIn`, `onHandOfIn`, `recordWeightIn`.<br>- `Stock.expenseIn`, with the new `inv.UpkeepExpensed`.<br>- `ProductFacts`: species and withdrawal days.<br>- `MasterDataRefs.speciesIn`. |
| Interface | One controller, schemas, and 17 contract fragments. IAM's approval kind filter gains the new kind. |
| Seed | `farm-liv.ts`: the first weighing of the six seeded animals and a ten-bird broiler sample, through `Weighing`. The register is filled by the receipts themselves. |
| Docs | - A-158.<br>- ADR-0026 Amendments.<br>- The openers: two new sections, the reference table, and B7 now reads the B06 continued 3 report.<br>- `docs/data-model/liv.md`.<br>- `docs/MODULE_BOUNDARIES.md`: LIV and INV cards.<br>- `docs/API.md`: livestock section, approval kinds, error codes.<br>- Threat model row 2.<br>- Contract changelog. |

## Contract requests

The frontend's `main` lists CR-001 to CR-018, the same as at B06m.
- **CR-001 to CR-004 and CR-006 to CR-018:** answered in earlier sessions. Nothing new for this phase.
- **CR-005** (a named empty example on every list): a standing decline, as before.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 (the back office) and the database.

- **Authorisation:** deny by default in every handler, scoped to the animal's branch and where it stands, or to the pen.
  - The wrong-role tests pass.
  - The handler walk covers all 17 routes.
- **Maker and checker:**
  - Both IAM and the database refuse a maker who tries to check their own request.
  - Only the reporter may submit, so the reporter is never the approver.
  - The approval hash includes the value at request time.
- **Abuse case 2:** blocked at or above the threshold, and made visible below it through `liv.MortalityReported` (`abuseCases: [2]`), which feeds B12's `MORTALITY` kind. The threat model row is updated.
  - **Residual:** the daily exception report itself is B12's, so its test is B12's or B13's.
- **Input:** strict zod schemas. SQL is parameterised; dynamic column names come from an allow-list.
- **Not applicable:** payments, webhooks, exports. No new upload path: the photograph goes through the existing file store.

## Deferred

- **To B06 continued 2:** animal edits and moves, the timeline, growth, batches, breeding and births. Also the feed, medicine, store and ration seed, and the recount of the B5 and B05x hand counts with it.
- **To B06 continued 3:** packs, labels, the reversing order (FR-PRC-011), and the Farm hand's PRC access (A-153).
- **To B8:** posting `inv.CostCapitalised`, `inv.UpkeepExpensed` and `liv.HealthEventRecorded`. The service fee's credit account is the accountant's decision.
- **To B12:** the MORTALITY exception kind, projected from `liv.MortalityReported` and `liv.MortalityApproved`.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **819 passed**. New: five LIV domain specs (40 tests). |
| Integration | **787 passed**. New: `liv/livestock.integration.spec.ts` (20). The handler walk lists the 17 routes; the seed test counts seven units. |
| Coverage, merged | 1,606 passed. Statements 93.46 percent, branches 83.72 percent (gate 80). Every 100 percent gate holds, including the new `src/modules/liv/domain/**`. |
| Contract | **60 passed**. New: `b6b/livestock.contract.spec.ts`. The drift test now counts 224 from code and 387 planned. Request examples parse with the six new schemas. |
| Lint (boundaries, schema names), type check, Redocly | Clean |
| End to end | Runs in CI |

**Test first:**
- The domain specs were written first.
- **Honestly:** the integration gate test was written after the application code. I proved it can fail by switching off the hold placement on purpose: 5 tests went red. I then restored the code.
- **Red runs during development:** each was a real bug, fixed in code:
  - `touch_version` needs an explicit version bump.
  - PL/pgSQL `CASE` cannot read a missing field.
  - A flock's location is not kept on its stock unit.
  - The pricing engine refuses any `stockUnitId`.
  - A wrong route path in the test.
- I saw no flaky test.

## Gate

**Passed for what is built.** I proved it by running `test/integration/liv/livestock.integration.spec.ts` on the seeded farm, with feed, medicine, a store and two pens arranged through MDM and INV's API.

- **Wrong role:**
  - Cashier, Sales, Driver, Investor and Accountant get 403 on all six writes.
  - The Farm hand and the Storekeeper get 403 on the ration writes.
  - The Farm hand gets 403 on the reads that carry cost.
- **Withdrawal hold:**
  - G-0143 was treated with 0.005 l of oxytetracycline, issued at 150 pesewas, which raised its pool to 60,150. The hold runs 28 days.
  - A sale is refused with `STOCK_UNIT_ON_HOLD`, and so is a direct SQL insert (`ck_stock_on_hold`).
  - Planning it for slaughter is refused with `STOCK_UNIT_ON_HOLD`.
  - Both managers get `WITHDRAWAL_CANNOT_BE_RELEASED`.
  - After the end, the sale goes through, the animal is `SOLD` in the same transaction, and a second sale is refused.
- **Mortality:**
  - A kid at 12,000 posts on submit and becomes DEAD.
  - A doe at 62,500 without a photograph gets 422 and stays ALIVE.
  - With a photograph, it waits as 202 `MORTALITY_WRITE_OFF` with the stock still on hand.
  - The maker gets `MAKER_CANNOT_CHECK`, and the Storekeeper gets 403.
  - A second manager approves it, and the doe becomes DEAD.
  - The database refuses an unapproved POSTED record (`ck_mortality_record_approved`).
- **Spread:**
  - 9,001 pesewas over the treatment pen: 3,001 and 3,000 capitalised, and 3,000 expensed for the breeding doe (`inv.UpkeepExpensed`).
  - Feed valued 10,001 (10 of 20 kg at 20,002) over flocks of 10, 10 and 5: 4,001, 4,000 and 2,000. The pools read exactly 54,001, 54,000 and 27,000.
  - An inconsistent 10,000 spread is refused at commit (HK010, `ck_feed_consumption_spread`).
- **Not part of this gate:** pack weights and labels belong to B06 continued 3's gate.

## Notes for the frontend track

- **The register is read-only here.** Animals appear when a receipt is posted.
- **Handle `ApprovalKind` `MORTALITY_WRITE_OFF`** in the approvals inbox.
- **Ask for the photograph when the death is reported,** not when it is submitted.
- **Hide the register, health, mortality and feed lists from the Farm hand.**
- **The mock still serves** moves, edits, the timeline, growth, batches, breeding, packs and labels.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`b4b1a66`** (`b4b1a66ae956fa606f0657606b38f2c8bb049bb7`, the last commit before this report): push run `43726460744` **success**; pull_request run `43726488413` **success**. The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's commit:** a commit cannot name its own runs, so they are named in the session's closing message.

## Next session

B06 continued 2. The opener is in `docs/prompts/session-openers.md`, section "B06 continued 2 — Animal edits, growth, batches and breeding":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06b-livestock-packs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-LIV-002, FR-LIV-003, FR-LIV-005, FR-LIV-006, FR-LIV-010, FR-LIV-011 and FR-LIV-016 of
docs/SRS.md (nothing else from the SRS), docs/data-model/liv.md, the LIV card in docs/MODULE_BOUNDARIES.md, and
ADR-0018. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase
needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued 2 only, on branch b06c-livestock-growth-breeding, branched from main, on top of the
livestock core B06 continued built (src/modules/liv): updateAnimal (purpose decides capitalised or expensed; fixed
attributes refused), moveAnimal (a TRANSFER_INTERNAL movement through INV's Stock.postIn from where the animal is),
listAnimalTimeline, listGrowth (average daily gain per animal, pen and batch over animals present for the whole
window, feed conversion from the feed issued, mortality percent), the batches (liv.batch, a flock's lot as its stock
unit, with an expand migration adding liv.animal.batch_id; a batch's purpose then decides a flock's cost treatment
instead of A-158's GROWING default), and breeding and births (liv.breeding_record, gestation days from data, recordBirth
registering offspring through INV at nil cost with a BIRTH movement and lineage to the dam, and the expand migration
adding liv.animal.breeding_record_id). Extend the seed with feed and medicine products, the Dodowa store, their stock
and rations, and count them by hand into the B5 and B05x hand counts. Write the money, weight and permission tests
first. Stop at the gate and write docs/sessions/B06c-livestock-growth-breeding.md.
```
