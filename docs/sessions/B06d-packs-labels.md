# B06 continued 3: the Farm hand's cost-free reads, packs, labels and the reversing order

Date: 2026-11-15 · Branch `b06d-packs-labels`, from `main` (`4d3c6d9`) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-160 | **The Farm hand decision as built.** No staff cost-visibility pattern existed, so the role works through cost-free care operations under `/care/` with their own shapes (ADR-0029's pattern for customers and investors; ADR-0052). Shapes drop every cost **and price** field. Reads under the new `liv.care.read`; the role gives up `liv.batch.read`. It keeps every write, through care twins; a full write whose answer carries cost also needs that answer's read permission (`x-answer-permission`), which refuses only the Farm hand. This also closes the cost in the answers of `recordHealthEvent`, `recordFeedConsumption`, `reportMortality` and `submitMortalityRecord` (A-158's grants), which leaked as well as 0082's. Death records, feed consumption reads, the timeline, rations management and all of PRC stay refused. The matrix is recorded in A-158's resolution as the owner's decision. | Owner |
| A-161 | **Packs and labels.** One packing per saleable output of a completed order, while its lot is whole; weights sum **exactly** (FR-PRC-009, not the planned 0.050 kg); the count equals `packCount` when recorded; under 1,000 kg. Barcode CODE_128, payload `<lot>/<grams, six digits>`; equal-weight packs of one lot share it, so `prc.pack.barcode` is **not unique** (data model said UNIQUE). `printPackLabels` answers label data to draw (A-151), not a PDF link, and takes an Idempotency-Key. No pack is seeded, since the seed processes no order (B6's reason: the hand counts). | Owner |
| A-162 | **The reversing order.** `cancelProcessingOrder` on a COMPLETED order reverses it under its own document `prc.processing_reversal`; the order stays COMPLETED and frozen (`reverses_order_id` unused). Refused unless every lot is whole where the order put it, unreserved, and no pack has left IN_STOCK (`OUTPUT_SOLD`). Movements reversed through INV's new `StockMovements.reverseForDocumentIn`, outputs then inputs, at their own values, no reason code and no approval. Needs the new `prc.order.reverse` (Owner, Manager). The direct cost leaves stock with the lots; `prc.ProcessingOrderReversed` names it for B8. | Owner; accountant (where a reversed order's direct cost lands) |

**Needs the owner's approval:**
- ADR-0052 (proposed): cost-free care operations and `x-answer-permission`.
- Price bands withheld from the Farm hand along with cost.
- `printPackLabels` answering data rather than a PDF, and the non-unique barcode.
- Reversal by the Manager without a second approver.
- CR-019 has no phase (BL-057); please place it.

**I found no ADR conflict.** ADR-0018: the reversal carries each movement's own value through INV. ADR-0029: own shapes for a role that must not see cost. ADR-0047, ADR-0051 untouched. One new ADR (0052, proposed); no dependency.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B06 continued 3 (`b06d-packs-labels`, from `main`).
2. **Scope:** first the Farm hand's cost-free LIV reads and the cost leaks; then `prc.pack` (`createPacks`, `listPacks`, `printPackLabels`), the reversing order of FR-PRC-011, and the Farm hand's PRC access.
3. **Gate:** the Farm hand sees no cost on any LIV or PRC operation its grants reach and reads a treated goat's withdrawal hold; pack weights equal the lot weight and a label encodes lot and weight; a completed order is frozen and reverses only while unsold, restoring the animal at its prior cost; every pack write refuses the wrong role; A-153 decided.

## Contract changes

**Version 1.26.0, minor. No schema, field or enumeration value removed.** 258 operations from code, 369 planned, 627 published.
- **New:** sixteen care operations and nine `Care*` schemas (`docs/CONTRACT_CHANGELOG.md` lists them).
- **LOUD:** nine full LIV writes carry `x-answer-permission` (new extension) and refuse the Farm hand (403); `listBatches` and `getBatch` refuse it too.
- **LOUD:** `printPackLabels` answers `PackLabelSheet` (new; with `PackLabel`) instead of `SignedUrl`, and takes an `Idempotency-Key`; `LabelPrintRequest.format` is optional.
- `createPacks` requires an exact sum. `Pack` gains `outputLineNo`, `weightSource` and status `REVERSED`.
- `cancelProcessingOrder` reverses a completed order; `ProcessingOrder.reversal` (required in responses, null until reversed).
- Changelog entry and cold-read summary written; Redocly clean; `contract:generate --check` up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0083, 0084:** `liv.care.read`, granted to Owner, Manager, Farm hand; Farm hand loses `liv.batch.read`.<br>**0085:** `prc.pack` (MASTER) with `prc.pack_guard` and the deferred `ck_pack_weights` (HK010).<br>**0086:** document type `PROCESSING_REVERSAL`.<br>**0087:** `prc.processing_reversal` (DOCUMENT, guard, frozen).<br>**0088, 0089:** `prc.order.reverse` for Owner and Manager. |
| LIV | `care.ts` projections; `CareController` (16 routes); `ReadDoor`/`WriteDoor` on the reused handlers; `runWrite` checks several permissions. |
| Platform | `OperationSpec.answerPermission`, checked against the fragment's `x-answer-permission` by the contract generator. |
| PRC domain (100 percent gate) | `packing.ts`: exact sum, count, label limits, `packBarcode`, `packLabelText`. Spec written first, seen red. |
| PRC application | `Packs` (list, create, print); `Processing.cancel` reverses a completed order; `prc.ProcessingOrderReversed`. |
| INV | `StockMovements.reverseForDocumentIn`. |
| Docs | ADR-0052 and the index; A-158 matrix, A-153 resolution, A-160 to A-162; BL-057; `docs/API.md`; `docs/data-model/prc.md`; `docs/MODULE_BOUNDARIES.md`; `docs/DOMAIN_MODEL.md` events; DC-11; the changelog; the openers row. |
| Seed | Unchanged (A-161): packs and reversals need a completed order, which the seed does not make. |

## Contract requests

The frontend's `main` lists CR-001 to CR-019.
- **CR-019** (server-side sort on `listProducts`, `listStockOnHand`, `listStockUnits`, `listStockMovements`): **declined here**, as outside this phase's modules; parked as BL-057 for the owner to place, as B06m was placed (A-155).
- **CR-016** (labels for products and lots): unchanged; `printPackLabels` now gives pack labels as data in the same `LabelBarcode` form.
- **CR-005**: standing decline. The rest were answered earlier.

## Security review (hakorem-security-review)

- **Authorisation:** every new handler authorises first, at the order's or animal's scope. The care writes reuse the full handlers, so no rule differs between doors. The answer's read permission is checked at every scope the write checks.
- **Tests:** the handler walk refuses all 19 new routes with no grant; the Farm hand walk refuses the nine full writes and every unreached LIV and PRC read; wrong-role tests on both pack writes and the reversal (the Storekeeper is refused a reversal).
- **Abuse paths considered:** a forged label (the database ties the barcode's grams to the pack's weight; packs never change weight); reversing an order to hide a sale (refused once any part is sold; audited and published); reading cost through a write's answer (closed by `x-answer-permission`).
- **Residual:** reversal needs no second approver (A-162).

## Deferred

- **B8:** posting `prc.ProcessingOrderReversed`'s direct cost and the reversing movements.
- **B9b:** scanning a pack at the counter and refusing a second scan (pack status).
- **Owner:** CR-019 (BL-057).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **878 passed** (10 new in `prc/domain/packing.spec.ts`). |
| Integration | **822 passed**. New: `liv/farm-hand-care` (2), `prc/packs-labels` (7), `prc/processing-reversal` (7). Updated to the care door: the B06b and B06c LIV tests, the handler walk. |
| Coverage, merged | 1,700 passed. Statements 93.68, branches 83.76 percent (gate 80). Every 100 percent gate holds, `src/modules/prc/domain/**` among them. |
| Contract | **65 passed**. New `b6d/care-packs.contract.spec.ts`; drift counts 627 and 258. |
| Lint, type check, Redocly, `contract:generate --check` | Clean |
| End to end | CI (not run locally). |

**Test first, honestly:**
- The Farm hand walk was written first and seen red on `main`: 42 cost fields reached, and `/care/health-events/{id}` 404.
- `packing.spec.ts` was red first (missing module).
- `processing-reversal` was written before the code and seen red (6 of 7 failing); it then passed first time.
- `packs-labels` was written after `Packs`. It failed once on a real fault: a pack update that did not move the version (the version trigger), fixed in code.
- I saw no flaky test.

## Gate

**Passed**, proved by running the three integration tests above on the seeded farm.
- **Farm hand:** a treated goat's hold reads through `getCareHealthEvent` (28 days, its end, one hold) and `getCareAnimal` (`withdrawalUntil`, `sellable: false`) with no cost key. The walk covers 25 reached LIV operations: no schema, example or live answer carries a cost or pesewa field, and each live answer matches its schema. The nine full writes refuse the role with 403, and every other LIV and PRC read refuses it. No PRC operation reaches it.
- **Packs:** a 15.200 kg goat meat lot refuses 8.000 + 7.300 and 7.999 + 7.200, refuses three packs against a `packCount` of two, and packs as 8.000 + 7.200 with barcodes `<lot>/008000` and `<lot>/007200`. The database refuses a pack that breaks the sum (HK010) and a changed weight (HK004). A lot with 1.500 kg sold refuses packing (`LOT_NOT_WHOLE`).
- **Labels:** CODE_128 payload `<lot>/007300`; a reprint keeps the first print time and the payload.
- **Reversal:** the database refuses an edit of a completed order. The Storekeeper and five other roles get 403. The Manager's reversal leaves goat G-0142 ALIVE in PENS with its pool at exactly 60,000. Both lots are at 0 and 0, the packs REVERSED, three reversing movements under the reversal document (the outputs carrying 65,000 in all), one event and one audit row. A second reversal gets `ORDER_REVERSED`, and the database freezes the reversal. The goat can be planned again at 60,000. A lot with 1.000 kg sold, or with a pack PICKED, gets `OUTPUT_SOLD` and moves nothing.
- **Wrong role on pack writes:** Cashier, Sales, Driver, Farm hand, Investor and Accountant get 403 on both; only the Accountant reads packs.

## Notes for the frontend track

- Build every Farm hand screen on `/care/` operations: their types have no cost.
- Draw pack labels from `PackLabelSheet`, as for lot labels.
- A completed order shows `reversal` when reversed, and its status stays COMPLETED.
- Exact pack sums: show the remainder still to pack.

## CI

The runs that exist for this report's commit are named in the session's closing message, because a commit cannot name its own runs. Earlier commits on the branch were pushed together, so CI ran only on the final head.

## Next session

B06u, copied from `docs/prompts/session-openers.md` (unchanged by this phase):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md), CR-011 above all:
implement what is reasonable, record in the report what you declined and why, never edit that file and never
open frontend source.
For this phase, read FR-MDM-003 of docs/SRS.md (nothing else from the SRS), the units and product_uom_conversion
parts of docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md and A-157. Use
docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money and hakorem-stock: a conversion changes a
quantity, and a quantity times a price is money.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B06u only, on branch b06u-uom-conversions, branched from main: mdm.product_uom_conversion with
numerator and denominator and the exact-factor rule in the database, FR-MDM-003's unit test, the operations to
list (CR-011's listUomConversions or conversions on Uom, whichever the contract can carry additively) and to
manage a product's conversions with wrong-role refusals, read by other modules through MasterDataRefs. A catch-
weight line is charged by the weighed kilograms, so a pack-to-kilogram factor is never a conversion (A-157).
Write the conversion and permission tests first; examples in farm terms; changelog and cold-read summary.
Stop at the gate, write docs/sessions/B06u-uom-conversions.md, and merge into main when every run on the pull
request is green.
```
