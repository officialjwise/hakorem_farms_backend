# ADR-0094: A short order goes with what was picked, and the rest is a linked backorder with its own delivery

- **Status:** Proposed (the owner reviews A-366 (a))
- **Date:** 2026-11-24
- **Session:** B11 continued 7 (lane B)
- **Deciders:** backend track; the owner reviews A-366 (a)

## Context

FR-ORD-012 asks for partial fulfilment: "a partly fulfilled order moves forward with the fulfilled lines; the remainder
is a linked backorder with its own passage through the machine", billed only on what was fulfilled. The owner approved
A-331 (b) on 2026-11-23: the delivery fee is charged once, on the first dispatch; a later dispatch the farm makes to
complete a short order carries no fee, and an extra delivery the customer asks for is its own, explicit fee line. Until
now every rule assumed one live delivery per order: `uq_delivery_order`, the run's close, the part delivery's credit
(ADR-0093), the cancellation (A-364 (a)), the driver variance report and the fee (A-338 (b)). `ord.sales_order` already
carries `parent_order_id` ("for a backorder split from another order") and each line `qty_backordered`.

## Options considered

1. **More than one delivery per order.** The order would be dispatched again for its rest. It needs `uq_delivery_order`
   dropped, an order machine that leaves `DELIVERED` for `PACKED`, every delivery rule rewritten for several deliveries
   per order, and the document re-issued or a second document per order: a wide change to accepted rules.
2. **A backorder order linked to the first (`parent_order_id`).** At dispatch (or collection) the rest of each short
   line becomes a new order of its own number, confirmed, with its own pick lists, document, delivery and passage through
   the machine. Every existing per-order rule holds unchanged, because each order still has one live delivery.
3. **Always refuse a short order** (the customer agrees to less, CR-054 point 2). Simple, but the farm cannot send what
   it has now and the rest later, which FR-ORD-012 requires.

## Decision

Option 2.

- A short line's rest is back-ordered explicitly at packing (`PackRecord.backorderLineIds`, the packer's choice), never
  inferred: never a line picked in full, a catch-weight line (it goes by its weight), a line the customer agreed to
  take less of, a discounted line (its discount belongs to the whole line), or a line on another live pick list.
- At dispatch or collection the order is billed on what was sent; each short line is fixed `PARTIAL` (or `BACKORDERED`
  when none of it went) and the rest becomes one backorder: `parent_order_id` names the **first** order (a backorder's
  own backorder names the same one), the same branch, customer, contact, terms, fulfilment mode and delivery address,
  the agreed prices and pricing record of the lines, extended once (ADR-0001), confirmed at once with no reservation (it
  waits for stock) and with **no delivery fee**: the database refuses one (`ck_sales_order_backorder`).
- An extra delivery the customer asks for is an `ord.order_extra_fee` row on a delivery backorder before its dispatch,
  at the zone's fee, added only under `ord.delivery_fee.add` (the Manager and the Owner) and charged as its own
  `DELIVERY_FEE` line on the backorder's document.
- The deposits stay on the first order. At each dispatch the document is settled from them; what they hold beyond it is
  **held for a backorder still to be sent**, and refunded (`WEIGHED_BELOW_PAID`) only at the last dispatch, or to the
  original method when the last open backorder is cancelled.
- A completed order's line wholly back-ordered needs no movement of its own (`ck_sales_order_settled_lines`, replaced):
  its backorder carries it.

## Consequences

- One live delivery per order stands, so the run's close, the part delivery's credit, the cancellation, the driver
  variance report and the cash due work on a backorder exactly as on any order.
- The customer's account of one purchase spans the first order and its backorders; a screen reads `parentOrderId`. A
  list of an order's backorders on `SalesOrder` is not built (the database index serves it when a screen asks).
- A guest's tracking link opens the first order only; the backorder's messages are NTF's (B11 continued 8 or later).
- An order on account is credit-checked at its own dispatch (B11 continued 8), so a backorder of a credit order is
  judged again on the quantities it sends.
- Binds: `docs/data-model/ord.md` (migration 0329), the ORD card in `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (ORD),
  the threat model (abuse case 53).

## Verification

`test/integration/ord/partial-fulfilment.integration.spec.ts`: three crates on cash on delivery, two sent: the document
2p + 1,500 (the fee once), 2p + 1,500 due; the backorder of one crate `CONFIRMED` with no fee; the extra fee by the
Manager only (five roles and another branch refused), once, 1,500; the backorder's document p + 1,500 with one "Extra
delivery" line; paid ahead, p held for the backorder (no refund) and allocated at its dispatch with no fee line;
a cancelled backorder refunds exactly p; the database refusing a backorder with a fee, an extra fee on an order that is
not a backorder or already dispatched, and any change to an extra fee. Unit: `src/modules/ord/domain/dispatch.spec.ts`
(`backorderLines`, `feesAtDispatch`, `judgeExtraDeliveryFee`, `planSettlement` holding for a backorder) and
`picking.spec.ts` (the back-order at packing).
