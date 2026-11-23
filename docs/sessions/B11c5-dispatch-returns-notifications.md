# B11 continued 5: a delivery's driver, vehicle and slot after dispatch, reassigned, booked and reattempted (lane B), split before the rest

Date: 2026-11-23 · Branch `b11c5-dispatch-returns-notifications`, from `main` at `336be4c` (#132, B11 continued 4) · Status: **phase split (A-363): reassignment, slot booking and the reattempt built to their own gate, passed locally; CI below. The rest is B11 continued 6.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-362 (a) | **Reassignment** (`assignDelivery`, the Manager's and the Owner's `del.delivery.assign`): only a delivery `ASSIGNED` (waiting on the van) or `FAILED`, never one on its way or finished, never a stop of a `PLANNED` or `IN_PROGRESS` run (`ON_A_RUN`; `ck_delivery_route` already keeps its driver and van), never while its write-off waits (`WRITE_OFF_PENDING`); the same driver and van `UNCHANGED`. A changed vehicle moves each dispatched pick van to van (`TRANSFER_INTERNAL`, still the farm's, never below zero) in the same transaction; the old driver can no longer open the delivery. | Owner |
| A-362 (b) | **Booking** (`rescheduleDelivery`): a live slot of the delivery's own zone, under its row lock, never above capacity, never one started (to the minute); today's only up to the zone's cut-off in Africa/Accra, **the cut-off minute itself still counts as before it** (14:00:00 books today, 14:00:01 does not). A delivery holds its unit while it is not `CANCELLED`, `RETURNED` or `WRITTEN_OFF` (a `DELIVERED` one keeps it); the counts are the database's. | Owner |
| A-362 (c) | **The reattempt:** rescheduling a `FAILED` delivery sends it back to `ASSIGNED` and its order `DISPATCHED`; the same slot may be taken again for a reattempt without a second unit; the same slot for a delivery waiting on the van 422 `SAME_SLOT`. | Owner |
| A-362 (d) | **A stop of a live run is booked only on its run's day** (`NOT_ON_RUN_DAY`): a stop never moves to another run and a run closes only with nothing on its van, so a failed stop reattempted another day keeps its run open overnight. Moving a failed stop to a later run is BL-110. | Owner |
| A-362 (e) | Dispatch still makes the delivery with no slot (the order does not keep the checkout's chosen slot); booking is `rescheduleDelivery`'s. Carrying the checkout's slot onto the delivery at dispatch is B11 continued 6's. | Owner |
| A-362 (f) | `del.DeliveryRescheduled` names no phone or name; NTF tells the customer (FR-DEL-003) in its own sub-domain (B11 continued 6). | Owner |
| A-363 | **The split.** Built the first part of the opener's first sub-domain (reassignment, slot booking and the reattempt) to its own gate, and stopped. **B11 continued 6** (`b11c6-dispatch-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds the rest in the same order. | Parent session |

**For the parent session to schedule:**
- **CR-063** (the till lists the drivers who hold delivery cash, `GET /shifts/{id}/driver-cash-holders`, `pos.sale.create`): small and additive, but its route, its shift check and its device credential are POS's, lane A's module, which this lane never edits. Not implemented; it needs a POS slot or the parent's leave (DEL can supply the read: proofs with cash collected and no hand-in, by branch). Until then the frontend keeps the hand-in behind its switch.
- Everything in B11 continued 6's opener; it is still large and should expect to split again at its sub-domain boundaries.

**No ADR conflict, and no stop.** ADR-0092 is followed (the goods ride on the van as the farm's stock; a reassignment moves them van to van as a recorded movement; a reattempt moves nothing). ADR-0035: each handler authorises in the application layer at the delivery's branch. ADR-0067: no `now()` in the new business SQL (the slot trigger takes the delivery's own `updated_by`; `touch_version` sets the slot's `updated_at` as everywhere). **`cancelDelivery` is not built** and carried to B11 continued 6 with a warning in its opener: the order machine of `docs/DOMAIN_MODEL.md` section 7 has no `DISPATCHED` to `CANCELLED`, so a dispatched delivery's cancellation must be decided against it, never coded around it. **Shared modules:** none changed (MDM's `Storefront.deliveryZonesIn` and INV's `Stock.postIn` are called as they are). DEL and ORD are lane B's; lane A's former files are untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 5, lane B (`b11c5-dispatch-returns-notifications`, from `main`).
2. **Scope:** planned to split from the start; built the first part of the first sub-domain only: `assignDelivery`, `rescheduleDelivery` with slot booking against capacity under a row lock and the zone's cut-off, and the reattempt of a failed delivery.
3. **Gate (this part):** a failed delivery is reattempted (order `DISPATCHED` again) or reassigned (audited, its goods following van to van, never below zero); a slot is never overbooked, under concurrency and by direct SQL; every write refuses the wrong role. **Passed** (below). The rest of the opener's gate (cancellation, the part delivery, the fee once, credit-terms dispatch, part of a crate refunded pro rata, the outbox's customer messages) is B11 continued 6's.

## Contract changes

**2.34.0, minor, LOUD on three slot fields** (on top of 2.33.0; Redocly clean, no warnings; `contract:generate`: 543 operations from code, 120 planned, 663 in all).
- **Into code with their planned paths:** `assignDelivery` (`POST /deliveries/{id}/assign`), `rescheduleDelivery` (`POST /deliveries/{id}/reschedule`), both `del.delivery.assign`.
- **LOUD:** `Delivery.slot`, `DeliverySummary.slotDate`, `slotStartsAt`, `slotEndsAt` and `RouteStopDelivery.slotStartsAt`, `slotEndsAt` are filled once a slot is booked (always null before).
- `DeliveryReschedule.reason` bounded 1 to 500 (the operation was never served).
- `DELIVERY_INVALID` gains `ON_A_RUN`, `UNCHANGED`, `SLOT_UNKNOWN`, `SLOT_OTHER_ZONE`, `SLOT_STARTED`, `PAST_CUT_OFF`, `SLOT_FULL`, `NOT_ON_RUN_DAY`, `SAME_SLOT`, `ZONE_NOT_DELIVERING` and `WRITE_OFF_PENDING` on both; a van without the goods answers INV's `INSUFFICIENT_STOCK`.
- No new permission. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| DEL domain | `domain/scheduling.ts`: `judgeReassignment`, `judgeBooking` (state alone; zone, started, cut-off, run's day, capacity, same slot). |
| DEL application and interface | `Scheduling` (`assign`, `reschedule`, serializable, the key as the first write, the delivery under its row lock, the slot under its row lock), `SchedulingController` under `/deliveries`; `DeliveryStore.reassign`, `book`, `routeOf`; `Deliveries` fills the slot in its views and summaries (`slotsIn`, `viewIn`), `Routes` in its stops; events `del.DeliveryReassigned`, `del.DeliveryRescheduled`. |
| ORD | `VanReturns.reassignedIn` (the picks van to van when the vehicle changed) and `rescheduledIn` (a reattempt: `DELIVERY_FAILED` to `DISPATCHED`, the history row), both refusing while a write-off waits; subscribed in-transaction. |
| Schema | 0326 (DEL): `trg_delivery_slot_booking` (a delivery's unit taken and freed by the database, `ck_delivery_slot` HK010: a live slot of its zone and branch, changed only while `SCHEDULED`, `ASSIGNED` or `FAILED`), `trg_delivery_slot_booked` (`ck_delivery_slot_booked_by_delivery` HK004). Rolls back (the rollback walk names it). |
| Docs | A-362, A-363; BL-110; abuse case 50; ADR-0026 Amendments; `data-model/del.md`; the DEL and ORD cards; API.md (DEL); the 2.34.0 changelog; the openers (B11 continued 5 marked built and split, B11 continued 6 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/del/scheduling.integration.spec.ts` (9 tests, over the seeded farm; eight guests' crates of big eggs dispatched onto VAN1 for Kwabena Asare; VAN2 made by the Owner; two slots later today, three tomorrow of capacity 5, 1 and 8):
- **Who:** the Driver, the Storekeeper, the Cashier, Sales and another branch's Manager 403 on both, nothing written (delivery versions, slot counts, movements and the two events unchanged by SQL); a blank reason and an unknown field 400; an unknown delivery 404.
- **Capacity under concurrency (FR-DEL-001):** eight managers' bookings into the slot of five at once: exactly five 200, three 422 `SLOT_FULL`; `booked` 5 and exactly five deliveries naming it, by SQL; the three book the evening slot; eight `del.DeliveryRescheduled`.
- **Moved atomically (FR-DEL-003):** a booking moved frees one in the first slot and takes one in the second; the same key answers the same and moves nothing more; into a full slot 422 `SLOT_FULL` with the first booking still held; `SAME_SLOT`; `SLOT_UNKNOWN`; nothing written; the order's delivery summary shows the slot's times.
- **Cut-off and started (FR-DEL-002):** with the zone's cut-off at 00:00 today's slot 422 `PAST_CUT_OFF`, nothing written; at 23:59 it books; ten minutes on, the slot has started, 422 `SLOT_STARTED`.
- **Reassigned (FR-DEL-004):** 200 with Kwesi Appiah and VAN2; the same key the same answer; by SQL one `TRANSFER_INTERNAL` of 30.000 from VAN1 to VAN2 against the delivery, VAN1 down 30 and VAN2 up 30; one `REASSIGN` audit and one `del.DeliveryReassigned`; Kwabena now 403 on it, Kwesi 200; `UNCHANGED`, `NOT_A_DRIVER`, `NOT_A_VEHICLE`, nothing written; another driver on the same van moves no stock.
- **Never below zero:** VAN2 emptied by a hand adjustment, moving the crate back 422 `INSUFFICIENT_STOCK`, nothing written, the delivery still Kwesi's on VAN2.
- **A stop of a started run (FR-DEL-011):** `ON_A_RUN`; failed at the door (order `DELIVERY_FAILED`); tomorrow's slots 422 `NOT_ON_RUN_DAY` (with `SLOT_FULL` for the full one), nothing written; reattempted in today's later slot: `ASSIGNED`, the order `DISPATCHED` with its history row, the slot's one unit, a `REATTEMPT` audit, the run's stop showing the slot's times; failed again and reattempted in the same slot without a second unit (`attempt_count` 2).
- **A write-off waiting:** a failed crate whose `UNACCOUNTED_ON_VAN` write-off waits for approval (threshold lowered for the test, restored) is neither reattempted nor reassigned, 422 `WRITE_OFF_PENDING`, nothing written.
- **The database:** `booked` changed by hand as `hk_app` HK004; a delivery moved by hand into a full slot 23514 (`ck_delivery_slot_booked`), the delivery's slot unchanged; every slot's count equals its live deliveries.

Unit: `del/domain/scheduling.spec.ts` (12, written first and run red: no module).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `judgeBooking` without the capacity rule (the database's check alone) | red: 3 (integration: the concurrent booking, the atomic move, the run's day) |

## Test first, as it honestly happened

- `scheduling.spec.ts` was written and run red before `scheduling.ts`.
- The integration spec was written after the application code, against the gate's list. Its first runs failed on its own expectations: slot generation answers 201, not 200; a concurrent booking's answer shows the slot's remaining places at its own moment, not the last; and which five crates win the concurrent booking is not fixed, so two later tests that picked "the first crates in the morning slot" were order-dependent (a red run that a re-run would have hidden). Fixed in the spec by naming the crates each test uses, then run twice green; no assertion on a rule loosened. The older slot spec wrote `booked` by hand, which 0326 now refuses: it asserts the refusal and writes its four bookings with the triggers held off, as other specs stand up records the rules no longer allow. The handler walk, the deny-by-default and identifier walks, the contract's operation counts and request-example schemas, and the rollback list each needed the two operations and the migration named: each was the walk doing its job.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (both operations), TB4 driver device (the ownership rule following the delivery), the database.
- **Identity, sessions and browser:** unchanged; both writes are staff sessions with CSRF and the idempotency key.
- **Authorisation:** deny by default; `Scheduling` authorises in the application layer, before and after the delivery is read at its branch; the Driver holds neither, so a driver cannot move their own delivery to a friend or a van; wrong roles and another branch tested; the handler walk and the deny-by-default walk include them. After a reassignment the old driver is refused the delivery (tested).
- **Input:** strict schemas, unknown fields 400, the reason trimmed and bounded; parameterised SQL only.
- **Money and stock paths:** no money moves; the goods move only through INV (its trigger refuses a van below zero, tested); never while a write-off of the same goods waits (tested); slot counts are the database's, an overbooking refused whoever writes (tested by concurrency and by SQL).
- **Data protection and logging:** the new events carry ids, slot times and the reason, no phone or name.
- **Webhooks, uploads, exports, rate limits:** not applicable (no webhook, upload or export; the console group as every back-office write).
- **Abuse paths:** abuse case 50 added (goods or cash moved to a colluding driver or van by reassignment, or a booking moved to hide a stop); its controls are in place and tested; its detection is B12's daily exception report, for which `del.DeliveryReassigned` (both drivers and both vans) and `del.DeliveryRescheduled` (the reason, a reattempt flagged) are in the outbox. Residual: A-362 (d) (a failed stop reattempted another day keeps its run open).
- Findings: none open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need the part delivery, partial dispatch, the driver's sync and notifications, which are B11 continued 6's; its opener names them.

## Reused photographs

Not recorded here; B11 continued 6's opener carries it (B12's opener says B12 must if B11 continued 6 does not).

## Contract requests (the frontend's `main` at `43acd8f`)

- **CR-063** (the till's list of drivers holding cash): new since `66b1be7`; POS's (lane A's module), named above for the parent session. Not declined on its merits.
- **CR-055** (a part delivery), **CR-054 point 1** (cracked eggs on the pick), **CR-057 point 3** (a sync `DUPLICATE`'s first outcome), **CR-039** (the shop's units), **CR-033 point 3** (the receipt SMS on sync): B11 continued 6's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request asked for reassignment or booking; the frontend reads them from 2.34.0.

## Tests (this machine)

Run on commit `3894184` (the code of the final head; the commit above it adds only this report) with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,102 passed, 344 files, none skipped, exit 0**, the whole integration suite included (`main` had not moved from `336be4c`, so no rebase or renumbering was needed). Coverage, whole: statements 94.12, branches 83.65, functions 97.93, lines 97.15 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them). |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.34.0 |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (543 operations from code, 120 planned) |

## Deferred

- **To B11 continued 6** (its opener): `cancelDelivery`; the checkout's slot carried onto the delivery; CR-055; `syncDriverEvents` (CR-057 point 3); BL-096; partial dispatch with the fee once and the extra delivery's fee line (A-331 (b), approved); credit-terms dispatch (remove `CREDIT_DISPATCH_NOT_AVAILABLE`); collection; the store-credit choice; BL-097; CR-054 point 1; returns of part of a crate; all of NTF (with the rescheduled message); CR-039; the reused-photograph match; the UAT dry runs.
- **Backlog:** BL-110 (a failed stop moved to a later run).
- **Seed:** nothing seeded (the bookings are made by the tests over the seeded farm's slots).

## Questions for the owner

1. **A failed stop reattempted another day (A-362 (d)).** As built it stays on its run and its van, so that run stays open until the stop is delivered or taken off the van. Agreed, or should a failed stop move to the next day's run (BL-110)?
2. **The cut-off minute (A-362 (b)).** With a 14:00 cut-off, a booking at 14:00 exactly still gets today's slots; at 14:00:01 it does not. Agreed?

## Notes for the frontend track

- **2.34.0:** a delivery's screen offers `assignDelivery` (driver and van; refused `ON_A_RUN` for a stop of a planned or started run) and `rescheduleDelivery` (a slot from `listDeliverySlots` for the delivery's zone and a reason); for a `FAILED` delivery the reschedule is the reattempt (the delivery `ASSIGNED`, the order `DISPATCHED`). `Delivery.slot`, the order's `delivery.slot*` and a run's stops' slot times are filled once booked; show them, and expect null for a delivery not yet booked.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 6 (`b11c6-dispatch-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c5-dispatch-returns-notifications.md,
B11 continued 5, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
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
Then execute B11 continued 6 only, on branch b11c6-dispatch-returns-notifications. B11 built picking and packing (2.25.0);
B11 continued built dispatch of a whole delivery order and the proof with the cash held by the driver (2.27.0, ADR-0092);
B11 continued 2 built the driver's cash handed in at a till shift (`handInDriverCash`, the variance report, 2.31.0,
A-345); B11 continued 3 built the driver's run (`createRoute` to `completeRoute`, `getMyRoute` 404 with no run,
`listDrivers`, `markOnTheWay`, `recordFailedDelivery`; a run closed only when every stop is DELIVERED or RETURNED and
no collection on it is held, the hand-ins recorded against it by the database; 2.32.0, A-347); B11 continued 4 built
the van's two other ways out (`returnDeliveryToStock` and `writeOffDelivery`, a FAILED delivery only, through INV's
adjustment and its approval, the whole document credited through `CREDIT_NOTE` and the refund through `REFUND` once it
is issued, `WRITTEN_OFF`, `listDriverGoodsVariances`; 2.33.0, A-360); B11 continued 5 built reassignment and slot
booking (`assignDelivery` with the goods following van to van, never on a live run; `rescheduleDelivery` under the slot's
row lock against capacity and the zone's cut-off, the counts the database's; a FAILED delivery rescheduled is the
reattempt, the order DISPATCHED again; 2.34.0, A-362): build on them, never again. The rest, in this order:
1. The rest of delivery and dispatch: cancelDelivery (A-362 and the order machine of docs/DOMAIN_MODEL.md section 7 have
   no DISPATCHED to CANCELLED: decide the cancellation of a dispatched delivery against it, conservatively, or stop and
   ask); the checkout's chosen slot carried onto the delivery at dispatch and booked (A-362 (e)); CR-055, a part delivery
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
   the final total, FR-ORD-011), the on-the-way (`del.DeliveryOnTheWay`, already in the outbox from 2.32.0), the rescheduled
   (`del.DeliveryRescheduled`, from 2.34.0, FR-DEL-003) and delivered
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
Stop at the gate and write docs/sessions/B11c6-dispatch-returns-notifications.md.
```
