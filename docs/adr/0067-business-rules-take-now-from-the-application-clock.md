# ADR-0067: Business rules in the database take "now" from the application's clock

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B09t (owner-inserted task, 2026-11-16)
- **Deciders:** backend track; the owner approves

## Context

`docs/ENGINEERING_STANDARDS.md` section 8 and the kernel `Clock` say the application's clock is the only source of the current time, so tests control time with `ManualClock`. CLAUDE.md says rules live in the database. The two met badly in a few places: a rule in a view, a trigger, a database function or a query string read the database's `now()`, so its "now" was the container's real clock while the application's was the test's. On 2026-11-16 the cheque-bounce test failed when CI ran at 20:54 UTC (PR #67), and the owner asked for every such place to be found and moved. The B09t inventory (session report `docs/sessions/B09t-clock-sweep.md`) found six that decide something:

- the hold window "in force now" in `inv.pub_stock_on_hand.available_qty` (0044), `inv.pub_reorder_level.held_qty` (0064) and `inv.check_reservation_place` (0060), and in `ACTIVE_HOLD` of `src/modules/inv/infrastructure/pg-stock-read-store.ts`;
- `settled_at` and `as_of` in `bil.apply_settlement` (0161, redefined by 0182) and `as_of` in `bil.credit_note_refund` (0182);
- "active" in the device list, `s.absolute_expires_at > now()` in `src/modules/iam/infrastructure/pg-iam-store.ts`;
- the 30-minute grace period of a provider charge nobody has a record of (`judgeMissingCharge`), measured from `pay.provider_transaction.created_at`, which the column default filled from the database's `now()`.

In production both clocks are the real time and agree to within NTP drift. In a test they do not: a hold placed at the `ManualClock`'s instant, a minute ahead of the database, was not in force for that minute, and a hold that had ended by the application's clock was still in force by the database's. If nothing is decided, every rule like these is untestable across its boundary, and each new one repeats the mistake.

## Options considered

1. **Pass the instant as an argument everywhere.** The application passes `clock.now()` (or the business date in Africa/Accra) into each query and database function. Explicit and testable, but a view cannot take an argument, and a trigger fires on a row the application wrote, not on a call it makes.
2. **Turn the views into set-returning functions with an instant argument.** `inv.pub_stock_on_hand_at(p_at)`. Explicit, but it changes a published interface (MODULE_BOUNDARIES, the INV card) that RPT and other readers select from, for every reader at once.
3. **A transaction-local setting written by the unit of work, read through one platform function.** The unit of work writes the application clock's instant into `hk.app_now` with `set_config(..., true)` right after BEGIN; `platform.app_now()` returns it, or `now()` when unset. The views and triggers keep their names, columns and callers. One more round trip per transaction, and a rule that reads the setting is only as right as the unit of work that wrote it.
4. **Leave the database's clock and fake it in tests** (a container with a shifted system time, or `faketime`). Nothing changes in the code, but the database's clock cannot follow a `ManualClock` that a test moves second by second, and it would hide the next such rule instead of finding it.

## Decision

Options 1 and 3 together: an argument wherever the application calls the rule, the setting only where it cannot.

- **An argument where the application calls.** A query string under `src/` binds the application clock's instant as a parameter (`$n::timestamptz`), never `now()`, when the instant decides something: `PgStockReadStore` (`onHand`, `onHandSorted`, `stockUnit`, `stockUnitIds`, `stockUnitIdsSorted` take `at`), `PgIamStore.listSessions` (`SessionListFilter.now`). A database function the application calls takes it as an argument: `bil.apply_settlement(document, amount, direction, at)` (0187); `Billing.settleIn` passes `clock.now()`. The three-argument form (0182's) stays for one release (expand then contract) and delegates with `platform.app_now()`; `bil.credit_note_refund`, called inside the unit of work, writes its `as_of` at `platform.app_now()` (0187).
- **The setting where it cannot.** `platform.app_now()` (0185): `COALESCE(NULLIF(current_setting('hk.app_now', true), '')::timestamptz, now())`, `STABLE`, executable by `hk_app`, `hk_worker` and `hk_report`. `UnitOfWork` takes the application's `Clock` (`PlatformModule.forRoot` passes it) and, on every attempt, runs `SELECT set_config('hk.app_now', $1, true)` with `clock.now().toISOString()` right after BEGIN, as a bound parameter (SECURE_CODING_STANDARDS section on SQL). The setting is transaction-local: it ends at COMMIT or ROLLBACK and never reaches the next transaction on a pooled connection. The views `inv.pub_stock_on_hand` and `inv.pub_reorder_level` and the trigger function `inv.check_reservation_place` read `platform.app_now()` (0186), unchanged otherwise.
- **What keeps the database's clock.** Audit and bookkeeping columns: `created_at`, `updated_at` (including `platform.touch_version()`), `deleted_at`, `recorded_at`, `sealed_at`, `anchored_at`, `processed_at`, `allocated_at`, `requested_at`, `raised_at`, projection `refreshed_at` and `computed_at`, decision stamps such as `posted_at` written in SQL, and the health lag measures. They record when the database stored something, which is what an audit trail must show, and decide nothing. Writing them from a settable value would let the application choose its own audit time. The one exception is a `created_at` that a rule reads as business time: the application writes it from its clock, as `iam.session.created_at` already was, and B09t makes `pay.provider_transaction.created_at` of a charge the application's instant (`PgPaymentStore.insertCharge`), since the missing-charge grace period runs from it.
- **A rule that reads the movement's own time stays on it.** `ck_stock_on_hold` (0044) and `ck_stock_expired` (0064) compare against `NEW.occurred_at`, which the application writes from its clock; they are unchanged.
- **New code.** A new view, trigger or function whose "now" decides a due date, an overdue count, an expiry, an active window, a settlement or as-of time or a business day reads an argument, else `platform.app_now()`; never `now()`, `current_date` or `current_timestamp`. Review checks it (hakorem-migration).

## Consequences

- Tests control every moved rule with `ManualClock`, across the boundary, whatever the database container's clock says.
- `hk.app_now` is settable by any role in its own transaction; it is not a security control and decides nothing an `hk_app` session could not already decide by the `occurred_at` it writes. Audit columns do not read it, so the audit trail keeps the database's time.
- A read outside a unit of work (a `psql` session, a report connection, a migration) gets `now()`, as before.
- One `set_config` round trip per transaction; the advisory lock and BEGIN already cost one each.
- Binds `docs/DATA_MODEL.md` (conventions), `docs/data-model/inv.md` and `docs/data-model/bil.md` (the views and the function), `docs/ENGINEERING_STANDARDS.md` section 8, and the hakorem-migration review.

## Verification

B09t, test first, each failing before the change:

- `test/integration/platform/unit-of-work.integration.spec.ts`: a unit of work with a clock makes `platform.app_now()` its instant in every statement of the transaction; without a clock, and outside any unit of work, it is `now()`; the setting does not survive COMMIT on the same connection.
- `test/integration/inv/stock-holds.integration.spec.ts`: a quarantine that ends two minutes on holds the goat in every read (the view, the reorder view, the on-hand list, the unit, the unit filter) and refuses a reservation one second before its end by the application's clock, and frees it at its end; a withdrawal that starts later is not in force one second before its start and is at its start.
- `test/integration/iam/authorisation.integration.spec.ts`: a session is listed as active one second before its absolute end by the application's clock and not at it.
- `test/integration/pay/payment-edge-cases.integration.spec.ts`: an allocation's settlement summary is settled and as of the application clock's instant; `test/integration/ord/order-payment-rules.integration.spec.ts`: the four-argument form holds the outstanding rule and refuses no instant.
- The forced-clock sweep of B09t (the session report) runs the integration suite with every test file's clock forced to 23:55 Accra, a month end, a year end and a control; its failures before and after are in the report.

B09t2 (2026-11-16), the two items B09t left:

- **The refund's `created_at` is the application's instant.** A payout recorded by hand (`markRefundPaid`) is refused when dated before its refund, and the refund's `created_at` was the column default. `PgPaymentStore.insertRefund` now writes `Refunds.request`'s `clock.now()`, the exception this ADR names for a `created_at` a rule reads as business time. `test/integration/pay/refunds.integration.spec.ts` › *asks a refund at 23:58 Accra, records its payout after midnight* failed first (the payout dated a second before the refund was recorded as paid), then passed.
- **The second rule, for the seed and the tests.** Every seeded expiry, best-before and valid-from or valid-to date is built from the seed's clock through `src/seed/seed-calendar.ts` (A-220), and the tests that print one take it from the same calendar. The forced-clock sweep at 2026-12-31T10:00Z and 2027-03-01T10:00Z is in `docs/sessions/B09t2-dates-from-clock.md`.
