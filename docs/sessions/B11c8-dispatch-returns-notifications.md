# B11 continued 8: an order on account, the rest of dispatch (the checkout's slot, BL-096, eggs broken on the pick) (lane B), split before returns

Date: 2026-11-24 · Branch `b11c8-dispatch-returns-notifications`, from `main` at `254e596` (#135, B11 continued 7) · Status: **phase split (A-371) at the boundary of its first sub-domain: an order on account at dispatch and collection, staff delivery orders, the checkout's slot, BL-096 and CR-054 point 1 built to their own gate, passed locally; CI below. Returns of part of a crate and notifications are B11 continued 9.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-368 | **An order on account** (the owner, 2026-11-23; A-331 (a) approved; ADR-0095, proposed). (a) Staff delivery orders take one of the customer's own live saved addresses, snapshotted with its zone, and the zone's own fee (waived over its threshold, as the checkout); a slot on a staff order is refused `SLOT_NOT_AVAILABLE`; a quote's conversion and a standing order stay collection only. (b) At dispatch and at the hand-over the credit check runs through ORD's `OrderConfirmationPolicy` port (`creditAtDispatchFor`, WHL's credit control) on the gross of the document on what is sent, the order's own estimate and its just-issued document never counted beside it; exactly at the limit goes; an approved override covers a gross no larger than approved; else refused with nothing written, or with `creditOverrideReason` the override is asked for that gross (202). A backorder is judged again at its own dispatch. (c) The invoice is due on the business date plus `paymentTermsDays`; nothing is due to the driver or at the till. (d) A delivered or collected order on account stays `DELIVERED` / `READY_FOR_COLLECTION` until its invoice is settled (BL-097). (e) No open account: `CREDIT_CHECK_UNAVAILABLE`, never waved through. | Owner |
| A-369 | **The checkout's slot** (A-362 (e), migration 0332): kept on the order, booked onto the delivery at dispatch under the slot's lock while live, not started and not full (the zone's cut-off is not applied at dispatch); otherwise the delivery goes unbooked and `ord.OrderDispatched` says so (`chosenSlotId`, `bookedSlotId` null). Dispatch is never refused for a slot. | Owner |
| A-370 | **The rest of dispatch.** (a) CR-054 point 1: `PickInput.damaged` writes units found broken off from the pick location in the pick's own transaction through INV's `StockAdjustments.createIn`/`submitIn` (`LOSS`), so the `STOCK_WRITE_OFF` approval applies; whole units only for a unit counted whole; a catch-weight line refused; kept insert-only in `ord.pick_breakage` (migration 0333). (b) The checkout's store-credit choice is **not** honoured: store credit is held on a customer account and every online order is a guest's, so the difference is refunded to the original method as built (BL-116). | Owner |
| A-371 | **The split.** Built the rest of dispatch to its own gate and stopped before returns. **B11 continued 9** (`b11c9-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order, B12's reused-photograph line), builds returns of part of a crate, then notifications with CR-039, CR-033 point 3, the reused-photograph match and the UAT dry runs. | Parent session |

**For the parent session to schedule:** everything in B11 continued 9's opener (returns of part of a crate; all of NTF; CR-039; CR-033 point 3; the reused-photograph match; the UAT dry runs). BL-116 (store credit for a lighter total) waits for the registered checkout.

**No ADR conflict, and no stop.** ADR-0088 (credit control reads exposure live) stands: the check at dispatch reads it live in the dispatch's own transaction under the account's row lock. ADR-0017: the asker never approves (tested at dispatch). ADR-0035: every new handler path authorises in the application layer. ADR-0067: no `now()` in business SQL (the two migrations read no clock; `recorded_at` defaults as every LEDGER table). ADR-0081: the breakage write-off goes through INV's adjustment, never below zero online. **Shared modules, additive only:** MDM `MasterDataRefs.customerAddressIn` (new); PAY `Payments` takes `PrincipalNames` and `PaymentRecord.heldByDriverId` (new, read only) to fill `Payment.driver`; INV unchanged (ORD calls its existing `createIn`/`submitIn`); no function of POS, IAM, BIL or FIN changed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 8, lane B (`b11c8-dispatch-returns-notifications`, from `main` 254e596).
2. **Scope:** the opener's three sub-domains in order (the rest of dispatch with the order on account first, returns of part of a crate, notifications), splitting at a boundary when the context will not reach the next gate.
3. **Gate (this part):** an order on credit terms is credit-checked at dispatch and at collection through WHL's credit control and invoiced on the quantities actually sent, with its due date from the customer's terms and nothing due to the driver; the rest of dispatch built; every new write refuses the wrong role. **Passed** (below). The rest of the opener's gate (part of a crate refunded pro rata; the customer messages) is B11 continued 9's.

## Contract changes

**2.37.0, minor, LOUD on three operations' behaviour and two answer fields** (on top of 2.36.0; Redocly clean, no warnings; `contract:generate`: 548 operations from code, 117 planned, 665 in all; no operation added).
- **LOUD, `createOrder`:** `DELIVERY` is taken with `deliveryAddressId` (it was refused `FULFILMENT_NOT_AVAILABLE`); new refusals `DELIVERY_ADDRESS_REQUIRED`, `ADDRESS_NOT_OF_CUSTOMER`, `NO_DELIVERY_ZONE`, `SLOT_NOT_AVAILABLE`.
- **LOUD, `dispatchFulfilment` and `collectFulfilment`:** an order on account is credit-checked and dispatched; `CREDIT_DISPATCH_NOT_AVAILABLE` is **removed** (never answered again); both may now answer **202 `CreditOverridePending`**; new `DispatchRecord.creditOverrideReason` and the optional `CollectRecord` body; `CREDIT_CHECK_UNAVAILABLE`.
- **LOUD, `getOrderCreditCheck`:** on a confirmed order the order's own estimate is no longer counted twice in `exposurePesewas`.
- **LOUD, answers:** `Payment.driver` now filled for a cash-on-delivery payment (BL-096); `Delivery.slot` now filled at dispatch from the checkout's slot; `FulfilmentLine.damaged` (new `PickDamage`, always sent, null when nothing was broken).
- **New optional request field:** `PickInput.damaged` (new `PickDamageInput`).
- Events: `ord.OrderDispatched` gains `dueDate`, `chosenSlotId`, `bookedSlotId`; `ord.OrderCollected` gains `dueDate`.
- No permission added. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| WHL domain | `overrideCoversDispatch` (a gross no larger than approved, no more over, no new reason), `dueDateAfter` (terms in calendar days). |
| WHL application | `CreditControl.creditAtDispatchFor` and `dueDateFor` (ORD's port); `judgeIn` leaves the order judged and its just-issued document out of exposure; an override asked at dispatch is bound to the gross (`currentPayloadHash` reads the request's amount for an order no longer `PLACED`). |
| ORD domain | `zoneFee` (the checkout's rule), `cashDueOnDelivery` (nil on account). |
| ORD application | `createOrder` with `DELIVERY` (`staffDeliveryIn`: the customer's own address, its zone, the fee); `Orders.creditAtDispatchIn`, `dueDateIn`, `requestDispatchOverrideIn`; `Dispatches.dispatch`/`collect` with the check after the document is issued (refused: the whole transaction rolls back, the number returns to its series; with a reason the override is asked in a transaction of its own, 202 under the same key), the invoice's `dueDate`, nothing due to the driver; the chosen slot passed to DEL; `Fulfilments.recordPicks` with `damaged`; `uninvoicedCreditIn` excluding an order. |
| DEL | `Deliveries.scheduleIn` books the chosen slot when still bookable (`bookableSlotIn`, `judgeBooking` without the cut-off). |
| SHP | the checkout's `deliverySlotId` passed to the order. |
| PAY (additive) | `Payment.driver` from `pay.payment.driver_id` through `PrincipalNames` (BL-096). |
| MDM (additive) | `MasterDataRefs.customerAddressIn`. |
| Schema | 0332 (ORD): `ord.sales_order.delivery_slot_id` (FK `del.delivery_slot`), `ck_sales_order_slot`, `ix_sales_order_delivery_slot`. 0333 (ORD): `ord.pick_breakage` (LEDGER, insert-only, one per pick and per adjustment, the adjustment keyed through its `platform.business_document` row, ADR-0011). Both roll back (the rollback walk names them). |
| Docs | ADR-0095 (proposed) and the decision index; A-368 to A-371; BL-096 marked done, BL-116; abuse cases 54 and 55; ADR-0026 Amendments; `data-model/ord.md`, `del.md`; the `OrderConfirmationPolicy` row of MODULE_BOUNDARIES; API.md (ORD); the 2.37.0 changelog; the openers (B11 continued 8 built and split, B11 continued 9 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/ord/order-on-account.integration.spec.ts` (8 tests, new, over the seeded farm; `p` the seeded crate price read from the engine, every limit set around it):
- **A staff delivery order:** no address `DELIVERY_ADDRESS_REQUIRED`, another customer's or an unknown address `ADDRESS_NOT_OF_CUSTOMER`, a slot `SLOT_NOT_AVAILABLE`, nothing written; with its own address: `deliveryFeePesewas` 1,500, `estimatedTotalPesewas` 2p + 1,500, the snapshot and the Dodowa zone kept.
- **Exactly at the limit dispatches** (limit 3p + 1,500, three crates delivered): exposure from the owning tables 0 before it (the order excluded); Sales, the Storekeeper, the Driver, the Cashier, the Accountant and another branch's Manager 403 (with a reason in the body); dispatched; the `INVOICE` of 3p + 1,500, issued today, **due today + 30 days**; the delivery's `codDuePesewas` **0**; `ord.OrderDispatched` with `codDuePesewas` 0 and the `dueDate`; exposure afterwards exactly 3p + 1,500; trial balance 0.
- **One pesewa over is refused:** a 101 invoice raised after the confirmation takes the account one pesewa over its 2p + 1,600 limit at dispatch: 422 `CREDIT_LIMIT_EXCEEDED`, "GHS 0.01 over its ... credit limit", "dispatch again with a written reason"; the order `PACKED`, no document, no invoice number used, no delivery.
- **Its approval:** with `creditOverrideReason` 202 `CREDIT_OVERRIDE` (the same key answers the same 202), nothing dispatched; without a reason while it waits `APPROVAL_PENDING`; the asker (the Manager) cannot approve; the Owner approves; the override records the gross 2p + 1,500 and 1 over; the same dispatch then goes, its invoice due on the terms; trial balance 0.
- **A backorder judged again:** three crates on account at exactly 3p + 1,500, two sent (invoice 2p + 1,500), the backorder on `CREDIT` with no fee; a 2-pesewa sale since; the backorder's own dispatch refused "GHS 0.02 over", nothing written.
- **Collection on account:** one pesewa over refused at the hand-over ("hand over again with a written reason"); five roles 403; another customer exactly at the limit handed over: `READY_FOR_COLLECTION`, the invoice due on the terms, `ord.OrderCollected` with `dueAtTillPesewas` 0, `dueDate`, `completed` false; trial balance 0.

`test/integration/ord/pick-breakage.integration.spec.ts` (3 tests, new): Sales, the Cashier and the Driver 403; `KG` `UNIT_NOT_SOLD`, a hundredth of a crate (0.3 egg) `INEXACT_QUANTITY`, a reason outside the stock domains 422, nothing written; **five cracked eggs** beside a crate picked: the adjustment `POSTED` at the shop, `BREAKAGE`, 5.000 `LOSS`, the shop holding exactly five eggs fewer (the crate picked moves nothing), `damaged` on the fulfilment line, the row insert-only (`hk_app` 42501, admin HK001); **above the threshold** (set to nil) the adjustment waits, nothing moves, the Manager approves and exactly two eggs leave.

`test/integration/del/scheduling.integration.spec.ts` (+1): a slot of one chosen at the checkout is booked at dispatch (`booked` 1, `slot_id` set, the event's `chosenSlotId` and `bookedSlotId`); a second order that chose the same slot is dispatched unbooked (`bookedSlotId` null, `booked` still 1).

`test/integration/ord/dispatch-delivery.integration.spec.ts` (+1 assertion, BL-096): the cash-on-delivery payment's view names Kwabena Asare.

Unit: `whl/domain/credit.spec.ts` (+7: the dispatch override at, below and one pesewa above the approved amount, one pesewa more over, a new reason; the due date across a month and a year end; terms negative or fractional refused); `ord/domain/dispatch.spec.ts` (+4: the zone fee at the threshold and one pesewa above, a zone without one; nothing due on account).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The order's own estimate counted in exposure at dispatch (`creditAtDispatchFor` passing no order id) | red: 6 of 8 (order-on-account) |
| M2 | The driver given the cash due on an order on account (`cashDueOnDelivery` bypassed) | red: 1 |
| M3 | The chosen slot not passed to DEL at dispatch | red: 1 (scheduling) |
| M4 | The breakage adjustment drafted but not submitted | red: 2 (pick-breakage) |

## Test first, as it honestly happened

- WHL's `overrideCoversDispatch` and `dueDateAfter` and ORD's `zoneFee` and `cashDueOnDelivery` were written as unit tests and run red before the code (6 and 4 failing).
- The integration specs were written against the gate before running them; their first runs found **two real faults, fixed in the code**: (1) **the dispatch's own invoice was counted as an open item beside its gross** (the check runs after the document is issued in the same transaction), so an order exactly at the limit was refused "GHS 195.00 over its GHS 195.00 limit": the port now takes the document's id and WHL leaves it out; (2) **a part of an egg could be written off** (a hundredth of a crate converted to 0.3 egg and posted): a unit counted whole is now written off whole only. BL-096's assertion was run red against the old PAY code before it was restored.
- One spec detail was corrected on the first run (a business account with a nil limit answers 201, not 202), and the contract's request-schema map was told `collectFulfilment`'s new body, as it should.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (`createOrder` with `DELIVERY`, `dispatchFulfilment`, `collectFulfilment`, `recordPicks` with `damaged`, every payment read), TB1 the storefront (the checkout's slot), the database.
- **SC-01 input:** strict schemas; unknown fields 400; `creditOverrideReason` 1 to 500 characters trimmed; `damaged` bounded (quantity pattern, `uom` 1 to 20, a reason code pattern, note 500).
- **SC-02 authorisation:** deny by default in the application layer, unchanged permissions: dispatch and hand-over `ord.fulfilment.dispatch` (six roles and another branch refused with a reason in the body, tested); breakage `ord.fulfilment.pick` (three roles refused, tested); the override approved only by a holder of `whl.credit.override` who did not ask (the asker refused, tested). The address is the customer's own (another customer's refused, tested): no ID is a key.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas; the zone fee exact; the check on the document's own gross; no client figure trusted (the override's amount is the server's gross).
- **SC-06 idempotency:** every write by its key; the 202 is stored under the request's key (replay tested).
- **SC-07, SC-08:** the events carry ids, amounts and dates; the address snapshot is the order's as before (CONFIDENTIAL, no new field class).
- **SC-09 to SC-13:** staff session writes with CSRF and origin, the console rate-limit group; no upload, webhook or outbound URL.
- **SC-14:** no external call inside a transaction.
- **SC-15, SC-16:** no empty catch: the dispatch's credit refusal is rethrown as the 422 or answered 202; every other error propagates.
- **SC-17 maker and checker:** the credit override (IAM, WHL's handler, the database) and the breakage's `STOCK_WRITE_OFF` approval (IAM).
- **SC-18 to SC-21:** no restricted field, no dependency added, no secret-shaped literal.
- **SC-22:** `ord.pick_breakage` insert-only (tested); stock moves only through INV's adjustment.
- **SC-23:** each write one serializable transaction with the whole-command retry; the account row lock serialises credit checks of one customer.
- **SC-24:** audited (`DISPATCH` with the `dueDate`, `COLLECT`, `CREDIT_OVERRIDE_REQUESTED`/`APPROVED`, INV's adjustment rows, `PICK`).
- **Abuse paths:** abuse case 54 (goods on account past the limit: no check, a double-counted estimate, an override reused for a heavier dispatch, a split into backorders, the asker approving) and 55 (good eggs recorded as broken on the pick); controls in the database and tested; detection is B12's daily exception report (`whl.CreditOverrideApproved`, `ord.OrderDispatched` with its `dueDate`, adjustments by reason and picker). Cases 6, 43, 44, 48, 51 to 53 unchanged.
- Findings: two real faults fixed (above). None open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need the customer messages (NTF), which are B11 continued 9's; its opener names them (an order on account can now be dispatched).

## Reused photographs

Not recorded here; B11 continued 9's opener carries it, and B12's says B12 must if B11 continued 6 to 9 do not.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-054 point 1** (cracked eggs on the pick): **implemented** (`PickInput.damaged`, `FulfilmentLine.damaged`, 2.37.0). Points 2 and 3 were answered earlier.
- **CR-039** (the crate and the single egg at the shop) and **CR-033 point 3** (the receipt SMS): B11 continued 9's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request is left without a phase.

## Tests (this machine)

Run on the fix commit just below the report (the code of the final head; the report commit adds only this file) with Docker's Testcontainers; see CI below for the runs on the pushed commits. `main` had not moved from `254e596`, so no rebase or renumbering was needed.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,182 passed, 349 files, none skipped, exit 0**, the whole integration suite included. Coverage, whole: statements 94.10, branches 83.71, functions 97.86, lines 97.16 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them; `ord/domain` and `whl/domain` among them). Unit alone: 2,009 passed (169 files). |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.37.0 |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (548 operations from code, 117 planned) |

**A red local run, and its cause fixed:** the first whole run (before the fix commit) failed 2 tests of `platform/database-roles.integration.spec.ts`, ADR-0011's cross-schema key check: `fk_pick_breakage_adjustment` pointed at `inv.stock_adjustment`, which INV does not publish. Fixed in its own commit by keying the breakage to the adjustment's `platform.business_document` row, as `ord.delivery_return` does; the second whole run is the one above. Nothing was retried or skipped.

## Deferred

- **To B11 continued 9** (its opener): returns of part of a crate; all of NTF (with the dispatch's `dueDate` and slot, `ord.OrderCollected`, a backorder's messages); CR-039; CR-033 point 3; the reused-photograph match; the UAT dry runs.
- **Backlog:** BL-116 (the checkout's store-credit choice, waiting for the registered checkout).
- **Not built, recorded:** a quote's conversion and a standing order to delivery (still collection only; A-368 (a)); a slot on a staff order (A-368 (a)).
- **Seed:** nothing seeded (the tests build their accounts and addresses over the seeded farm).

## Questions for the owner

1. **The credit check at dispatch (ADR-0095, A-368 (b)).** As built an order on account is judged again at dispatch on what is actually sent, and a backorder on its own quantities; an override approved at confirmation covers a dispatch of no more than it was approved for. Agreed?
2. **An order on account stays open until paid (A-368 (d)).** A delivered order on account reads `DELIVERED` until its invoice is settled, then `COMPLETED`. Agreed, or should it complete at delivery with the invoice open?
3. **The store-credit choice (A-370 (b), BL-116).** A guest who chose store credit for a lighter total is refunded to the original method (store credit needs an account). Agreed until the registered checkout?

## Notes for the frontend track

- **2.37.0:** the console's order form offers `DELIVERY` for a customer with a saved address (`deliveryAddressId`; the fee is answered, never typed). Dispatch and hand-over of an order on account may answer 422 with the credit figures in words, or, sent with `creditOverrideReason`, 202 `CreditOverridePending` (show the approval and wait; the same button then dispatches). `CREDIT_DISPATCH_NOT_AVAILABLE` is gone. The pick screen may send `damaged` on a pick (five single eggs on a crate line: `uom` the egg) and reads `damaged` on each fulfilment line with its adjustment. A payment view names its `driver`; a delivery shows the checkout's slot after dispatch when it could be booked.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 9 (`b11c9-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c8-dispatch-returns-notifications.md,
B11 continued 8, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (returns), DEL and NTF requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/ord.md and ntf.md, the ORD, DEL, NTF, BIL and PAY cards in docs/MODULE_BOUNDARIES.md, and ADR-0010,
ADR-0026 (the abandoned-cart assignment), ADR-0062 (document sends), ADR-0074 (a link sent by message gets its own token
from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost rule's running-total rounding),
ADR-0093, ADR-0094 and ADR-0095, and the abuse cases 6, 43, 44, 48, 51 to 55 in docs/security/THREAT_MODEL.md. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 9 only, on branch b11c9-returns-notifications. B11 continued 8 built an order on account
(staff delivery orders with the customer's own address and its zone's fee; the credit check at dispatchFulfilment and
collectFulfilment through ORD's `OrderConfirmationPolicy` port, `creditAtDispatchFor` and `dueDateFor`, on the gross of
the document on what is sent, the order's estimate and document never counted twice, an override covering no more than
it was approved for, 202 with `creditOverrideReason`; the invoice due on the terms, nothing due to the driver), the
checkout's slot booked at dispatch (`ord.sales_order.delivery_slot_id`, `ord.OrderDispatched.chosenSlotId` and
`bookedSlotId`), BL-096 (`Payment.driver`) and CR-054 point 1 (`PickInput.damaged`, `ord.pick_breakage`); 2.37.0,
A-368 to A-370: build on them, never again. The checkout's store-credit choice is parked (BL-116: store credit needs a
customer account, and every online order is a guest's). The rest, in this order:
1. Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
   paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
   refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the
   egg cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per
   crate) less round(paid x previously returned / per crate), so the pieces always add up. Tests by SQL: a GH₵55.00 crate
   (5,500 pesewas) with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one
   egg at a time, all 30, refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding
   each egg on its own, turns a test red. Extend createReturn's description to a part of a crate returned as single eggs.
2. Notifications (NTF): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers, preferences, opt-out,
   quiet hours, the message log and retry: the customer's messages from `ord.OrderDispatched` (one, with the weights and
   the final total, FR-ORD-011; it names a backorder from 2.36.0, and from 2.37.0 an order on account's `dueDate` and the
   slot booked or not), `ord.OrderCollected` (from 2.36.0, `dueDate` from 2.37.0), the on-the-way
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
record every difference (an order on account can now be dispatched).
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c9-returns-notifications.md.
```
