# B11 continued 4: the van's two other ways out, returned to stock or written off with a reason (lane B), split before the rest

Date: 2026-11-23 · Branch `b11c4-returns-dispatch-notifications`, from `main` at `5a27569` (#131, the A-331 decision) · Status: **phase split (A-361): the van's two other ways out built to their own gate, passed locally; CI below. The rest is B11 continued 5.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-360 (a) | **Only a `FAILED` delivery** (its order `DELIVERY_FAILED`) takes a way out other than delivery; a stop still assigned or on its way first has its failed attempt recorded by its driver. Both ways out are the Manager's and the Owner's (`del.delivery.return`, `del.delivery.write_off`, new), never the Driver's. | Owner |
| A-360 (b) | **Returned to stock:** each dispatched pick moved `TRANSFER_INTERNAL` from the vehicle into the named live `RETURNS_HOLD` of the delivery's branch; "not sellable until inspected" is that location kind, never promised online nor picked from (as built); the delivery and the order `RETURNED`. | Owner |
| A-360 (c) | **Written off:** INV's own adjustment at the vehicle (a loss at cost) with a `WASTAGE` reason or the new `UNACCOUNTED_ON_VAN` (note needed), through INV's `STOCK_WRITE_OFF` policy: at once below the threshold; at or above it the goods stay on the van until a different person approves (then `WRITTEN_OFF` in the approval's transaction); refused, the goods are still aboard and it may be asked again. `WRITTEN_OFF` is a new posted delivery status; the order is `RETURNED` (the order machine has no written-off status). | Owner |
| A-360 (d) | **The money:** the **whole document** is credited, the delivery fee included (no delivery was made), reason `DELIVERY_RETURNED` (new), through BIL's `CREDIT_NOTE` approval by someone other than the Manager; once issued, what the customer paid beyond what the document still asks is asked back through PAY's `REFUND` approval, the Manager its maker, to the original method, or to store credit for a customer account only (a guest 422 `STORE_CREDIT_NEEDS_CUSTOMER`). No money moves without its own second-person approval. | Owner |
| A-360 (e) | **The driver variance report's goods line** (`listDriverGoodsVariances`, under `del.cash_reconciliation.read`): only goods written off as `UNACCOUNTED_ON_VAN`, at the adjustment's value at cost; spoiled or damaged goods are wastage, not the driver's variance. | Owner |
| A-360 (f) | **Residual:** the `CREDIT_NOTE` policy asks for approval at every amount (A-200), so a write-off approved later never issues a credit note at once inside IAM's decision (which would need the credit-note series lock); revisit if that policy changes. | Owner |
| A-361 | **The split.** Built the first item of the opener's first sub-domain (the van's two other ways out and the variance line) to its own gate, and stopped. **B11 continued 5** (`b11c5-dispatch-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds the rest in the same order. | Parent session |

**For the parent session to schedule:** everything in B11 continued 5's opener; it is still large and should expect to split again at its sub-domain boundaries (the rest of delivery and dispatch, then returns of part of a crate, then notifications). No larger contract request was taken on here.

**No ADR conflict, and no stop.** ADR-0092 is followed (the goods ride on the van as the farm's stock until delivered, returned to the hold or, now, written off; a failed delivery's goods go back to the returns hold with a credit note). ADR-0066: the credit note and the refund each wait for a person other than their maker. ADR-0067: no `now()` in the new business SQL and no time default on the new table (every time is the application clock's). ADR-0035: each handler authorises in the application layer. **Shared modules, additively only:** BIL gains `Billing.requestWholeCreditIn` (a new function on `issueCreditNote`'s path; `issueCreditNote` untouched); INV gains `StockAdjustments.viewIn` (a read); MDM gains two reason rows; IAM gains two permission rows and their grants (migrations 0324, 0325); no POS, PAY, FIN or IAM code changed. ORD (lane B's) subscribes in-transaction to IAM's existing `iam.ApprovalDecided`. Lane A's former files (`sale-posting.ts`, PAY's till-cash rules) are untouched. A-331 (approved by the owner) was already recorded on `main` by #131; this branch carries it once (rebased, the duplicate commit dropped).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 4, lane B (`b11c4-returns-dispatch-notifications`, from `main`).
2. **Scope:** planned to split from the start (the parent session's order); built the first item of the first sub-domain only: `returnDeliveryToStock`, `writeOffDelivery` and the driver variance report's goods line, with the close rule taking the write-off.
3. **Gate (this part):** every item on the van leaves it delivered, returned to stock or written off with a reason, the unaccounted on the driver variance report, and a run with goods aboard is still refused its close; a way out never takes the van below zero; every write refuses the wrong role. **Passed** (below). The rest of the opener's gate (credit-terms dispatch, part of a crate refunded pro rata, the outbox's customer messages) is B11 continued 5's.

## Contract changes

**2.33.0, minor, LOUD on `Delivery.status`** (on top of 2.32.0; Redocly clean, no warnings; `contract:generate`: 541 operations from code, 122 planned, 663 in all).
- **Into code with its planned path:** `returnDeliveryToStock` (`POST /deliveries/{id}/return-to-stock`, `del.delivery.return`); `ReturnToStock.note` bounded 1 to 500; `refundDestination` new and optional.
- **New operations:** `writeOffDelivery` (`POST /deliveries/{id}/write-off`, `del.delivery.write_off`, `DeliveryWriteOff`): 200 `WRITTEN_OFF`, or 202 `ApprovalPending` (`STOCK_WRITE_OFF`); `listDriverGoodsVariances` (`GET /driver-goods-variances`, `del.cash_reconciliation.read`, `DriverGoodsVariancePage`).
- **LOUD:** `Delivery.status` gains `WRITTEN_OFF`; `completeRoute`'s description names it.
- `DELIVERY_INVALID` gains `NOT_A_RETURNS_HOLD`, `WRITE_OFF_PENDING`, `STORE_CREDIT_NEEDS_CUSTOMER` (and `REASON_UNKNOWN`, `REASON_NOT_ALLOWED`, `NOTE_REQUIRED` on the write-off); below zero on the van answers INV's `INSUFFICIENT_STOCK`.
- **New permissions in `x-seeded-roles`:** `del.delivery.return`, `del.delivery.write_off` (the Owner, the Manager).
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| ORD domain | `domain/van-return.ts`: `judgeWayOut` (FAILED only, no second way out while a write-off waits, a live returns hold of the branch, a write-off reason and its note, store credit only for a customer account), `isDriverVariance`, `UNACCOUNTED_ON_VAN`. |
| ORD application and interface | `VanReturns` (`returnToStock`, `writeOff`, `decidedIn` on `iam.ApprovalDecided` for its own `STOCK_WRITE_OFF` and `CREDIT_NOTE` requests), `VanReturnStore` and `PgVanReturnStore`, `VanReturnsController` under `/deliveries`. |
| DEL | `leftTheVan` takes `WRITTEN_OFF`; `Deliveries.vanDeliveryIn`, `returnedIn`, `writtenOffIn`, `goodsVariances` (`listDriverGoodsVariances` on `DriverCashController`); events `del.DeliveryReturned`, `del.DeliveryWrittenOff` (`unaccounted`, abuse case 48). |
| BIL, INV (additive) | `Billing.requestWholeCreditIn`; `StockAdjustments.viewIn`. |
| Schema | 0321 (MDM: `UNACCOUNTED_ON_VAN`, `DELIVERY_RETURNED`); 0322 (DEL: `WRITTEN_OFF`, its four columns and `ck_delivery_written_off`, the guard's edge, `ck_route_closed`); 0323 (ORD: `ord.delivery_return` and its guard); 0324 and 0325 (IAM: the two permissions and their grants). Each rolls back (the rollback walk names them). |
| Docs | A-360, A-361; ADR-0026 Amendments; `data-model/del.md` and `ord.md`; the ORD card; API.md (DEL); the 2.33.0 changelog; abuse case 49 (case 48's detection names the goods line); the openers (B11 continued 4 marked built and split, B11 continued 5 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/del/van-returns.integration.spec.ts` (10 tests, over the seeded farm; Kwabena Asare's started run carries four crates of big eggs on VAN1, A, B and C guests' on cash on delivery, D paid ahead by mobile money; all four fail at the door; Kwesi Appiah's crate rides on no run):
- **Goods aboard:** the close 422 `ROUTE_INVALID` with `GOODS_ON_VAN` for each of the four stops.
- **Who:** the Driver, the Storekeeper, the Cashier, Sales and another branch's Manager 403 on both ways out, nothing written (movements, adjustments, credit notes, ways out and delivery versions all unchanged by SQL).
- **Refusals, nothing written:** a delivery not failed `INVALID_STATE_TRANSITION`; the shop floor for a returns hold `NOT_A_RETURNS_HOLD`; `COUNT_ERROR` `REASON_NOT_ALLOWED`; an unknown reason `REASON_UNKNOWN`; unaccounted with no note `NOTE_REQUIRED`; an unknown field 400.
- **A returned:** 200 `RETURNED`, the same key the same answer, again 422; by SQL one `TRANSFER_INTERNAL` of 30.000 from the VEHICLE to the RETURNS_HOLD, VAN1 down 30 and the hold up 30; the order `RETURNED`, the delivery posted; the credit note DRAFT of the whole document's gross exactly, reason `DELIVERY_RETURNED`, made by the Manager; the Manager's own approval refused; the Owner's issues it at the document's gross; nothing paid, so no refund; one `del.DeliveryReturned`.
- **B written off as spoiled, below the threshold:** 200 `WRITTEN_OFF`; the adjustment `POSTED` at the VEHICLE, its total equal to the delivery's written-off value; one `ADJUST_LOSS` of 30.000 to LOSS at that value; the order `RETURNED`; the credit note of the whole gross; not on the variance report; `del.DeliveryWrittenOff` `unaccounted: false`.
- **C unaccounted, above the threshold (lowered to 1 pesewa for the test, restored after):** 202 `STOCK_WRITE_OFF`, the delivery still `FAILED` and the eggs still aboard; a second write-off and a return 422 `WRITE_OFF_PENDING`; the Owner's rejection leaves it `REJECTED` and aboard; asked again, the Manager's own approval refused, the Owner's approval posts it (`posted_by` the Owner) and the delivery is `WRITTEN_OFF` in that transaction, the order `RETURNED`, the credit note DRAFT by the Manager; **the variance report lists C alone** with its run, the driver, the adjustment and its value exactly, filtered by driver and day; another driver's and another branch's empty; the Driver, the Storekeeper, the Cashier and Sales 403; the event names abuse case 48.
- **Never below zero:** with VAN1 emptied by a hand adjustment, D's write-off and its return both 422 `INSUFFICIENT_STOCK`, nothing written, VAN1 still 0.000; the eggs found again.
- **D returned, paid ahead:** store credit for a guest 422 `STORE_CREDIT_NEEDS_CUSTOMER`, nothing written; returned; once the Owner issues the credit note, the refund is asked once: exactly the credit note's gross, which is exactly what was allocated to the document, `ORIGINAL_METHOD`, `ORDER_RETURNED`, against that credit note, `PENDING_APPROVAL`, requested by the Manager.
- **Closed:** VAN1 holds only Kwesi's 30 eggs; the run closes 200 `COMPLETED`, `stopsOnVan` 0; four ways out audited.
- **The database:** a delivery written off from `ASSIGNED` HK004; a failed delivery written off with no reason 23514 (`ck_delivery_written_off`); a written-off delivery changed HK004; a way out's credit note or note changed HK004, a rejected one moved HK004, deleted 42501, a second live one 23505.

Unit: `ord/domain/van-return.spec.ts` (8, written first and run red: no module) and `del/domain/routes.spec.ts` (two cases extended to `WRITTEN_OFF`, run red first).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `leftTheVan` without `WRITTEN_OFF` (the code before this session) | red: 2 (unit) |
| M2 | The credit note's approval never asks for the refund (`decidedIn` skips `CREDIT_NOTE`) | red: 1 (integration, D) |
| M3 | Any reason accepted for a write-off from the van (`judgeWayOut` skips the domain check) | red: 1 (unit) |

## Test first, as it honestly happened

- `van-return.spec.ts` and the two `routes.spec.ts` cases were written and run red before `van-return.ts` and the `leftTheVan` change.
- The integration spec was written after the application code, against the gate's list. Its first run failed on 7 cases: the new store updates did not move `version` (the platform's `touch_version` refused them, a 500): fixed in the store; the test's own direct SQL updates likewise. Its second run failed on 4: a DRAFT credit note carries no gross until issued (the test now reads the approval's amount, then the issued gross), and store credit for a guest was refused by PAY inside the credit note's approval, which would have rolled that approval back: **a real defect**, fixed by refusing store credit for an order with no customer account at the command (`STORE_CREDIT_NEEDS_CUSTOMER`, unit-tested first). The contract tests then failed on the operation counts and a request example with no schema in the walk: each was the walk doing its job. Nothing was skipped, no assertion loosened, nothing re-run to turn red into green.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (both ways out, the variance report), the database, IAM's approvals.
- **Identity, sessions and browser:** unchanged; every write is a staff session with CSRF and the idempotency key.
- **Authorisation:** deny by default; each handler authorises in the application layer at the delivery's branch (`VanReturns.command`, `Deliveries.goodsVariances` at the branches read whole); the Driver holds neither way out, so a driver cannot write off or return their own van's goods; wrong roles tested on every operation; the handler walk and the seeded role matrix include them.
- **Maker and checker:** the write-off above the threshold, the credit note and the refund each wait for a different person (IAM refuses the maker; tested for the write-off and the credit note); the refund's maker is the Manager, so PAY refuses them as its approver.
- **Money paths:** no money moves without its approval; the credit note is the whole document once (BIL's cap); one refund per credit note (`uq_delivery_return_refund`), its amount `planReturnRefund`'s (never more than the credit note, never more than refundable).
- **Stock:** movements through INV only (its trigger refuses a van below zero, tested); one live way out per delivery (`uq_delivery_return_live`).
- **Input:** strict schemas, unknown fields 400, parameterised SQL only.
- **Data protection and logging:** the new events carry ids, codes and amounts, no phone or name.
- **Webhooks, uploads, exports:** not applicable.
- **Abuse paths:** abuse case 49 added (a failed delivery taken off the van to hide goods or obtain money: a false write-off, a paper return, a double refund); its controls are in place and tested; its detection item (write-offs by driver and reason, the returns hold against what came back) is B12's daily exception report, for which `del.DeliveryWrittenOff` (with `unaccounted` and abuse case 48) and `del.DeliveryReturned` are in the outbox. Case 48's detection now names the goods line.
- Findings: one, fixed in this change (store credit for a guest would have failed inside the credit note's approval). Residual: A-360 (f).

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need partial dispatch, the driver's sync and notifications, which are B11 continued 5's; its opener names them.

## Reused photographs

Not recorded here; B11 continued 5's opener carries it (B12's opener says B12 must if B11 continued 5 does not).

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-055** (a part delivery), **CR-054 point 1** (cracked eggs on the pick), **CR-057 point 3** (a sync `DUPLICATE`'s first outcome), **CR-039** (the shop's units), **CR-033 point 3** (the receipt SMS on sync): B11 continued 5's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request asked for the two ways out; the frontend reads them from 2.33.0.

## Tests (this machine)

Run on commit `6614c54` (the code of the final head; the commit above it adds only this report) with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,081 passed, 342 files, none skipped, exit 0**, the whole integration suite included (`main` had not moved, so no rebase or renumbering was needed in the merge slot). Coverage, whole: statements 94.11, branches 83.61, functions 97.95, lines 97.14 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them). The first whole run (on `2b66250`) was red on four tests, each a walk doing its job: the handler walk did not list the three new operations; the deny-by-default and identifier walks sent the two new writes an empty body, so validation answered before the refusal; the reason code list did not count 0321's two codes. Fixed in `6614c54` (the walks name them and send a valid body; no rule loosened). The push run `45257762825` on `946fbc8` was red on the same four tests (shard 2: 3, shard 3: 1, and the coverage gate job that follows them); it was not re-run. |
| Contract (`pnpm test:contract`) | 139 passed, on 2.33.0 |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (541 operations from code, 122 planned) |

## Deferred

- **To B11 continued 5** (its opener): assignment and reassignment; rescheduling, cancellation and slot booking; CR-055; `syncDriverEvents` (CR-057 point 3); BL-096; partial dispatch with the fee once and the extra delivery's fee line (A-331 (b), approved); credit-terms dispatch (remove `CREDIT_DISPATCH_NOT_AVAILABLE`); collection; the store-credit choice; BL-097; CR-054 point 1; returns of part of a crate; all of NTF; CR-039; the reused-photograph match; the UAT dry runs.
- **Seed:** nothing seeded (the ways out are made by the tests over the seeded farm).

## Questions for the owner

1. **The whole document credited (A-360 (d)).** A failed delivery returned or written off credits the goods and the delivery fee, since no delivery was made. Agreed, or should the farm keep the fee for a delivery attempted and refused at the door?
2. **Only the unaccounted on the variance report (A-360 (e)).** Goods spoiled or damaged on the van are wastage, not the driver's variance. Agreed?

## Notes for the frontend track

- **2.33.0:** a failed stop's screen offers `returnDeliveryToStock` (a returns hold of the branch, a note, optionally `STORE_CREDIT` for a customer account) and `writeOffDelivery` (`UNACCOUNTED_ON_VAN` or a `WASTAGE` reason, a note); the write-off answers 200 with the delivery `WRITTEN_OFF`, or 202 waiting for a stock write-off approval (the stop still on the van; show it as pending, never as off). `Delivery.status` may be `WRITTEN_OFF`. The driver variance report gains its goods line, `listDriverGoodsVariances`, beside the cash hand-ins.

## CI

Red, recorded: push run `45257762825` on `946fbc8` (the four walk tests above; fixed in `6614c54`, never re-run). A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 5 (`b11c5-dispatch-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c4-returns-dispatch-notifications.md,
B11 continued 4, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0091 and ADR-0092 (dispatch
loads the vehicle; the driver's cash is a payment held by the driver), and the abuse cases 6, 43, 44 and 48 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 5 only, on branch b11c5-dispatch-returns-notifications. B11 built picking and packing (2.25.0);
B11 continued built dispatch of a whole delivery order and the proof with the cash held by the driver (2.27.0, ADR-0092);
B11 continued 2 built the driver's cash handed in at a till shift (`handInDriverCash`, the variance report, 2.31.0,
A-345); B11 continued 3 built the driver's run (`createRoute` to `completeRoute`, `getMyRoute` 404 with no run,
`listDrivers`, `markOnTheWay`, `recordFailedDelivery`; a run closed only when every stop is DELIVERED or RETURNED and
no collection on it is held, the hand-ins recorded against it by the database; 2.32.0, A-347); B11 continued 4 built
the van's two other ways out (`returnDeliveryToStock` and `writeOffDelivery`, a FAILED delivery only, through INV's
adjustment and its approval, the whole document credited through `CREDIT_NOTE` and the refund through `REFUND` once it
is issued, `WRITTEN_OFF`, `listDriverGoodsVariances`; 2.33.0, A-360): build on them, never again. The rest, in this order:
1. The rest of delivery and dispatch: assignDelivery and reassignment, audited (FR-DEL-004; a delivery on a live run keeps
   its driver and van, `ck_delivery_route`); rescheduleDelivery (a reattempt: FAILED back to ASSIGNED, the order
   DISPATCHED again) and cancelDelivery; delivery slot booking against capacity under a row lock, zone cut-offs and
   rescheduling (FR-DEL-001 to FR-DEL-003; `RouteStopDelivery`'s slot times then filled); CR-055, a part delivery
   (`ProofOfDeliveryCreate.lines` and `returnedReasonCode`: the rest back to stock or kept for a reattempt, the document
   credited for what came back, the cash due fixed again); the driver's offline sync (syncDriverEvents, idempotent by
   client id, CR-057 point 3: a DUPLICATE answers the first outcome). PAY's `Payment.driver` (BL-096). Partial
   fulfilment and backorders (FR-ORD-012) with the delivery fee once, on the first dispatch, never again (UAT scenario
   2's rule, A-331 (b), approved by the owner 2026-11-23, steps 2.12 and 2.13, test with exact pesewas): a later dispatch
   the farm makes to complete a short or part order carries no fee. The owner, 2026-11-23: a delivery the customer asks
   for as an extra is a separate, explicit fee line, added by staff who hold its permission (a new permission, granted
   by migration, its wrong-role test), never inferred from a second dispatch; test-first with exact pesewas, on the
   dispatch's document and its total; an order on account dispatched with its due date
   from the customer's terms (the owner, 2026-11-23: the credit check runs at dispatch, WHL's credit control through a
   port, ORD sitting below WHL, and the invoice is issued from the quantities actually dispatched; remove
   `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD); collectFulfilment (a collection order handed over and paid at the till); the
   checkout's store-credit choice for a lighter total (ADR-0021, A-338 (c)); a delivered order completed once later
   settled (BL-097); cracked eggs written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
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
   the final total, FR-ORD-011), the on-the-way (`del.DeliveryOnTheWay`, already in the outbox from 2.32.0) and delivered
   messages (FR-DEL-012, once per event and recipient), abandoned-cart messaging (ADR-0026), the death report sent back
   by the malware scan (B06r, A-175: liv.MortalityReturned names the reporter and the reason), the document sends
   (ADR-0062, A-204: sendBillingDocument and sendStatement, 202 through the outbox, a bil.reprint_log row with the
   channel, the archived bytes or a lasting link, never a new document; the remittance advice from
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
Stop at the gate and write docs/sessions/B11c5-dispatch-returns-notifications.md.
```
