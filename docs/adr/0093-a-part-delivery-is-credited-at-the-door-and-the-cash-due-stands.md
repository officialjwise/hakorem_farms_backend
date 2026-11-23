# ADR-0093: A part delivery is credited at the door, and the cash due stands

- **Status:** Proposed (the owner reviews A-364 (b))
- **Date:** 2026-11-23
- **Session:** B11 continued 6 (lane B)
- **Deciders:** backend track; the owner reviews A-364 (b)

## Context

CR-055 asks for a part delivery: the customer keeps 10 of 12 crates, the driver records what was kept, "the server
returns the rest to stock, invoices what was delivered, and fixes the cash due again". ADR-0092 fixed the cash due on
delivery at dispatch from the document on the weighed quantity, and made it unchangeable (`ck_delivery_transition`, the
driver "cannot change the amount due", FR-DEL-009). A part delivery must therefore lower what the driver may collect
without rewriting the cash due, and without letting the driver decide an amount.

## Options considered

1. **Rewrite the delivery's cash due** at the door. Simple, but contradicts ADR-0092 and FR-DEL-009, and lets the
   driver change an amount the server fixed.
2. **Collect the whole cash due and refund the rest later.** Keeps ADR-0092 literally, but asks the customer for money
   for goods they handed back.
3. **Credit what came back at the door and set it beside the cash due.** The proof names what was kept of each line;
   BIL prices the credit for the rest by its own credit rules (a preview, nothing written by DEL); the proof records it
   (`returned_credit_pesewas`), and the cash the driver may collect is the cash due less that credit, never below zero.

## Decision

Option 3.

- The delivery's `cod_due_pesewas` never changes (ADR-0092 stands). The proof carries `returned_credit_pesewas`, the
  credit BIL's `creditPreviewIn` computes for the returned quantities of the delivery's own document lines (a weighed
  line whole); the delivery fee is never credited. The database checks the cash against
  `greatest(cod_due - returned_credit, 0)` (`ck_proof_variance`): never more, less only with a `COD_VARIANCE` reason.
- What was kept is issued for the sale from the vehicle; what came back moves from the vehicle into the branch's returns
  hold (not sellable until inspected), its picks' last parts first; a weighed pack is kept or returned whole.
- ORD asks for the credit note of the returned quantities through BIL's `CREDIT_NOTE` approval, the driver its maker
  (a different person approves it); once it is issued, what the customer paid ahead beyond what they kept is refunded
  to the original method through PAY's `REFUND` approval. The order moves to DELIVERED as for any proof.
- A returned line needs a `DELIVERY_FAILURE` reason (and its note where the reason asks for one); a reason is refused
  when everything was kept; nothing kept is a failed attempt, not a proof.

## Consequences

- The driver never chooses an amount: the credit is the server's, at the document's own prices.
- If the approver refuses the credit note, the customer owes the returned value though the goods are in the hold; that
  is the approver's decision, recorded, and visible as an open item.
- Abuse case 51: a driver could claim goods came back that the customer kept, collect their price and keep it. The
  goods are moved into the returns hold by the system, so the hold's count is short by them at its next count; the
  proof, the credit note's maker and `del.DeliveryCompleted` (returned lines, the driver) are in the outbox for B12's
  exception report. Keeping the rest on the van until a Manager checks it in is BL-111.
- Binds: `docs/data-model/del.md` (migration 0328), the DEL, ORD and BIL cards in `docs/MODULE_BOUNDARIES.md` (DEL now
  imports BIL for the read-only credit preview), `docs/API.md` (DEL), the threat model.

## Verification

`test/integration/del/van-returns.integration.spec.ts` (the part delivery block): three crates, two kept, the cash due
less one crate's price collected to the pesewa (one pesewa more refused), 60 eggs issued and 30 moved to the returns
hold by SQL, the credit note of one crate's price approved by the Owner; a paid-ahead order kept in part collects
nothing and refunds one crate's price once the credit note is issued; the database refusing more kept than dispatched
and a short line without its reason.
