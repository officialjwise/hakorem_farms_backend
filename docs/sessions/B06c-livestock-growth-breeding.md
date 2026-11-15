# B06 continued 2: animal edits, growth, batches and breeding

Date: 2026-11-15 · Branch `b06c-livestock-growth-breeding`, from `main` (`2c4c842`) · Pull request #38 · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-159 | **How B06 continued 2 reads LIV**, each time the most conservative reading.<br>- **Edits:** breed, sex, purpose and grade only, on a live animal. The tag is the stock unit's identifier, which INV holds fixed, so `tagNo` is accepted only unchanged (`TAG_NOT_EDITABLE`, BL-056). A dam's sex is fixed. The grade is set on the unit through INV's new `StockUnits.setGradeIn`.<br>- **Moves:** to a live physical location of the animal's branch that is not SITE or IN_TRANSIT, from where inventory says it stands. Recorded in the new `liv.animal_move` (document type `ANIMAL_MOVE`). The movement carries the cost from pen to pen; the pool is unchanged.<br>- **Growth:** the members are the units standing there at both ends of the window. One row per pen and species. Averages are per head over members weighed on two days. Daily gain is total gain over total days. Feed is the head-day share of each issue, rounded once. **Feed conversion to three places (FR-LIV-016), not the contract's former two.** A weight loss shows null gain, daily gain and conversion. Mortality counts deaths, not culls. Accra days are UTC days.<br>- **Batches:** a received flock opens its batch in the receipt's transaction. `createBatch` hatches a flock at nil cost (a BIRTH movement) for a species with one lot-tracked product (`NO_FLOCK_PRODUCT` otherwise), so batches grouping individual animals are not built (BL-055). The purpose decides treatment: GROWING is capitalised, BREEDING and LAYING are expensed. A batch closes only with no head left, a reason is always required, and a closed batch is frozen.<br>- **Breeding:** gestation days are a LIV lookup, `liv.gestation_period`. The mating day counts as day one, as FR-LIV-010's own example needs (1 March 2027 gives 28 July 2027). Offspring go into the dam's pen (`DAM_NOT_IN_A_PEN` if she stands nowhere) with the dam's breed and purpose GROWING, and their lineage is linked to the dam. Stillbirths are recorded.<br>- **Permissions:** see "Farm hand" below.<br>- **Seed:** the store, its feed and medicine, the delivery and three rations, each through its module's service. | Owner; accountant (laying flock treatment, nil-cost hatch); vet (gestation count) |

**Needs the owner's approval:**
- FCR stated to three places, against the contract's former two.
- The tag correction refused.
- Only lot-tracked flocks as batches.
- The mating day as day one of gestation.

**I found no ADR conflict:**
- ADR-0018: every cost and stock change goes through INV. Births enter at nil cost; growing stock is capitalised and breeding stock expensed.
- ADR-0019: a hold does not block a pen move.
- ADR-0047 and ADR-0051 are untouched.
- No new ADR, dependency or port.

**Farm hand (owner's decision, 2026-11-15, relayed by the parent session):** no new Farm hand refusal on a read needed for animal work. The Farm hand holds all eight new permissions: `liv.animal.update`, `liv.animal.move`, `liv.report.read`, `liv.batch.read`, `liv.batch.create`, `liv.batch.update`, `liv.breeding.read` and `liv.breeding.record`.

**For B06 continued 3 to make cost-free:** these answers still carry cost to the Farm hand:
- `updateAnimal` and `moveAnimal`: `Animal.accumulatedCostPesewas`.
- `listBatches`, `getBatch`, `createBatch`, `updateBatch` and `closeBatch`: `Batch.accumulatedCostPesewas`.
- `listAnimalTimeline` (`AnimalEvent.valuePesewas`) is read with `liv.animal.read`, which the Farm hand does not yet hold. A-158's matrix is unchanged here.
- `listGrowth` and the breeding shapes carry no cost.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B06 continued 2, animal edits, growth, batches and breeding (`b06c-livestock-growth-breeding`, from `main`).
2. **Scope:** LIV's remaining 15 operations, two expand migrations, and the feed, medicine, store and ration seed with its hand counts.
3. **Gate:**
   - Every remaining LIV write refuses the wrong role.
   - A move starts only where the animal is and changes no cost.
   - Average daily gain and feed conversion match a hand calculation.
   - A batch closes only when empty or with a reason.
   - A birth registers nil-cost offspring linked to the dam, and refuses a dam that was not alive and female.
   - The seed is counted by hand.

## Contract changes

**Version 1.25.0, minor. No schema, field, parameter or response shape changed.**
- **Fifteen operations now from code:** `updateAnimal`, `moveAnimal`, `listAnimalTimeline`, `listGrowth`, `listBatches`, `createBatch`, `getBatch`, `updateBatch`, `closeBatch`, `listBreedingRecords`, `createBreedingRecord`, `getBreedingRecord`, `updateBreedingRecord`, `recordBirth`, `failBreedingRecord`.
- **Counts:** 239 operations from code, 372 planned, 611 published. Every LIV operation is now built.
- **LOUD:** `GrowthRow.feedConversionRatio` is stated to three decimals.
- **LOUD, behaviour now stated:** a changed `tagNo` is refused; a hatch starts at nil cost with its lot; a close is refused with head left.
- **Examples corrected** so they agree with one another and with their own figures (FCRs recomputed, expected births counted, statuses as each operation leaves them). New `LIVESTOCK_RECORD_INVALID` codes are listed in `docs/API.md` 10.3.
- **Changelog:** the 1.25.0 entry and the cold-read summary. Redocly is clean and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0079:** document types `ANIMAL_MOVE`, `LIVESTOCK_BATCH`, `BREEDING_RECORD`.<br>**0080:**<br>- `liv.gestation_period` (LOOKUP, seeded).<br>- `liv.batch` (MASTER, guard and freeze).<br>- `liv.breeding_record` (DOCUMENT, guard, freeze, born and failed checks).<br>- `liv.animal_move` (LEDGER).<br>- The expand that adds `liv.animal.batch_id` and `breeding_record_id`.<br>- `liv.animal_guard` replaced: tag and parentage fixed, and a dam's sex fixed.<br>**0081:** eight permissions.<br>**0082:** their grants. |
| LIV domain (100 percent gate) | - `growth.ts`: ADG, group growth, FCR, percent, feed share.<br>- `herd.ts`: edit, move, pen and close rules.<br>- `breeding.ts`: expected birth, dam, sire, status, birth checks, stillbirths.<br>- `cost-spread.ts`: LAYING is expensed.<br>The `herd` and `breeding` specs were written first and seen red. |
| LIV application | - `AnimalCare`: update, move and timeline.<br>- `Batches`.<br>- `Breeding`.<br>- `Growth`.<br>- `Animals.register` now also opens a received flock's batch.<br>- `CostSpreader` reads the batch's purpose.<br>- New `HerdStore` and `PgHerdStore`.<br>All writes are serializable, idempotent and audited, with events through the outbox: `liv.AnimalUpdated`, `liv.AnimalMoved`, `liv.BatchStarted`, `liv.BatchClosed`, `liv.BirthRecorded`, and `liv.AnimalRegistered` per offspring. |
| INV and MDM | - `StockUnits.registerSerialIn`, `onHandAsOfIn` and `setGradeIn`.<br>- `factsIn` now gives the unit's source document.<br>- `MasterDataRefs.productsOfSpeciesIn`. |
| Interface | 15 routes, strict zod schemas, 15 contract fragments. |
| Seed | `farm-liv.ts`:<br>- the STORE and the `FEED-MED` category;<br>- `FEED-BRL-GROWER`, `FEED-GOAT-CONC` and `MED-ALBENDAZOLE`, received at GHS 1,940.00;<br>- rations for broilers, goats and sheep.<br>The seeded broiler flock now has its batch. |
| Docs | - A-159, BL-055 and BL-056.<br>- `docs/data-model/liv.md`.<br>- `docs/MODULE_BOUNDARIES.md`: LIV and INV cards.<br>- `docs/API.md`: livestock section and error codes.<br>- The contract changelog.<br>- Openers table row marked built. |

## Contract requests

The frontend's `main` lists CR-001 to CR-018, unchanged since B06m.
- **CR-001 to CR-004 and CR-006 to CR-018:** answered in earlier sessions. Nothing new for this phase.
- **CR-005** (a named empty example on every list): a standing decline, as before.

## Security review (hakorem-security-review)

Boundary: TB2 and the database.
- **Authorisation:** deny by default in every handler, scoped to the animal's branch and pen (both pens for a move), the batch's lot, or the dam.
  - Wrong-role tests cover all nine writes.
  - The handler walk lists all fifteen routes and refuses each with no grant.
- **Input:** strict schemas, so fixed attributes are a 400. Parameterised SQL with allow-listed columns.
- **Abuse paths considered:**
  - Hiding an animal by moving it: every move is a movement plus an audited ledger row.
  - Registering a fake birth to explain an extra animal: a birth needs a live female dam with a mating record, and it is audited and published (`liv.BirthRecorded`).
  - No new abuse case for the threat model. No payment, upload or export path.
- **Residual:** the Farm hand sees cost in the answers listed above until B06 continued 3.

## Deferred

- **To B06 continued 3:**
  - packs, labels and the reversing order;
  - A-153;
  - the Farm hand's cost-free LIV shapes (the list above).
- **To the backlog:**
  - BL-055: batches that group individual animals.
  - BL-056: tag correction.
  - The timeline's `RESERVED` entry is not shown yet (INV's reservation history).
- **To B8:** posting `inv.UpkeepExpensed` and nil-value BIRTH movements (no posting event).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **868 passed**: the LIV domain is now 89 tests over eight specs. |
| Integration | **806 passed**. New: `liv/growth-breeding.integration.spec.ts` (19). These were updated:<br>- the handler walk (15 routes);<br>- the seed, B5 and B05x hand counts;<br>- B06 continued's test (seeded store and category). |
| Coverage, merged | 1,674 passed. Statements 93.51 percent, branches 83.37 percent (gate 80). Every 100 percent gate holds, `src/modules/liv/domain/**` among them. |
| Contract | **63 passed**. New: `b6c/growth-breeding.contract.spec.ts`. The drift test counts 239 and 372, and the request examples parse with the nine new schemas. |
| Lint, type check, Redocly, `contract:generate --check` | Clean |
| End to end | CI. Red on `1629294` (the seeded store's location, fixed in `74b28c9`), then green |

**Test first, honestly:**
- `herd.spec.ts` and `breeding.spec.ts` were written before their code and seen red: missing module, then two wrong expected-birth dates. That showed the SRS counts the mating day as day one.
- `growth.spec.ts` was written beside `growth.ts`, not before it.
- The integration gate test was written after the application code. It went red five times before going green, each time on a real fault:
  - a uuid column given a tag;
  - a test design that moved animals after the window;
  - session expiry after a clock jump;
  - the timeline's first entry;
  - the audit table name.
- **One red CI run, recorded above:** the end-to-end location list. I had not run the end-to-end suite locally; it is a test that needed the new seed's eighth location.
- I saw no flaky test.

## Gate

**Passed.** I proved it by running `test/integration/liv/growth-breeding.integration.spec.ts` on the seeded farm, with dates set back from now.

- **Wrong role:**
  - Cashier, Sales, Driver, Investor and Accountant get 403 on all nine writes.
  - The Storekeeper gets 403 on batch purpose and close.
  - The Cashier gets 403 on the growth, batch and breeding reads.
  - The handler walk refuses all fifteen routes with no grant.
- **Move:**
  - GR-B moved from the growing pen to pen 2 by exactly one TRANSFER_INTERNAL movement. Its pool is unchanged, and the movement carried that same value.
  - A second move to pen 2 gets `ALREADY_THERE`.
  - A direct `Stock.postIn` from the pen it left gets `STOCK_UNIT_NOT_AVAILABLE`.
  - A move to a virtual location gets `NOT_A_PEN`.
  - An animal under an albendazole withdrawal hold moved.
  - The timeline shows the move with its actor.
- **Hand calculation:**
  - Two goats at 18.000 kg on day 1 and 24.600 kg 30 days later give ADG 0.220. A third goat joined mid-window and is left out (head 2).
  - 33.000 kg of feed over 13.200 kg gained gives FCR **2.500**.
  - A flock of 20 from 0.500 to 2.500 kg on 100.000 kg of feed gives FCR **2.500** and ADG 0.067. Mortality is 0.00.
- **Batch:**
  - The received flock opened as BRG-01 with 20 head.
  - Two deaths leave 18 head at 10.00 percent and 85,500 pesewas.
  - Closing with 18 head gets `BATCH_NOT_EMPTY`.
  - After the sale of 18, the close is accepted: CLOSED, cost 0. A second close gets `BATCH_CLOSED`, and the database refuses a change (HK004).
  - A hatch of 50 starts at nil cost, with one BIRTH movement of value 0.
  - A goat batch gets `NO_FLOCK_PRODUCT`.
  - A LAYING flock's feed is expensed.
- **Edit:**
  - GROWING to BREEDING is audited, and the next feed is EXPENSED for GR-A while the others are capitalised.
  - `speciesId` and cost in the body get 400. A new tag gets `TAG_NOT_EDITABLE`. A stale version gets 409. A direct species change is refused by the database (HK004).
  - A dam's sex change gets `SEX_FIXED_AS_DAM`, from the API and from the database.
- **Birth:**
  - A mating on 2026-03-01 is expected on 2026-07-28. A male dam gets `DAM_NOT_FEMALE`.
  - A litter of 4 with 3 live kids registers three animals:
    - each at cost 0, source BIRTH, with dam and sire, in the dam's pen;
    - three BIRTH movements of value 0 and three BIRTH lineage links to the dam;
    - one stillbirth recorded;
    - MATED and GAVE_BIRTH on the dam's timeline.
  - A second birth on the record gets `RECORD_CLOSED`. A birth dated two days after the dam's death gets `DAM_NOT_ALIVE_ON_BIRTH`.
- **Seed counted by hand:** the seeded-stock gate and the dashboard test both pass:
  - **GHS 17,895.01** of stock at cost, with STORE lines of 200, 150 and 2;
  - **GHS 17,290.01** of purchases over five receipts on the seed day.

## Notes for the frontend track

- **Every LIV operation now answers from the real API.**
  - Show `feedConversionRatio` with three decimals.
  - Do not offer a tag edit.
  - Disable "close batch" while `currentHead` is above 0.
- **Batches are flocks:** a goat group is not a batch.
- **Births:** offspring appear in the register at nil cost in the dam's pen.
- **The Farm hand:** the role may now edit, move and work batches, growth and breeding. Until B06 continued 3, hide the cost fields on those screens for the role.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`1629294`** (`16292947c304f680ff641168226e8cf3b7c81eb6`): push run `43731757076` **failure**; pull_request run `43731783219` **failure**.
  - Both failed in one job, "setup script brings the stack up on a clean checkout", at its end-to-end step. Every other job was green.
  - The cause: `test/e2e/mdm/parties-locations.e2e.spec.ts` lists Dodowa's physical locations exactly, and the seeded STORE is now an eighth.
  - It was fixed in code by `74b28c9`, with no re-run.
- **`74b28c9`** (`74b28c9aaad081d6ec484a07800d87b5069c939f`, the last commit before this report): push run `43732183893` **success**; pull_request run `43732188670` **success**.
  - The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's commit:** a commit cannot name its own runs, so they are named in the session's closing message.

## Next session

B06 continued 3. The opener is in `docs/prompts/session-openers.md`, section "B06 continued 3 — Packs, labels and the reversing order". The parent session is adding the owner's Farm hand decision to it: cost-free LIV read shapes for the Farm hand, covering the list above.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06c-livestock-growth-breeding.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-009 to FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md,
the PRC card in docs/MODULE_BOUNDARIES.md, and ADR-0018. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06 continued 3 only, on branch b06d-packs-labels, branched from main: PRC's packs and labels (prc.pack;
createPacks, listPacks, printPackLabels, whose barcodes follow B05x's LabelBarcode: CODE_128, A-151; the payload
<lot>/<grams, six digits>), the reversing order of FR-PRC-011 (cancelProcessingOrder on a COMPLETED order, reversing
its movements through INV's StockMovements only while every output is unsold; the reversed animal is ALIVE again, which
LIV's register already follows), and the Farm hand's PRC access (A-153). Write the weight and permission tests first.
Extend the seed. Stop at the gate and write docs/sessions/B06d-packs-labels.md.
```
