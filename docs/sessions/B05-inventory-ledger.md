# B5: inventory and the stock movement ledger

Date: 2026-11-15 · Branch `b05-inventory-ledger`, from `b04e6-mdm-import-sheets` · Pull request #19 (stacked on #18, not merged) · Status: **phase split**. The movement ledger and its database invariants are built and green. **B05 continued** (`b05b-inventory-documents`) builds the rest and runs the B5 gate.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-131 | **The split.** B5 built the ledger core: migrations 0042 to 0046, the valuation domain, `Stock.postIn`, `Lineage` and `BalanceReconciliation`. B05 continued builds:<br>- the stock documents;<br>- the hold, reservation and exception services, with the expiry job;<br>- temperature readings and alerts;<br>- the INV endpoints and permissions;<br>- the scheduling of the nightly job;<br>- the `OPENING_STOCK` sheet;<br>- the seed with stock;<br>- and the gate | Owner |
| A-132 | **Weight range.** FR-INV-024 names 1000000.000 kg as out of range, but `NUMERIC(10,3)` holds up to 9,999,999.999. The data model wins: the test uses 10,000,000.000 kg, and no narrower cap is added | Owner |
| A-133 | **Who may trace.** `inv.trace.read` is granted to the Owner, Manager and Accountant only | Owner |
| A-134 | **How the triggers read ADR-0002 and ADR-0018 where they are silent:**<br>- **Value:** the value of any movement leaving a physical location comes from the cost pool, and the caller's figure is ignored.<br>- **Reversals:** a reversal carries its original's value exactly. It is refused when the pool can no longer give that value up; the correction is then an adjustment. A reversal of a reversal is refused.<br>- **Serial units:** a unit has no location until its first movement, which comes from a virtual location. Its status follows the virtual kind it moves to.<br>- **Lots:** a lot is `DEPLETED` when its physical stock reaches zero.<br>- **Branch:** a movement takes its branch from its physical side.<br>- **Reservations:** a movement that names a reservation consumes all of it. An allowed-negative movement that dips below reserved raises `RESERVATION_CONFLICT` instead of failing.<br>- **Ledger events:** `FEED_ISSUE`, `MEDICATION_ISSUE` and `BIRTH` post no ledger event of their own.<br>- **Expiry:** blocking the sale of an expired lot comes in B05 continued | Owner; accountant for the reversal and event rules |

**Needs the owner's approval:**
- **ADR-0047, proposed.** A lower layer may publish read-only database functions that a higher layer's trigger calls by key. MDM publishes `location_stock_facts` and `product_tracking`.
- **No new dependency.**

I found no ADR conflict:
- ADR-0002's trigger needs location and product facts. ADR-0047 gives the trigger those facts without reading MDM's tables, so ADR-0011 holds.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B5, inventory and the stock movement ledger.
2. **Scope:** the INV module, schema `inv`. The opener's list covers the ledger, units and lineage, cost pools, reservations, holds, the stock documents, exceptions, `OPENING_STOCK` and the seed.
3. **Gate:** on-hand derived from movements matches a hand count, stock cannot go negative outside the allowed types, and a lot traces in both directions.

## Contract changes

**None.** The contract stays at 1.15.0:
- No endpoint was added.
- `contract:generate` reports no change (138 operations from code, 462 planned).
- Redocly lint is clean.

## Built

| Area | What |
| --- | --- |
| Migrations | **0042:** the INV document types (`GOODS_RECEIPT`, `STOCK_TRANSFER`, `STOCK_ADJUSTMENT`, `STOCK_TAKE`, `STOCK_HOLD`).<br>**0043:** MDM's published functions (ADR-0047).<br>**0044:** schema `inv`. Movement types are seeded with their flags and ADR-0003 posting events. It adds stock units with a guard, lineage, and the movement ledger (LEDGER, `reject_change`). `stock_balance` and `cost_pool` are projections written only by the SECURITY DEFINER triggers `inv.check_movement` and `inv.apply_movement`. It also adds reservations (`inv.apply_reservation`), holds and exceptions with guards, and the views `pub_stock_on_hand`, `pub_stock_value` and `pub_movement`. Refusals are SQLSTATE HK010, with the rule as the constraint name.<br>**0045 and 0046:** `inv.trace.read`, and its grant |
| Domain | `inv/domain/valuation/cost-pool.ts`: `receive`, `issue` (half-up, empties the pool exactly, reports the uncovered quantity) and `capitalise`. It is under the 100 percent gate, now uncommented in `vitest.config.mts` |
| Application | **`Stock.postIn`:** serializable only. Refusals become `INSUFFICIENT_STOCK`, `STOCK_UNIT_NOT_AVAILABLE`, `STOCK_UNIT_ON_HOLD`, `STOCK_UNIT_RESERVED` and `STOCK_MOVEMENT_ALREADY_REVERSED`. It publishes the posting event, with the value the database decided, through the outbox.<br>**`Lineage`:** `linkIn` records which unit came from which. `trace` returns, in one call, the units a lot came from with each one's costs by element, the units that came from it, and their sales.<br>**`BalanceReconciliation.run`:** raises a `BALANCE_DRIFT` exception and an `inv.BalanceDriftDetected` event for each balance or pool that disagrees with the ledger. It never corrects anything |
| Infrastructure and wiring | `PgStockStore`; `InvModule` in `AppModule`; `inv/index.ts` |
| Checks | `schema-names.ts` allows `publishedFunctions` from a higher layer only, and its unit test proves it. The roles test tolerates the real `inv` schema. Three IAM and contract tests no longer insert a stand-in `STOCK_ADJUSTMENT` type |
| Docs | ADR-0047 and the ARCHITECTURE section 12 index; the INV card and MODULE_BOUNDARIES section 7; A-131 to A-134; ADR-0026 Amendments; the openers (B5 marked split, the new section "B05 continued", B6 now reads `B05b-inventory-documents.md`) |

## Decisions

- **ADR-0047 (proposed):** published database functions, rather than reading another schema's table or copying its flags.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

- **CR-001 (cost fields on stock lines):** deferred to B05 continued, which builds `GET /stock/on-hand`. The pools and views it needs exist now.
- **CR-003, point 2 (unit precision on stock lines):** deferred to B05 continued for the same reason.
- **CR-004 to CR-008:** answered earlier; nothing changed.

## Deferred (all to B05 continued)

- **Stock documents:** goods receipts, transfers and receipt variance, adjustments with approval, stock takes and cycle counts.
- **Services and jobs:** the services and endpoints for holds, reservations and exceptions, and the reservation expiry job.
- **Cold chain and alerts:** temperature readings and quarantine; reorder and expiry alerts, including the refusal to sell an expired lot.
- **Nightly job:** scheduling it. The worker has no module job hook yet, and `BalanceReconciliation` is built but not yet scheduled.
- **Permissions:** every INV endpoint, with its permissions and wrong-role tests.
- **`ProductUsageCheck`:** not built.
- **Opening stock:** the `OPENING_STOCK` sheet through a new port MDM defines, with its ADR.
- **Seed:** stock.
- **Gate:** the hand count of the seeded farm.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **620 passed.** New: `cost-pool.spec.ts` (13), covering 100,001 over 3 units as 33,334, 33,334 and 33,333; a half pesewa rounded up; one just below rounded down; 0.001 kg; specific identification at 71,400; and the uncovered offline issue. Also new: the schema-name case for published functions |
| Integration | **Run red first,** before migration 0044 existed: 39 failed. **Then green:**<br>- `movement-ledger.integration.spec.ts` (13): update, delete and truncate refused for `hk_app` (42501) and for the owner (HK001); projections not writable; the shape and numeric rules; reversal once, carrying 330,000.<br>- `stock-invariants.integration.spec.ts` (26): negative stock refused; the offline sale leaves -2 and raises one exception; a serial unit never goes negative; a second sale is refused; the wrong location is refused; two concurrent sales post exactly once; sale and dispatch under a hold are refused, with release once, withdrawal never released early, and a time-ended hold; reservations: a second one refused, 4 of 3 refused, a dip below reserved refused, consumption, expiry releases, wrong reservation refused; average cost in the database; 71,400; transfers keep their value.<br>- `stock-services.integration.spec.ts` (8): serializable-only posting, the error mapping, the outbox event at 33,334, 3 on hand after 10 receipts and 7 sales, drift detected and not corrected, the trace both ways, and the cashier refused.<br>**Unit and integration together: 1,199 passed** |
| Coverage, merged | Statements 93.77 percent, branches 85.62 percent (gate 80). Every 100 percent gate holds, the new valuation gate included |
| Contract | **45 passed** |
| Lint, type check | Clean |
| End to end | Unchanged. It runs in CI; I did not run it on this machine |

## Gate

**Not yet run as a whole: the phase split (A-131).** What is proved now, against real PostgreSQL:
- **Stock cannot go negative outside the allowed types.** Proved by direct SQL, and through `Stock.postIn` as `INSUFFICIENT_STOCK`.
- **A lot traces in both directions.** `LOT-GOAT-0001` traces back to G-0142 with its supplier, receipt and costs (PURCHASE 60,000, FEED 8,400, VETERINARY 3,000). G-0142 traces forward to the lot and its sale.
- **On-hand from movements equals the projection.** After 10 receipts and 7 sales, both read 3.

The hand count of the **seeded** farm waits for the seed with stock, in B05 continued.

## Notes for the frontend track

- **Nothing new to consume yet:** there are no new endpoints.
- **Planned stock error codes:** `INSUFFICIENT_STOCK`, `STOCK_UNIT_NOT_AVAILABLE`, `STOCK_UNIT_ON_HOLD` and `STOCK_UNIT_RESERVED`, as in `docs/API.md`. They are live in the domain now.

## Next session

B05 continued. The opener is in `docs/prompts/session-openers.md`, section "B05 continued — Stock documents, the INV endpoints, opening stock and the seed":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05-inventory-ledger.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0018,
ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128 and A-131 to A-134 in
docs/ASSUMPTIONS.md, and migration 0044. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued only, on branch b05b-inventory-documents, branched from b05-inventory-ledger:
goods receipts, transfers with in-transit and receipt variance, adjustments with approval at the
threshold (maker and checker differ), stock takes with blind counts and cycle counts that refuse
overlapping scopes, the hold, reservation and exception services with the reservation expiry job,
temperature readings with automatic quarantine, reorder and expiry alerts (and the refusal to sell an
expired lot), the scheduling of the nightly recompute, and the INV endpoints of the contract with their
permissions, each write with a wrong-role refusal; answer CR-001 and CR-003 point 2 on the stock lines.
Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK import sheet
(A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV implements
(a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction. Extend the seed
with stock through the services. Keep the valuation gate at 100 percent. Stop at the gate and write
docs/sessions/B05b-inventory-documents.md.
```

## CI

The runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`48460ad`** (the last code commit before this report): push run `43687298065` **success**; pull_request run `43687301967` **success** (the pull_request run includes the contract versioning check against the base branch, the image build and the end-to-end suite).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.
