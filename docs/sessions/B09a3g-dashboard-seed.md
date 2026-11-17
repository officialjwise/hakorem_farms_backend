# B09a continued 2g: the dashboard's sales figures and the seeded trading day

Date: 2026-11-17 · Branch `b09a3g-dashboard-seed`, from `main` (`f8bd7ac`) · Pull request #79 · Status: **gate passed**. No split. B09x runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-234 | **The dashboard's sales figures as built.** (a) ORD publishes `ord.pub_completed_sale` and `ord.pub_completed_sale_line` (0206); RPT reads only them and `mdm.pub_product`. (b) A sale is a `COMPLETED` order's gross total on the Africa/Accra business date it **completed** on, the day boundaries from the application clock; a VOIDED, cancelled or open order is not a sale. (c) **A completed return does not change the sales figures** (FR-RPT-001 defines them as completed orders' gross; netting a credit note on its approval day could make a day negative, which `Pesewas` cannot carry without a breaking change); a returns figure is parked as BL-071. (d) Month to date from the first of `date`'s month; all four channels listed, a channel with no sale at 0; top movers the five products with the highest gross, a tie by SKU, a product in two units two rows; real zeros, never nulls; `pendingFigures` keeps `alerts` and `exceptionsToday`. (e) `getSalesTodayTile` refuses a date after today with 422 `REPORT_PERIOD_INVALID`. | Owner (b, c, d), Accountant (c) |
| A-235 | **The seeded trading day as built.** The seeded cashier (Adwoa Darko, added to the seed's acting staff) posts three sales at Dodowa through `SalePosting.postIn` on the seed calendar's `today`: goat G-0142, 2 crates of eggs, 3 cabbages and 3.500 kg of goat meat wholesale (80,430 cash); 1 crate collected online and paid on collection (6,000); 4 yams wholesale (8,000 cash), into till `T1`. **It is its own seed unit**, added by `seedUnits(env, { tradingDay: true })`: `pnpm db:seed` (and so `pnpm run setup` and the CI end-to-end job) always adds it, as do the tests that read the day; the farm the other eighty test files load is unchanged, so the B5 hand count and every exact amount they assert stay true without editing one. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-235.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2g (`b09a3g-dashboard-seed`, from `main` at `f8bd7ac`).
2. **Scope:** the dashboard's six B9a figures and the tiles `getSalesTodayTile` and `getSalesSeries` from completed orders through a published ORD view; the seeded trading day through `SalePosting`.
3. **Gate:** exact pesewa figures from completed orders through a published view (VOIDED not a sale, returns as decided), every wrong role refused, the tiles agreeing; the seeded trading day keeps the B5 hand count, the trial balance at 0 and every existing exact amount true.

## Contract changes

**1.52.0, minor. No field removed, renamed or retyped, no schema's shape changed, nothing a client sends made required, no error code added.**
- `getSalesTodayTile` and `getSalesSeries` move into code with exact descriptions and their `x-error-codes`; `getSalesTodayTile` gains a `422` (`REPORT_PERIOD_INVALID` for a date after today) and a description of `date`.
- `getOwnerDashboard`'s six sales figures answer numbers where they were null, and `pendingFigures` lists only `alerts` and `exceptionsToday`: the change the schema and CR-013 planned (a figure is null exactly while it is listed). Named in the changelog's cold-read summary. Its `beforeSalesAndBilling` example becomes `beforeExceptionReport`; `OwnerDashboard` describes the sales fields.
- 419 operations from code, 216 planned. `contract:generate --check` is up to date, Redocly is clean with no warnings, and the versioning check against `main` passes.

## Built

| Area | What |
| --- | --- |
| ORD database | 0206: the published views `ord.pub_completed_sale` (each `COMPLETED` order: branch, channel, `completed_at`, its Accra business date, its gross) and `ord.pub_completed_sale_line` (each line of one: product, the quantity sold, the weighed kilograms for a per-kilogram line, and the line's gross), granted to `hk_app`, `hk_worker` and `hk_report`; `ix_sales_order_completed`. Neither view reads the clock. |
| RPT domain | `PENDING_FIGURES` keeps `alerts` and `exceptionsToday`; `monthToDate`, `CHANNELS`, `sumCounts` (`dashboard.ts`); `salesByChannel` and `topMovers` in pesewas (`sales.ts`). 100 percent under the `rpt/domain/**` gate. |
| RPT application | `Dashboards.getSalesTodayTile`, `getSalesSeries`, and `getOwnerDashboard`'s six figures, each authorised in the handler (`rpt.tile.read`, `rpt.dashboard.owner`) and dated by the application clock. `DashboardStore.salesByDay`, `salesByChannel`, `productSales` over the published views only. |
| Interface | `GET /dashboard/tiles/sales-today`, `GET /dashboard/tiles/sales`. |
| Seed | `src/seed/farm-ord.ts` (`SEED_TRADING_DAY`, the unit `ord-trading-day`), `SeedOptions.tradingDay`, the cashier in `SEED_STAFF`, `pnpm db:seed` adding the day. |
| Docs | A-234, A-235, BL-071; `docs/data-model/ord.md`; the ORD and RPT cards; API.md (RPT); the changelog; ADR-0026 Amendments; the openers (2g marked run). |

No permission is added; no ADR is needed (A-234 reads FR-RPT-001 and contradicts no ADR: RPT reads published views only, ADR-0011 and ADR-0023; the views decide nothing by the clock, ADR-0067).

## The gate, proved by running it

`test/integration/rpt/dashboard-sales.integration.spec.ts` (15 tests) loads the seeded farm with its trading day against real Postgres.

- **The trading day** posted three sales through `SalePosting`, each COMPLETED, numbered `SO-…-DDW-…` and paid in full by the seeded cashier: 80,430, 6,000 and 8,000. A second run of the seed with the day changes nothing.
- **The B5 hand count holds:** on hand at every Dodowa location is exactly `SEED_HAND_COUNT` less `SEED_TRADING_DAY.sold`, and a fresh sum of the movement ledger agrees. The day issued **122,300** at cost (by hand: the goat's pool 60,000; eggs 7,000 then 3,500; cabbages 1,500; 3.500 kg of goat meat at 13,000 a kg, 45,500; yams 4,800), so stock stands at **1,667,201**, as the dashboard values it.
- **The books:** the trial balance sums to exactly **0**; `LedgerReconciliation` finds no unbalanced entry and no break; cost of sales equals the cost issued; the till holds **94,430** (`cash.tillsPesewas`, every other bucket 0); receivables are unchanged at 109,389, overdue 0.
- **The dashboard:** today **94,430**, yesterday 0, month to date 94,430; by channel POS 0, ONLINE 6,000 (1), WHOLESALE 88,430 (2), QUOTE 0, summing to today; top movers goat 58,500 (1.000 HEAD), eggs 18,000 (3.000 CRATE), yams 8,000 (4.000 TUBER), goat meat 6,930 (3.500 KG), cabbage 3,000 (3.000 UNIT); the week's series 0 for six days and 94,430 over 3 orders today; `pendingFigures` only `alerts` and `exceptionsToday`.
- **The tiles agree:** `getSalesTodayTile` 94,430 over 3 orders (Manager); `getSalesSeries` 30 days ending today with the same point (Accountant), and a one-day period; yesterday's tile 0. The test branch answers exact zeros. A future date, a 93-day period and a reversed one are 422 `REPORT_PERIOD_INVALID`; an unknown parameter 400.
- **A VOIDED order is not a sale:** a cashier asks to void the yam sale and it still counts while waiting; once the Owner approves (step-up), today, the month and the series are **86,430** over 2 orders, WHOLESALE 80,430 (1), and the yams leave the top movers.
- **A completed return leaves the figures as they were:** one cabbage returned (made and submitted by a cashier, approved by the Owner, COMPLETED): still 86,430 over 2 orders, the cabbage line still 3.000 and 3,000.
- **Midnight in Accra:** with the application clock at the next day, the seeded day is yesterday at 86,430, today 0, the month to date 86,430 or 0 by whether the month turned (computed from the clock), no top movers, and the tiles take today from the application clock too.
- **Wrong roles refused:** the owner dashboard to the Manager, Accountant, Storekeeper, Cashier, Sales, Driver and Farm hand (403); both sales tiles to the last five (403), and answered for the Owner, Manager and Accountant; a branch outside the grants 403.
- **Published views only:** the store's three new reads answer as the reporting role (`hk_report`), which is refused `ord.sales_order` and `ord.sales_order_line` (42501).

`test/contract/b9/dashboard-sales.contract.spec.ts` checks `OwnerDashboard` (week and month), `SalesTodayTile`, `SalesSeriesTile` and the `Error` refusals on the seeded day. The B5x dashboard spec now expects real zeros for the sales figures on the farm without the day, and the sales tiles answer its dashboard's figures.

**B9a's one-transaction proof stands:** every seeded sale goes through `SalePosting.postIn`; `ord/sale-posting` and the other ORD specs pass unchanged.

### Mutation runs (scratch, never committed)

Each rule was broken on its own in scratch (the file restored afterwards) and the new spec run. The test data has distinct people: the seeded cashier who posted the sales, a different cashier who asked the void and made the return, and the Owner who approved both.

| Mutation | Result |
| --- | --- |
| M1 `pub_completed_sale` counts VOIDED orders | red (4 tests) |
| M2 `getSalesTodayTile` asks `rpt.dashboard.owner` | red (3) |
| M3 the tiles skip authorisation | red (2) |
| M4 month to date from the date itself | red (1, and the unit spec) |
| M5 top movers ranked ascending | red (2) |
| M6 `pub_completed_sale_line` lists every status | red (2) |
| M7 `getSalesTodayTile` dates today by the real clock | **green**, then red: the midnight test then asked the tiles for today with the application clock a day on (added before the run that went red) |
| M8 `getSalesSeries` dates today by the real clock | red (1) |

Not mutable to a different answer: reading the business date in UTC instead of Africa/Accra, which keeps UTC all year.

## Test first, as it honestly happened

- **The domain unit tests** (pending list, month to date, channels, top movers, the largest sum) were written before the domain code and were red, 5 failing; then green. A same-SKU tie case was added afterwards for the 100 percent branch gate.
- **The integration and contract specs** were written after the store, application and seed code, and proved by the mutation run above (M7 found a gap, closed before the final run).
- **The seed's first run failed** on its own data: the yam sale was tendered at a guessed 4,800 (`TENDER_SHORT`); the engine's list is 2,000 a tuber, so 8,000. The first spec run then failed on the top movers' order the test had guessed (yams 8,000 rank above the goat meat 6,930); fixed in the test.
- **Stale tests updated because this phase made them stale:** the B5x dashboard spec (pending list, the sales tiles no longer 404), the drift counts (419 from code, 216 planned), the IAM handler walk (two new routes), the 0155 rollback walk (0206).
- Nothing was skipped, quarantined or retried, and no test was re-run to turn it green.

## Decisions

- How a completed return counts (A-234 (c)), and the trading day as its own seed unit (A-235). Both reversible without a contract change.

## Security review

Read-only endpoints; no new permission, grant, secret or personal data. Authorisation in the handler through IAM's `Authoriser` (ADR-0035), branch scope as the other tiles; the views carry no customer, contact or price-band field; parameterised SQL only; `console` rate limit.

## Deferred

- **BL-071:** a returns figure beside the sales (no screen has asked).
- `getDailySales` (FR-RPT-003) and the report codes of CR-018 stay B12's.
- Counter sales (POS) reach these figures from B9b; online orders' own posting from B11.

## Contract requests

I fetched the frontend's `main` at `0efb338`, the same commit 2c to 2f read. It lists CR-001 to CR-033, and nothing is new or changed.
- **CR-013: done.** The last of its figures (today's sales, yesterday's, the month, by channel, top movers and the sales series) answer from completed orders; `pendingFigures` (its `unavailable`) lists only the alerts and the exception count, which are B12's.
- **CR-031, CR-032 and CR-033** stay placed in B9b, with B11 for CR-033's SMS (CR-033 and CR-032 point 2 placed by the parent).
- **CR-005, CR-023, CR-027 and CR-028** stay with B09x, which runs next.
- **CR-018** (report codes) stays with B12's `runReport`.
- The others were answered in earlier phases. No request is unplaced larger work.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,456 passed** (new: 4 in `rpt/domain/dashboard.spec.ts`, and the pending list changed) |
| Integration | **1,465 passed** (new: 15 in `rpt/dashboard-sales`) |
| Coverage, merged (`pnpm test:coverage`) | **2,921 passed**, 235 files, exit 0. Statements 93.74 percent, branches 83.59 percent (gate 80), functions 97.21, lines 96.37. Every 100 percent gate held, `src/modules/rpt/domain/**` (with the new `sales.ts`) included |
| Contract | **101 passed** (new: `b9/dashboard-sales.contract.spec.ts`). `contract:generate --check` up to date (419 from code, 216 planned); Redocly clean; the versioning check against `main` passes |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found 284 specs in place; schema names and lint fixtures pass. The money lint (no number arithmetic beside `Money`) fired twice on the first draft, so the pesewa rules moved to `rpt/domain/sales.ts` and the counts to `sumCounts` |
| End to end | CI only (its `pnpm run setup` now seeds the trading day) |

No local run was red apart from the first runs named under "Test first".

## Gate

**Passed.**
- The owner dashboard's six B9a figures answer exactly, to the pesewa, from completed orders through ORD's published views: a VOIDED order is not a sale, and a completed return leaves the figures as they were (A-234).
- `getSalesTodayTile` and `getSalesSeries` answer the same figures; every wrong role is refused.
- The seeded trading day, posted through `SalePosting`, keeps the B5 hand count (less exactly what it sold), the trial balance at 0 and every existing exact amount true.

## Notes for the frontend track

- **Contract 1.52.0:** wire the sales tiles to `salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `topMovers` and `salesSeries`; they leave `pendingFigures`. A 0 is a real zero now.
- `getSalesTodayTile` and `getSalesSeries` answer from the API. Returns are not taken off the sales; they are a separate figure not yet built (BL-071).
- `pnpm run setup` now seeds a trading day: three sales today at Dodowa, 94,430 in all.

## CI

- **`fd4a7c3`** (all code, tests and documents before this report; pull request #79 was opened on it): run **44036155322 (push)**, success; run **44036176077 (pull_request**, which also compares the contract with `main`), success. Nothing was red and nothing was re-run.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09x, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09a3g-dashboard-seed.md, or the last
report of its own splits).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), in particular CR-005 and
CR-023: implement them, answer every other request in the report, never edit that file and never open frontend source.
For this phase, read docs/API.md (examples and lists), scripts/contract/, the IAM seed migrations and
ADR-0038. Load hakorem-endpoint, hakorem-seed and hakorem-tests.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09x only, on branch b09x-contract-requests, branched from main: a named empty example (`empty`) on
every list operation, generated by one scripted pass over the fragments and the planned file and kept by a contract
test; the seeded role matrix published in the contract from the IAM seed, generated and checked in CI; CR-023's
confirmation of the Farm hand's grants answered from the seed in the report. The published matrix must show the
credit-note grants as the owner set them on 2026-11-16 (migration 0174): `bil.credit_note.create` for the Owner, the
Accountant and the Manager, never the Cashier, and `bil.credit_note.approve` for the Owner and the Manager.
Also (A-205): allocate `pur.supplier_payment.payment_no` from its `SPY` series through `platform.allocate_number` in the
transaction that marks the payment paid, test-first with a concurrent gap-free test, and print it on the remittance
advice in place of the payment id (load hakorem-documents and hakorem-migration). Examples and an extension only: a
contract minor version, a changelog entry, and the cold-read summary updated.
Also, from the owner (2026-11-16), each test-first with its wrong-role refusal:
(1) The Farm hand's death report always needs a photograph, whatever its value: the role cannot see the value, so it
cannot know when the threshold applies (the frontend already requires it). Enforce it on the server in the care
operations (reportCareMortality and submitCareMortalityRecord refuse a Farm hand report without its EVIDENCE photograph,
MORTALITY_PHOTO_REQUIRED), with a test below the 50,000 threshold; every other maker keeps the threshold rule unchanged,
also tested.
(2) CR-027: an approval request for a processing reversal links to its order, additively: an optional
`ApprovalRequest.relatedDocument` (`DocumentRef`) naming the order, or `reversalId` on listProcessingOrders, whichever
is cheaper. Never change the existing `subject`, which stays the reversal.
(3) CR-028: getShopProfile (GET /shop/profile), anonymous and cacheable: the trading name, a phone and a WhatsApp number
in E.164, the farm's address and directions, and opening hours, read from the business profile; it exposes nothing
else from it (no TIN, bank or staff detail), proved by a test of the response's keys; the seed uses invented,
clearly fictional numbers (hakorem-seed).
Stop at the gate, write docs/sessions/B09x-contract-requests.md, and merge into main when every run on the pull
request is green.
```
