# B11 continued 3: a driver's run, closed only with nothing on the van and nothing held (lane B), split before the rest

Date: 2026-11-23 · Branch `b11c3-driver-run-failures-returns-notifications`, from `main` at `a851f1a` (#129, B11 continued 2) · Status: **phase split (A-348): the driver's run and its close rule built to their own gate, passed locally; CI below. The rest is B11 continued 4.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-347 (a) | **One run per driver per day** (the dictionary's UNIQUE driver and date); its stops are deliveries dispatch already loaded onto that van for that driver (`ASSIGNED`), at its branch, on no other run, dispatched by its date, in the Manager's order; set and reordered only while `PLANNED`, never added or dropped once planned; never for a past day. A second run the same day is BL-099. | Owner |
| A-347 (b) | **Starting moves nothing** (dispatch loaded the van, ADR-0092 replaces FR-DEL-005's "starting loads the stock"); it is on or after the run's day. Until a run has started its stops are not taken on the way, delivered or failed (`ROUTE_NOT_STARTED`, and `ck_delivery_route` in the database); a delivery on no run is not held back (as built in B11 continued). | Owner |
| A-347 (c) | **The close rule** (`completeRoute`, new): refused while any stop is not `DELIVERED` or `RETURNED` (`GOODS_ON_VAN`, one detail per stop) or while any collection made on the run is still held by the driver (`CASH_NOT_HANDED_IN`); the database holds the same at commit (`ck_route_closed`). The write-off with a reason joins `DELIVERED` and `RETURNED` in B11 continued 4, with the unaccounted on the driver variance report. | Owner |
| A-347 (d) | **The hand-in recorded against the run:** each handed-in collection names its run (`del.driver_cash_handed_in.route_id`, set by the database from the stop, never by a caller); the run answers its `handIns`. A hand-in still takes everything held at the branch (A-345 (b)), so one may cover two runs. | Owner |
| A-347 (e) | **On the way** records its time once and queues `del.DeliveryOnTheWay` with no phone or name in the outbox (NTF reads the delivery by id when it sends, B11 continued 4); again answers unchanged. **A failed attempt** is insert-only with a `DELIVERY_FAILURE` reason, the next action asked and the device's id (a resend answers the first); the delivery `FAILED`, the order `DELIVERY_FAILED`, the goods still on the van. | Owner |
| A-347 (f) to (i) | `getMyRoute` with no run that day is **404** (CR-057 point 2). `listDrivers` lists everyone who may be given a delivery at the branch as dispatch judges it (holds `del.proof.create`, A-337 (d)), so the Manager and the Owner appear beside the Drivers; with no `branchId`, every branch the caller manages whole. `del.route.read` and `del.route.manage` to the Manager and the Owner only. Contract LOUD on the planned `RouteStopDelivery` (slot times nullable) and `Route` (six fields). | Owner |
| A-348 | **The split.** Built the first sub-domain the parent session named (the driver's run and its close rule, with on the way and the failed attempt the close refuses) to its own gate, and stopped. **B11 continued 4** (`b11c4-returns-dispatch-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds the rest: the van's two other ways out and the variance line, assignment, rescheduling and slots, CR-055, the driver's sync, partial and credit-terms dispatch and the rest of fulfilment; then returns of part of a crate; then notifications; the reused-photograph match; the UAT dry runs. | Parent session |

**For the parent session to schedule:** everything in B11 continued 4's opener (below); it is still large and should expect to split again at its three sub-domain boundaries. No larger contract request was taken on here; the frontend's requests still open are named under "Contract requests".

**No ADR conflict, and no stop.** ADR-0092 ("dispatch loads the vehicle") is followed: `startRoute` moves no stock, which the ADR already settled over FR-DEL-005's wording (recorded in A-347 (b)). ADR-0077 and A-345: the run's cash still reaches a till only through `handInDriverCash`; the close only reads whether it did. ADR-0067: no `now()` in the new business SQL (every time is the application clock's; `platform.touch_version` is the existing platform trigger). ADR-0035: every handler authorises in the application layer. **Shared modules:** ORD (lane B's own) gains one subscriber (`Dispatches.failedIn`); no POS, PAY, INV, BIL, IAM or FIN code changed; IAM changed only by two seed rows and their grants (migrations 0319, 0320). Lane A's former files (`sale-posting.ts`, PAY's till-cash rules) are untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 3, lane B (`b11c3-driver-run-failures-returns-notifications`, from `main` `a851f1a`).
2. **Scope:** planned to split from the start (the parent session's order); built the first sub-domain only, the driver's run: routes, the drivers' list, `getMyRoute`, on the way, the failed attempt, the close rule with the hand-in recorded against the run.
3. **Gate (this part):** a run is planned, ordered, started and read by its own driver only; it cannot be closed while goods remain on the van or its cash is still held, and closing records its hand-ins; every write refuses the wrong role. **Passed** (below). The rest of the opener's gate (the two other ways off the van and the variance line, credit-terms dispatch, returns of part of a crate, the outbox's messages sent) is B11 continued 4's.

## The owner's documentation decisions of 2026-11-23 (from the parent session, one `docs:` commit, `1d980af`)

- **ADR-0003:** the row `del.DriverCashRemitted` now reads Dr 1000 (the till that counted it), Cr 1020 (the driver), the short and over on 6900, as migration 0315 seeds it (rules 294 to 297 agree; `data-model/fin.md` names no rule for the event, so nothing there disagrees); a dated Amendments line replaces the "Applied in B11 continued 2" note; A-345 (d) no longer cites it.
- **A-345 and A-346:** approved by the owner, 2026-11-23.
- **B13's opener and ADR-0026 Amendments:** the owner's release review of the whole system before launch (B13 prepares it and does not deploy to production until the owner signs it off); branch protection on `main` after launch (B13 sets it up or writes the steps, and changes CLAUDE.md step 6 from then); no review per pull request during the build.
- **A-331 approved** (the owner, 2026-11-23, after the merge, in its own `docs:` commit on a follow-up pull request): (a) the credit check counts the whole unpaid order; (b) the delivery fee once, on the first dispatch, a later dispatch completing a short or part order carrying none; added: an extra delivery the customer asks for is a separate, explicit fee line added by staff with its permission, never inferred from a second dispatch. Not built here (partial dispatch is B11 continued 4's); written into B11 continued 4's opener.
- **BL-109 closed** by the owner's decision ("the till takes cash and mobile money only for now. No card at the till. Online card payment (B09c) stays."), with a dated line in A-287.

## Contract changes

**2.32.0, minor, LOUD on two planned schemas** (on top of 2.31.0; Redocly clean, no warnings; `contract:generate`: 538 operations from code, 123 planned, 661 in all).
- **Into code with their planned paths:** `createRoute`, `getRoute`, `listRoutes`, `reorderRouteStops`, `startRoute`, `getMyRoute` (404 listed for no run that day), `markOnTheWay`, `recordFailedDelivery`.
- **New operations:** `completeRoute` (`POST /routes/{id}/complete`), `listDrivers` (`GET /drivers`, `DriverPage`); new error code `ROUTE_INVALID`; `DELIVERY_INVALID` gains `ROUTE_NOT_STARTED` (also on `recordProofOfDelivery`), `OCCURRED_BEFORE_DISPATCH`, `REASON_UNKNOWN`, `REASON_NOT_ALLOWED`.
- **New permissions in `x-seeded-roles`:** `del.route.read`, `del.route.manage` (the Owner, the Manager).
- **`Route` (always sent):** `stopsOnVan`, `codCollectedPesewas`, `codHeldPesewas`, `handIns`, `startedAt`, `completedAt`. **LOUD:** `RouteStopDelivery.slotStartsAt` and `slotEndsAt` nullable (no slot is booked yet).
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| DEL domain | `domain/routes.ts`: `judgeRouteStops`, `judgeReorder`, `canMoveRoute`, `leftTheVan`, `judgeClose`, `judgeOnTheWay`, `takesFailure`, `judgeFailure`; `stopNo` in `numbering.ts`. |
| DEL application and interface | `Routes` (create, get, list, reorder, start, complete, getMine, drivers), `RouteStore` and `PgRouteStore`; `Deliveries.markOnTheWay` and `recordFailure`, and the route-started check on the proof; `RoutesController`, `DriversController`, `DriverRouteController`, two routes on `DriverDeliveriesController`; `RouteInvalidError`; events `del.DeliveryOnTheWay`, `del.DeliveryFailed`, `del.RouteCompleted`. |
| ORD | `Dispatches.failedIn` on `del.DeliveryFailed`: the order DISPATCHED to DELIVERY_FAILED, audited; nothing moves. |
| Schema | 0318 (DEL: `del.route`, `del.route_stop`, their guards, the deferred `ck_route_closed`, `ck_delivery_route`, `del.delivery.on_the_way_at`, `del.driver_cash_handed_in.route_id` set by trigger); 0319 and 0320 (IAM: `del.route.read`, `del.route.manage` and their grants). Each rolls back. |
| Docs | A-347, A-348, BL-099; ADR-0026 Amendments; `data-model/del.md`; the DEL and ORD cards; API.md (DEL, `ROUTE_INVALID`); the 2.32.0 changelog; abuse case 48; the openers (B11 continued 3 marked built and split, B11 continued 4 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/del/routes.integration.spec.ts` (15 tests, over the seeded farm; three crates of big eggs on cash on delivery dispatched to Kwabena Asare on VAN1, one to Kwesi Appiah; Adwoa Darko's own open shift on an enrolled till):
- **Who plans:** the Driver, the Storekeeper, the Cashier, Sales and another branch's Manager 403 on `createRoute`, nothing written; refusals with nothing written: another driver's delivery `NOT_THE_DRIVERS`, a past day `ROUTE_DATE_PAST` (with `DISPATCHED_AFTER_ROUTE_DATE`), no stops, a stop twice, a non-driver `NOT_A_DRIVER`.
- **Planned:** 201 `PLANNED` in the order given, `stopsOnVan` 3, the cash due exactly 3 x the crate; the same key the same run; a second run that day `DRIVER_HAS_A_ROUTE` with each stop `ON_ANOTHER_ROUTE`; tomorrow's run of a stop already on one `ON_ANOTHER_ROUTE`.
- **Reads:** the Manager reads and lists; another branch's Manager 403 by id and an empty list; the Driver, the Storekeeper, the Cashier and Sales 403 on `getRoute`, `listRoutes` and `listDrivers`; `listDrivers` names both drivers and the Manager, never the Storekeeper. **Each driver reads only their own run; none that day is 404.**
- **Not before the start:** on the way, a failure and a proof on a stop of a planned run 422 `ROUTE_NOT_STARTED`, the delivery still `ASSIGNED`.
- **Ordered:** the Driver 403; a stale version 409; fewer or other stops `NOT_THE_SAME_STOPS`; the new order read back by SQL; version 2.
- **Started:** the Driver 403; `IN_PROGRESS` with the clock's time; started again or reordered 422 `INVALID_STATE_TRANSITION`.
- **On the way:** another driver 403; once, its time by SQL; again unchanged; **one** `del.DeliveryOnTheWay` in the outbox, with no phone in it.
- **The close refused with goods on the van:** 422 `ROUTE_INVALID` with `GOODS_ON_VAN` for each of the three stops, by field.
- **A failed attempt:** a COD reason `REASON_NOT_ALLOWED`, an unknown one `REASON_UNKNOWN`, half a position `POSITION_INCOMPLETE`; another driver, the Storekeeper, the Cashier and Sales 403; then `FAILED` with one attempt (by SQL), a resend answers it with no second, the same id on another delivery `ID_IN_USE`; the order `DELIVERY_FAILED`; on the way after it 422; the crate never issued for the sale (still on the van).
- **Refused while cash is held:** two crates delivered with their cash; `codCollectedPesewas` and `codHeldPesewas` exactly 2 x the crate; the close 422 `GOODS_ON_VAN` and `CASH_NOT_HANDED_IN`.
- **Closed:** Kwesi's crate delivered; his close `CASH_NOT_HANDED_IN`; his cash handed in at the till; by SQL the handed-in row names his run; the Driver 403 on the close; then 200 `COMPLETED`, `stopsOnVan` 0, held 0, `handIns` that hand-in; the same key the same answer; again `INVALID_STATE_TRANSITION`; `del.RouteCompleted` names the hand-in; create, start and complete audited.
- **After Kwabena's hand-in:** held 0, his hand-in named, the close still refused for the failed crate alone (`GOODS_ON_VAN`).
- **The database:** a close by SQL with a stop on the van HK010 at commit; the same with that stop `RETURNED` taken (rolled back); the route's driver changed HK004; moved back to `PLANNED` HK004; a completed run changed HK004; a stop renumbered on a started run HK010; a stop deleted 42501; a stop for a delivery not on that van and driver HK010; a run written `IN_PROGRESS` HK004; a second run that day 23505; a delivery on a planned run moved on its way HK004, its driver changed HK004.

Unit, `del/domain/routes.spec.ts` (14, written first and run red: no module). The identifier walk lists `getMyRoute` as taking none; the handler walk lists the ten operations; both walks green.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The close ignores cash held (`judgeClose` never `CASH_NOT_HANDED_IN`) | red: 1 (unit) |
| M2 | A failed stop counts as off the van (`leftTheVan` takes `FAILED`) | red: 2 (unit) |
| M3 | No route-started check on the doorstep (`assertRouteStartedIn` never refuses) | red: 1 (integration) |

## Test first, as it honestly happened

- `routes.spec.ts` was written and run red (no module) before `routes.ts`.
- The integration spec was written after the application code, against the gate's list, then run: two cases failed on their first run, both in the test's expectations, not the rule: a route for a past day also breaks `DISPATCHED_AFTER_ROUTE_DATE` (both rules are true; the test now names both), and a run written `IN_PROGRESS` is refused by the guard (HK004) before its check (the test now expects HK004). The handler walk then refused `listDrivers` with a 400 because its `branchId` was required, so a caller without the permission saw validation before the refusal; `branchId` became optional (every branch the caller manages whole), and the walk is green. The contract tests then failed on the operation count, an example with no schema in the request-example walk and a list with no `empty` example: each was the walk doing its job, fixed in the listed place. Nothing was skipped, no assertion loosened, nothing re-run to turn red into green.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (plan, start, close, the drivers' list), TB4 driver device (the driver's run, on the way, the failed attempt), the database.
- **Identity, sessions and browser:** unchanged; every write is a staff session with CSRF and the idempotency key.
- **Authorisation:** deny by default; each handler authorises in the application layer (`Routes.*`, `Deliveries.markOnTheWay`, `recordFailure`) at the run's or delivery's branch; object level: a driver acts and reads only their own deliveries and run (`getMyRoute` reads by the caller's id, never an id given; another driver's delivery 403); the run is planned, started and closed by the Manager or the Owner, never the driver. Wrong roles tested on every operation; the handler walk, the identifier walk and the seeded role matrix include them.
- **Input:** strict schemas, unknown fields 400, the device's ids as UUIDs, parameterised SQL only.
- **Money paths:** no money moves here; the close only reads whether every collection was handed in at a till (A-345), and the database holds it.
- **Webhooks, uploads, exports:** not applicable (no such path in this change).
- **Data protection and logging:** `del.DeliveryOnTheWay` carries ids and times only, no phone or name (tested); the audit rows carry the delivery views already audited by B11 continued.
- **Rate limiting:** the console group.
- **Database:** the new tables declare their class (DOCUMENT), grants follow it (no DELETE); the run's rules are triggers (transition, stops, close at commit, the delivery on a run); the handed-in row's run is the database's.
- **Abuse paths:** abuse case 48 added (goods kept off the books on a van: a false failed attempt, or a run left open). Its control is in place and tested (a run cannot close with goods aboard or cash held). Its exception item (a run open past its day, failures by driver) is B12's, which builds the daily exception report: `del.DeliveryFailed` and `del.RouteCompleted` are in the outbox for it; its test belongs there. Cases 43 and 44 unchanged.
- Findings: none open. Residual: a driver and the Manager colluding to close a run stays visible through the van's stock on hand and the failed attempts (B12's report).

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need the return to stock, partial dispatch and notifications, which are B11 continued 4's; its opener names them.

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-056 item 4** (a list of drivers without `iam.user.read`): **implemented** as `listDrivers` (`del.route.manage`). Item 3's `del.route.read` and `del.route.manage` for the Manager and the Owner: **implemented**. Items 1 and 2 were done in B11 continued.
- **CR-057 point 2** (`getMyRoute` with no run that day): **implemented**, 404 (the phone treats 404 and an empty route alike already). Point 1 was done in B11 continued 2. **Point 3** (a sync `DUPLICATE`'s first outcome): B11 continued 4's, with `syncDriverEvents` (not declined).
- **CR-055, CR-054 point 1, CR-039, CR-033 point 3:** B11 continued 4's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases.

## Tests (this machine)

Run on commit `24b4347` (the code of the final head; the commits above it change only documents) with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,063 passed, 340 files, none skipped, exit 0**, the whole integration suite included. Coverage, whole: statements 94.10, branches 83.61, functions 97.93, lines 97.13 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them). The first whole run (on `fd7c095`) was red on one test: the rollback walk (`bil/archive-link-rollback`) lists every migration it rolls back and did not yet name 0318 to 0320; the three rolled back and applied cleanly, the list was the walk doing its job, and it now names them (`24b4347`); the second whole run is the one above |
| Contract (`pnpm test:contract`) | 139 passed, on 2.32.0 (the operation counts, the request-example walk and the seeded role matrix given the new operations) |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (538 operations from code, 123 planned) |

## Deferred

- **To B11 continued 4** (its opener): `returnDeliveryToStock` and a write-off with a reason (the van's two other ways out; `leftTheVan` and `ck_route_closed` take the write-off) and the unaccounted on the driver variance report; assignment and reassignment; rescheduling, cancellation and slot booking (then `RouteStopDelivery`'s slot times are filled); CR-055; `syncDriverEvents` (CR-057 point 3); BL-096; partial dispatch with the fee once; credit-terms dispatch (remove `CREDIT_DISPATCH_NOT_AVAILABLE`); collection; the store-credit choice; BL-097; CR-054 point 1; returns of part of a crate; all of NTF (the on-the-way message from `del.DeliveryOnTheWay`, already in the outbox); CR-039; the reused-photograph match on the proof (B11 continued 4, or B12 if it does not); the UAT dry runs.
- **Seed:** no run is seeded (a run lives for a day; the seeded farm's deliveries are made by the tests' dispatches). B11 continued 4 may seed one with its slots.
- **Backlog:** BL-099 (more than one run a day for a driver).

## Questions for the owner

1. **One run a day (A-347 (a)).** A driver has one run per day, its stops fixed once it starts. Agreed, or should a driver have a morning and an afternoon run (BL-099)?
2. **The Manager and the Owner in the drivers' list (A-347 (g)).** They may be given a delivery (A-337 (d)), so they are listed. Agreed, or should the list show only the Driver role?

## Notes for the frontend track

- **2.32.0:** the dispatch screen lists drivers with `listDrivers`; the run screens use `createRoute`, `reorderRouteStops` (with the `version` read), `startRoute` and `completeRoute`, showing `stopsOnVan`, `codHeldPesewas` and `handIns` as answered, never computed; a refused close names each stop still aboard (`GOODS_ON_VAN`, `field` `/stops/{deliveryId}`) and `CASH_NOT_HANDED_IN`. The driver's phone reads `getMyRoute` (404 for no run), sends `markOnTheWay` and `recordFailedDelivery` (the attempt's `id` from the device); a stop of a run not started answers `ROUTE_NOT_STARTED`. `RouteStopDelivery.slotStartsAt` and `slotEndsAt` may be null.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 4 (`b11c4-returns-dispatch-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c3-driver-run-failures-returns-notifications.md,
B11 continued 3, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
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
Then execute B11 continued 4 only, on branch b11c4-returns-dispatch-notifications. B11 built picking and packing (2.25.0);
B11 continued built dispatch of a whole delivery order and the proof with the cash held by the driver (2.27.0, ADR-0092);
B11 continued 2 built the driver's cash handed in at a till shift (`handInDriverCash`, the variance report, 2.31.0,
A-345); B11 continued 3 built the driver's run (`createRoute` to `completeRoute`, `getMyRoute` 404 with no run,
`listDrivers`, `markOnTheWay`, `recordFailedDelivery`; a run closed only when every stop is DELIVERED or RETURNED and
no collection on it is held, the hand-ins recorded against it by the database; 2.32.0, A-347): build on them, never
again. The rest, in this order:
1. The van's two other ways out and the rest of delivery and dispatch. `returnDeliveryToStock` (the Manager, a FAILED
   delivery: from the vehicle to the returns hold, not sellable until inspected; the order RETURNED; the document
   credited for what came back and what was paid refunded or kept as store credit, as applicable, through BIL's and
   PAY's existing paths and their approvals); a write-off from the van with a reason (goods spoiled, damaged or
   unaccounted for, through INV's adjustment path and its approval; the delivery leaves the van; `leftTheVan` and
   `ck_route_closed` take it), anything unaccounted for on the driver variance report as its own line (the owner,
   2026-11-23: test the refusal to close with goods aboard, each of the three ways out, and the variance line; a write-off
   never takes the van below zero); assignDelivery and reassignment, audited (FR-DEL-004; a delivery on a live run keeps
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
Stop at the gate and write docs/sessions/B11c4-returns-dispatch-notifications.md.
```
