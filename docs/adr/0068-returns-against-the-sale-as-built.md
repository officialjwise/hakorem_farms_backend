# ADR-0068: Returns against the original sale as built

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B09a continued 2d
- **Deciders:** backend track; the owner confirms who makes and approves a return (A-228); the accountant reviews the valuation of returned goods and the postings

## Context

FR-ORD-015: "A return references the original order and cannot exceed what was sold less what was already returned (database trigger)." Abuse case 12 (a false return to obtain a refund) requires the refund tied to the original payment and approved. ADR-0066 built the refund against a credit note, approved by neither its maker nor the credit note's maker. A-200 (c) issues no credit note without a second person. Building returns left open: when the credit note is issued and who makes it; how the stock comes back and at what cost (ADR-0018 values an issue from the pool, but a receipt from a virtual location takes the caller's value); and how the cap holds when two returns of the last of a line arrive at once.

## Options considered

1. **Issue the credit note and post the stock at `submitReturn`; only the refund waits.** One person moves receivables (a credit on an invoice is money even with no refund) and stock, contrary to A-200 (c).
2. **Every return waits for `RETURN`; the approval issues the credit note under the return maker's name, posts the stock, and asks for the refund as the return's maker.** Two people for the credit and the stock, and PAY's existing rules (ADR-0066) then refuse the maker as the refund's approver because the maker is also the credit note's and the refund's maker.
3. **As option 2, but the approver makes the credit note and the refund.** The return's maker could then approve the refund, which the owner's rule for this phase forbids.

For the value of returned goods: (a) the pool's current average (the value would drift with every receipt since the sale, and cost of sales would not reverse exactly what it was charged); (b) the issue's own value, shared by quantity, computed in the database.

## Decision

Option 2 with valuation (b).

- **`ord.order_return` and `ord.order_return_line` (migration 0200).** Written `REQUESTED` against a `COMPLETED` sale and its own receipt, numbered (`ORDER_RETURN`, `RET-`). `ck_order_return_line_cap`: what returns not `REJECTED` hold of a sold line plus the new line never exceeds its `qty_fulfilled`, decided under the sold line's row lock. Submitted only by its maker (`ck_order_return_submitted`); decided by someone other than its maker (`ck_order_return_decided`); a decided return is frozen and what was asked never changes.
- **The approval (`RETURN`, threshold 0, `ord.return.approve` with step-up, migration 0196).** In the approval's transaction: `Billing.creditIn` with the return's maker as the credit note's maker and the approval as its approval; `StockMovements.returnSaleIn` for every line not `WRITE_OFF` (`RESTOCK` to where it was issued from, `RETURNS_HOLD` to the branch's `RETURNS_HOLD` location); `Refunds.requestIn` as the return's maker against the credit note, for the credit note's amount but never more than the original owes back, from the cleared payment that paid most of the sale. A `WRITE_OFF` line moves no stock: the goods do not re-enter the farm's stock and their cost stays in cost of sales.
- **`inv.stock_movement.returns_movement_id` (migration 0199).** Every `SALE_RETURN` that is not a reversal names the sale issue it takes back; `ck_stock_sale_return` refuses one from anywhere but where the issue went, of another product, unit or branch, of a reversed issue, or beyond what the issue issued less its returns not reversed (under the issue's row lock). The trigger sets the value: with the issue of `Q` valued `V`, returned `p` before and `q` now, `half_up(V x (p+q) / Q) - half_up(V x p / Q)`, so the parts sum to `V` exactly; the cost element is the issue's. The caller's value is ignored.
- **Read-only ports added below ORD:** `Billing.creditPreviewIn` (what a credit would take back, without writing), `Billing.linesByOrderLineIn`, `Refunds.summariesIn`. Commands down in the caller's transaction (ADR-0010).

## Consequences

- The smallest team is two people: a seller makes the return, a supervisor approves it and then, or another holder of `pay.refund.approve`, the refund.
- An exchange, a line sold by weight and a refund split across tenders are refused until B9b and B11 build what they need (A-228).
- A void after a return is refused by BIL (the receipt cannot be credited in full twice); nothing is reversed.
- Binds: `docs/data-model/ord.md`, `docs/data-model/inv.md`, `docs/API.md` (ORD), the ORD, INV, BIL and PAY cards in `docs/MODULE_BOUNDARIES.md`, abuse case 12 in `docs/security/THREAT_MODEL.md`, A-228.

## Verification

- `test/integration/ord/order-return.integration.spec.ts`: wrong roles and branch; sold 2, returned 1, 2 more refused over the API and by a direct insert; two returns of the last 2 at once leave one over the API, and two SQL transactions at once leave one; the maker refused as approver in IAM and by SQL; a rejection gives the quantity back; an approved return of 2 yams leaves a credit note of 4,000 (Dr 4200, Cr 1200), the yams back at 2,400 (Dr 1330, Cr 5020) and a refund of 4,000 that the maker cannot approve; a written-off yam moves no stock; three returns of an issue of 10,000 carry 3,333, 3,334 and 3,333; a fourth and an unlinked `SALE_RETURN` refused by SQL; the trial balance at zero.
- `src/modules/ord/domain/order-return.spec.ts` at 100 percent under the `ord/domain` gate.
- Mutation runs (B09a continued 2d report): each database rule removed in turn fails the spec.
