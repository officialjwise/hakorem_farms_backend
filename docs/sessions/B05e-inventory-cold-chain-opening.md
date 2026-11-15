# B05 continued 4: cold chain, alerts, opening stock and the B5 gate

Date: 2026-11-15 · Branch `b05e-inventory-cold-chain-opening`, from `main` · Pull request #28 · Status: **gate passed**. Temperature readings with automatic quarantine, reorder rules with one alert per crossing, expiry alerts and the refusal to sell an expired lot, the nightly recompute and the daily alerts as scheduled jobs, and the `OPENING_STOCK` import sheet are built and green, and the B5 gate holds in full. **B05x** (`b05x-dashboard-branches-labels`) is next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-147 | **How the cold chain, reorder rules and alerts read FR-INV-007, FR-INV-008, FR-INV-015 and FR-INV-016 where they are silent.**<br>- **Who:** Owner, Manager and Storekeeper manage reorder rules and record readings; the Accountant reads both; no other role (not the Driver) holds either. Alerts read under `inv.stock.read`.<br>- **Readings:** only where master data gives a permitted range; the range is copied onto the reading, so the database checks the excursion flag against it without reading `mdm` (ADR-0047 not widened); both bounds in range; at most five minutes ahead of the server; the client id stores a resubmission once.<br>- **Excursion:** one `TEMPERATURE_EXCURSION` document; a `QUARANTINE` hold from the reading's time on every active lot and animal with stock in the room, placed by whoever recorded the reading (so they never release it); one exception per stock line, untracked stock included; a hold per excursion even on a lot already quarantined.<br>- **Alerts:** available is on hand less reserved less held, in transit and sites left out; `LOW_STOCK` at or below the reorder point, `BELOW_MINIMUM` under the minimum, each raised once and cleared once recovered, judged in every movement, reservation and hold transaction and again daily; `StockAlert.suggestedQty` added. Expiry by the daily job, lead time from the rule (location, then branch) or 3 days.<br>- **Expired:** sale and offline sale refused by the database; processing, transfer and write-off are not.<br>- **Jobs:** the recompute records `SUCCESS` with its drift count, since `ScheduledJob` records only `SUCCESS` or `FAILED` (ADR-0049 not widened). | Owner |
| A-148 | **How opening stock is loaded.**<br>- Only through the `OPENING_STOCK` import, with a new permission `inv.opening_stock.load` (the Owner alone) at each location the file writes; a goods receipt of kind `OPENING` stays refused over HTTP: **A-136 (a) is decided that way**.<br>- One row per untracked line, lot or animal; value at cost above zero; received now, never backdated; refused for a product with any stock history in the branch, so it loads once, before trading.<br>- One goods receipt of kind `OPENING` per location, posted through `GoodsReceipts` as `OPENING_BALANCE` movements from the branch's OPENING location, cost element `PURCHASE` (the accountant may map it in B8).<br>- The export is the empty template. | Owner, accountant for the cost element |

**Needs the owner's approval:**
- **ADR-0050 (proposed):** MDM's `EntitySheet` becomes a port; a higher module registers a sheet with `MdmImports.registerSheet`. INV's `OPENING_STOCK` sheet is the first.
- **No new dependency.** No image or spreadsheet library was added: the spreadsheet codec of ADR-0046 already reads the opening stock sheet, and nothing in this phase renders an image.

I found no ADR conflict:
- ADR-0047 is not widened: the location's range is read through MDM's interface and copied onto the reading; the new view and trigger call only the published `location_stock_facts`.
- ADR-0049 is used as it stands for `stock-balance-recompute` and `stock-alerts`.
- ADR-0019's quarantine on an excursion, ADR-0002's nightly recompute and ADR-0046's imports are built as written.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05 continued 4, the last part of B5.
2. **Scope:** temperature readings with quarantine; reorder rules and stock alerts; expiry alerts and the refusal to sell an expired lot; the nightly recompute and the alerts scheduled through `ScheduledJob`; the `OPENING_STOCK` sheet through a port, and the decision on A-136.
3. **Gate:** the B5 gate in full: on hand from movements matches a hand count of the seeded farm, stock cannot go negative outside the allowed movement types, a lot traces both ways over the API, and every INV write refuses the wrong role.

## Contract changes

**Version 1.20.0, additive, with one changed behaviour.** Nothing a client sends was made required, and a client generated from 1.19.x compiles unchanged. The cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md` now covers 1.20.0.

- **6 operations now run in code** (187 from code, 413 planned): `listReorderRules`, `createReorderRule`, `updateReorderRule`, `listStockAlerts`, `listTemperatureReadings`, `recordTemperatureReading`.
- **Changed behaviour, same shape:** `OPENING_STOCK` on `createImportJob`, `applyImportJob` and `createExportJob` now works, instead of answering `IMPORT_ENTITY_NOT_AVAILABLE`.
- `StockAlert` gains `suggestedQty` (required, nullable).
- **New error codes:** `REORDER_RULE_INVALID`, `TEMPERATURE_READING_INVALID`, `STOCK_UNIT_EXPIRED`.
- **CR-012:** the `listStockTakeLines` example now shows a counting take's lines blind.
- Redocly lint is clean; `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0063:** document type `TEMPERATURE_EXCURSION`.<br>**0064:** `inv.reorder_rule` (MASTER), `inv.stock_alert` (DOCUMENT, one open alert per rule or lot by partial unique index, guard), `inv.temperature_reading` (LEDGER, range copied, `ck_temperature_reading_excursion`), `movement_type.blocked_when_expired` and `inv.protect_expired` (`ck_stock_expired`), and the published view `inv.pub_reorder_level`.<br>**0065, 0066:** five permissions and their grants |
| Domain | `stock-alert.ts` (levels, one alert per crossing, expiry), `temperature.ts` (tenths of a degree), `opening-stock.ts` (row reading), each under a new 100 percent gate. `goods-receipt.ts`: an opening line needs a value |
| Application | **`StockAlerts`:** rules (list, create, update), `evaluateIn` (called by `Stock.postIn`, `Reservations` and `StockHolds` through `AvailabilityWatch`), `evaluateExpiryIn`, the alert list. **`StockAlertSweep`:** the daily job. **`ColdChain`:** list and record, with quarantine through `StockHolds.placeIn`, exceptions and the event. **`OpeningStockSheet`:** INV's `EntitySheet`, posting through `GoodsReceipts.createIn` and `postIn` with `openingStock`. Every movement goes through `Stock.postIn`; no projection is written |
| MDM | `MdmImports.registerSheet` (the port, ADR-0050); `MasterDataRefs` gains a location's temperature class and range and branches, locations and products by code |
| Events | `inv.StockAlertRaised`, `inv.TemperatureExcursionRecorded`, and `inv.OpeningStockLoaded` from each opening movement, through the outbox |
| Platform | `src/worker-app.ts` runs `stock-balance-recompute` (02:00) and `stock-alerts` (06:30) through `ScheduledJob` |
| Interface | `StockAlertsController`, `ColdChainController`, strict zod schemas, 6 fragments; the three MDM import descriptions and `createGoodsReceipt`'s |
| Seed | Three reorder rules at Dodowa (eggs at their reorder point, so one `LOW_STOCK` alert) and two in-range cold room readings, through the services. The hand count is unchanged |
| Docs | ADR-0050 and the decision index; API.md (INV and the error codes); `data-model/inv.md` and DATA_MODEL.md; the INV and MDM cards and section 6; THREAT_MODEL abuse cases 25 and 26; OPERATIONS; ASSUMPTIONS (A-147, A-148; A-128, A-134 and A-136 statuses); CONTRACT_CHANGELOG; the B05x opener names `inv.pub_reorder_level` |

## Decisions

- **ADR-0050 (proposed):** import sheets contributed by higher modules.
- **A-136 (a) decided:** a goods receipt of kind `OPENING` stays refused over HTTP; opening stock enters only through the import (A-148).
- Everything else is a reversible reading, recorded as A-147 and A-148.

## Contract requests

`../frontend/docs/CONTRACT_REQUESTS.md` was read on 2026-11-15; it is unchanged since CR-008. The copy from the frontend's `f05-stock` branch lists CR-009 to CR-012:
- **CR-012 (INV): implemented.** The counting example's lines now carry `expectedQty`, `recountQty` and the variance fields as null. The description already said which statuses carry them.
- **CR-009, CR-010, CR-011 (MDM: price list preview, price list examples, units of measure): declined for this phase.** They belong to MDM, and this phase is INV only. They are left for the next session that opens MDM, and nothing here blocks them.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 back office, and the database. I ran `SECURE_CODING_STANDARDS.md` item by item on the opening stock import and on temperature quarantine; it passed.
- **Authorisation:** every handler calls `Authoriser.authorise`, deny by default:
  - readings and rules are scoped to their location or branch;
  - opening stock is authorised at each location the file writes, on top of `mdm.import.apply`.
  - The handler walk and the no-grant walk cover the 6 new operations. The B5 walk proves that all 24 INV writes refuse the Accountant, Cashier, Sales, Driver and Farm hand.
- **Maker-checker:** a quarantine is released by someone other than the person who recorded the excursion (proved, `RELEASED_BY_PLACER`). Opening stock is the Owner's alone, and the Manager's apply is refused with nothing written.
- **Database:** the excursion flag is checked against the copied range; readings reject update and delete; one open alert per rule or lot; an expired lot's sale is refused for every role, even by direct SQL.
- **Input:** strict schemas with unknown fields refused; parameterised SQL only; every opening row is checked again in the apply transaction (ADR-0046). The file is CLEAN-only and read outside the transaction.
- **Not applicable, with reason:** payments, webhooks and uploads are unchanged (the import upload is ADR-0044's); there is no personal data in these tables; the opening stock export is a template with no data.
- **Abuse cases:** 25 (a hidden cold room failure, or quarantined meat sold) and 26 (stock value from nothing through opening stock) are added. Their daily exception report items are B12's, as for cases 7 and 20 to 24. A cold room with no reading at all is not detected yet.

## Deferred

- **To B05x:** the low stock tile reads `inv.pub_reorder_level`.
- **To B8:** the posting of `inv.OpeningStockLoaded` and the opening stock cost element (A-148).
- **To B9b:** the offline sale of an expired or quarantined lot, recorded as a conflict (ADR-0027).
- **To B12:** the daily exception report items for abuse cases 25 and 26, and the check for a cold room with no reading in a day.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **719 passed** (23 new: `stock-alert.spec.ts` 11, `temperature.spec.ts` 6, `opening-stock.spec.ts` 5, `goods-receipt.spec.ts` 1; `stock-exception.spec.ts` and `imports.spec.ts` extended) |
| Integration | **706 passed** (unit and integration together, under coverage: **1,425 passed**). New:<br>- `cold-chain-alerts.integration.spec.ts` (21): readings in range and at the bound; refusals (no range, virtual, ahead of the clock, two decimals); one stored per client id; update and delete refused; the excursion check in the database; the list and its scope; the -9.5 °C excursion (two holds from the reading's time, two exceptions, one event); sale refused under quarantine; release by the recorder refused and by the Owner audited; recording refused to six roles; the yam rule through one crossing, a recovery and a second crossing; a reservation raising `BELOW_MINIMUM`; one open alert per rule in the database; `pub_reorder_level` read as `hk_report`; update with version, stale and wrong roles; expiry five days out, sale on the date, `STOCK_UNIT_EXPIRED` the day after (online and offline), `EXPIRED` raised and `EXPIRING` cleared; the expired sale refused by direct SQL.<br>- `opening-stock.integration.spec.ts` (8): the dry run; nine row errors by row and column; storekeeper refused; Manager's apply refused with nothing written; the Owner's apply (three receipts, four movements at 150,000, 150,001, 340,000 and 120,000 pesewas from the opening location, four `inv.OpeningStockLoaded`, pools 760,001); a second load refused; `OPENING` receipt still refused; the template export.<br>- `seeded-stock-gate.integration.spec.ts` (+3): negative stock on the seeded farm; the walk of all 24 INV writes against five roles.<br>- `worker.integration.spec.ts` (+1): `stock-balance-recompute` and `stock-alerts` run as the Scheduler and record `SUCCESS`.<br>- MDM import tests now expect `OPENING_STOCK` to reach its sheet |
| Coverage, merged | Statements 94.42 percent and branches 85.30 percent (gate 80). Every 100 percent gate holds: valuation, stock take, hold, stock exception, reservation, availability, and the new stock alert, temperature and opening stock gates |
| Contract | **53 passed**, including the rule, alert and reading shapes. The versioning check against `main` passes |
| Lint, type check, schema names, Redocly | Clean |
| End to end | Runs in CI |

The rules on money, stock, weight and permission were tested against real PostgreSQL:
- The two new integration suites were written before their run and went red first:
  - `cold-chain-alerts`: 6 of 21 failing at first, 5 of them on code faults (a version not moved, the job without its system context).
  - `opening-stock`: 1 of 8 failing at first (a zero value reported twice).
- The opening line's value rule (`goods-receipt.spec.ts`) was run red before the change.
- The three new domain specs were written alongside their code, not run red first. That is a departure from the test-first rule, recorded here.

## Gate

**Passed.** Each part was proven by running it against real PostgreSQL, over the HTTP API and the in-process interfaces:
- **On hand from movements matches a hand count of the seeded farm:** `seeded-stock-gate`, unchanged by this phase's seed. Every Dodowa location matches `SEED_HAND_COUNT`, GHS 15,955.01 at cost, and agrees with a fresh sum of the ledger; the nightly recompute finds no drift, and it now runs as a scheduled job.
- **Stock cannot go negative outside the allowed types:** on the seeded farm, 41 yams from 40 are refused for a counter sale. The offline sale is refused too, at the pens and at the shop floor, because neither location allows negative stock; on hand is unchanged and no drift is found. The allowed path (offline sale at a location that allows it, below zero with one exception) remains proven in `stock-invariants`.
- **A lot traces both ways over the API:** LOT-GOAT-0002 back to G-0143, its supplier and its costs, and G-0143 forward to the lot and its sale, one request each.
- **Every INV write refuses the wrong role:** all 24 INV writes answer 403 `FORBIDDEN` to the Accountant, Cashier, Sales, Driver and Farm hand, and each suite proves its own refusals.
- **This phase's parts:**
  - A -9.5 °C reading in the frozen cold room quarantines both meat lots, with two exceptions and the event, and the beef lot's sale is refused until a different person releases both holds.
  - The yam rule raises nothing from 40 to 21, one alert suggesting 81 at 19, none at 18, clears above 20 and raises again.
  - The eggs alert five days before their expiry; they sell on their date and are refused the day after, `EXPIRED` raised.
  - Opening stock posts at its exact cost (760,001 pesewas) once, and never through a receipt.

## Notes for the frontend track

- **Alerts:** `onHandQty` on a level alert is what is available now, and `suggestedQty` reaches the maximum; on an expiry alert, `daysToExpiry` is negative once the lot has expired.
- **Readings:** a reading outside the range answers 201 with `isExcursion: true`. Expect `STOCK_UNIT_ON_HOLD` on the room's lots until each hold is released.
- **Opening stock** is an import (`entity: OPENING_STOCK`) that only the Owner applies; the export downloads the template.
- Show `STOCK_UNIT_EXPIRED` on a sale screen as "past its expiry date: write it off".

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`a0d6413`** (`a0d64134d6e44f729b528e636b25fd07b61f2f6f`, the last commit before this report): push run `43706590672` **success**; pull_request run `43706620238` **success**. The pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite.
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B05x. The opener is in `docs/prompts/session-openers.md`, section "B05x — Dashboard tiles, branch management and label data, pulled forward for the frontend":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md, and the newer copy from the frontend's f05-stock branch if the
parent session saved one (it lists CR-009 to CR-012): implement what is reasonable, record in the report
what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and MDM (branches and locations) requirement blocks of docs/SRS.md and NFR-023
(nothing else from the SRS), the RPT, MDM and INV cards in docs/MODULE_BOUNDARIES.md, ADR-0011 (published
views), ADR-0023 (the reporting read model), ADR-0026 (Amendments), ADR-0042 and ADR-0047, and the planned
contract's getOwnerDashboard and printPackLabels. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05x only, on branch b05x-dashboard-branches-labels, branched from main:
1. Dashboard tiles in RPT, one operation per tile, each reading only published views (ADR-0011, ADR-0023),
   scoped to the branches the caller holds rpt permissions at, money as integer pesewas, with asOf:
   stock value at cost, animals on hand (serialised live stock units on hand, by species), low stock count
   (products at or below their reorder point, from INV's published view inv.pub_reorder_level, built in
   B05 continued 4), and a purchases time series over a period (posted goods
   receipts at cost, per day in Africa/Accra) - all built now over INV's published views; and, in the
   contract only, today's sales, cash position, outstanding receivables and a sales time series, whose
   sources are BIL (B8), ORD and PAY (B9a) and POS (B9b). Never answer one of those from code before its
   source exists: a 200 with a zero would be a placeholder. Add a line to the B8, B9a and B9b openers
   naming the tile each must make live. Keep the planned getOwnerDashboard for B12 (NFR-023: one round trip
   for the whole screen); the per-tile operations are the owner's addition, and each tile is useful alone.
2. Branch and location management where B04d continued 2 left gaps: deactivate (and reactivate) a branch
   with its refusals (not the last active branch, not one holding stock or open documents, not the
   farm's own), and listBranches and listLocations scoped to the caller's grants. Kasoa and KNUST are real
   selling points the owner will create through the API: do not seed them as SEED data.
3. Label data for printing lot and product barcodes, if the contract does not expose it: a read that
   returns what a label prints (code, name, lot, weight, dates, the barcode payload and its symbology),
   no image rendering. printPackLabels stays B6's.
Each operation with a wrong-role refusal, written test-first; update the cold-read summary at the top of
docs/CONTRACT_CHANGELOG.md with every contract change. Record the schedule change in ADR-0026
Amendments.
Stop at the gate, write docs/sessions/B05x-dashboard-branches-labels.md, and merge into main when every
run on the pull request is green.
```
