# B09e continued: eggs in crates on receipts and transfers, received dates and oldest first, reorder points in crates

Date: 2026-11-17 · Branch `b09e2-eggs-lines-lots`, from `main` (`6668e0d`) · Pull request #88 · Status: **gate passed**. B09e continued 2 runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-263 | **Lines in crates as built.** The base quantities stay in `qty_received`, `qty_rejected` and `qty_dispatched`, which stock, the pool, `inv.GoodsReceiptPosted`, the purchase order's match and supplier scoring read unchanged. The line also keeps its entered unit and quantities. The answer follows `PurchaseOrderLine`: `uom` and the entered quantities, with `baseUom` and the base quantities beside them. A transfer's `qtyReceived` and `varianceQty` stay in the base unit; the count on arrival may name its own unit. A draft is converted once, when its line is written. | Owner |
| A-264 | **The database checks each conversion** through a new published MDM function, `mdm.uom_to_base` (ADR-0047's list, `tooling/architecture.json`). INV still reads no MDM table. | Backend |
| A-265 | **The received date as built.** Every unit a goods receipt registers (of any kind) keeps the receipt's `received_at`; a processing output or a birth has none. The database refuses a purchase receipt of a lot without one. Oldest first: expiry (none last), then received date (none last), then unit id and location. | Owner |
| A-266 | **A sale that names no lot** takes the oldest live, unheld, unexpired lot at its location that covers the whole line; one line is one lot. A line no single lot covers is `STOCK_UNIT_REQUIRED`, as before. B09a's test of "a lot product with no lot named" now asks 31 crates against the seeded 30. | Owner |
| A-267 | **Reorder levels in crates as built.** A rule's unit is fixed when it is created; updates are in it. The base levels stay in the existing columns. An alert answers in the rule's unit through the rule's own maximum: whole units counted toward zero and what is left over, the level as entered, and the suggestion in whole units **rounded up** so the order reaches the maximum (a count of crates, not money). | Owner |
| A-268 | **The seeded big eggs entered in crates:** 30 crates received, a rule of 20, 30 and 80 crates. Everything stored is as B09e seeded it (A-261). | Owner |

No ADR conflict. ADR-0018 and ADR-0075 are untouched: the cost of every issue is still the database's, and a crate bought at GHS 47.50 still issues at exactly 4,750 (proved below for a delivery entered in crates).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09e continued (`b09e2-eggs-lines-lots`, from `main` at `6668e0d`).
2. **Scope:** the owner's decisions 3 (receipts and transfers in crates), 4 (received dates, oldest first) and the rest of 6 (reorder points in the selling unit), each test-first.
3. **Gate:** as the opener states it. All three were built; nothing was split.

## Contract changes

**2.2.0, minor and additive.** No existing field, parameter, schema or status changed for a line, rule or unit in the base unit. The changelog entry and the cold-read line are written.
- **`GoodsReceiptLineInput.uom`**, **`StockTransferLineInput.uom`**, **`TransferReceiveLine.uom`**, **`ReorderRuleCreate.uom`**: optional.
- **`GoodsReceiptLine.baseUom`, `qtyReceivedBase`, `qtyRejectedBase`**; **`StockTransferLine.baseUom`, `qtyDispatchedBase`**; **`ReorderRule.baseUom`, `minQtyBase`, `reorderPointQtyBase`, `maxQtyBase`**: required in the answer. `uom` is the entered unit and the entered quantities are in it; unchanged for every base-unit line or rule.
- **`StockUnit.receivedAt`**: required in the answer (date-time or null).
- **`StockAlert.inRuleUnit`** (new schema `StockAlertInRuleUnit`, or null): required in the answer.
- **New details:** `NO_CONVERSION` and `INEXACT_QUANTITY` on `GOODS_RECEIPT_INVALID`, `STOCK_TRANSFER_INVALID` and `REORDER_RULE_INVALID`.
- **Behaviour, same shapes:** lots are picked oldest first (expiry, then received date) by an order's confirmation and a checkout; a sale naming no lot takes the oldest lot that covers it (no HTTP operation posts such a sale yet; B9b's will).
- **Examples:** the INV examples count the seeded eggs per egg (B09e's deferred example fix).
- **Checks:** `contract:generate --check` is up to date (422 operations from code, 214 planned). Redocly is clean. `scripts/contract/versioning.ts` against `main` prints `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Migration 0216 (MDM) | The published function `mdm.uom_to_base(product, uom, qty)`: what `MasterDataRefs.toBaseIn` answers, in SQL (null for no live conversion or an inexact result). Listed in `tooling/architecture.json` and ADR-0047. |
| Migration 0217 (INV) | `inv.goods_receipt_line.uom`, `qty_received_uom`, `qty_rejected_uom`; `inv.stock_transfer_line.uom`, `qty_dispatched_uom`; their shape checks; `inv.line_uom_guard()` (HK010 `ck_line_uom_conversion`). The rollback keeps the data. |
| Migration 0218 (INV) | `inv.stock_unit.received_at`, backfilled from each unit's goods receipt; `ix_stock_unit_received`; `inv.require_received_date()` (HK010 `ck_stock_unit_received`). The rollback keeps the column. |
| Migration 0219 (INV) | `inv.reorder_rule.uom`, `min_qty_uom`, `reorder_point_qty_uom`, `max_qty_uom`; `ck_reorder_rule_uom`; `inv.reorder_rule_uom_guard()` (HK010 `ck_reorder_rule_uom_conversion`, the unit never changes). The rollback keeps the data. |
| INV domain (100 percent gates, new) | `oldestFirst` (expiry, then received date, then unit and location). `rule-unit`: `inRuleUnit` (whole units and what is left over), `wholeUnitsToReach` (rounded up), `exactlyInRuleUnit`. |
| INV application | `GoodsReceipts`: a line's unit converted through `toBaseIn` (refused `NO_CONVERSION`, `INEXACT_QUANTITY`), stored beside the base quantities, answered as entered and in the base unit; each unit it registers keeps `received_at`. `StockTransfers`: the same for a draft line, and an arrival counted in either unit. `StockQueries.promisableIn` sorts by `oldestFirst`; new `StockQueries.lotsAtIn`. `StockAlerts`: a rule's levels in its unit, and `inRuleUnit` on each level alert. `StockUnit` answers `receivedAt`. |
| ORD | `SalePosting`: a lot-tracked line that names no lot and no reservation takes the oldest lot at its location that covers it (`StockQueries.lotsAtIn`). |
| Seed | The big eggs are received as 30 crates and ruled in crates (20, 30, 80). Stored figures unchanged. |
| Tests | `inv/lines-in-crates` (10), `inv/oldest-first` (8), `inv/reorder-in-crates` (7), the two domain specs (5 and 6). The rollback walk lists 0216 to 0219. B09a's no-lot test and RPT's low-stock count read the new rule (below). |
| Docs | A-263 to A-268; the changelog; `docs/data-model/inv.md` and `mdm.md`; API.md (stock); ADR-0047's list; the MDM, INV and ORD cards; the `hakorem-stock` skill (items 5 and 9); B09e continued 2's opener (a rejected quantity may be in crates). |

## The gate, proved by running it

**Receipts and transfers take a line in crates or eggs, converted by the server through `MasterDataRefs.toBaseIn`.** `inv/lines-in-crates`, 10 tests:
- A receipt of 10 crates at 47,500 keeps `uom: CRATE`, `qtyReceived: 10.000`, and answers `qtyReceivedBase: 300.000`. Its movement, cost pool and journal are exactly those of 300 eggs entered in eggs:
  - one `RECEIPT_PURCHASE` of 300.000 at 47,500;
  - the pool at 300 and 47,500, anchored at 300 and 47,500;
  - the same journal lines, debits summing to 47,500.
- A crate sold from either delivery issues 30 eggs at exactly 4,750 (ADR-0075 unchanged).
- 9 crates received and 1 rejected store 270 and 30 eggs, with 9 and 1 as entered.
- `BAG` is refused (`NO_CONVERSION` on `/lines/0/uom`), and nothing is written.
- The database refuses a line whose eggs are not its crates times 30, or whose unit is changed (HK010), and a unit without its entered quantities (23514).
- A purchase order of 10 crates is completed by a receipt of 10 crates: `qtyReceived` 300.000, outstanding 0, `RECEIVED`.
- A transfer of 2 crates dispatches 60 eggs; its arrival counted as 58 eggs holds 2 as the variance. A transfer of 1 crate counted as 1 crate on arrival receives 30 eggs.
- `BAG` on a transfer is refused, and the database refuses a dispatched quantity off its crates (HK010).

**Every bought lot has a received date and sells oldest first, wherever the server picks a lot.** `inv/oldest-first`, 8 tests. The four deliveries of small eggs:

| Lot | Received | Expires | Registered |
| --- | --- | --- | --- |
| OLD | 6 days ago | in 20 days | first |
| MID | 3 days ago | in 10 days | second |
| LATE | 1 day ago | in 10 days | third |
| EARLY | 4 days ago | in 10 days | last |

- Each lot answers its receipt's `receivedAt`, and every seeded unit a receipt registered carries its receipt's date.
- The database refuses a purchase receipt of a lot with no received date, and a change of the date (HK010).
- **Promisable stock:** EARLY, MID, LATE, OLD. The tie on expiry is broken by received date, against the id order; the oldest delivery comes last because it expires last.
- **An order's reservation** (`confirmOrder`) holds EARLY.
- **A checkout's reservation** holds MID.
- **A sale that names no lot** takes LATE (one crate), then 3 single eggs from OLD; a crate no single lot covers is refused.
- Unit: `oldestFirst`, 5 tests, both directions of each key.

**Reorder points are counted in the selling unit and stored in eggs; the alert and the suggested reorder answer in both.** `inv/reorder-in-crates`, 7 tests:
- The seeded rule is 20, 30 and 80 crates, stored as 600, 900 and 2,400 eggs. The farm opens with one `LOW_STOCK` alert: 900 eggs against 900, suggesting 1,500 eggs; in crates, 30 against 30, suggesting 50.
- A rule of 20, 30 and 80 crates for the small eggs stores 600, 900 and 2,400 and alerts at once in both units.
- After 10 crates and 5 eggs arrive (305 eggs): 10 crates and 5 loose, threshold 20 crates, suggesting 2,095 eggs or 70 whole crates.
- A reorder point changed to 40 crates is 1,200 eggs.
- `BAG` is refused (`NO_CONVERSION`); the database refuses a level off its crates and a change of unit (HK010), and a level without its unit (23514).
- Unit: `rule-unit`, 6 tests (905 eggs are 30 crates and 5; 1,495 short is 50 crates; a negative balance; a factor of 5/2).

**Every write refuses the wrong role.**
- **New writes:** none; existing writes take new optional fields.
- **`createGoodsReceipt`, `createStockTransfer`, `receiveStockTransfer`** with a crate line: the Cashier is refused (403) and nothing is written or moved.
- **`createReorderRule`, `updateReorderRule`** in crates: the Cashier is refused (403) and nothing changes.
- **No new read:** `getStockUnit`, `listStockUnits`, `listReorderRules`, `listStockAlerts` keep their authorisation and their place in the identifier walk.

## Mutation checks (each applied alone, the targeted spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `oldestFirst` ignores the received date | red: 7 of 13 (`oldest-first` unit and integration) |
| 2 | Promisable stock sorted newest first (the order reversed) | red: 5 of 8 (`inv/oldest-first`) |
| 3 | The sale never picks a lot when none is named | red: 2 of 8 (`inv/oldest-first`) |
| 4 | A receipt line's unit ignored (crates booked as eggs) | red: 8 of 10 (`inv/lines-in-crates`) |
| 5 | A transfer's arrival unit ignored | red: 1 of 10 (`inv/lines-in-crates`) |
| 6 | Migration 0217's guard switched off | red: 2 of 10 (`inv/lines-in-crates`, the tamper tests) |
| 7 | The suggestion in crates rounded down | red: 2 of 13 (`rule-unit` and `inv/reorder-in-crates`) |
| 8 | A rule's levels stored as entered, not converted | red: the seed itself fails (the database refuses the eggs' rule in crates), 0 of 7 run |
| 9 | The receipt does not keep `received_at` | red: the seed itself fails (`ck_stock_unit_received`), 0 of 8 run |
| 10 | Migration 0219's guard switched off | red: 1 of 7 (`inv/reorder-in-crates`) |

## Test first, as it honestly happened

- **`inv/lines-in-crates`:** written before any code and seen red (7 failed, 3 skipped: `uom` refused as an unknown field). The wrong-role test was then 400, not 403, until the field existed.
- **`oldest-first.spec` (unit):** written first and seen red (no module), then the comparator; branch coverage was raised to 100 percent with both directions of each key.
- **`inv/oldest-first`:** written before the received date was kept and before the sale picked a lot. It was seen red: the seed failed on migration 0218's new rule (`ck_stock_unit_received`), since the receipts did not yet keep the date. After the date was kept, the checkout and the two sale tests were red until the sale picked a lot (one was a wrong status code in the test itself, 200 for a cart line).
- **`rule-unit.spec` (unit):** written with the code and run after it. It was proved by mutation 7, not by a red run before the code.
- **`inv/reorder-in-crates`:** written before the reorder code and seen red. The first red run also showed a wrong path in the test (`/stock-alerts` for `/stock/alerts`), which was fixed; the three alert tests then passed only with the code.
- **Changed expectations:** B09a's `order-payment-rules` refused any lot-tracked line naming no lot; decision 4 makes the server pick one, so it now refuses a line no single lot covers (A-266). RPT's `dashboard` compared the hand count with the rule's entered reorder point; it now reads the stored base point. Nothing was skipped.

## Decisions

- **No new ADR.** The published function is an addition to ADR-0047's list, as its Decision section provides.
- **The answer's shape follows `PurchaseOrderLine`** (B7): the entered unit and quantities under the existing names, the base unit and quantities beside them.
- **A sale that names no lot picks a lot** (the owner's decision 4) rather than being refused. The one existing test that asserted the refusal now asserts it for a line no lot covers.

## Security review (hakorem-security-review, the parts that apply)

- **Boundary:** TB2 (back office stock and reorder writes); TB1 unchanged (the checkout's reservation order only).
- **SC-01:** strict zod; a unit is `^[A-Z]{2,10}$`. **SC-02:** no new operation, authorisation unchanged and tested with the wrong role. **SC-03/04:** parameterised SQL. **SC-22/23:** the new trigger functions have a fixed `search_path`; `mdm.uom_to_base` is `SECURITY DEFINER`, `STABLE`, executable by `hk_app` and `hk_worker` only.
- **Abuse considered:** a storekeeper keys 10 crates as 10 eggs, or the reverse, to move value. The base quantity is the server's conversion and the database's check; the value is the receipt's line value as before (three-way matched). A crate on a receipt against a purchase order in crates matches only at its base quantity. No new exception report item.

## Deferred

- **B09e continued 2:** the rejection reasons (A-260), CR-035, CR-036, breakage adjustment reasons, and the last price paid. Its opener now says a rejected quantity may be entered in crates.
- **A sale line split across two lots** (A-266): not built; a line no single lot covers names its lot.

## Contract requests

I fetched the frontend's `main` at `5a44d38` at the start and again before writing this report: CR-001 to CR-036, nothing new.
- **CR-035 (breakage and rejection reasons) and CR-036 (a claim from a receipt): not built here; scheduled to B09e continued 2** by the owner (A-262), unchanged. That phase's opener now notes that a rejected quantity may be entered in crates (A-263), so the claim prices the base quantities.
- **CR-031 and CR-032** stay with B9b, **CR-033** with B9b (points 1 and 2) and B11 (point 3), **CR-018** with B12, as B09e listed.
- **CR-034** was answered by 2.0.0. The others were answered in earlier phases, as B09q continued listed. Nothing small or examples-only is left open for this phase's modules; B09e's deferred egg examples in the INV fragments are fixed here.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,510 passed**, 129 files. New: `oldest-first` (5), `rule-unit` (6). |
| Coverage, merged (`pnpm test:coverage`) | **3,100 passed**, 253 files, exit 0. Statements 94.17 percent, branches 84.46 (gate 80), functions 97.63, lines 96.79. Every 100 percent gate held, including the two new ones (`inv/domain/oldest-first.ts`, `inv/domain/rule-unit.ts`). |
| Integration (in the merged run) | New: `inv/lines-in-crates` (10), `inv/oldest-first` (8), `inv/reorder-in-crates` (7). The rollback walk (`bil/archive-link-rollback`) rolls 0219 to 0155 back over the seeded farm and applies them again. `ord/eggs-by-the-crate` and `fin/trial-balance` still tie on the seed entered in crates. |
| Contract | **118 passed**, 44 files. |
| Lint, typecheck, Redocly, `contract:generate --check`, versioning | Clean |
| End to end, setup, and the last migration rolled back and applied again | CI |

## Gate

**Passed.**
- Goods receipts and stock transfers take a line in crates or eggs, converted by the server through `MasterDataRefs.toBaseIn` and checked by the database; the line keeps its unit and stock moves in eggs. A delivery entered in crates gives the same stock, cost pool and journal as the same delivery entered in eggs, and a crate still issues at exactly 4,750.
- Every bought lot has a received date and sells oldest first, by expiry and then by received date, at every place the server picks a lot (promisable stock, an order's reservations, a checkout, a sale naming no lot), proved with lots whose dates disagree and a tie on expiry.
- Reorder points, minimum and maximum levels are counted in the selling unit and stored in eggs; the alert and the suggested reorder answer in both.
- The trial balance is 0 on the seeded day and the inventory accounts equal the cost pools.
- Every write refuses the wrong role.

## Notes for the frontend track

- **2.2.0 is additive.** A receiving, transfer or reorder screen in crates sends `uom: CRATE` and shows `uom` with the entered quantity and the `...Base` quantity in eggs. An arrival may be counted in eggs (`uom: UNIT`) on a crate line.
- **`StockUnit.receivedAt`** is the delivery's date; the server picks lots oldest first, so a picking screen need not.
- **`StockAlert.inRuleUnit`** gives a reorder alert in crates: whole crates and loose eggs, and the suggested order in whole crates.

## CI

- **`f754df6`** (the code and docs head; pull request #88 opened on it): run **44108838128 (push)** and run **44108887944 (pull_request)** both **succeeded**. Every job passed: lint and type check; unit and integration with the coverage gate; contract (the `pull_request` run compares the contract with `main`); the setup script with end to end, smoke and the last migration rolled back and applied again; the image build and scan; and security.
- No run was red on this branch, and nothing was re-run, skipped or quarantined.
- The runs on this report's own commit (the final head) are named in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09e continued 2, copied from `docs/prompts/session-openers.md` (updated this session: a rejected quantity may be entered in crates).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09e2-eggs-lines-lots.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions 5 and 7 below, CR-035 and CR-036 as committed on the frontend's main,
ADR-0075, A-260, docs/data-model/inv.md, pur.md and mdm.md (the reason codes), and the INV and PUR cards in
docs/MODULE_BOUNDARIES.md. Load hakorem-money, hakorem-stock, hakorem-ledger, hakorem-migration, hakorem-endpoint,
hakorem-security-review and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e continued 2 only, on branch b09e3-eggs-claims, branched from main. The owner's decisions
(2026-11-17), each test-first with exact pesewa assertions:
5. Cracked on arrival: a reason on every rejected quantity, from a new reason code domain GOODS_RECEIPT_REJECTION
   seeded with CRACKED, BROKEN, DIRTY, SHORT, WRONG_ITEM and QUALITY_REJECTED (A-260), each with requiresNote; the
   receipt line answers its reason and note (CR-035 points 2 and 3, with the codes A-260 names); STOCK_ADJUSTMENT
   breakage reasons (BREAKAGE and any the seed already names, CR-035 point 1); supplier scoring's rejection rate reads
   the same field (CR-035 point 4). A claim raised from the posted receipt drafts the supplier credit note from the
   rejected lines and their cost (from the purchase order line's price, split exactly with the kernel's allocate
   between accepted and rejected), never keyed by hand, linked both ways (the receipt answers its claims; the claim
   names its receipt, purchase order and the credit note or invoice that settles it), moving no stock, on the
   supplier's account until settled; the credit note keeps its existing approval, maker and checker apart,
   mutation-checked with test data where the maker, the receiver and the approver are different people (CR-036).
   Since B09e continued (A-263), a receipt line may be entered in crates: `qtyRejected` is counted in the line's `uom`
   and stored in the base unit (`qty_rejected`, `qtyRejectedBase`), so the claim's quantities and cost come from the
   base quantities, never from a factor of the claim's own.
7. A purchase order line defaults to the last price paid to that supplier for that product; no full supplier price
   list yet.
Answer CR-035 and CR-036 in the report. Every new read is authorised and joins the contract-generated identifier walk
(B09q continued). Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e3-eggs-claims.md, and merge into main when every run on the pull request is
green.
```
