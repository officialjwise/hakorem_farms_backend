# B05 continued 2: movements and their reversal, transfers through in-transit, adjustments with approval

Date: 2026-11-15 · Branch `b05c-inventory-control`, from `b05b-inventory-documents` · Pull request #21 (stacked on #20, not merged) · Status: **phase split** (A-140). The movement reads and reversal, transfers and adjustments are built and green. **B05 continued 3** (`b05d-inventory-counts-holds`) and **B05 continued 4** (`b05e-inventory-cold-chain-opening`) build the rest, and B05 continued 4 runs the B5 gate in full.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-139 | **How movements, transfers, adjustments and reversals read FR-INV-004 and FR-INV-010 to FR-INV-012 where they are silent.**<br>- **Who:** the Owner, Manager and Storekeeper read, reverse, transfer and adjust. The Owner and Manager hold `inv.adjustment.approve`, the checker for both `STOCK_WRITE_OFF` and `STOCK_REVERSAL`. The Accountant reads all three and writes none. Every other role holds none.<br>- **Thresholds:** both kinds need approval at or above 50,000 pesewas, with step-up. The threshold is read through IAM's new `Approvals.judgeIn` and copied onto the document, so the database checks the row against itself. ADR-0047 is not widened.<br>- **Adjustments:**<br>&nbsp;&nbsp;- a reason from the `STOCK_ADJUSTMENT` or `WASTAGE` lists, and a note where the reason requires one;<br>&nbsp;&nbsp;- a loss is valued at the pool issue value, a gain at the pool average (`valueAtAverage`);<br>&nbsp;&nbsp;- animals are never adjusted, in either direction;<br>&nbsp;&nbsp;- a typed weight is recorded `MANUAL`;<br>&nbsp;&nbsp;- the approval is bound to the lines and their values;<br>&nbsp;&nbsp;- the checker is the actor of the movements.<br>- **Transfers:**<br>&nbsp;&nbsp;- stock goes through the source branch's `IN_TRANSIT` location (the seed adds Dodowa's `TRANSIT`);<br>&nbsp;&nbsp;- any hold blocks dispatch;<br>&nbsp;&nbsp;- a shortfall posts `ADJUST_LOSS` with a `TRANSFER_VARIANCE` exception;<br>&nbsp;&nbsp;- a dispatched transfer is never cancelled;<br>&nbsp;&nbsp;- **no approval at receipt**, because `receiveStockTransfer` has no 202 in the contract.<br>- **Reversals:**<br>&nbsp;&nbsp;- each is an `inv.stock_reversal` document;<br>&nbsp;&nbsp;- a reason from `STOCK_ADJUSTMENT` and a note are required;<br>&nbsp;&nbsp;- a transfer's movements, value-only movements and reversals are never reversed by hand;<br>&nbsp;&nbsp;- a reversal whose pool value is gone is refused (`POOL_VALUE_GONE`).<br>- **Tests:** IAM's approval tests now borrow `SALE_VOID` and a test-only permission. | Owner |
| A-140 | **The split.** This session built the movement reads and reversal, transfers and adjustments (migrations 0050 to 0053, 15 operations, contract 1.17.0).<br>- **B05 continued 3:** stock takes and cycle counts; holds, reservations with the expiry job, and exceptions; availability; the stock unit list.<br>- **B05 continued 4:** cold chain; reorder and expiry alerts; the nightly scheduling; the `OPENING_STOCK` sheet with its port ADR; then the B5 gate in full. | Owner |

**Needs the owner's approval:**
- **No new dependency.**
- **No new ADR.**

I found no ADR conflict:
- `Approvals.judgeIn` and the `MasterDataRefs` additions are published interfaces of lower modules, not ports (ADR-0008).
- The new tables follow ADR-0012 and ADR-0024.
- No database function was published, so ADR-0047 stands as it is.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05 continued 2.
2. **Scope:**
   - the transfers, adjustments, stock takes, holds, reservations, exceptions, cold chain and alerts;
   - the nightly scheduling;
   - the remaining INV operations;
   - the `OPENING_STOCK` sheet.
3. **Gate:** the B5 gate in full:
   - on-hand from movements matches a hand count of the seeded farm;
   - stock cannot go negative outside the allowed types;
   - a lot traces both ways;
   - every INV write refuses the wrong role.

About 40 operations remained, and they would not reach that gate in one context. So I built the stock documents that move stock by a person's decision and split at that sub-domain boundary, as "If a session cannot finish" allows.

## Contract changes

**Version 1.17.0, additive.** Nothing a client sends changed, and a client generated from 1.16.x compiles unchanged. See `docs/CONTRACT_CHANGELOG.md`.

- **15 operations now run in code**, which makes 162 from code and 438 planned:
  - **Movements:** `listMovementTypes`, `listStockMovements`, `getStockMovement`, `reverseStockMovement` and `listStockUnitMovements`.
  - **Transfers:** the six transfer operations.
  - **Adjustments:** the four adjustment operations.
- **New error codes:** `STOCK_TRANSFER_INVALID`, `TRANSFER_VARIANCE`, `STOCK_ADJUSTMENT_INVALID` and `STOCK_REVERSAL_NOT_POSSIBLE`.
- **Descriptions and `x-error-codes`** are added on all 15.
- Redocly lint is clean, and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0050:** the document type `STOCK_REVERSAL`.<br>**0051:** `inv.stock_transfer` and its lines, `inv.stock_adjustment` and its lines, and `inv.stock_reversal`.<br>- `inv.document_status_guard`: each document starts in its first status and moves only along its listed transitions (HK004).<br>- Freezes: received or cancelled transfers, posted or rejected adjustments and reversals. A dispatched or pending document changes only to be decided.<br>- `inv.stock_document_part_guard`: lines are written while the document is a draft, then only the next step's columns, once.<br>- `ck_stock_adjustment_approved` and `ck_stock_reversal_approved`.<br>**0052 and 0053:** nine permissions and their grants, and the two approval policies at 50,000 pesewas with step-up |
| Domain | **`domain/stock-documents.ts`:** the line rules, the adjustment rules and the receipt plan.<br>**`valueAtAverage`** in `domain/valuation/cost-pool.ts`, under the 100 percent gate |
| Application | **`StockMovements`:**<br>- reads, narrowed to the reader's grants;<br>- `reverse`, with the `STOCK_REVERSAL` approval handler.<br>**`StockTransfers`:** create, dispatch, receive with variance, and cancel.<br>**`StockAdjustments`:** `createIn` and `submitIn`, with the `STOCK_WRITE_OFF` handler.<br>- Shared steps live in `stock-command.ts`, and the store is `PgStockDocumentsStore`.<br>- Every movement goes through `Stock.postIn`.<br>- Every write is serializable, authorised in the handler, scoped, idempotent and audited |
| Other modules | **IAM:** `Approvals.judgeIn`.<br>**MDM:** `MasterDataRefs.branchesIn`, `reasonCodesIn` and `physicalLocationOfKindIn` |
| Interface | `StockControlController`, strict zod schemas, and 15 fragments |
| Seed | Dodowa's `TRANSIT` location (in-transit), created through `LocationsAdmin`. The hand count is unchanged |
| Docs | - API.md: the INV section and the four error codes.<br>- `data-model/inv.md` and DATA_MODEL.md.<br>- The INV and MDM cards.<br>- THREAT_MODEL: abuse case 7 updated; 20 and 21 added.<br>- ADR-0026 Amendments.<br>- The openers: this one marked split, two new sections added, and B6 now reads `B05e-inventory-cold-chain-opening.md`.<br>- CONTRACT_CHANGELOG |

## Decisions

- **No ADR.** Each choice was a reversible reading, recorded as A-139.
- The data model said a posting function would read `iam.approval_policy`. That was replaced by copying the threshold onto the row, which avoids widening ADR-0047.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

- **No new request.** CR-001 to CR-008 were answered earlier.

## Deferred

- **To B05 continued 3:**
  - stock takes and cycle counts;
  - the hold, reservation and exception services, with the reservation expiry job;
  - `listStockAvailability` and `listStockUnits`.
- **To B05 continued 4:**
  - temperature readings with quarantine;
  - reorder rules and alerts;
  - expiry alerts, and the refusal to sell an expired lot;
  - the nightly scheduling;
  - the `OPENING_STOCK` sheet and its port ADR, and the `OPENING` receipt kind;
  - the B5 gate in full.
- **To B12:** the daily exception report items for abuse cases 7, 20 and 21.
- **For the owner:** approval of a large variance at transfer receipt needs a 202 on `receiveStockTransfer`, which is a contract change (A-139).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **659 passed.** New: `stock-documents.spec.ts`, and gain values in `cost-pool.spec.ts`:<br>- 1 of 3 crates worth 100,001 carries 33,334;<br>- 4 from 3 worth 10,500 carries 14,000;<br>- half a pesewa rounds up;<br>- an empty pool carries 0 |
| Integration | **622 passed** (unit and integration together: **1,281 passed**). New: `stock-control.integration.spec.ts` (19 tests):<br>- all seven writes refuse the Accountant, Cashier, Sales, Driver and Farm hand: 35 audited refusals, and nothing moves;<br>- the wrong location is refused;<br>- 10.000 kg goes through in-transit at an unchanged value;<br>- receiving with no variance reason is 422 `TRANSFER_VARIANCE`;<br>- a 0.200 kg shortfall is valued 2,400 and raises an exception;<br>- the database refuses changes to a received transfer;<br>- 12 crates at 42,000 post at once;<br>- 15 crates at 52,500 answer 202, the maker is refused with `MAKER_CANNOT_CHECK`, and the owner approves;<br>- a found-yam gain of 60,000 is rejected;<br>- reason, note and animal refusals;<br>- the database refuses an unapproved posting at the threshold;<br>- a reversal at 3,500, once; a reversal of a reversal is refused;<br>- the sheep's 75,001 receipt is reversed after approval;<br>- a transfer's movement is not reversible;<br>- the ledger listing is scoped.<br>The handler walk, the no-grant walk and the seed tests were updated |
| Coverage, merged | Statements 93.97 percent and branches 84.93 percent (gate 80). Every 100 percent gate holds, valuation included |
| Contract | **48 passed**, including the new movements, transfers and adjustments shape test |
| Lint, type check, schema names, Redocly | Clean |
| End to end | It runs in CI. Only the location list expectation changed |

## Gate

**This session's part passed. The B5 gate in full runs in B05 continued 4 (A-140).** Proven by running against real PostgreSQL over the HTTP API:
- **Every write built here refuses the wrong role and the wrong location.** That is the reversal, the four transfer writes and the two adjustment writes.
- **An adjustment at or above the threshold waits for a different person.** The database refuses one posted without an approval.
- **A transfer balances:** received plus variance equals dispatched.
- **B05 continued's gate tests** (hand count and two-way trace) still pass, unchanged.

## Notes for the frontend track

- **New live operations:** movements and reversal, transfers and adjustments.
- **Handle the 202 `ApprovalPending`** on `submitStockAdjustment` and `reverseStockMovement`.
- **Variance reasons** come from the stock adjustment and wastage lists. The contract example's `DRIP_LOSS` is not on the fixed list.

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):
- **`be670a4`** (the last commit before this report): push run `43693961191` **success**; pull_request run `43693991490` **success** (the pull_request run includes the contract versioning check against the base branch, the image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.

## Next session

B05 continued 3. The opener is in `docs/prompts/session-openers.md`, section "B05 continued 3 — Stock takes, holds, reservations and exceptions":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05c-inventory-control.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part) and ADR-0047, A-131 to A-140 in
docs/ASSUMPTIONS.md, migrations 0044 and 0051, and src/modules/inv/application/stock-adjustments.ts as the
pattern for a document with approval. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on stock-take variance posting, hold release and exception resolution.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 3 only, on branch b05d-inventory-counts-holds, branched from b05c-inventory-control:
stock takes (createStockTake through submitStockTake, listStockTakes, getStockTake, listStockTakeLines,
cancelStockTake) with expected figures frozen at start and hidden from the counter, recounts, a variance
report, STOCKTAKE_GAIN and STOCKTAKE_LOSS movements, and approval of a variance value at or above the
threshold (STOCK_WRITE_OFF, maker and checker differ); cycle counts that refuse overlapping scopes; the
hold service (listStockHolds, createStockHold for QUARANTINE and INVESTIGATION, releaseStockHold with a
named user and a reason, a WITHDRAWAL hold never released early) and the in-process Holds interface LIV
will call; the reservation service (listStockReservations, releaseStockReservation, the Reservations
interface with serializable reserve) and the scheduled reservation expiry job publishing
inv.ReservationExpired; the exception service (listStockExceptions, getStockException,
resolveStockException posting any correction through the adjustment path); listStockAvailability and
listStockUnits. Each write with a wrong-role refusal. Post every movement through Stock.postIn; never
write a projection. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05d-inventory-counts-holds.md.
```
