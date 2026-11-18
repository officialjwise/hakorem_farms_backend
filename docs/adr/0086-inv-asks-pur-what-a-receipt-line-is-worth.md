# ADR-0086: INV asks PUR what a receipt line naming its order line is worth

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B09u (lane B)
- **Deciders:** backend track; the owner to accept (CR-040 is the owner's decision 2 of 2026-11-17)

## Context

CR-040 and the owner's decision 2 for B09u: a goods receipt line that names `purchaseOrderLineId` may leave out
`valuePesewas`; the server values it from the order line for the accepted quantity, rounded half-up once (ADR-0001), the
receipt's answer shows it, and a typed value always wins. The contract had both required the field and said it
"defaults from the purchase order line", which the code never did.

The receipt is INV's (layer 5); the purchase order, its price and its stored conversion are PUR's (layer 7). INV may not
import PUR or read `pur.*` (MODULE_BOUNDARIES rules 3 and 7), and the value must be known when the draft is written,
since the answer shows it and the posting moves stock at it. PUR already follows `inv.GoodsReceiptPosted`, but that is
after the value is fixed.

## Options considered

1. **A port defined by INV, implemented by PUR (chosen).** INV's `OrderLineValuation` (`OrderLineValuationRegistry`),
   asked in the receipt's transaction; PUR registers `PurchaseOrderLineValues`. One new port, no new import, no
   cross-schema SQL.
2. **A published SQL function in `pur`, called by INV's application.** INV would call up a layer; refused by rule 3.
3. **PUR fills the value in at posting, in its transactional subscriber.** The draft would answer no value, and the
   posted movement would be valued after INV computed it; refused.
4. **Keep the field required and remove "defaults" from the description.** CR-040's other answer; the owner chose the
   server's value.

## Decision

Option 1.

- `src/modules/inv/application/order-line-valuation.ts`: `OrderLineValuation.valueIn(tx, { purchaseOrderId,
  purchaseOrderLineId, productId, qtyAcceptedBase })` answers `{ ok, value }`, a refusal (`ORDER_LINE_UNKNOWN`,
  `ORDER_LINE_OTHER_PRODUCT`), or null for a document it does not know. `OrderLineValuationRegistry` denies by default:
  with no valuation registered, or none that knows the order, the line is refused `ORDER_LINE_UNKNOWN`.
- `GoodsReceipts` asks it only for a line that names its order line and types no value, when the line is written (create
  or a change of lines), with the accepted quantity in the base unit after the line's conversion, and stores the answer
  as the line's `value_pesewas`. The receipt must name its `purchaseOrderId`; the order line must be one of its lines
  and for the line's product. A typed value is never replaced.
- PUR's `PurchaseOrderLineValues` reads PUR's own order and answers the domain's `acceptedValueAtOrder`:
  `half_up(unit price x qty ordered x accepted base / qty ordered base)`, the order line's own stored conversion, as
  ADR-0076's claim converts. It authorises nothing.
- The value is the order price only. A levy the farm cannot reclaim reaches purchase price variance through the
  supplier's invoice (FR-PUR-015), as before. ADR-0075's issue arithmetic is untouched: the receipt's value is what the
  delivery's pool is anchored at.

## Consequences

- The storekeeper no longer types the cost of a delivery against an order; the screen shows the server's value.
- A receipt line with no order line still requires a value (400 `VALIDATION_FAILED`, as before).
- Binds: the INV and PUR cards and section 6 of `docs/MODULE_BOUNDARIES.md`, `docs/data-model/inv.md`, A-302.

## Verification

- `test/integration/inv/receipt-order-value.integration.spec.ts` (7 tests, written first and seen red): 23 eggs of a
  crate at 4,751 are 3,642 and the posted movement carries 3,642; an exact half (15 eggs, 2,375.5) is 2,376; 2 crates of
  3 are 9,502; a typed 3,600 wins; a changed draft is valued again (29 eggs, 4,593); a line with no order line and no
  value is 400; an unknown order line, one of another order and one of another product are refused.
- `src/modules/pur/domain/purchasing.spec.ts`: `acceptedValueAtOrder` at an exact half, one below, one above, zero and
  the largest amount.
- Mutation checks in the B09u report.
