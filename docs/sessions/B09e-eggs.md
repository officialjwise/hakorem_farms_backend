# B09e: eggs priced per selling unit, and a bought lot costed by its place in the delivery

Date: 2026-11-17 · Branch `b09e-eggs`, from `main` (`b899a40`) · Pull request #87 · Status: **gate passed for what was built; the phase split** (A-262). B09e continued runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-259 | **The owner's decision: option B (ADR-0075).** A bought lot is valued by its place in the delivery: `half_up(V0 x (p+q)/Q0) - half_up(V0 x p/Q0)`. With the owner's two conditions: rounding is half-up only, never half-to-even; and cost added to a delivery may leave a whole crate 1 pesewa off its even share, while the delivery still totals exactly. | Owner (decided); accountant reviews |
| A-260 | **The owner's decision: the six rejection reasons.** `CRACKED`, `BROKEN`, `DIRTY`, `SHORT`, `WRONG_ITEM` and `QUALITY_REJECTED`, in a `GOODS_RECEIPT_REJECTION` domain. Recorded here; B09e continued 2 builds them. | Owner (decided) |
| A-261 | **The owner's decision: the seeded eggs are counted per egg.** EGG-0001 to EGG-0003 are re-seeded with base unit `UNIT`, selling unit `CRATE` (30 to the crate), and a crate price and a single-egg price each. Only seed data changes. A-163 (c) still stands for real products. | Owner (decided) |
| A-262 | **B09e split at its sub-domain boundaries** (ADR-0026 Amendments). Receipts and transfers in crates, received dates and oldest first, and reorder points in the selling unit go to **B09e continued**. The rejection reasons, the claim (CR-035, CR-036) and the last price paid go to **B09e continued 2**. Both run before B9b. | Owner |

Still open, proceeded on as stated: as B09q continued listed, plus A-262.

**Stop and restart.** B09e first stopped before building. The owner's decision 2 (exact per-delivery cost) contradicted ADR-0018's issue rule:
- **ADR-0018 as written:** 2 crates at 4,750, then 3 singles, then a whole crate posts 4,751.
- **The kernel's `allocate` taken literally:** the first crate of 10 posts 4,770.

Three options went to the owner. The owner chose option B, with two conditions; the phase then restarted.

Phase, scope and gate, as confirmed at the start (after the owner's decision):
1. **Phase:** B09e (`b09e-eggs`, from `main` at `b899a40`). It may split at a sub-domain boundary after a green gate.
2. **Scope:** the owner's seven decisions, CR-035 and CR-036, and the three answers of 2026-11-17 (option B, six rejection reasons, eggs counted per egg).
3. **Gate:** as the opener states it. This session reached the gate for decisions 1, 2 and the breaks of 6. The rest is split (A-262).

## Contract changes

**2.1.0, minor and additive.** No existing field, parameter, schema or status changed. The changelog entry and the cold-read line are written.
- **`PriceListEntryInput.uom`**: optional.
- **`PriceListEntry.uom` and `minQtyBase`**: required in the answer. `minQty` is now counted in `uom`; it is unchanged for every entry in the base unit.
- **`PriceResolveLine.uom`**: optional. **`ResolvedPrice.uom`**: required in the answer.
- **`OrderLineInput.uom`**: optional (`createOrder`).
- **New details:** `PRICE_ENTRY_INVALID` gains `NO_CONVERSION`, `NOT_PER_KG` and `INEXACT_QUANTITY`. A line in a unit the product is not sold by is 422 (`REFERENCE_NOT_FOUND` on `resolvePrices`, `ORDER_INVALID` / `NO_CONVERSION` on `createOrder`).
- **Behaviour, same shapes:** sale, order and receipt lines keep the unit sold. The seeded eggs answer in eggs (900 where it was 30 crates).
- **Checks:** `contract:generate --check` is up to date (422 operations from code, 214 planned). Redocly is clean. `scripts/contract/versioning.ts` against `main` prints `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Migration 0214 (INV) | `inv.cost_pool.anchor_qty` and `anchor_value_pesewas` (`ck_cost_pool_anchor`). `trg_stock_movement_pool_anchor` anchors a lot's pool at its `RECEIPT_PURCHASE`. `trg_stock_movement_delivery_cost` values an issue by its place in the delivery, through `inv.half_up_div`. A pool that is off its schedule is anchored again at the next issue. Every other pool keeps ADR-0018's rule. Rollback is tested. |
| Migration 0215 (MDM) | `mdm.price_list_entry.uom` and `min_qty_uom`. The check `ck_price_list_entry_uom` (units always come with their break; never on `PER_KG`). The match key gains the unit. The guard `trg_price_list_entry_uom_guard` (HK010) allows only a unit the product converts from. The rollback keeps the data and removes only the guard; the up runs again over it (fixed after the first full run found the rollback could not drop the unit over seeded crate entries). |
| MDM domain (100 percent gate) | `resolvePrice` matches the entry's unit to the unit sold. Breaks are compared in the base unit. `defineEntries` converts a break with `toBase`, refuses an unknown unit or a unit on `PER_KG`, and stores the base unit named explicitly as null. `entryIdentity` keeps a base-unit entry's key (and cursor) unchanged. |
| MDM application and infrastructure | `PricingService.resolveIn` takes `ResolveLine.uom`, prices and extends by the quantity sold, and answers `uom`. The pricing store carries the base unit and live factors. The price list store writes and reads the unit and the break as entered. |
| ORD | `SalePosting` prices and records the unit sold; the receipt line is in it. `Orders.createIn` takes a line `uom`, converted through `MasterDataRefs.toBaseIn`; confirmation reserves the base quantity, and the shortfall is in the base unit. `OnlineOrders.placeIn` prices in the cart's unit. `Returns` converts a returned crate to eggs for the `SALE_RETURN`. |
| SHP | `pricingUom`: a storefront line, and its catalogue price, is in the sale unit, except catch-weight packs. |
| Seed | Eggs per egg with a crate conversion and two prices each. The INV receipt is 900 eggs at 105,000; the reorder rule is 600/900/2,400. The seeded day sells crates. The BIL lines are in `CRATE`. |
| Docs | ADR-0075 (indexed in ARCHITECTURE section 12). A-259 to A-262. ADR-0026 Amendments. The openers (B09e continued, B09e continued 2, and B9b reading B09e continued 2's report). `docs/data-model/inv.md` and `mdm.md`. API.md (pricing). The MDM and INV cards. The `hakorem-stock` skill item 11. The changelog. |

## The gate, proved by running it

**A crate and a single egg each carry their own price; stock stays in eggs.**
- `mdm/selling-units` (7 tests, through the API):
  - a crate at 5,500, 10 crates at 5,250 and a single egg at 200 sit side by side;
  - the break is entered as 10 crates and stored as 300 eggs;
  - 9 crates keep 5,500;
  - 300 single eggs stay at 200;
  - BAG is refused, a unit on `PER_KG` is refused, and the database guard refuses too;
  - the Cashier is refused (403) and nothing is written.
- `pricing-gate` (the oracle now walks the selling unit): the seeded big eggs at the counter are 6,000 a crate and 220 an egg. A reseller pays 5,520 and 202.
- Unit tests: the engine never derives a crate from an egg. A list with only an egg price sends a crate to a quote.

**A delivery's cost is spread by place, never egg by egg; a crate bought at GHS 47.50 posts exactly 4,750.** In `inv/delivery-cost`, 14 tests:
- **3 singles first** (2 crates): 158, 159, 158, then the crate at 4,750.
- **1 single first** (10 crates): three crates at 4,750 each.
- **A random mix of 120 sales:** every crate at 4,750; the delivery at 47,500.
- **30 singles in a row:** 4,750.
- **Reversal, value-only addition, gain and transfer** follow the ADR's rules.
- **ADR-0018 unchanged elsewhere:** an untracked pool and an opening lot still post 4,751.
- **The owner's conditions:**
  - At 4,751 a crate, after 15 singles (a running total of 2,375.5), the crate posts 4,751. A 10-crate mix that passes through exact halves posts each of its 7 crates at 4,751, and the delivery at 47,510.
  - 3 crates plus 100 of transport post 4,783, 4,784 and 4,783: 14,350 in all, none more than 1 pesewa from the even share.

**On the seeded farm** (`ord/eggs-by-the-crate`, 5 tests):
- the lot is anchored at 900 and 105,000;
- 1 crate sells at 6,000: line 1 `CRATE`, issue 30 eggs at exactly 3,500;
- 3 singles sell at 660, costing 350;
- the next crate costs 3,500 again, and 2 crates 7,000;
- the trial balance is 0, and the inventory accounts equal the cost pools (`LedgerReconciliation` clean).
- The seeded trading day (`fin/trial-balance`) still ties.

**Orders and returns take a crate.**
- `ord/orders`: 2 crates at 12,000 and 12 eggs at 2,640; `NO_CONVERSION` for BAG; confirmation reserves 120 eggs for 4 crates.
- `ord/order-return`: 1 of 2 crates comes back as 30 eggs at exactly 3,500, credited 1 `CRATE` at 6,000.

**Quantity breaks counted in the selling unit, stored in eggs:** above. Reorder points are B09e continued's.

**Every write refuses the wrong role.**
- **New writes:** none; only existing writes take new optional fields.
- **`replacePriceListEntries` with a unit:** the Cashier is refused (403).
- **`createOrder`:** keeps its role tests (Storekeeper, Investor, Cashier, another branch).

## Mutation checks (each applied alone, the targeted spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The lot never anchored (`trg_stock_movement_pool_anchor` disabled) | red: 4 of 11 (`delivery-cost`) |
| 2 | The schedule check dropped (never anchored again) | red: 2 of 11 |
| 3 | Half-to-even swapped in for half-up (`inv.half_up_div`) | red: 2 of 14, the two 4,751 tests. Every 4,750 test stays green, as the owner warned. |
| 4 | The engine ignores the entry's unit | red: 5 of 38 (`pricing-engine.spec`) |
| 5 | A break stored as entered, not in the base unit | red: 1 of 20 (`price-list.spec`) |
| 6 | `createOrder` not passing the line unit (controller) | red (`orders`: crates priced as eggs) |
| 7 | A returned crate not converted to eggs | red (`order-return`: 1 egg back, not 30) |
| 8 | The storefront and online placement not pricing in the sale unit | red: 3 of 20 (`storefront-checkout`) |

## Test first, as it honestly happened

- **`delivery-cost`:** written before migration 0214, and seen red: 4 of 11 failed on ADR-0018's rule. The owner's three condition tests were added after the rule existed and were proved by mutation 3.
- **`pricing-engine`, `price-list` and `price-list-preview` specs:** written first, and seen red (5, 4 and 1).
- **`selling-units`:** written after the domain and application layers but before the interface. Seen red (3 failed, 3 skipped) with the schemas held back.
- **`eggs-by-the-crate`:** written before the ORD change, and seen red (`TENDER_SHORT`: a crate priced as 30 eggs).
- **The `createOrder` and return tests:** written after their code, then shown red with that code held back (mutations 6 and 7).
- **The re-seed's first full run** failed 55 tests in 12 files, all counting eggs in crates, plus the 0155 rollback walk. Each was moved to eggs at the same pesewa values. Nothing was skipped.

## Decisions

- **ADR-0075**, accepted by the owner. It supersedes ADR-0018's issue rule for bought lots only.
- **A bought lot** is a lot pool anchored by a `RECEIPT_PURCHASE`. Harvest, opening and processing lots keep ADR-0018's rule.
- **0215's rollback keeps the data.** Dropping the unit would make the seeded crate and single-egg entries collide.
- **`createOrder` in crates was built here**, because the seeded orders sell crates. B09e continued's opener says so.

## Security review (hakorem-security-review)

- **Boundary:** TB2 (back office pricing and orders) and TB1 (storefront pricing).
- **Standards:**
  - SC-01: strict zod; a unit is `^[A-Z](2, 10)$`.
  - SC-02: no new operation; existing authorisation is unchanged and tested.
  - SC-03/04: parameterised SQL.
  - SC-05: money is integers; `extendPrice` rounds half-up once; costs are database-set, half-up (mutation 3).
  - SC-22/23: the new trigger functions are `SECURITY DEFINER` with a fixed `search_path`, and the pool stays a projection.
- **Abuse considered:**
  - A Manager prices a crate below 30 eggs' worth to move value. The price is an approved list version (maker-checker, `PRICE_LIST_ACTIVATION`), as before.
  - A wrong conversion factor: it is immutable and audited (B06u), and now affects prices and reservations. B09e continued judges it for receipts.
  - No new exception report item.

## Deferred

- **B09e continued:** receipts and transfers in crates; received dates and oldest first; reorder points in the selling unit; the egg examples in the INV contract fragments still show crates (examples only).
- **B09e continued 2:** the rejection reasons (A-260), CR-035, CR-036, breakage adjustment reasons, and the last price paid.
- **`PRICE_ENTRY` import sheet:** it stays in the base unit. A crate price is set through `replacePriceListEntries`.

## Contract requests

I fetched the frontend's `main` at `aea09a0`: CR-001 to CR-036.
- **CR-035 (breakage and rejection reasons): not built here.** The owner chose the codes (A-260): `CRACKED`, `BROKEN`, `DIRTY`, `SHORT`, `WRONG_ITEM` and `QUALITY_REJECTED`, in place of CR-035's `BROKEN_ON_ARRIVAL` and `SHORT_DELIVERED`. Building them moves to B09e continued 2, with the shape CR-035 asks for (`rejectionReasonCode`, `rejectionNote`, the 422 details).
- **CR-036 (a claim from a receipt): moved to B09e continued 2**, unchanged.
- **CR-031, CR-032 and CR-033** stay with B9b (and CR-033 point 3 with B11). **CR-018** stays with B12. **CR-034** was answered by 2.0.0.
- The others were answered in earlier phases, as B09q continued listed.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,499 passed**. New: the engine's selling unit (5), the entries per selling unit (4), preview identity by unit (1). |
| Coverage, merged (`pnpm test:coverage`) | **3,064 passed**, 248 files, exit 0. Statements 94.16 percent, branches 84.4 (gate 80), functions 97.63, lines 96.77. Every 100 percent gate held, including `mdm/domain` pricing. |
| Integration (in the merged run) | New: `inv/delivery-cost` (14), `mdm/selling-units` (7), `ord/eggs-by-the-crate` (5), one `orders` test, one `order-return` test, and the crate cases in `pricing-gate`. Twelve files were moved to eggs (the re-seed). |
| Contract | **118 passed**, 44 files, after the fix below. |
| Lint, typecheck, Redocly, `contract:generate --check`, versioning | Clean |
| End to end, setup, and the last migration rolled back and applied again | CI (the setup job passed on `6800eed`, 0215's rollback over the seeded farm included) |

## Gate

**Passed for decisions 1, 2 and the breaks of 6, with the egg re-seed. Phase split (A-262).**
- A crate and a single egg each carry their own price, while stock stays in eggs.
- A delivery's cost is spread by place in the delivery, half-up. A crate bought at GHS 47.50 posts exactly 4,750, whatever was sold before it.
- Breaks are counted in the selling unit and stored in eggs.
- The trial balance is 0 and the inventory accounts equal the pools.
- Every write refuses the wrong role.
- Decisions 3 (receipts and transfers), 4, 5, the rest of 6, and 7 are split to B09e continued and B09e continued 2.

## Notes for the frontend track

- **2.1.0 is additive.** Send `uom: CRATE` on a crate line (`resolvePrices`, `createOrder`) and show the answer's `uom`.
- **Seeded eggs now count in eggs:** stock 900, reservations 30 per crate. A crate's price and an egg's price are separate entries.
- **CR-035 and CR-036 come with B09e continued 2,** using the owner's six codes.

## CI

- **`6800eed`** (pull request #87 opened on it):
  - runs **44093375399 (push)** and **44093429692 (pull_request)** both **failed**, in the contract job only. `test/contract/b6u/uom-conversions` counted three seeded conversions; the re-seed makes six.
  - Every other job passed: lint, unit and integration with the coverage gate, setup with e2e, smoke and the rollback step, image, and security.
  - Fixed in its cause by commit `test(contract)`. Nothing was re-run, skipped or quarantined.
- The runs on the following commits and on the final head (this report's commit) are named in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09e continued, copied from `docs/prompts/session-openers.md` (this split inserted it; B9b follows B09e continued 2).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09e-eggs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decisions 3, 4 and 6 below, ADR-0018 and ADR-0075, A-157, A-163 and A-259 to A-262,
docs/data-model/inv.md, mdm.md and ord.md, and the MDM, INV and ORD cards in docs/MODULE_BOUNDARIES.md. Load
hakorem-stock, hakorem-money, hakorem-migration, hakorem-endpoint and hakorem-tests. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e continued only, on branch b09e2-eggs-lines-lots, branched from main. The owner's decisions
(2026-11-17), each test-first with exact quantity and pesewa assertions:
3. Lines in crates: goods receipts (createGoodsReceipt and its lines) and stock transfers accept a line in crates or in
   eggs, converted by the server through MasterDataRefs.toBaseIn (B06u), never with a factor of their own; the line
   keeps the unit it was entered in, and stock moves in eggs. Orders already do (B09e: createOrder, its confirmation's
   reservations, the sale posting, online placement and returns). A purchase order line already converts (B7): a
   receipt against it in crates matches it.
4. A received date on every bought lot (the receipt's received_at, kept on the stock unit); sell oldest first by
   expiry, then by received date, wherever the server picks a lot: promisable stock, reservations, checkout, and the
   sale when no lot is named.
6. (The rest of it.) Reorder points, minimum and maximum levels counted in the selling unit (a reorder point of 30
   crates), stored in eggs; the alert and the suggested reorder answer in both.
The cost of each issue stays the database's (ADR-0075): a crate bought at GHS 47.50 still posts exactly 4,750.
Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e2-eggs-lines-lots.md, and merge into main when every run on the pull
request is green.
```
