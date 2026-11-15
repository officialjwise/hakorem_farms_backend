# B05 continued 3: stock takes and cycle counts, and holds

Date: 2026-11-15 · Branch `b05d-inventory-counts-holds`, from `b05c-inventory-control` · Pull request #22 (stacked on #21, not merged) · Status: **phase split** (A-143). Stock takes, cycle counts and holds are built and green. **B05 continued 3b** (`b05d2-inventory-reservations-exceptions`) builds reservations with the expiry job, the exception service, availability and the stock unit list; **B05 continued 4** then runs the B5 gate in full.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-141 | **How stock takes read FR-INV-013 and FR-INV-014 where they are silent.**<br>- **Who:** the Owner, Manager and Storekeeper plan, start, count and cancel; only the Owner and Manager submit (`inv.stock_take.post`); at or above the `STOCK_WRITE_OFF` threshold (50,000 pesewas, the existing policy) a different person holding `inv.adjustment.approve` approves; the Accountant reads.<br>- **Scope:** one live physical location (not in-transit, not a site); `CYCLE` lists products (the contract has no category scope); animals are never counted here, and a full take leaves them out.<br>- **Overlap:** a take holds its scope from `DRAFT` to `PENDING_APPROVAL`; an overlapping take is refused at planning and at start, and the database refuses an overlapping start under an advisory lock on the location. Same location only, not child locations.<br>- **Blind:** expected is hidden from every reader, not only the counter, until counting closes.<br>- **Recount:** tolerance zero; every difference is recounted once before submit, and the recount is final.<br>- **Values:** as adjustments (loss at the pool's issue value, gain at its average), at review and again at submit; gains and losses together are judged; the approval binds to lines and values; a rejected take is cancelled.<br>- **Movements:** loss `STOCKTAKE_LOSS` reason `COUNT_ERROR`, gain `STOCKTAKE_GAIN` reason `FOUND_STOCK`; no weight posted (the expected weight is not frozen); a typed counted weight is `MANUAL`.<br>- `StockWriteOffs` routes the one `STOCK_WRITE_OFF` handler to the adjustment or the take by document type. | Owner |
| A-142 | **How holds read FR-INV-022 and FR-INV-008 where they are silent.**<br>- **Who:** the Owner and Manager place and release; the Accountant and Storekeeper read.<br>- **Placing:** by hand only `QUARANTINE` or `INVESTIGATION`, on an `ACTIVE` unit, with a note (new column); the hold is its own `STOCK_HOLD` document. LIV places `WITHDRAWAL` through `StockHolds.placeIn`, and it must have an end.<br>- **Releasing:** once, with a `HOLD_RELEASE` reason and a note (new column, required), never by the person who placed it (also `ck_stock_hold_releaser` in the database); a released or ended hold is refused; a withdrawal hold is refused for everyone.<br>- Scope: the unit's branch and, for an animal, where it stands; a lot needs a branch-wide grant.<br>- No event for a hold placed by hand; the audit trail records it. | Owner |
| A-143 | **The split.** This session built stock takes, cycle counts and holds (migrations 0054 to 0059, 12 operations, contract 1.18.0). **B05 continued 3b** builds reservations with the expiry job, exceptions, availability and the stock unit list; B05 continued 4 branches from it. | Owner |

**Needs the owner's approval:**
- **No new dependency.**
- **No new ADR.**

I found no ADR conflict:
- The stock take tables follow ADR-0012 and ADR-0024; their thresholds are copied onto the row (as A-139), so no `inv` trigger reads `iam`, and ADR-0047 is not widened.
- `ck_stock_take_overlap` reads only `inv` tables.
- Sharing the `STOCK_WRITE_OFF` kind between two documents keeps ADR-0017's one-handler-per-kind rule: INV registers one handler that routes inside the module.
- `StockHolds.placeIn` is the `Holds` interface ADR-0019 and the INV card already name; it is not a port.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05 continued 3.
2. **Scope:** stock takes and cycle counts; holds and the `Holds` interface; reservations with the expiry job; exceptions; availability and the stock unit list.
3. **Gate:** a stock take posts its variances from blind counts with approval at the threshold; overlapping cycle counts are refused; a hold blocks a sale until released, and a withdrawal hold cannot be released; an expired reservation is released by the job; every write refuses the wrong role.

I built stock takes and holds, then split at that sub-domain boundary (A-143) rather than start reservations and exceptions that this context could not carry to their gate.

## Contract changes

**Version 1.18.0, additive.** Nothing a client sends changed, and a client generated from 1.17.x compiles unchanged. See `docs/CONTRACT_CHANGELOG.md`.

- **12 operations now run in code** (174 from code, 426 planned):
  - **Stock takes:** `listStockTakes`, `createStockTake`, `getStockTake`, `startStockTake`, `listStockTakeLines`, `recordStockTakeCounts`, `closeStockTakeCounting`, `submitStockTake`, `cancelStockTake`.
  - **Holds:** `listStockHolds`, `createStockHold`, `releaseStockHold`.
- **New error codes:** `STOCK_TAKE_INVALID`, `STOCK_HOLD_INVALID`. `STOCK_TAKE_NOT_COUNTED` now names each unfinished line.
- **Descriptions, examples and `x-error-codes`** on all 12. Redocly lint is clean; `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0054:** `inv.stock_take`, `inv.stock_take_product`, `inv.stock_take_line`.<br>- `inv.document_status_guard` with the take's nine transitions; `POSTED` and `CANCELLED` frozen; a pending take changes only to be decided.<br>- `inv.stock_take_part_guard`: scope and lines while `DRAFT`; counts while `COUNTING`; recount (once), variance and movement (once) in `REVIEW`; movement (once) while pending (HK004).<br>- `inv.stock_take_overlap` (HK010 `ck_stock_take_overlap`) under an advisory lock on the location.<br>- `ck_stock_take_approved`, `ck_stock_take_variance`, `ck_stock_take_line_variance` (variance = final count less expected).<br>**0055, 0056:** four stock take permissions and grants.<br>**0057:** `inv.stock_hold.note` and `release_note`, `ck_stock_hold_release_noted`, `ck_stock_hold_releaser`, and the hold guard replaced to allow the release note.<br>**0058, 0059:** three hold permissions and grants |
| Domain | `domain/stock-take.ts` (scope rules, overlap, variance and its value, recount, totals, count rules) and `domain/stock-hold.ts` (hold window, placement, early release), each under a new 100 percent coverage gate |
| Application | **`StockTakes`** (create, start, record counts and recounts, close, submit with approval, cancel, the approval handler) and **`StockWriteOffs`** (routes `STOCK_WRITE_OFF` to the adjustment or the take).<br>**`StockHolds`** (list, create, release, and `placeIn`, the `Holds` interface for LIV and the cold chain).<br>- Every movement goes through `Stock.postIn`; no projection is written.<br>- Every write is serializable, authorised in the handler, scoped, idempotent and audited |
| Interface | `StockTakesController`, `StockHoldsController`, strict zod schemas, 12 fragments |
| Seed | Unchanged: the seed makes no take or hold, so the hand count stands |
| Docs | API.md (the INV section and three error codes), `data-model/inv.md` and DATA_MODEL.md, the INV card, THREAT_MODEL abuse cases 22 and 23, ADR-0026 Amendments, the openers (this one marked split, B05 continued 3b added, B05 continued 4 now from `b05d2-inventory-reservations-exceptions`), CONTRACT_CHANGELOG |

## Decisions

- **No ADR.** Each choice was a reversible reading, recorded as A-141 and A-142.
- The one `STOCK_WRITE_OFF` approval handler routes by document type inside INV, rather than adding an approval kind (a new kind would be a new policy for the owner).

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

- **No new request.** CR-001 to CR-008 were answered earlier.

## Security review (hakorem-security-review)

Boundary crossed: TB2 back office, and the database. `SECURE_CODING_STANDARDS.md` run item by item on stock-take variance posting and hold release; passed.
- **Authorisation:** every handler calls `Authoriser.authorise` with the take's location or the unit's branch (and an animal's location); deny by default; the handler walk and the no-grant walk cover the 12 operations; tests refuse the Accountant, Cashier, Sales, Driver and Farm hand on all six take writes (30 audited refusals) and six roles on both hold writes (12).
- **Maker-checker:** a large variance waits for a different person (`MAKER_CANNOT_CHECK` proved); the database refuses a take posted at or above its threshold without an approval (23514 proved); a hold is never released by its placer (handler and `ck_stock_hold_releaser`, both proved); a withdrawal hold is never released (API and database, both proved).
- **Input:** strict schemas, unknown fields refused, parameterised SQL only. Values come from the cost pools, never the request.
- **Blind count:** the expected figure is never returned while counting (proved for the counter, the manager and the owner).
- **Not applicable, with reason:** uploads, exports, webhooks, payments, personal data (none in these tables).
- **Abuse cases:** 22 (a fudged count) and 23 (a hold lifted to sell) added to the threat model. Their daily exception report items are B12's, as for cases 7, 20 and 21.

## Deferred

- **To B05 continued 3b:** reservations (`listStockReservations`, `releaseStockReservation`, the `Reservations` interface) and the expiry job publishing `inv.ReservationExpired`; the exception service (`listStockExceptions`, `getStockException`, `resolveStockException` through the adjustment path); `listStockAvailability` and `listStockUnits`.
- **To B05 continued 4:** cold chain (which places its quarantine through `StockHolds.placeIn`), reorder and expiry alerts, the nightly scheduling, the `OPENING_STOCK` sheet, and the B5 gate in full.
- **To B12:** the daily exception report items for abuse cases 22 and 23.
- **For the owner:** a recount tolerance (A-141), and whether the recount should be by a second counter.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **682 passed.** New: `stock-take.spec.ts` (16: 12 expected and 11 counted is a loss of 1; 1 of 3 worth 100,001 is 33,334; 3,200 + 12,000 + 971 judged as 16,171; scope, overlap and count rules) and `stock-hold.spec.ts` (7) |
| Integration | **645 passed** (unit and integration together: **1,327 passed**). New: `stock-takes.integration.spec.ts` (13) and `stock-holds.integration.spec.ts` (10):<br>- wrong roles refused, audited, nothing changes;<br>- 30 crates frozen, hidden while counting, 29 counted and recounted, a `STOCKTAKE_LOSS` of 3,500, 29 on hand;<br>- 2 yams lost during counting leave the frozen 40;<br>- beef short 5 kg (60,000) answers 202, the maker is refused, the owner approves;<br>- goat meat short 65,000: the database refuses an unapproved post; a rejection cancels with nothing moved;<br>- overlapping counts refused by the API and by the database;<br>- an investigation hold blocks dispatch and a `SALE_ISSUE`, the placer and a wrong reason are refused, the owner releases it once, the sale then posts;<br>- a withdrawal hold placed through `placeIn` blocks the goat's sale, is refused to the owner and to direct SQL, and ends by time.<br>`stock-invariants.integration.spec.ts`: its direct-SQL release now names a different releaser and a note, as migration 0057 requires. The handler walk lists the 12 operations |
| Coverage, merged | Statements 94.12 percent and branches 84.86 percent (gate 80). Every 100 percent gate holds: valuation, and the new `stock-take.ts` and `stock-hold.ts` gates |
| Contract | **50 passed**, including the stock take and hold shape tests |
| Lint, type check, schema names, Redocly | Clean |
| End to end | Runs in CI; nothing it reads changed |

## Gate

**This session's part passed; the reservation expiry and exception parts moved to B05 continued 3b (A-143).** Proven against real PostgreSQL over the HTTP API:
- **A stock take posts its variances from blind counts**, each a `STOCKTAKE_GAIN` or `STOCKTAKE_LOSS` at its pool value, and a variance value at or above the threshold waits for a different person.
- **A cycle count of an overlapping scope is refused**, in the handler and in the database.
- **A hold blocks a sale until a named user releases it with a reason**, and **a withdrawal hold cannot be released** by anyone.
- **Every write built here refuses the wrong role.**

## Notes for the frontend track

- **New live operations:** stock takes and holds.
- **Handle the 202 `ApprovalPending`** on `submitStockTake`; a rejected take comes back `CANCELLED`.
- **The count is blind:** `expectedQty` and the variance fields are null for everyone until `closeStockTakeCounting`; then every line with `needsRecount: true` must be recounted with `isRecount: true` before submit.
- **`createStockHold`** takes only `QUARANTINE` and `INVESTIGATION`; a release by the person who placed the hold is refused with `RELEASED_BY_PLACER`.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`0fffc46`** (the last commit before this report): push run `43697065022` **success**; pull_request run `43697091088` **success** (the pull_request run includes the contract versioning check against the base branch, the image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B05 continued 3b. The opener is in `docs/prompts/session-openers.md`, section "B05 continued 3b — Reservations, exceptions, availability and the stock unit list":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05d-inventory-counts-holds.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0010,
ADR-0017, ADR-0019, ADR-0027 (the stock exception part) and ADR-0047, A-131 to A-143 in
docs/ASSUMPTIONS.md, migrations 0044 and 0057, and src/modules/inv/application/stock-holds.ts and
stock-adjustments.ts as the patterns. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on reservation release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3b only, on branch b05d2-inventory-reservations-exceptions, branched from
b05d-inventory-counts-holds: the reservation service (listStockReservations, releaseStockReservation,
the Reservations interface with serializable reserve and consume, one active reservation per animal,
reserved never above available, proved under concurrency) and the scheduled reservation expiry job
releasing exactly what it reserved and publishing inv.ReservationExpired through the outbox; the
exception service (listStockExceptions, getStockException, resolveStockException with a resolution kind
and note, posting any correction through the adjustment path and its approval); listStockAvailability
(on hand less reserved less held) and listStockUnits. Each write with a wrong-role refusal. Post every
movement through Stock.postIn; never write a projection. Keep the valuation gate and the stock-take and
hold domain gates at 100 percent. Stop at the gate and write
docs/sessions/B05d2-inventory-reservations-exceptions.md.
```
