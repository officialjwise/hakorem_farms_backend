# B05 continued: goods receipts, stock on hand at cost, the trace over HTTP and the seeded stock

Date: 2026-11-15 · Branch `b05b-inventory-documents`, from `b05-inventory-ledger` · Pull request #20 (stacked on #19, not merged) · Status: **phase split** (A-138). Goods receipts, the stock reads and the seeded stock are built and green. **B05 continued 2** (`b05c-inventory-control`) builds the rest and runs the B5 gate in full.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-135 | **Who holds the new permissions.**<br>- `inv.stock.read` and `inv.goods_receipt.read`: the Owner, Manager, Accountant and Storekeeper.<br>- `inv.goods_receipt.create` and `inv.goods_receipt.post`: the Owner, Manager and Storekeeper.<br>- Every other role holds none.<br>- Receipt writes are scoped to the receiving location. Stock and receipt lists are narrowed to the branches and locations the reader's grants reach. | Owner |
| A-136 | **How goods receipts read FR-INV-005 and FR-INV-009 where they are silent.**<br>- A receipt of kind `OPENING` is refused until opening stock has its own controls.<br>- `purchaseOrderId` must name a registered `PURCHASE_ORDER`. None exists before B7. The over-receipt tolerance check belongs to B7.<br>- A serialised line's value is split equally across its animals by largest remainder.<br>- A purchase line needs a value; a harvest line may carry none. Every receipt movement uses cost element `PURCHASE`.<br>- A lot needs a batch number. It also needs an expiry date when its product has a shelf life, and that date cannot be before arrival.<br>- A receipt cannot be dated more than 5 minutes ahead of the server clock.<br>- The receiving location must be physical, and neither in-transit nor a site.<br>- A tag or batch already active for the product is refused at posting.<br>- `receiptNo` stays null until B8.<br>- Data model additions: `inv.goods_receipt_animal` and `cancel_reason`. | Owner |
| A-137 | **How the stock reads fill the contract.**<br>- `priceBand` is null.<br>- A trace's `costByElement` is the cost of its origins (the animals).<br>- `healthEvents`, and a sale's `customer` and `billingDocument`, are empty until LIV, ORD and BIL exist.<br>- `heldQty` is the whole positive on-hand while any hold covers the unit.<br>- Reading a lot needs a branch-wide grant.<br>- A stock line's value is its share of its pool.<br>- The on-hand list is paged in memory.<br>- MDM's new `MasterDataRefs` is a published interface, not a port, so it needs no ADR. | Owner |
| A-138 | **The split.** This session built goods receipts, the stock reads (on hand, stock unit, trace), CR-001 and CR-003 point 2, and the seed with stock, and ran the hand count and two-way trace part of the gate. **B05 continued 2** builds:<br>- transfers;<br>- adjustments;<br>- stock takes and cycle counts;<br>- the hold, reservation and exception services, with the expiry job;<br>- cold chain;<br>- reorder and expiry alerts;<br>- the nightly scheduling;<br>- the remaining INV operations;<br>- the `OPENING_STOCK` sheet;<br>- and then the B5 gate in full. | Owner |

**Needs the owner's approval:**
- **No new dependency.**
- **No new ADR.** ADR-0047 is unchanged: no published database function was added.

I found no ADR conflict:
- `MasterDataRefs` is a lower module's published interface, imported from a higher layer through `index.ts`, as ADR-0008 allows.
- The goods receipt tables follow the DOCUMENT rules of ADR-0012 and ADR-0024.

Phase, scope and gate, as confirmed at the start:

1. **Phase:** B05 continued, the stock documents, the INV endpoints, opening stock and the seed.
2. **Scope:** schema `inv` and the INV module. The documents are goods receipts, transfers, adjustments and stock takes. Also in scope: the hold, reservation and exception services, cold chain, alerts, the nightly scheduling, the INV operations with their permissions, the `OPENING_STOCK` sheet, and the seed with stock.
3. **Gate:** the B5 gate in full:
   - on-hand from movements matches a hand count of the seeded farm;
   - stock cannot go negative outside the allowed types;
   - a lot traces both ways over the API;
   - every INV write refuses the wrong role.

I judged early that the whole scope (about 45 operations) would not reach its gate in one context. So I split at the sub-domain boundary after goods receipts and the stock reads, as "If a session cannot finish" allows.

## Contract changes

**Version 1.16.0, additive.** Nothing a client sends changed, and a client generated from 1.15.x compiles unchanged. See `docs/CONTRACT_CHANGELOG.md`.

- **Nine operations now run in code:** `listStockOnHand`, `getStockUnit`, `traceStockUnit`, `listGoodsReceipts`, `createGoodsReceipt`, `getGoodsReceipt`, `updateGoodsReceipt`, `postGoodsReceipt` and `cancelGoodsReceipt`. That makes 147 from code and 453 planned.
- **`StockOnHandLine` and `StockUnit` gain the required `uomDisplayDecimals`** (CR-003 point 2).
- **New error code `GOODS_RECEIPT_INVALID`.**
- **Descriptions and `x-error-codes`** are added on the nine operations.
- Redocly lint is clean, and `contract:generate` reports no difference from the committed file.

## Built

| Area | What |
| --- | --- |
| Migrations | **0047:** `inv.goods_receipt`, its lines and `inv.goods_receipt_animal`.<br>- POSTED and CANCELLED are final (`freeze_posted`).<br>- Lines and animals are frozen with their receipt (`goods_receipt_part_guard`, HK004).<br>- `clear_draft_goods_receipt_lines` replaces a draft's lines (SECURITY DEFINER; there is no DELETE for `hk_app`).<br>**0048 and 0049:** the four permissions and their grants |
| Domain | **`domain/goods-receipt.ts`:** the line rules.<br>**`domain/valuation/pool-lines.ts`:** a pool's value over its lines by `allocate`, the unit cost half-up, and an even split over animals. It is under the 100 percent gate |
| Application | **`GoodsReceipts`:** list, get, create (`createIn`), update at the version read, cancel, and post (`postIn`).<br>- Posting checks the rules again, then registers the stock units and posts one movement per unit or untracked line, all through `Stock.postIn`.<br>- It publishes `inv.StockUnitRegistered`, and each movement publishes its own ledger event.<br>- Every write is audited and idempotent.<br>**`StockQueries`:** on hand at cost, stock unit, and trace.<br>**`Lineage.traceIn`:** the trace in the caller's transaction.<br>**`counting.ts`:** the non-money arithmetic, kept out of the files that import Money |
| Platform and other modules | **IAM:** `Authoriser.scopes`.<br>**MDM:** `MasterDataRefs` with `PgMasterDataRefsStore` |
| Interface | `GoodsReceiptsController`, `StockController`, strict zod schemas, and nine fragments in `inv/interface/openapi/` |
| Seed | `src/seed/farm-inv.ts`, written as the seeded Manager through the services:<br>- three suppliers;<br>- five posted receipts: goats, sheep, broilers, beef, goat meat, eggs, and harvested yam and cabbage.<br>`SEED_HAND_COUNT` is the separate hand count |
| Docs | API.md (the INV section, and `GOODS_RECEIPT_INVALID` in the catalogue); `data-model/inv.md` and DATA_MODEL.md; the MDM and INV cards; THREAT_MODEL abuse case 19 (`GOODS_RECEIPT_UNMATCHED`); ADR-0026 Amendments; the openers (B05 continued marked split, the new section "B05 continued 2", and B6 now reads `B05c-inventory-control.md`); CONTRACT_CHANGELOG |

## Decisions

- **No ADR this session.** Each choice was a reversible reading, recorded as A-135 to A-137.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

- **CR-001 (stock valuation at cost): implemented.** `listStockOnHand` returns:
  - `unitCostPesewas`;
  - `valueAtCostPesewas`, each line's exact share of its pool;
  - `valuationMethod`;
  - `totalValueAtCostPesewas` over the whole filter;
  - `asOf`.
  Cost and price are never one field. `priceBand` is null, because which channel's band a stock screen shows is undecided (A-137).
- **CR-003 point 2 (unit precision on stock lines): implemented.** `StockOnHandLine` and `StockUnit` carry `uomDisplayDecimals` from the unit itself.
- **CR-002 and CR-004 to CR-008:** unchanged; they were answered earlier.

## Deferred (all to B05 continued 2, A-138)

- **Stock documents:** transfers with in-transit and receipt variance; adjustments with approval at the threshold; stock takes with blind counts and cycle counts.
- **Services and jobs:** the hold, reservation and exception services, with the reservation expiry job.
- **Cold chain and alerts:** temperature readings and quarantine; reorder and expiry alerts, including the refusal to sell an expired lot.
- **Nightly job:** scheduling the recompute.
- **Remaining INV operations:** movements and their reversal, stock unit lists and movements, availability, holds, reservations, exceptions, transfers, adjustments, stock takes, reorder rules, alerts and temperature.
- **Not yet built:** `ProductUsageCheck`.
- **Opening stock:** the `OPENING_STOCK` sheet and its port ADR, and the decision on the `OPENING` receipt kind.

**Outside B05 continued 2:**
- **B7:** the over-receipt tolerance against a purchase order.
- **B12:** the `GOODS_RECEIPT_UNMATCHED` item on the daily exception report, with its two tests.
- **No end-to-end test for inventory yet.** The stack's e2e suites sign nobody in, to save the login budget. The stock reads need a session, so the gate is proved over HTTP against the real application in the integration layer.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **642 passed.** New: `pool-lines.spec.ts`, `goods-receipt.spec.ts` and `counting.spec.ts`. They cover:<br>- 100,001 over 3 as 33,334, 33,334 and 33,333;<br>- 99,999 over 12.500 and 2.500 kg as 83,333 and 16,666;<br>- a negative line valued 0;<br>- a half pesewa rounded up;<br>- the maximum pesewa amount;<br>- 110,000 over 20 animals as 5,500 each |
| Integration | **602 passed** (unit and integration together: **1,244 passed**). New:<br>**`goods-receipts.integration.spec.ts` (14 tests):**<br>- the wrong roles are refused on all four writes, each refusal audited;<br>- the cold room storekeeper is refused in the pens;<br>- 20 broilers post at 110,000;<br>- four goats bought for 100,001 split as 25,001, 25,000, 25,000 and 25,000;<br>- a posted receipt is frozen, both in the handler and in the database;<br>- a replay posts once;<br>- cancel works on a draft only;<br>- an update at a stale version answers 409;<br>- each line rule is refused.<br>**`seeded-stock-gate.integration.spec.ts` (9 tests):**<br>- the hand count;<br>- the ledger sum, with no drift;<br>- line values;<br>- paging;<br>- scope;<br>- filters;<br>- the trace both ways;<br>- the trace refused to the wrong roles.<br>Also updated: the handler walk and the seed unit kinds |
| Coverage, merged | Statements 93.96 percent and branches 85.64 percent (gate 80). Every 100 percent gate holds, valuation included |
| Contract | **47 passed**, including the new `b5/inventory.contract.spec.ts` |
| Lint, type check, schema names, Redocly | Clean |
| End to end | It runs in CI; I did not run it on this machine |

The tests were written alongside the code, not strictly before it. The domain rules and their exact values were pinned in unit tests before the integration layer ran.

## Gate

**Run in part: the phase split (A-138).** Passed now, against real PostgreSQL over the HTTP API:

- **On-hand from movements matches a hand count of the seeded farm.**
  - Every Dodowa location equals `SEED_HAND_COUNT`:
    - PENS: 4 goats, 2 sheep and 20 broilers.
    - COLD: 45.000 kg of beef and 30.000 kg of goat meat.
    - SHOP: 30 crates of eggs, 40 yam and 25 cabbage.
  - The total at cost is 1,595,501 pesewas.
  - The listing agrees with a fresh sum of the ledger, and the nightly recompute finds no drift.
- **A lot traces in both directions over the API.**
  - Backward: the sold lot LOT-GOAT-0002 traces to G-0143, Kpone Livestock Traders, and PURCHASE 60,000, FEED 8,400 and VETERINARY 3,000.
  - Forward: G-0143 traces to the lot and its sale.
- **Every goods receipt write refuses the wrong role**, and the wrong location.
- **Stock cannot go negative outside the allowed types.** This is proved at the database by B5's integration tests, which are unchanged and pass.

Still to run in B05 continued 2: the wrong-role refusal on the INV writes it builds, and the gate as a whole.

## Notes for the frontend track

- **New live operations:** goods receipts, stock on hand and the trace.
- **`uomDisplayDecimals`** is on every stock line, so the local mock override of CR-003 can go.
- **Stock line values:** use `valueAtCostPesewas` and `totalValueAtCostPesewas` as given; never sum rows. `priceBand` is null for now.

## Next session

B05 continued 2. The opener is in `docs/prompts/session-openers.md`, section "B05 continued 2 — Transfers, adjustments, stock takes, holds, cold chain, alerts and opening stock":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B05b-inventory-documents.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the INV requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/inv.md, the INV card in docs/MODULE_BOUNDARIES.md, ADR-0002, ADR-0005, ADR-0017,
ADR-0018, ADR-0019, ADR-0027 (the stock exception part), ADR-0046 and ADR-0047, A-128, A-131 to A-138
in docs/ASSUMPTIONS.md, and migrations 0044 and 0047. Use docs/prompts/module-build-prompt.md as the
recipe, and run hakorem-security-review on adjustments, write-offs and the opening stock import.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B05 continued 2 only, on branch b05c-inventory-control, branched from b05b-inventory-documents:
transfers with in-transit and receipt variance, adjustments with approval at the threshold (maker and
checker differ), stock takes with blind counts and cycle counts that refuse overlapping scopes, the hold,
reservation and exception services with the reservation expiry job, temperature readings with automatic
quarantine, reorder and expiry alerts (and the refusal to sell an expired lot), the scheduling of the
nightly recompute, and the remaining INV endpoints of the contract (movements and their reversal, stock
units and their movements, availability, holds, reservations, exceptions, transfers, adjustments, stock
takes, reorder rules, alerts, temperature readings) with their permissions, each write with a wrong-role
refusal. Post every movement through Stock.postIn; never write a projection. Build the OPENING_STOCK
import sheet (A-128): the sheet is INV's, registered with MdmImports through a port MDM defines and INV
implements (a new port needs an ADR), posting OPENING_BALANCE movements in the import's transaction; then
decide whether a goods receipt of kind OPENING stays refused (A-136). Extend the seed through the services
where these documents need it. Keep the valuation gate at 100 percent. Run the B5 gate in full, stop at
it and write docs/sessions/B05c-inventory-control.md.
```

## CI

These are the runs that exist for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`1100539`** (the last commit before this report): push run `43690211662` **success**; pull_request run `43690239816` **success** (the pull_request run includes the contract versioning check against the base branch, the image build and the end-to-end suite, which ran the seed with stock).
- **This report's final commit:** its runs are named in the session's closing message, because a commit cannot name its own runs.
