# B09t2: seed and test dates from the clock, before they expire

Date: 2026-11-16 · Branch `b09t2-dates-from-clock`, from `main` (`3fcede5`) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-220 | **The seeded farm's dates come from the seed's clock.** `src/seed/seed-calendar.ts` builds every seeded date from the business day the seed's clock reads, once per seed run. Prices, tax, the caterer's list and the promotions take effect 15 days before, at 06:00. The stock arrives 6 days before, at 07:00, and is weighed and logged in the cold room that day. The eggs last 21 days and the meat 90. WELCOME10 runs 135 days and XMAS-MEAT-5 51 days. A run on 2026-11-16 seeds exactly the earlier fixed dates, so no amount moves. Lot numbers that contain a date are names, so they are kept. The fixed assets' 2026 acquisition dates are past history that no rule reads against today, so they are kept too. | Owner |
| A-221 | **A refund's `created_at` is the application's instant.** `markRefundPaid` refuses a payout dated before its refund, so `Refunds.request` writes `created_at` from its clock, as a charge's already was (the exception A-217 names). | Owner |
| A-222 | **A test's dates are built from its clock, or the test pins its clock.** `fin/year-close` closes the year 2026, so it pins its `ManualClock` to 2026-11-16T10:00Z and passes it to the application and the seed. Two kinds of fixed date stay: request bodies that a role refusal never reads, and schema tests that assert a rule between two explicit dates. Neither outcome depends on today. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216 to A-222.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09t2 (`b09t2-dates-from-clock`, from `main` at `3fcede5`), inserted by the parent session and urgent before 2026-12-01.
2. **Scope:** four items. (1) Seeded expiry, best-before, due and valid-from or valid-to dates relative to the seed's clock, plus every other fixed date the seed and the tests carry. (2) The locked-period statement test in any month. (3) The refund payout check against an instant the application wrote. (4) file-store's signed link recorded as a container artifact.
3. **Gate:** no seed row and no test depends on a fixed calendar date that real time will pass. The full integration suite passes with every test file's clock forced to 2026-12-31T10:00Z and to 2027-03-01T10:00Z. The only allowed failures are those caused by a container's own clock, each named. Nothing is skipped or loosened.

## Contract changes

None. The contract stays at **1.46.0** and no shape changed. No operation was added or touched, so `contract:generate` has nothing to regenerate.

## Built

| Area | What |
| --- | --- |
| Seed | `src/seed/seed-calendar.ts` defines `seedCalendar(now)`, `seedRunCalendar()` (one calendar per run, read from the application's `CLOCK` by the first unit that asks) and `addDays`. `seedUnits` passes the run calendar to the MDM, INV and LIV units. The changes: `SEED_INSTANT` (2026-11-01) becomes `pricesFrom`; `SEED_STOCK_RECEIVED_AT`, `SEED_WEIGHED_AT` and the cold room readings follow the calendar; the receipt lines name the expiry they carry (`eggsExpireOn`, `meatExpiresOn`) instead of a date; each promotion names its end (`welcomeOfferEnds`, `christmasOfferEnds`) instead of a `validTo`. Unit test: `src/seed/seed-calendar.spec.ts`, 4 tests. They cover the 2026-11-16 farm to the second, a year end and a leap day, `addDays`, and one clock read per run across midnight. |
| PAY | `PgPaymentStore.insertRefund` writes `created_at`. `Refunds.request` passes `this.clock.now()`, and `PaymentStore.insertRefund` takes it. |
| Tests | These now read the seed calendar: `inv/labels`, `inv/cold-chain-alerts` (the expiry alert, the sale on the expiry date, the refusal the day after and the database's `ck_stock_expired`, all from the eggs' expiry), `liv/livestock` (`lastWeighedAt`), `rpt/dashboard` (the seed day and the series around it), `fin/financial-statements`, `fin/trial-balance` and the contract `b7/credit-scores` (scored for the month the stock arrived in). Built from the test's clock: `inv/opening-stock` (the pork and wings expiry), `pur/supplier-register` (the health certificate) and `inv/seeded-stock-gate` (`LOT-GOAT-0002`). `fin/financial-statements` locks the period that holds the seeded 6800 posting, found from the posting. `fin/year-close` pins its clock to 2026. `pay/refunds` has one new test. |
| Docs | A-220 to A-222. ADR-0067 gains a B09t2 verification note. `docs/data-model/pay.md` records both application-written `created_at`s. TEST_STRATEGY section 8.6 now forbids fixed calendar dates and names the two ways around them. The B09a continued 2b opener names the seed calendar. |

## The sweep, before and after

Method: the scratch tool from B09t, never committed. A setup file starts each test file's `Date` at the forced instant and lets it run on from there. It was added to the unit, integration and contract projects in a copy of the checkout, and the checkout itself never held it. The database, Redis and object store containers keep their real clocks.

| Run | Before (main at `3fcede5`) | After the seed fix (`8cc7d12`) | After everything (`2786186`) |
| --- | --- | --- | --- |
| Integration at 2026-12-31T10:00Z | 19 failed in 5 files: `sale-posting` (10), `storefront-checkout` (7), `order-payment-rules` (setup), `financial-statements` (1), `file-store` (1) | 1 failed (`file-store`) | **1 failed (`file-store`)**, 1,369 passed |
| Integration at 2027-03-01T10:00Z | 55 files failed: in 53 the seed itself failed (XMAS-MEAT-5 ended 2027-01-06, `WINDOW_PASSED`), plus `platform/seed` (9) and `file-store` | 12 failed in 4 files: `year-close` (5), `opening-stock` (5), `supplier-register` (1), `file-store` (1), each hidden before by the seed's failure | **1 failed (`file-store`)**, 1,369 passed |
| Contract at 2026-12-31 / 2027-03-01 | 2 failed / 17 files failed (the seed) | 0 / 1 (`credit-scores`, fixed in the same commit) | **95 passed / 95 passed** |
| Unit at both instants | 1,398 passed | | **1,402 passed** both |
| Integration at B09t's moments: 2026-11-17T23:55Z (Accra midnight), 2026-11-30T23:55Z (month end) | | | **1 failed (`file-store`)** at each |

**What the sweep found, beyond the opener's list:**
- **XMAS-MEAT-5 ended on 2027-01-06**, fixed in the seed. The promotion service refuses to submit a promotion whose window has passed, so from 2027-01-07 every suite that loads the seeded farm would fail in its setup. That is 53 integration files and 17 contract files.
- **The supplier scores contract test** asked for the scores of the clock's month. Real CI would have failed it in the first six days of every month, whenever the seeded receipt fell in the previous month.
- **Four tests had their own fixed future dates:**
  - the opening stock's pork lot (2027-01-30) and wings (2027-01-01)
  - a health certificate (2027-02-28)
  - the traced lot `LOT-GOAT-0002` (2027-02-12), which is sold at the clock's instant
- **`fin/year-close` moved its clock to fixed instants** (2026-12-28, 2027-01-05). After those dates the move goes backwards, and the seeded day falls outside 2026.

**Still failing, with the reason: `doc/file-store` › *refuses a link with one extra character in its signature, and one used five minutes and a second after it was signed*.** It fails under every forced instant. The cause is the MinIO container, which checks a presigned URL's expiry against its own real clock. The forced test process signs the link "in the future", so the container still accepts it five minutes and a second later. This is a container artifact, not a defect. In production, the API and the object store read the same real time. On the real clock the test passes (it ran in the coverage run below). Forcing the process's clock cannot fix it; only the container's own clock could.

## Test first, as it honestly happened

- **The refund payout (opener item 3):** `pay/refunds` › *asks a refund at 23:58 Accra, records its payout after midnight: refused a second before the refund was asked, paid at its own instant*. It was red first. The refund's `created_at` was the database's 2026-11-16T23:05:05Z against the application's 2026-11-17T23:58:01Z. With that assertion set aside on purpose, the behaviour was red too: a payout dated a second before the refund was recorded `PAID`. With the fix, both refunds files pass (31 tests). The test logs a fresh team in after the clock moves, because the jump to midnight outlasts the earlier sessions' 12-hour idle limit.
- **The seed calendar:** the forced sweep failed before and passed after, as the table shows. Its unit test was written with the module and passed on its first run. The 2026-11-16 case pins the old fixed dates, so every amount the suite asserts stayed the same: no pesewa figure in any test changed.
- **The locked-period statement (opener item 2):** it fails at both forced instants before the change and passes after.
- No test was skipped, loosened, retried or re-run to turn green, and nothing was quarantined.

## Decisions

- No new ADR. ADR-0067's second rule (no fixed calendar date in the seed or a test) is applied, not changed. A refund's `created_at` is the exception ADR-0067 already names, so it gets a verification note and A-221. No ADR is contradicted.
- The fixed assets' acquisition dates (January to March 2026) stay fixed (A-220). They are past history. The tests that charge depreciation name 2026's periods, which stay ended, and the sweep at 2027-03-01 proves none of them depends on today.

## Deferred

- **A later horizon, not a defect today:** migration 0123 creates accounting periods for 2026 to 2030 only. From 2031-01-01 the seeded farm has no period to post into. Whatever creates later years' periods belongs to FIN's operations work, and B13's runbooks are the right place to schedule it. I did not add it to BACKLOG: it is outside this phase.
- `doc/file-store`'s forced-clock failure stays, as described above.

## Contract requests

I fetched the frontend's `main` at `382a820`, the same commit B09a continued 2 read. It lists CR-001 to CR-033, and nothing is new.
- **CR-033** (a digital receipt opened from a link, made offline, its SMS sent once on sync) is still **not built, and named for the parent to schedule**, as in the last report. It is larger than additive: a new anonymous endpoint, an offline-safe token design, its abuse review and an SMS through NTF. It belongs with B9b's sync, with NTF's send in B11.
- CR-013 stays with B09a continued 2b. CR-031 and CR-032 stay with B9b. CR-005, CR-023, CR-027 and CR-028 stay with B09x. CR-029 was built in 1.46.0. The others were answered in earlier phases.
- This phase built no endpoint, so no request was taken here.

## Tests (this machine, 2026-11-16, real clock)

| Layer | Result |
| --- | --- |
| Unit | **1,402 passed** (new: 4 in `src/seed/seed-calendar.spec.ts`) |
| Integration | **1,370 passed** (new: 1 in `pay/refunds`) |
| Coverage, merged (`pnpm test:coverage`) | **2,772 passed**, 223 files, exit 0 (the run before the container restart was lost and re-run). Statements 93.56 percent, branches 83.34 percent (gate 80). Every 100 percent gate held. `doc/file-store` passes on the real clock |
| Contract | **95 passed**, 36 files. `contract:generate` has nothing to regenerate (no interface changed) |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored; the test placement check found all 267 specs in place |
| End to end | CI only |

## Gate

**Passed.**
- No seed row depends on a fixed calendar date that real time will pass. Every seeded expiry and valid-from or valid-to date comes from the seed calendar (A-220).
- No test does either. Each test date is built from its clock, read from the seed calendar, or comes from a pinned clock (A-222). The kept fixed dates are listed in A-220 and A-222.
- The full integration suite passes at 2026-12-31T10:00Z and at 2027-03-01T10:00Z, apart from one named container artifact (`doc/file-store`). It also passes at B09t's Accra midnight and month end, and the contract and unit suites pass at both instants.
- The refund payout check compares against an instant the application wrote, proved test-first across midnight.
- Nothing was skipped or loosened.

## Notes for the frontend track

- No contract change. A screen that shows the seeded farm's dates (the egg lot's expiry, the promotions' end) now sees dates relative to the day the database was seeded, not 1 December 2026.

## CI

- **`c9660bb`** (every code and docs commit, before this report; pull request #73 was opened on it): run **43982084401 (push)**, completed, success; run **43982131333 (pull_request**, which also compares the contract with `main`), completed, success.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green. No run on this branch was red, and nothing was re-run.

## Next session

B09a continued 2b, copied from `docs/prompts/session-openers.md` (this phase only added the seed calendar's name to its last rule). B09x follows it.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09t2-dates-from-clock.md), and also
docs/sessions/B09a3-orders-online.md, the handoff of the orders work this phase continues.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213, A-216 and A-218 in docs/ASSUMPTIONS.md, ADR-0063, ADR-0064 and
ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a credit note,
built in B09a continued 1d), and ADR-0067 with A-217 (a rule's "now" is the application clock's). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger,
hakorem-documents, hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2b only, on branch b09a3b-orders-online, branched from main: ORD's permissions and
grants; createOrder, getOrder, listOrders, listOrderHistory, confirmOrder (reserving every line or staying PLACED
with the shortfall), cancelOrder (releasing reservations and requesting the refund in one transaction) and voidOrder
(a supervisor who is not the cashier, a credit note and reversing entries, every void on the exception report),
each test-first with its wrong-role refusal; returns against the original sale (createReturn, getReturn,
submitReturn, never more than sold less returned, by database trigger); price variance and override limits per
role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder
releases the order's pending charges through ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared
only when it is not heldAsUnmatched, and the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures (A-149): remove
`salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and
`topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published view, and build
the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal. Extend the seed
with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true.
CR-029 was built in B09a continued 2 (`Cart.checkoutId`, contract 1.46.0): when placeOrder completes a checkout,
prove through placeOrder itself that the cart's checkoutId is null again (B09a continued 2 proved it for an expiry,
and for a completion only by setting the rows directly). The integration tests run against the local Paystack fake,
which now answers as Paystack's test mode did (A-218): its MTN test number pays at once, a payer email on `.example`
is refused, and a refund's idempotency key is honoured only through the adapter's note lookup.
Two rules from B09t (ADR-0067): no new now() or current_date in business SQL (due dates, expiries, holds, business
days and as-of times take the application clock, as a parameter or platform.app_now()); and no new fixed calendar
date in the seed or a test (build dates from the seed's or the test's clock); B09t2 made the seed's dates relative
to its clock (src/seed/seed-calendar.ts, A-220, A-222), so the seeded trading day this phase adds takes its dates from
the same seed calendar.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3b-orders-online.md, and merge into main when every run on the pull
request is green.
```
