# B09t: the forced-clock sweep and the database's clock

Date: 2026-11-16 · Branch `b09t-clock-sweep`, from `main` (`c19ec6c`, which includes PR #67), main merged in at `7fd257d` (B09a continued 1d) · Status: **owner-inserted task, done; three findings left for scheduling (below).**

The owner's task (2026-11-16): after `receipts-reversals.integration.spec.ts` failed when CI ran at 20:54 UTC (PR #67), list every place business logic reads the database's clock instead of the application's, move the ones that matter, and run the integration suite with every test file's clock forced to risky moments. Recorded in ADR-0026 Amendments.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

- **A-217:** a rule's "now" is the application clock's: an argument where the application calls the rule, `platform.app_now()` where it cannot; audit columns keep `now()`, except a `created_at` a rule reads as business time, which the application writes (as `iam.session.created_at` already was; now also a provider charge's).

## Decisions

- **ADR-0067 (Proposed):** business rules in the database take "now" from the application's clock. `platform.app_now()` (0185) reads the transaction-local `hk.app_now`, which `UnitOfWork` writes from its `Clock` right after BEGIN with a bound `set_config`; it falls back to `now()`. No accepted ADR is contradicted (ADR-0005, ADR-0009, ADR-0012 and ADR-0024 were read: the unit of work owns the transaction, LEDGER `recorded_at` keeps `DEFAULT now()`, connections are direct, and a transaction-local setting needs no pooler change).

## Part A: the inventory

Searched: every `migrations/*.sql` (functions, triggers, views, checks, defaults) and every SQL string under `src/` for `now()`, `current_date`, `current_timestamp`, `localtimestamp`, `clock_timestamp()`, `statement_timestamp()`, `transaction_timestamp()`; then the `DEFAULT now()` columns a rule reads back as business time. `current_date`, `localtimestamp` and the other forms appear nowhere outside comments.

| Where | What it decides | Verdict | Done |
| --- | --- | --- | --- |
| `migrations/0044_inv_create_stock_ledger.sql:715` `inv.pub_stock_on_hand` | available quantity is zero under a hold in force | move | 0186: `platform.app_now()` |
| `migrations/0060_inv_transfer_variance_held.sql:123` `inv.check_reservation_place` | a reservation of a held unit is refused | move | 0186: `platform.app_now()` |
| `migrations/0064_inv_cold_chain_alerts.sql:204` `inv.pub_reorder_level` | held quantity, so reorder alerts | move | 0186: `platform.app_now()` |
| `src/modules/inv/infrastructure/pg-stock-read-store.ts:7` `ACTIVE_HOLD` (five queries) | the holds listed, the on-hold filter, online promising (`promisableIn`) | move | bound `at` from `StockQueries`' clock |
| `migrations/0161_bil_settlement_allocations.sql:45`, redefined by `0182_bil_credit_note_refunds.sql:101,230` `bil.apply_settlement` | `settled_at`, `as_of` | move | 0187: four-argument form, `Billing.settleIn` passes the clock; the three-argument form delegates for one release |
| `migrations/0182_bil_credit_note_refunds.sql:153,155` `bil.credit_note_refund` (found after merging main) | `as_of` | move | 0187: `platform.app_now()` |
| `src/modules/iam/infrastructure/pg-iam-store.ts:293` `listSessions` | which sessions are "active" | move | bound `SessionListFilter.now` |
| `pay.provider_transaction.created_at` `DEFAULT now()`, read by `judgeMissingCharge` (`src/modules/pay/domain/charge.ts:58`) and `openCharges` | the 30-minute missing-charge grace period | move | `insertCharge` writes the clock's instant |
| `src/modules/pay/application/refunds.ts:222` `paidAt < refund.createdAt` (`created_at DEFAULT now()`) | a bank payout's date is not before its refund | move | **not done:** refunds were being built in parallel (B09a continued 1d); listed below |
| `migrations/0044:398` `ck_stock_on_hold`, `migrations/0064:180` `ck_stock_expired` | sale blocked by a hold, by expiry | fine | already on `NEW.occurred_at` |
| `migrations/0001:45` `platform.touch_version`, `0017:238,268`, `0044:465,470,492,494,630,654`, `0155:60` | `updated_at` | fine | audit column |
| `migrations/0119:213` `refreshed_at`, `0138:48` `computed_at` | projection stamps | fine | decide nothing |
| `migrations/0152:223`, `0157:29` `activated_at` of seeded templates | a migration-time stamp | fine | lookup seed |
| `src/` SQL: `updated_at = now()` (81 lines), `deleted_at` (3), `posted_at` decision stamps (`pg-shp-store.ts:391`, `pg-supplier-register-store.ts:180,254`), `confirmed_at` (`pg-iam-store.ts:178`), `password_changed_at` at sign-up (`pg-self-service-store.ts:18`, never read as a time), `destroyed_at` (`subject-keys.ts:86`), `applied_at` default (`migration-runner.ts:100`) | when a row was written | fine | audit stamps |
| `src/platform/health/health.service.ts:89,124` | outbox and sealing lag of rows the database stamped | fine | both sides on the database clock |

Counts: **9 moved** (3 view or trigger rules, 2 functions, 2 query strings, 1 default read as business time, plus the credit-note refund's `as_of`), **1 to move, deferred** (`refunds.ts:222`), the rest fine: 14 non-default reads in migrations, 92 lines in `src/`, and 240 column defaults (`created_at` 105, `updated_at` 95, `recorded_at` 30, `valid_from` 2 on `iam.role_grant` and `platform.setting`, which the application always writes and whose default only stamps migration-seeded rows, and one each of `sealed_at`, `requested_at`, `raised_at`, `processed_at`, `issued_at`, `anchored_at`, `allocated_at`, `added_at`).

## Part B: built (test first, each test failing before its change)

- `0185_platform_app_clock`, `UnitOfWork(pool, logger, sleep, clock)`, `PlatformModule` passing its clock; `tooling/architecture.json` lists `app_now` as a shared platform object.
- `0186_inv_hold_window_app_clock`; `StockReadStore` methods take `at`.
- `0187_bil_settlement_as_of`; `Billing.settleIn` passes `clock.now()`.
- `SessionListFilter.now`; `insertCharge` writes `created_at`.
- Tests: `unit-of-work` (the instant in every statement, the fallback, no leak past COMMIT), `stock-holds` (a quarantine ending two minutes on: held in every read and a reservation refused one second before its end by the application clock, free at its end; a withdrawal starting later: not in force one second before, in force at its start), `authorisation` (a session active one second before its absolute end, not at it), `payment-edge-cases` (`settledAt` and `asOf` equal the allocation's instant), `order-payment-rules` (the four-argument form holds the outstanding rule and refuses no instant). Before the change, on a copy with `src/` reverted: 5 failed (the 4 new assertions and one test that depends on one of them); `stock-holds` failed 2 of its 4 new tests; after: all pass.

## Part C: the sweep

`npx vitest run --project integration` with every test file's `Date` started at the instant (scratch setup file, never committed); the database, Redis and object store containers keep their real clocks.

| Moment | Before | After |
| --- | --- | --- |
| 23:55 Accra tonight, 2026-11-16T23:55Z | 6 failed, 4 files | 1 failed (`file-store`) |
| month end, 2026-11-30T23:55Z | 11 failed, 9 files | 1 failed (`file-store`) |
| year end, 2026-12-31T23:55Z | 32 failed, 15 files | 19 failed, 4 files (the control's) |
| control, 2026-12-31T10:00Z | 30 failed, 13 files | 19 failed, 4 files |

The "after" column is the full sweep on `cbc6f06` with the three later test fixes of `bfba054` re-run forced at all four moments (`archive-link-rollback`, `depreciation-runs` and `financial-statements`: only the control and year-end `financial-statements` failure remains).

Fixed, by cause:

- **The database's clock in a rule (Part B):** `reservations` (3 tests, every moment), `payment-edge-cases` grace period (every moment), `livestock` direct SALE_ISSUE dated `now()` in the test (control, year).
- **A time-of-day boundary in the test:** `manual-journals` (23:55 Accra, month, year: expected `today()` after the clock crossed midnight; now the journal's own date), `accounting-periods` (month, year: re-read "today's" period after crossing into the next month; now the period it locked), `depreciation-runs` (month, year, control: "November not ended"; now the period holding tomorrow, since a period may run on its last day).
- **A fixed calendar date in the test, which also breaks real CI on that date:** `movement-ledger` (a lot expiring 2026-11-20), `stock-services` (2026-11-21), `fixed-assets` (a "future" 2026-12-01), `supplier-register` (an invoice of 2026-11-20). Lot dates now come from `businessDay` in `test/support/inventory.ts`; the others from the clock.

Still failing, with the reason:

1. **`doc/file-store` "a link used five minutes and a second after it was signed" (every moment).** The object store container checks the presigned URL against its own real clock; forcing the test's `Date` signs in the future. Not a defect in production, where the clocks agree; not fixable by forcing the test process clock.
2. **The seeded egg lot `EGG-BIG-2026-1110` expires on 2026-12-01 (`src/seed/farm-inv.ts:78`), fixed in the seed (control, year): `sale-posting` (10), `storefront-checkout` (7), `order-payment-rules` (its setup).** Real CI fails from **2026-12-02** in Accra. Needs the seed's dates relative to the seed clock and the tests that print them (labels, cold-chain alerts) updated: a hakorem-seed task.
3. **`fin/financial-statements` "reads a locked period with lines from its balances" (control, year).** It locks November 2026 and tampers its 6800 row; weeks ahead, the seeded farm's 6800 posting is not in November. Choosing "today's period" made it fail at month end instead, so main's version is kept; it will likely fail in real CI after November. Needs the period found from the posting it tampers.

## Contract changes

None. The contract version is unchanged.

## Deferred

- `refunds.ts:222` (a payout dated before the refund's `created_at`, a database default): write the refund's `created_at` from the clock, or compare against an application-written instant.
- Findings 2 and 3 above. Contract requests were not read: this is an owner-inserted task, not a phase.

## Tests (this machine, 2026-11-16)

- `pnpm lint`, `pnpm typecheck`: clean. `pnpm test:unit`: 116 files, 1,384 tests passed.
- After merging main: bil, pay, `order-payment-rules`, `stock-holds`, `unit-of-work`, `migration-runner` and `authorisation`: 14 files, 175 tests passed.

## CI

- `fde0ff4` (the first push): run 43962156576 (push) failed on `archive-link-rollback`, which lists every migration rolled back past 0155; fixed in `bfba054`. Nothing was re-run.
- The runs on the final head are named in the session's closing message: a commit cannot name its own runs.

## Next session

Unchanged by this task: the phase main's latest report hands off to, B09a continued 2, with the opener copied in `docs/sessions/B09a2d-payments-credit-refunds.md` (from `docs/prompts/session-openers.md`). Before it, the parent may schedule findings 2 and 3 above and the deferred refund date.
