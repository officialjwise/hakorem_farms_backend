# B11 continued 7: partial dispatch with backorders and the fee once, the extra delivery's fee line, collection paid at the till and BL-097 (lane B), split inside the rest of dispatch

Date: 2026-11-24 · Branch `b11c7-dispatch-returns-notifications`, from `main` at `93460a9` (#134, B11 continued 6) · Status: **phase split (A-367): partial dispatch and backorders with the fee once and the extra fee line, collection paid at the till and BL-097 built to their own gate, passed locally; CI below. The rest is B11 continued 8.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk. The container restarted once mid-phase (2026-11-24); the worktree was intact and every test covering the change was rerun after it.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-366 (a) | **Backorders** (FR-ORD-012, ADR-0094, proposed): a short line's rest is back-ordered only when the packer names it (`PackRecord.backorderLineIds`), never a catch-weight line (BL-114), a discounted line, a line the customer agreed to take less of, or one on another live pick list. At dispatch or collection the rest becomes **one backorder order** naming the first order (`parent_order_id`), confirmed with no reservation and **no delivery fee** (the database refuses one); its own pick lists, document and delivery, so every one-delivery-per-order rule (the run's close, the part delivery's credit, the cancellation, the variance report) holds unchanged. The deposits beyond a document are **held for a backorder still to be sent** and refunded at the last dispatch, or to the original method when the last open backorder is cancelled. | Owner |
| A-366 (b) | **The extra delivery** (the owner, 2026-11-23): `addExtraDeliveryFee` on a delivery backorder before its dispatch, once, at the zone's own fee (staff never type an amount), under the new `ord.delivery_fee.add` (migration 0330), granted to the Manager and the Owner (0331); charged as its own "Extra delivery" `DELIVERY_FEE` line on the backorder's document. Only on a backorder (BL-115). | Owner |
| A-366 (c) | **Collection** (`collectFulfilment`): the document on the weighed quantity at the hand-over, the goods issued from where they were picked, the order `READY_FOR_COLLECTION` (the machine's only way to `COMPLETED`) and completed at once when nothing is left to pay; what is left is paid at the till. An order on account is refused `CREDIT_DISPATCH_NOT_AVAILABLE` until B11 continued 8. | Owner |
| A-366 (d) | **A guest's receipt paid at the till**, with the parent session's leave of 2026-11-24: `payInvoiceAtTill` also takes an `ISSUED` `RECEIPT` of a sales order with something outstanding (A-338 (a) holds it on 1200 until paid); any other receipt and every other kind is still `NOT_AN_INVOICE`; the shift, branch, outstanding and cash-only rules unchanged. | Parent session (granted), owner |
| A-366 (e) | **BL-097:** a `DELIVERED` order, or a collected one `READY_FOR_COLLECTION`, completes in the transaction of a later payment allocated to its document (`pay.PaymentCleared`, `pay.DepositAllocated`) or a credit note against it (`bil.CreditNoteIssued`). `getOrder` counts every allocation to the order's document as paid (a balance paid at the till names no order). | Owner |
| A-367 | **The split.** Built the above to its own gate and stopped. **B11 continued 8** (`b11c8-dispatch-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds an order on account (staff delivery orders, the credit check at dispatch and collection through a new port method, the invoice's due date, nothing due to the driver; `CREDIT_DISPATCH_NOT_AVAILABLE` removed LOUD), the checkout's slot carried onto the delivery, BL-096, the store-credit choice and CR-054 point 1, then returns of part of a crate, then notifications. | Parent session |

**For the parent session to schedule:** everything in B11 continued 8's opener. The order on account is the largest piece left of dispatch: staff orders cannot be `DELIVERY` today (`FULFILMENT_NOT_AVAILABLE`), so a credit delivery order cannot yet exist, and WHL's `creditFor` counts an uninvoiced order's estimate in its exposure, so the check at dispatch needs a port method that does not count the order twice.

**No ADR conflict, and no stop.** FR-ORD-012's "linked backorder with its own passage through the machine" is what `parent_order_id` was planned for (data-model/ord.md); ADR-0094 (proposed) records it. ADR-0092 and ADR-0093 stand (each backorder has one delivery and its own cash due). ADR-0035: every new handler authorises in the application layer. ADR-0067: no `now()` in business SQL (the new triggers read no clock; `recorded_at` defaults as every LEDGER table). **Shared modules, additive only, or with leave:** POS's `judgeTillInvoicePayment` takes a guest's receipt (the parent session's leave, conditions met below); BIL's `SettleableDocument` gains `orderDocumentId`; no other function of POS, PAY, INV, BIL, IAM or FIN changed. The date moved to 2026-11-24 during the phase; entries written from then are dated 2026-11-24.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 7, lane B (`b11c7-dispatch-returns-notifications`, from `main` 93460a9).
2. **Scope:** the opener's first sub-domain (the rest of dispatch), then returns of part of a crate and notifications, splitting at a boundary when the context will not reach the next gate.
3. **Gate (this part):** partial dispatch charges the fee once and an extra delivery is its own fee line; a collection order is handed over and paid at the till; a delivered or collected order completes once settled; every new read and write refuses the wrong role. **Passed** (below). The rest of the opener's gate (credit-terms dispatch, part of a crate refunded pro rata, the customer messages) is B11 continued 8's.

## Contract changes

**2.36.0, minor, LOUD on one till operation and three order answers** (on top of 2.35.0; Redocly clean, no warnings; `contract:generate`: 548 operations from code, 117 planned, 665 in all).
- **Into code with its planned path:** `collectFulfilment` (`POST /fulfilments/{id}/collect`, `ord.fulfilment.dispatch`).
- **New:** `addExtraDeliveryFee` (`POST /orders/{id}/extra-delivery-fee`, the new `ord.delivery_fee.add`; `ExtraDeliveryFeeCreate`, `ExtraDeliveryFee`).
- **New optional request field:** `PackRecord.backorderLineIds`.
- **LOUD:** `payInvoiceAtTill` also takes a guest's receipt of an order; `getOrder`'s `paidPesewas` and `outstandingPesewas` count every allocation to the order's document; `SalesOrder.parentOrderId`, `SalesOrderLine.qtyBackordered` and `lineStatus` `BACKORDERED` are now filled for a backorder; a delivered or collected order completes when a later payment or credit note settles it.
- New refusals as the changelog lists. One new permission. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| ORD domain | `backorderLines` (the rest of each short line, extended once half-up), `feesAtDispatch` (the fee once, an extra fee its own line), `judgeExtraDeliveryFee`, `planSettlement` holding for a backorder, `readyToPack` with the back-order. |
| ORD application | `Fulfilments.pack` with `backorderLineIds`; `Orders.backorderIn`; `Dispatches.dispatchIn` sends what was picked, fees by `feesAtDispatch`, the deposits of the first order, the backorder; `Dispatches.addExtraFee`; `Dispatches.collect`; `Dispatches.settledIn` (BL-097) on `pay.PaymentCleared`, `pay.DepositAllocated` and `bil.CreditNoteIssued`; `OrderReversals` cancels a backorder with what was held for it refunded; the order view counts the document's allocations; `ord.OrderCollected`; `ord.OrderDispatched` names its backorder. |
| POS (with leave) | `judgeTillInvoicePayment` takes an issued receipt of an order with something outstanding. BIL's `SettleableDocument.orderDocumentId` (additive). |
| Schema | 0329 (ORD): `ck_sales_order_line_backorder`, `ck_sales_order_parent`, `ck_sales_order_backorder` (HK010), `ck_sales_order_settled_lines` replaced (a `BACKORDERED` line needs no movement), `ix_sales_order_parent`, `ix_sales_order_billing_document`, `ord.order_extra_fee` (LEDGER) with `ck_order_extra_fee_order`. 0330, 0331 (IAM): `ord.delivery_fee.add`, the Manager and the Owner. All roll back (the rollback walk names them). |
| Docs | ADR-0094 (proposed) and the decision index; A-366, A-367; BL-114, BL-115; abuse case 53; ADR-0026 Amendments; `data-model/ord.md`; the ORD and POS cards; API.md (ORD); the 2.36.0 changelog; the openers (B11 continued 7 marked built and split, B11 continued 8 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/ord/partial-fulfilment.integration.spec.ts` (8 tests, new, over the seeded farm; `p` is the seeded crate price, read and asserted to the pesewa):
- **Back-order at packing:** a line not on the pick list `LINE_UNKNOWN`, a short pack without the back-order `SHORT_PICK_NOT_AGREED`, nothing written; then packed with the third crate back-ordered (`qtyBackordered` 1.000).
- **The fee once:** three crates on cash on delivery, two sent: the document 2p + 1,500 with one "Delivery" line of 1,500 and 2.000 crates, the delivery's cash due 2p + 1,500, the line `PARTIAL`; the backorder `CONFIRMED`, `parentOrderId` the first order, `deliveryFeePesewas` 0, one line of 1.000 at p; `ord.OrderDispatched` names it; trial balance 0.
- **The extra fee line:** the Storekeeper, Sales, the Cashier, the Driver and another branch's Manager 403; on the first order `NOT_A_BACKORDER`; an amount in the body 400; then 1,500 added once (the same key answers the same, a second `EXTRA_FEE_ALREADY_ADDED`), audited; the backorder's document p + 1,500 with one "Extra delivery" line of 1,500 and no order fee, p + 1,500 due; once dispatched `NOT_BEFORE_DISPATCH`.
- **The deposit held:** two crates paid ahead (2p + 1,500), one sent: p + 1,500 allocated, nothing refunded, nothing due; the backorder's document p with no fee line, p allocated from what was held, nothing refunded, the payment wholly allocated.
- **A cancelled backorder:** paid ahead, one sent, the backorder cancelled: exactly p asked back to the original method.
- **The database:** a backorder inserted with a fee HK010; an extra fee on an order that is not a backorder HK010, on a dispatched backorder HK010; an extra fee changed as `hk_app` 42501 and as admin HK001; a line set `BACKORDERED` while it sent part 23514.

`test/integration/ord/collection.integration.spec.ts` (5 tests, new): a guest's beef collection paid ahead at 96,390 and picked at 30.800 kg: the Storekeeper, Sales, the Cashier, the Driver, the Accountant and another branch's Manager 403, no session 401, nothing written; handed over: `COLLECTED`, the receipt for 98,960, 96,390 allocated, 2,570 outstanding, `READY_FOR_COLLECTION`, two `SALE_ISSUE` of 15.200 and 15.600 kg from the cold room to the customer, no reservation left, no delivery, `ord.OrderCollected` with 2,570 due at the till; the same key answers the same, a second 422. **At the till:** the Accountant 403; 2,571 `AMOUNT_EXCEEDS_OUTSTANDING`; **two payments of 1,570 at once: exactly one taken** (1,000 left), the other 422; 1,000 with 2,000 handed over, change 1,000: the order `COMPLETED` and `PAID`; one pesewa more `NOT_AN_INVOICE`; trial balance 0. A goat pack weighed heavier: the whole difference paid at once, completed. A crate of eggs paid in full: completed at the hand-over, nothing refunded, 30 eggs issued from the shop.

`test/integration/del/van-returns.integration.spec.ts` (22 tests, one extended): a part delivery's order waits `DELIVERED` while the returned crate is owed and is `COMPLETED` when its credit note is issued later (BL-097).

Unit: `ord/domain/dispatch.spec.ts` (+13: the backorder line 44,000 for 8 crates at 5,500, 500 for 1.500 at 333 and 499 for 1.499, the mismatch and discount refusals, the fee once, the extra fee, the five refusals), `ord/domain/picking.spec.ts` (+3), `pos/domain/till-invoice.spec.ts` (+2: the receipt taken whole and in part, never beyond; any other receipt and kind refused).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | Dispatch refunding what the deposits hold beyond the document although a backorder waits (`holdForBackorder: false`) | red: 2 (the deposit held; the backorder paid from it) |
| M2 | ORD no longer subscribed to `bil.CreditNoteIssued` | red: 1 (the part delivery's order completed by its later credit note) |
| M3 | `feesAtDispatch` charging the order's fee on a backorder | red: 1 (unit); the database refuses a backorder with a fee in any case (HK010, tested) |

## Test first, as it honestly happened

- The ORD domain rules (`backorderLines`, `feesAtDispatch`, `judgeExtraDeliveryFee`, `planSettlement`'s hold, `readyToPack`'s back-order) and POS's receipt rule were each written as unit tests and run red before the code (14 and 1 failing).
- The integration blocks were written after the application code, against the gate's list. Their first runs failed on the specs' own details (the audit table's name, a document insert's columns, the order of two refusals on a dispatched backorder) and on one real fault, fixed in the code: **the order view read only payments naming the order, so a balance paid at the till left `outstandingPesewas` at 2,570**; it now counts the document's own allocations. The collection spec's last case moved from goat meat to eggs when the cold room ran short of goat for a second pack.
- The handler walk, the identifier walk and the contract's request-schema map failed on the two new operations until they were named (the walk's valid body for `addExtraDeliveryFee`), as they should.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (`packFulfilment`'s back-order, `dispatchFulfilment`, `addExtraDeliveryFee`, `collectFulfilment`), TB3 the till (`payInvoiceAtTill` on a guest's receipt), the database.
- **SC-01 input:** strict schemas; unknown fields 400 (an amount sent to `addExtraDeliveryFee` is refused, tested); `backorderLineIds` bounded 1 to 200 UUIDs.
- **SC-02 authorisation:** deny by default in the application layer. `addExtraDeliveryFee`: `ord.delivery_fee.add`, the Manager and the Owner at the order's branch (five roles and another branch tested); `collectFulfilment`: `ord.fulfilment.dispatch` at the pick list's branch (six roles and another branch tested); the back-order is the packer's (`ord.fulfilment.pick`), never a money decision; `payInvoiceAtTill` keeps its own open shift, device and branch checks (the Accountant refused, tested). The handler walk and the identifier walk include both new operations; no ID is a key.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas through the kernel; the backorder line extended once half-up; the fee and the extra fee exact integers; the extra fee is the zone's, never typed.
- **SC-06 idempotency:** every write takes its key; replays answer the first result (tested).
- **SC-07, SC-08 logs and events:** `ord.OrderCollected` and the dispatch event carry ids and amounts; the order's contact phone travels as before for NTF, no new personal data.
- **SC-09 to SC-13:** staff session writes with CSRF and an allowed origin, unchanged; the console rate-limit group; no upload, no webhook in this change.
- **SC-14:** no external call inside a transaction (the outbox carries the messages).
- **SC-15, SC-16:** no empty catch; refusals are stable codes with the correlation id.
- **SC-17 maker and checker:** unchanged: a refund of a held deposit goes through the `REFUND` approval; the credit note of a part delivery through `CREDIT_NOTE`.
- **SC-18, SC-19:** no restricted field, no outbound URL.
- **SC-20, SC-21:** no dependency added; no secret-shaped literal written.
- **SC-22:** `ord.order_extra_fee` is insert-only (update refused for `hk_app` and admin, tested); stock moves only through INV's movements.
- **SC-23:** every new write is one serializable transaction with the whole-command retry; the two concurrent till payments prove the outstanding cap (one taken, one refused).
- **SC-24:** each new write is audited in its transaction (`BACKORDER`, `ADD_EXTRA_DELIVERY_FEE`, `COLLECT`, `COMPLETE`, `COLLECT_INVOICE`).
- **The leave's conditions (A-366 (d)):** only an issued receipt of an order with something outstanding (a receipt with nothing outstanding, not of an order, not issued, and every other kind refused `NOT_AN_INVOICE`, unit and integration); every existing rule unchanged (the existing till invoice tests pass unchanged); the same allocation and posting (`Payments.recordIn`, Dr 1000 Cr 1200, trial balance 0); a guest paying in full, in two parts, overpaying refused, two concurrent payments never beyond the outstanding; a wrong-role test; the identifier walk covers the operation; the contract's description changed, so 2.36.0 marks it LOUD.
- **Abuse paths:** abuse case 53 added (a fee waived or charged twice, an extra fee without the permission, a held deposit refunded early); its controls are in the database and tested; its detection is B12's daily exception report, which reads `ord.OrderDispatched` (the backorder), the `BACKORDER` and `ADD_EXTRA_DELIVERY_FEE` audit rows. Cases 6, 43, 44, 48, 51 and 52 are unchanged by this part.
- Findings: one real fault fixed (the order view's outstanding after a till payment). None open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need an order on account at dispatch and the notifications, which are B11 continued 8's; its opener names them.

## Reused photographs

Not recorded here; B11 continued 8's opener carries it (B12's opener says B12 must if B11 continued 6, 7 or 8 does not).

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-054 point 2** (a short pick only with agreement, or back-order the rest): **answered further**: besides `proposeShortPick`, a short line's rest may be back-ordered at packing (`backorderLineIds`); `recordPicks` still takes a pick below `qtyToPick`, and packing refuses it unless the customer agreed or the rest is back-ordered.
- **CR-054 point 1**, **CR-039**, **CR-033 point 3**: B11 continued 8's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request is left without a phase.

## Tests (this machine)

Run on commit `aa1701d` (the code of the final head; the commits above it add only this report) with Docker's Testcontainers; see CI below for the runs on the pushed commits. `main` had not moved from `93460a9`, so no rebase or renumbering was needed.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,159 passed, 347 files, none skipped, exit 0**, the whole integration suite included. Coverage, whole: statements 94.11, branches 83.68, functions 97.85, lines 97.16 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them). |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.36.0 |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (548 operations from code, 117 planned) |

## Deferred

- **To B11 continued 8** (its opener): an order on account at dispatch and collection (staff delivery orders, the credit check through a new port method, the due date, nothing due to the driver, `CREDIT_DISPATCH_NOT_AVAILABLE` removed LOUD); the checkout's slot carried onto the delivery (A-362 (e)); BL-096; the store-credit choice; CR-054 point 1; returns of part of a crate; all of NTF (with `ord.OrderCollected` and a backorder's messages); CR-039; CR-033 point 3; the reused-photograph match; the UAT dry runs.
- **Backlog:** BL-114 (a catch-weight line back-ordered by packs), BL-115 (an extra fee for a reattempt the customer caused; an order's backorders listed on `SalesOrder`).
- **Seed:** nothing seeded (the tests build their orders over the seeded farm).

## Questions for the owner

1. **A backorder is its own order (ADR-0094, A-366 (a)).** The rest of a short order becomes a new order number linked to the first, with its own delivery and document. Agreed, or should the customer see one order number with several deliveries?
2. **Who back-orders (A-366 (a)).** As built the packer decides at packing; the customer is not asked (they get everything, the fee once). Agreed, or should the customer agree first, as for a smaller quantity?
3. **The extra delivery fee (A-366 (b)).** As built it is the zone's own fee, added by the Manager or the Owner, only on a backorder before its dispatch. Agreed?

## Notes for the frontend track

- **2.36.0:** the pick list's pack offers, for a line picked short, "send what is picked and back-order the rest" (`backorderLineIds`); the order page reads `parentOrderId` on a backorder and `qtyBackordered` on each line; a Manager's order page offers "charge an extra delivery" on a delivery backorder before it is dispatched (`addExtraDeliveryFee`, no amount: the zone's fee is answered). The pick list of a collection order offers "hand over" (`collectFulfilment`); what is left is paid at the till with `payInvoiceAtTill`, which now takes a guest's receipt too. `getOrder`'s paid and outstanding now include a balance paid at the till.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 8 (`b11c8-dispatch-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c7-dispatch-returns-notifications.md,
B11 continued 7, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF, WHL and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0088 (credit control
reads exposure live), ADR-0091, ADR-0092, ADR-0093 and ADR-0094 (dispatch loads the vehicle; the driver's cash is a
payment held by the driver; a part delivery is credited at the door; a short order's rest is a linked backorder), and
the abuse cases 6, 43, 44, 48, 51, 52 and 53 in docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md
as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 8 only, on branch b11c8-dispatch-returns-notifications. B11 continued 7 built partial dispatch
with backorders (ADR-0094: a short line's rest back-ordered at packing becomes a backorder order naming the first, with
no delivery fee; the deposits beyond a document held for it), the extra delivery's fee line (`addExtraDeliveryFee`,
`ord.delivery_fee.add`), `collectFulfilment` (what is left paid at the till with `payInvoiceAtTill`, a guest's receipt
included) and BL-097 (a delivered or collected order completed when a later payment or credit note settles it); 2.36.0,
A-366: build on them, never again. The rest, in this order:
1. The rest of dispatch: an order on account (the owner, 2026-11-23: the credit check runs at dispatch, WHL's credit
   control through a port, ORD sitting below WHL, and the invoice is issued from the quantities actually dispatched):
   staff delivery orders (`createOrder` with `fulfilmentMode` `DELIVERY`, refused today `FULFILMENT_NOT_AVAILABLE`: the
   customer's own address, its zone and fee), the credit check at dispatch and at collection (a new port method that
   judges the dispatched gross without counting the order's own estimate twice; an approved override covers it as at
   confirmation), the invoice's due date from the customer's terms, nothing due to the driver on an order on account,
   a backorder of a credit order judged again at its own dispatch; remove `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD (from
   dispatch and collection). Then the checkout's chosen slot carried onto the delivery at dispatch and booked (A-362
   (e)); PAY's `Payment.driver` (BL-096); the checkout's store-credit choice for a lighter total (ADR-0021, A-338 (c));
   cracked eggs written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
2. Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
   paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
   refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the
   egg cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per
   crate) less round(paid x previously returned / per crate), so the pieces always add up. Tests by SQL: a GH₵55.00 crate
   (5,500 pesewas) with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one
   egg at a time, all 30, refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding
   each egg on its own, turns a test red. Extend createReturn's description to a part of a crate returned as single eggs.
3. Notifications (NTF): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers, preferences, opt-out,
   quiet hours, the message log and retry: the customer's messages from `ord.OrderDispatched` (one, with the weights and
   the final total, FR-ORD-011; it names a backorder from 2.36.0), `ord.OrderCollected` (from 2.36.0), the on-the-way
   (`del.DeliveryOnTheWay`, from 2.32.0), the rescheduled (`del.DeliveryRescheduled`, from 2.34.0, FR-DEL-003), the
   cancelled (`del.DeliveryCancelled`, from 2.35.0) and delivered messages (FR-DEL-012, once per event and recipient;
   `del.DeliveryCompleted` names a part delivery's returned lines from 2.35.0), abandoned-cart messaging (ADR-0026), the
   death report sent back by the malware scan (B06r, A-175: liv.MortalityReturned names the reporter and the reason),
   the document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202 through the outbox, a bil.reprint_log
   row with the channel, the archived bytes or a lasting link, never a new document; the remittance advice from
   pur.SupplierRemittanceReady, once per payment; a send reaches only the document's own customer or supplier and a
   failed send is retried without a second archive row), CR-033 point 3 (the receipt SMS once when a counter sale with
   customerPhone syncs, with a fresh server-made token for a sale whose till token was refused, ADR-0074; the refused
   till token still opens nothing), and the guest's SMS tracking link with its own long random token (a guessed token or
   the order's id answers 404). The owner, 2026-11-23 (from the frontend's F12 and F10n): list the message templates so a
   reminder level picks one instead of typing a code, and record each reminder's delivery per channel (sent, delivered,
   failed), so a failed reminder shows as failed. CR-039 at the shop (the crate and the single egg, each at its own
   price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference.
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c8-dispatch-returns-notifications.md.
```
