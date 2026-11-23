# ADR-0092: Dispatch loads the vehicle and issues the document on the weighed quantity; the driver's cash is a payment held by the driver

- **Status:** Proposed
- **Date:** 2026-11-23
- **Session:** B11 continued (lane B)
- **Deciders:** backend track; the owner reviews A-337 to A-340

## Context

FR-ORD-011 has dispatch issue the invoice on the weighed quantity, allocate the deposit and fix the cash due on delivery;
FR-DEL-005 and FR-DEL-011 have the goods ride on the vehicle as the farm's stock until delivered or returned to the
returns hold; FR-DEL-009 and ADR-0003 (`del.CodCollected`: Dr 1020, Cr 1200) have the cash collected recorded against the
driver; A-212 (a) and CR-057 have it handed in at a till shift, never typed in as loose cash. ADR-0091 left dispatch to
consume the order's reservations and move the picked stock once. Three questions had no written answer: when the goods
leave stock, what the cash on delivery is in PAY, and what document a guest's order gets.

## Options considered

1. **Issue for the sale at dispatch** from the pick location. One movement; a failed delivery is a sale return and a
   credit note; the vehicle never holds stock, against FR-DEL-005 and FR-DEL-011.
2. **Move onto the vehicle at dispatch, issue at delivery.** Two movements; the vehicle holds the farm's stock while it
   is out; a failure returns it from the vehicle to the returns hold; revenue at dispatch, cost of sales at delivery.
3. For the cash: (a) a DEL record and journal only; (b) a PAY payment published as `pay.PaymentCleared` into a till;
   (c) a PAY payment held by the driver, posted by DEL's `del.CodCollected`.

## Decision

Option 2 and cash (c).

- Dispatch, in one serializable transaction: the billing document on the weighed quantity (an `INVOICE` for a customer
  account, a `RECEIPT` for a guest, whom BIL cannot invoice), the delivery fee as its own line once; the cleared deposits
  allocated oldest first, what they hold beyond the document asked back (`WEIGHED_BELOW_PAID`), what they leave fixed as
  the cash due on the delivery; the order's reservations ended and each pick moved `TRANSFER_INTERNAL` from its pick
  location onto the vehicle (the trigger refuses a location below zero or another order's promised stock); DEL's delivery
  made from ORD's snapshot (DEL does not know orders); `ord.OrderDispatched` in the outbox.
- The proof of delivery, in DEL's transaction: the cash collected recorded by PAY's `DriverCash` as a cleared cash
  payment held by the driver (`driver_id`, never a register or a shift), allocated to the delivery's document; DEL's ◆
  `del.CodCollected` posts Dr 1020 against the driver, Cr 1200; no `pay.PaymentCleared`, since no till took the cash.
  `del.DeliveryCompleted` makes ORD issue each pick for the sale from the vehicle and move the order to DELIVERED, and to
  COMPLETED when nothing is outstanding.
- The cash due is never changed after dispatch and never exceeded (`ck_delivery_cod`, `ck_proof_variance`); less needs a
  `COD_VARIANCE` reason. The hand-in moves the driver's 1020 into a till's 1000 through the receiving cashier's own open
  shift (ADR-0077), each collection once (B11 continued 2).

## Consequences

- Stock on a vehicle is the farm's and visible by location; a failed delivery's goods go from the vehicle to the returns
  hold with a credit note (B11 continued 2). Revenue is recognised at dispatch, its cost of sales at delivery: the two
  can fall on different days, and a period closing between them sees the goods still in inventory on the vehicle.
- Every collection is a payment a hand-in can name, so a collection is handed in exactly once by a unique key.
- A guest's delivery is a receipt with an amount outstanding until delivered.
- Binds: `docs/data-model/del.md`, `docs/data-model/ord.md`, the ORD, DEL, PAY and FIN cards in
  `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (ORD and DEL), abuse cases 43 and 44.

## Verification

`test/integration/ord/dispatch-delivery.integration.spec.ts`: dispatch on 30.800 kg at 98,960 with 96,390 allocated and
2,570 due; the packs moved from the cold room to the van and issued from it at delivery; 2,000 collected with a reason
posting Dr 1020 against the driver; a refund of one kilogram's price on a lighter pack; dispatch refused below zero with
nothing written; the database refusing a changed cash due, a proof without evidence and more cash than due.
