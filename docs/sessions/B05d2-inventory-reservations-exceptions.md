# B05 continued 3b: reservations, exceptions, the held transfer variance, availability and the stock unit list

Date: 2026-11-15 · Branch `b05d2-inventory-reservations-exceptions`, from `main` · Pull request #25 · Status: **gate passed**. Reservations with the scheduled expiry job, the exception queue, ADR-0048's held transfer variance, availability and the stock unit list are built and green. **B05 continued 4** (`b05e-inventory-cold-chain-opening`) is next and runs the B5 gate in full.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-144 | **How reservations, exceptions, availability and the stock unit list read FR-INV-005, FR-INV-021, FR-INV-023 and FR-INV-025 where they are silent.**<br>- **Who:** Owner, Manager, Accountant and Storekeeper read reservations; only Owner and Manager release one by hand, with a reason. Owner, Manager and Accountant read exceptions; only Owner and Manager resolve them. Availability and the unit list read under `inv.stock.read`.<br>- **Reserving** is in process only (`Reservations.reserveIn`, `consumeIn`, `releaseIn`), naming `reservationLockKey` in `seriesLocks` so concurrent reservations queue (A-060); never virtual, in transit or at a site, never a unit under a hold; the holder sets the expiry; consumed whole.<br>- **Expiry:** every minute as the Scheduler, up to 500 a run, locked rows skipped; each end publishes its event through the outbox. The released reason takes 500 characters, as the contract.<br>- **Exceptions:** a kind is required: `WRITE_OFF` or `FOUND` for a held variance, `ADJUSTED` or `NO_CORRECTION` for the rest; without a kind the document decides, so nothing a client sends became required. An adjustment by hand never names a held variance or adjusts in transit.<br>- **Availability:** physical stock locations only, in transit and sites left out; a held unit's on hand is all held; `LOW_STOCK` at five or fewer (SA-19). | Owner |
| A-145 | **How ADR-0048 is built where it leaves the choice.**<br>- (a) **Held state** adds no movement type, location kind or exception kind: the shortfall stays in the source branch's `IN_TRANSIT` at its value, held by its open `TRANSFER_VARIANCE` with no movement. The hand count is unchanged. The database refuses any movement taking in-transit below what is held (`ck_stock_held`) and any sale, processing or dispatch out of transit (`ck_stock_in_transit`).<br>- (b) **Threshold:** the adjustment rule exactly, approval **at or above** 50,000 pesewas, though the ADR's prose says "above": the stricter reading.<br>- (c) **Write-off:** an adjustment in transit with the receiver's reason and the resolver's note, valued from the pool at submit; resolved when the loss posts, by whoever lets it post. An animal is never written off this way (animals are never adjusted, A-139).<br>- (d) **Found:** no approval (no expense), a stock location in either branch of the transfer, a `TRANSFER_RECEIPT` against the transfer.<br>- (e) Nothing else is decided while a write-off waits; a rejected one leaves the variance held.<br>- (f) **B8:** no event at receipt; the holding account is B8's to design (from the open variances, the write-off's `ADJUST_LOSS` and the found `TRANSFER_RECEIPT`). | Owner, accountant for (f) |

**Needs the owner's approval:**
- **ADR-0049 (proposed):** a module contributes its scheduled jobs to the worker through the composition root (`ScheduledJob` in `src/platform/worker/worker-runtime.ts`, the list in `src/worker-app.ts`). It is a new port, so it needs an ADR (MODULE_BOUNDARIES section 6). The reservation expiry uses it; B05 continued 4's nightly recompute and expiry alerts will too.
- **No new dependency.**

I found no ADR conflict:
- ADR-0048 is built as written; the threshold reading is A-145 (b).
- The new triggers read only `inv` tables and MDM's published `location_stock_facts` from an `inv` trigger, which ADR-0047's table already allows; ADR-0047 is not widened.
- The write-off goes through the existing `STOCK_WRITE_OFF` handler (ADR-0017, one handler per kind).

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05 continued 3b.
2. **Scope:** reservations (interface, list, release, expiry job); exceptions (list, get, resolve through the adjustment path); ADR-0048's held transfer variance; availability; the stock unit list.
3. **Gate:** one active reservation per animal and reserved never above available, under concurrency; an expired reservation released by the scheduled job exactly as reserved, `inv.ReservationExpired` through the outbox; an exception resolved once with a kind and note, any correction through the adjustment path; availability is on hand less reserved less held; every write refuses the wrong role.

## Contract changes

**Version 1.19.0, additive, with one changed behaviour.** Nothing a client sends was made required, and a client generated from 1.18.x compiles unchanged. The cold-read summary at the top of `docs/CONTRACT_CHANGELOG.md` now covers 1.19.0.

- **Changed behaviour, same shape:** `receiveStockTransfer` no longer posts a shortfall as a loss. It holds it in transit with an open `TRANSFER_VARIANCE` (`movementId` null).
- **7 operations now run in code** (181 from code, 419 planned): `listStockExceptions`, `getStockException`, `resolveStockException`, `listStockReservations`, `releaseStockReservation`, `listStockAvailability`, `listStockUnits`.
- `StockExceptionResolve` gains optional `resolutionKind` and `foundLocationId`.
- `StockException` gains `resolutionKind` (required, nullable). This is a new property with its own values; no existing enumeration gained a value.
- `resolveStockException` gains a 202 `ApprovalPending`.
- **New error code:** `STOCK_EXCEPTION_INVALID`. `createStockAdjustment` gains the rule `RESOLVED_THROUGH_THE_EXCEPTION`.
- Redocly lint is clean; `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0060:**<br>- The transfer line no longer needs a variance movement.<br>- `inv.stock_exception.resolution_kind`, `ck_stock_exception_resolution_kind_set` and `ck_stock_exception_held_resolution`; the exception guard now writes the kind once.<br>- `inv.protect_in_transit` (`ck_stock_in_transit`, `ck_stock_held`) and `inv.check_reservation_place` (`ck_stock_reservation_place`, `ck_stock_reservation_held`).<br>- The released reason widened to 500 characters; two point-read indexes.<br>**0061, 0062:** four permissions and their grants |
| Domain | `stock-exception.ts` (resolution kinds, summaries), `reservation.ts` (what may be promised, what is due), `availability.ts`. Each is under a new 100 percent gate |
| Application | **`StockExceptions`:** list, get, resolve.<br>- `WRITE_OFF` drafts and submits through `StockAdjustments.createIn(…, { forHeldVariance })` and `submitIn`. `postLines` resolves the held exception before the loss posts, in the direct and the approved path.<br>- `FOUND` posts a `TRANSFER_RECEIPT` through `Stock.postIn`.<br>**`Reservations`:** `reserveIn`, `consumeIn`, `releaseIn`, `endIn`, the HTTP list and release, and `reservationLockKey`.<br>**`ReservationExpiry`** (serializable, skip locked).<br>**`StockQueries`** gains `listAvailability` and `listStockUnits`.<br>**`StockTransfers.receive`** holds the shortfall. Every movement goes through `Stock.postIn`; no projection is written |
| Events | `inv.ReservationExpired`, `inv.ReservationReleased` (`ReservationEnded` v1), through the outbox |
| Platform | `ScheduledJob` and `WorkerRuntime.runJob` (records `platform.job_run`); `src/worker-app.ts` runs `reservation-expiry` every 60 seconds (ADR-0049) |
| Interface | `StockExceptionsController`, `StockReservationsController`, two routes on `StockController`, strict zod schemas, 7 fragments |
| Seed | Unchanged. The seed makes no transfer, reservation or exception, so the hand count stands |
| Docs | ADR-0049 and the decision index; API.md (the INV section and the error code); `data-model/inv.md`; the INV card and section 6; THREAT_MODEL abuse case 20 updated and 24 added; OPERATIONS; ASSUMPTIONS; CONTRACT_CHANGELOG; the B05 continued 4 opener (reads ADR-0048 and ADR-0049, schedules its jobs through `ScheduledJob`) |

## Decisions

- **ADR-0049 (proposed):** scheduled jobs a module contributes, wired at the composition root.
- Everything else is a reversible reading, recorded as A-144 and A-145.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

- **No new request.** CR-001 to CR-008 were answered earlier.

## Security review (hakorem-security-review)

Boundaries crossed: TB2 back office, and the database. I ran `SECURE_CODING_STANDARDS.md` item by item on reservation release and exception resolution; it passed. The finding is in the pull request.
- **Authorisation:** every handler calls `Authoriser.authorise`, deny by default:
  - an exception is authorised at its branch and location, and `FOUND` also at the found location;
  - a reservation is authorised at its branch and location.
  - The handler walk and the no-grant walk cover all 7 operations. The no-grant walk now sends `listStockAvailability`'s required `branchId`.
  - Refusals proved: 7 roles on resolve, 6 on release, 4 on each read, every refusal audited.
- **Maker-checker:**
  - A 60,000 pesewa write-off waits for a different person: `MAKER_CANNOT_CHECK` is proved, the owner approves with step-up, and the threshold of 50,000 is copied onto the adjustment.
  - A found variance cannot also be written off; while a write-off waits, nothing else is decided; an exception is resolved once (the database guard is proved).
- **Database:**
  - Held stock is refused to a sale, to another in-transit movement, to a reservation and to a dispatch. This is proved through `Stock.postIn`, direct SQL and the API.
  - Proved under concurrency: 10 concurrent reservations of one goat give 1; 50 of a crate from 30 give 30.
- **Input:** strict schemas with unknown fields refused, and parameterised SQL only. Values come from the cost pool.
- **Not applicable, with reason:** uploads, exports, webhooks and payments are untouched; there is no personal data in these tables.
- **Abuse cases:** 20 is updated (a false shortfall is now held, and its write-off approved) and 24 is added (a reservation used to block a sale, or lifted to sell). Their daily exception report items are B12's, as for cases 7 and 20 to 23.

## Deferred

- **To B05 continued 4:** the cold chain, reorder and expiry alerts, the nightly recompute's scheduling (through `ScheduledJob`), the `OPENING_STOCK` sheet and the B5 gate in full.
- **To B7, B9a and B10:** the holder document types (checkout, order, quote) that call `Reservations`. Until then only tests reserve.
- **To B8:** the holding account for held variances (A-145 (f)).
- **To B12:** the daily exception report items for abuse cases 20 and 24.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **696 passed** (14 new: `stock-exception.spec.ts` 8, `reservation.spec.ts` 6) |
| Integration | **673 passed** (unit and integration together, under coverage: **1,369 passed**). New:<br>- `stock-exceptions.integration.spec.ts` (13). Held 0.200 kg: value unchanged, no loss, hand count 45.000 = 45.000. Held stock refused to sale, other movement, reservation and dispatch. Wrong roles refused. A 2,400 pesewa write-off posts at once. 60,000 answers 202, the maker is refused and the owner approves. A rejected write-off leaves the variance held, then found. `NO_CORRECTION` and `ADJUSTED`; replay.<br>- `reservations.integration.spec.ts` (14). One goat for C1, refused for C2. 10 concurrent give 1; 41 of 40 refused; 50 concurrent give 30. A sale that names no reservation is refused; consume is whole. Hold and transit refused. Two concurrent expiry runs end each lapsed reservation once, with one `inv.ReservationExpired` each; an interleaved run leaves reserved = sum active. HTTP list, release once, availability (3 on hand, 1 reserved, 1 held: 1 `LOW_STOCK`), the unit list, wrong roles.<br>- `worker.integration.spec.ts` (+1): the worker runs `reservation-expiry` as the Scheduler and records `SUCCESS`.<br>- `stock-control.integration.spec.ts` now expects the shortfall held, not lost.<br>- The reservations file ran three times in a row, green each time |
| Coverage, merged | Statements 94.29 percent and branches 85.07 percent (gate 80). Every 100 percent gate holds: valuation, stock take, hold, and the new stock exception, reservation and availability gates |
| Contract | **52 passed**, including the exception, reservation, availability and unit shapes |
| Lint, type check, schema names, Redocly | Clean |
| End to end | Runs in CI |

The rules on money, stock and permission were tested against real PostgreSQL. The ADR-0048 and exception integration suite was written first and run red (13 of 13 failing) before any of its code existed. The reservation integration suite and the three domain specs were written alongside their code rather than run red first; that is a departure from the test-first rule, recorded here.

## Gate

**Passed.** Each part was proven by running it against real PostgreSQL, over the HTTP API and the in-process interfaces:
- **One active reservation per animal, and reserved never above available, under concurrency:** 10 concurrent reservations of one goat give 1, and 50 concurrent reservations of a crate from 30 give exactly 30.
- **An expired reservation is released by the scheduled job exactly as reserved:** two concurrent runs end each lapsed reservation once, reserved equals the sum of what is still active, and one `inv.ReservationExpired` per reservation is in the outbox. The worker runs the job on its schedule.
- **A stock exception is resolved once with a kind and a note, and any correction goes through the adjustment path:** a held variance's write-off is an adjustment with its approval at the threshold; a second resolution is refused by the API and by the database.
- **Availability is on hand less reserved less held**, and in-transit stock is left out.
- **Every write refuses the wrong role.**
- **ADR-0048:** held stock is never sold, reserved or moved; the hand count reconciles; a write-off at or above the threshold cannot post without a different approver; a found variance cannot also be written off.

## Notes for the frontend track

- **Transfer shortfalls are held:** show an open `TRANSFER_VARIANCE` (no `movementId`) as awaiting a decision. Clear it with `resolveStockException`:
  - `resolutionKind: WRITE_OFF` answers 202 at or above 50,000 pesewas;
  - `FOUND` takes `foundLocationId`.
- **`resolutionKind`** is on every exception (null while open).
- **Availability** is per product; `LOW_STOCK` means five or fewer.
- **Reservations** cannot be made from a screen; they come from checkout, orders and quotes.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`858f7be`** (the last commit before this report): push run `43701941175` **success**; pull_request run `43701968483` **success** (the pull_request run includes the contract versioning check against `main`, the image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B05 continued 4. The opener is in `docs/prompts/session-openers.md`, section "B05 continued 4 — Cold chain, alerts, opening stock and the B5 gate":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d2-inventory-reservations-exceptions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0046, ADR-0047, ADR-0048 and ADR-0049, A-128 and A-131 to the latest INV assumption in
docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on the opening stock import and temperature quarantine.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 4 only, on branch b05e-inventory-cold-chain-opening, branched from
main: temperature readings (listTemperatureReadings, recordTemperatureReading)
with automatic quarantine of every lot in the location in the reading's transaction, a
TEMPERATURE_EXCURSION exception and an event (a location's range is MDM's: read it through MDM's
interface, and a database rule that needs it needs a new proposed ADR, since ADR-0047 is not widened
silently); reorder rules (listReorderRules, createReorderRule, updateReorderRule) and listStockAlerts with
one low-stock alert per crossing; expiry alerts by a daily job and the refusal to sell an expired lot
(A-134 (j)); the scheduling of the nightly recompute (BalanceReconciliation) and the expiry alerts as ScheduledJob entries in
src/worker-app.ts (ADR-0049, as reservation-expiry is); the OPENING_STOCK import
sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction;
then decide whether a goods receipt of kind OPENING stays refused (A-136). Each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Extend the seed through the
services where these need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, with a
walk that every INV write operation refuses the wrong role, stop at it and write
docs/sessions/B05e-inventory-cold-chain-opening.md.
```

## Mutation check of the reservation tests (2026-11-15, parent session, at the owner's request)

The reservation suite was written alongside its code rather than first (disclosed above). The owner asked, instead of rewriting it, for the proof test-first gives: break the implementation on purpose and confirm a test fails each time. Thirteen deliberate breaks were applied one at a time against `src/modules/inv/domain/reservation.spec.ts` and `test/integration/inv/reservations.integration.spec.ts` (20 tests, all passing unbroken), each reverted after its run.

| # | Break | Caught by |
| --- | --- | --- |
| M1 | Database: the available check never refuses | 4 tests, among them "41 of 40 yams refused; 50 concurrent reservations of 30 eggs give exactly 30" |
| M2 | Database: one active exclusive reservation per unit no longer unique | "G-0142 for checkout C1 succeeds; for C2 it is refused" |
| M3 | Database: ending a reservation gives nothing back | 6 tests, the release and both expiry tests among them |
| M4 | Database: making a reservation adds nothing to reserved | 7 tests |
| M5 | Database: an ended reservation can end again | **Nothing. Survived** |
| M6 | Application: the "only an active reservation ends" guard removed | "the manager releases it ... a second release is refused" |
| M7 | Database: a unit under a hold can be reserved | 2 tests |
| M8 | Domain: in-transit stock can be promised | the domain test of places stock is never promised from |
| M9 | Domain: due one instant late (`<` for `<=`) | "releases an active reservation at or after its expiry" |
| M10 | Store: the expiry job takes reservations not yet due | both expiry tests |
| M11 | Domain: availability forgets held stock | 2 tests, domain and integration |
| M12 | Application: release checks the read permission | the wrong-role refusal test, and the release test |
| M13 | Store: the expiry job without `SKIP LOCKED` | **Nothing. Survived** |

**The two survivors, and what was added:**

- **M5 was a real gap.** The application refuses a second release before the database sees it, so the database rule `ck_stock_reservation_change` was never proved on its own, as CLAUDE.md requires of a rule in the database. New test: "the database itself refuses to end a reservation twice or to change what it promised". As the application role, without the service, ending an ended reservation again and changing a live reservation's quantity are each refused with `HK010` `ck_stock_reservation_change`, and reserved stays equal to the active sum.
- **M13 was equivalent for correctness, not for liveness.** Without `SKIP LOCKED` a second expiry run waits and then finds nothing, so "each reservation expires once" still held. What `SKIP LOCKED` buys is that the job never stalls behind a row a checkout holds. New test: "never waits behind a reservation another session holds". One due reservation is locked from another session for the whole run; the run must finish within five seconds, expire the other one, leave the locked one, and the next run expires it.

**After:** M5, M6 and M13 rerun against the extended suite (22 tests) are each caught by the test that names their rule. All thirteen breaks are caught; the suite passes 22 of 22, three runs out of three.
