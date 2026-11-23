# B11 continued 6: a dispatched delivery cancelled, a part delivery credited at the door, the driver's queue and the till's list of drivers holding cash (lane B), split before the dispatch's money

Date: 2026-11-23 · Branch `b11c6-dispatch-returns-notifications`, from `main` at `85ca8e9` (#133, B11 continued 5) · Status: **phase split (A-365): the cancellation, the part delivery, the driver's queue and CR-063 built to their own gate, passed locally; CI below. The rest is B11 continued 7.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-364 (a) | **Cancelling a dispatched delivery** (`cancelDelivery`, `del.delivery.assign`): only one still waiting on the van (`SCHEDULED` or `ASSIGNED`) on no planned or started run (`ON_A_RUN`); a `FAILED` one goes back through `returnDeliveryToStock`, one on its way is the driver's. FR-ORD-014 allows no cancel after dispatch but the delivery return, and the order machine has no `DISPATCHED` to `CANCELLED`, so the cancellation **is** the delivery return along the machine's own edges: the delivery `CANCELLED` with a `CANCELLATION` reason (migration 0327), the goods into a returns hold (not sellable until inspected, though the van never left), the order `DISPATCHED` to `DELIVERY_FAILED` to `RETURNED` with the cancellation named on each history row, the whole document credited and the refund asked as a van return's. **No new order edge.** The order stays `RETURNED` (BL-112). | Owner |
| A-364 (b) | **A part delivery** (CR-055, ADR-0093, proposed): `lines` say what was kept of each line in its unit; a weighed line kept or returned whole (BL-113); nothing kept is a failed attempt; a short line needs a `DELIVERY_FAILURE` reason and its note where asked (`returnedNote`, new). What was kept is issued, **the rest moves into the returns hold at once** (keeping it on the van until checked in is BL-111). BIL prices the credit at the door; the driver collects at most the cash due less it, never below zero; **the cash due itself never changes** (ADR-0092 stands). The credit note goes through `CREDIT_NOTE` **with the driver as its maker**; a paid-ahead customer is refunded what they did not keep once it is issued. The order is `DELIVERED` and completes only when settled (BL-097, B11 continued 7). | Owner |
| A-364 (c) | **The driver's queue** (`syncDriverEvents`): each record in its own transaction by the online rules, the caller's own deliveries only; exactly once by its client id, a UUIDv7 (`CLIENT_ID_NOT_V7`); a resend answers `DUPLICATE` with `firstOutcome` and the first `reason`, derived from what was stored; a refusal `REJECTED` with its codes, nothing written; another delivery's id `ID_IN_USE`. No clock-window check beyond the proof's own rules. | Owner |
| A-364 (d) | **CR-063** (`listShiftDriverCashHolders`, POS, additive, with the parent session's leave): the hand-in's own shift check; each driver holding a collection at the branch and how many, never an amount; the calling cashier is never listed. | Owner |
| A-365 | **The split.** Built the delivery's end of the opener's first sub-domain (CR-063, `cancelDelivery`, CR-055, `syncDriverEvents`) to its own gate, and stopped. **B11 continued 7** (`b11c7-dispatch-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds the dispatch's money (the checkout's slot, BL-096, partial dispatch and backorders with the fee once and the extra delivery's fee line, credit-terms dispatch, collection, the store-credit choice, BL-097, CR-054 point 1), then returns of part of a crate, then notifications. | Parent session |

**For the parent session to schedule:** everything in B11 continued 7's opener; it is still large (the partial dispatch and backorders alone change "one live delivery per order" into a sequence of deliveries) and should expect to split again at its sub-domain boundaries. No contract request is left without an owner.

**No ADR conflict, and no stop.** ADR-0092 is kept: the delivery's cash due never changes; a part delivery's credit is set beside it (ADR-0093, proposed). FR-ORD-014 and the order machine are kept: no `DISPATCHED` to `CANCELLED`. ADR-0035: every new handler authorises in the application layer (the delivery's branch and, for the driver, ownership; the till's own cashier for CR-063). ADR-0067: no `now()` in the new business SQL (the two new triggers read no clock). **Shared modules, additive only:** POS gains one function and one route (CR-063, the leave); BIL gains `requestCreditIn`; no existing function of POS, PAY, INV, BIL, IAM or FIN changed. DEL now imports BIL (layer 6, below DEL) for the read-only credit preview.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 6, lane B (`b11c6-dispatch-returns-notifications`, from `main` 85ca8e9).
2. **Scope:** the opener's first sub-domain (the rest of dispatch) with CR-063 first, then returns of part of a crate and notifications, splitting at a sub-domain boundary when the context will not reach the next gate.
3. **Gate (this part):** a dispatched delivery is cancelled and a part delivery credits what came back, never below zero, the cash to the pesewa; the driver's queue applies each record once; every new read and write refuses the wrong role. **Passed** (below). The rest of the opener's gate (the fee once and the extra fee line, credit-terms dispatch, part of a crate refunded pro rata, the customer messages) is B11 continued 7's.

## Contract changes

**2.35.0, minor, LOUD on four answer fields** (on top of 2.34.0; Redocly clean, no warnings; `contract:generate`: 546 operations from code, 118 planned, 664 in all).
- **Into code with their planned paths:** `cancelDelivery` (`POST /deliveries/{id}/cancel`, `del.delivery.assign`; its request is now `DeliveryCancel`, the planned `ReasonCodeRequest` never served) and `syncDriverEvents` (`POST /driver/sync`, `del.proof.create`).
- **New:** `listShiftDriverCashHolders` (POS, `GET /shifts/{id}/driver-cash-holders`, `pos.sale.create`; `DriverCashHolder`, `DriverCashHolderList`).
- **New optional request fields:** `ProofOfDeliveryCreate.lines` (`ProofOfDeliveryLine`), `returnedReasonCode`, `returnedNote`.
- **LOUD:** `ProofOfDelivery.lines`, `returnedReasonCode`, `returnedNote`, `returnedCreditPesewas` and `DriverSyncItem.firstOutcome` are always sent.
- New refusals as listed in the changelog. No new permission. No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| POS (CR-063, additive) | `TillDriverCash.holders` and `GET shifts/:id/driver-cash-holders` on `TillInvoicesController`, over the hand-in's own `OwnOpenShift` check; DEL's `DriverCashReconciliations.holdersIn` and `DriverCashStore.holders`. |
| DEL domain | `judgeCancellation` (state and run), `judgePartDelivery` (lines, weighed whole, nothing kept, the returned reason and note), `dueAtDoor`, `syncOutcomeOfProof`. |
| DEL application and interface | `Deliveries.cancelledIn`; the part delivery in `proofIn` (the credit priced through BIL's `creditPreviewIn`, the cash judged against the cash due at the door, `del.proof_line` written, the series lock of a credit note taken before BEGIN); `Deliveries.sync` with `DriverSyncController` (`POST driver/sync`); `del.DeliveryCancelled`; `del.DeliveryCompleted` gains `returnedLines`, `returnedReasonCode`, `returnedCreditPesewas`; the proof view gains its lines, reason, note and credit. DEL imports BIL. |
| ORD | `VanReturns.cancel` behind `cancelDelivery`, `judgeCancelReturn`; `VanReturns.partReturnedIn` (the credit note of what came back and its refund); `Dispatches.deliveredIn` issues only what was kept and moves the rest into the returns hold (`splitReturned`: base units by the line's own picked ratio, last picks first, `UNIT_SPLIT` otherwise). |
| BIL (additive) | `Billing.requestCreditIn` (named lines by quantity, the `CREDIT_NOTE` approval as `requestWholeCreditIn`). |
| Schema | 0327 (DEL): `cancel_reason_code`, `cancelled_at`, `ck_delivery_cancelled`. 0328 (DEL): the proof's `returned_reason_code`, `returned_note`, `returned_credit_pesewas`, `ck_proof_returned`, `ck_proof_variance` against the cash due at the door, `del.proof_line` (LEDGER) and the deferred `ck_proof_line_returned`. Both roll back (the rollback walk names them). |
| Docs | ADR-0093 (proposed) and the decision index; A-364, A-365; BL-111 to BL-113; abuse cases 51 and 52; ADR-0026 Amendments; `data-model/del.md`; the DEL, ORD, BIL and POS cards; API.md (DEL); the 2.35.0 changelog; the openers (B11 continued 6 marked built and split, B11 continued 7 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/del/van-returns.integration.spec.ts` (22 tests, over the seeded farm; 10 new) and `test/integration/del/driver-cash-hand-in.integration.spec.ts` (9 tests; 1 new and 2 extended):
- **CR-063:** the till's own cashier on its enrolled device sees `{ data: [{ driver: Kwabena Asare, collections: 2 }] }` and no amount anywhere in the answer; the Driver, the Storekeeper, Sales, the Accountant, another branch's Manager, the branch's Manager and another cashier 403; no device 401; an unknown shift 404; a malformed id 400; empty once handed in; 422 `SHIFT_NOT_OPEN` once the shift is closing.
- **Cancellation, who:** the Driver, the Storekeeper, the Cashier, Sales and another branch's Manager 403; an unknown delivery 404; a missing returns hold or an unknown field 400; nothing written (stock movements, credit notes, delivery versions by SQL).
- **Cancellation, what:** a failed delivery 422 `INVALID_STATE_TRANSITION` (`FAILED`); a stop of a planned run `ON_A_RUN`; a shelf `NOT_A_RETURNS_HOLD`; a wastage reason `REASON_NOT_ALLOWED`; an unknown reason `REASON_UNKNOWN`; store credit for a guest; nothing written. A crate on VAN1 cancelled: `CANCELLED` with `CUSTOMER_CANCELLED` and its time; one `TRANSFER_INTERNAL` of 30.000 eggs VAN1 to the returns hold, VAN1 down 30, the hold up 30; the order's last two history rows `DISPATCHED`→`DELIVERY_FAILED` (naming the cancellation) and `DELIVERY_FAILED`→`RETURNED`; the credit note drafted for the whole document, the Manager its maker; one `del.DeliveryCancelled`, one audit row; the same key answers the same, a second cancel 422, the driver can no longer fail it.
- **Never below zero:** with VAN1 emptied by a hand adjustment, cancelling a paid-ahead crate 422 `INSUFFICIENT_STOCK`, nothing written, the delivery still `ASSIGNED`; found again, cancelled, its credit note approved by the Owner, and its refund asked for exactly what was allocated, to the original method.
- **Part delivery, refusals:** another driver 403; 3.001 of 3 `ABOVE_DISPATCHED`; nothing kept `NOTHING_DELIVERED`; a short line without a reason `REASON_REQUIRED`, without the note `CUSTOMER_REFUSED` asks for `NOTE_REQUIRED`, a wastage reason `REASON_NOT_ALLOWED`, a reason with everything kept `REASON_NOT_NEEDED`; an unknown line `LINE_UNKNOWN`; `2.5` 400; nothing written.
- **Part delivery, the cash to the pesewa:** three crates, two kept: the whole cash due `ABOVE_DUE`, the cash due less one crate plus one pesewa `ABOVE_DUE`; the cash due less exactly one crate's price (the line's gross divided by 3, asserted to divide exactly) accepted; the delivery's `codDuePesewas` unchanged; the proof answering its line (3 dispatched, 2 kept), reason, note and credit; by SQL one `SALE_ISSUE` of 60.000 eggs to the customer and one `TRANSFER_INTERNAL` of 30.000 into the returns hold, VAN1 down 90; the credit note asked for exactly one crate, the driver its maker, issued on the Owner's approval; nothing refunded on cash on delivery; `del.DeliveryCompleted` naming the returned line; one `PART_DELIVERY` audit row.
- **Part delivery paid ahead:** two crates, one kept: the cash due 0, nothing collected, no variance reason; on the credit note's approval a refund of exactly one crate's price to the original method.
- **The database:** `del.proof_line` refuses an update as `hk_app` (no grant) and as admin (HK001); a line kept above dispatched 23514; a short line added to a proof with no returned reason HK010 at commit (`ck_proof_line_returned`); a cancellation without its reason and time 23514 (`ck_delivery_cancelled`), a failed delivery moved to `CANCELLED` HK004, a cancelled delivery frozen HK004.
- **The driver's queue:** the Storekeeper, the Cashier and Sales 403 on the batch; the Manager (who holds `del.proof.create`) has every record of other drivers' deliveries `REJECTED`; a malformed batch 400; nothing written. One batch: a full proof `APPLIED`; a short one `APPLIED_WITH_EXCEPTION` `COD_VARIANCE:CUSTOMER_PAID_SHORT`; another driver's delivery `REJECTED` `FORBIDDEN`; a v4 id `REJECTED` `CLIENT_ID_NOT_V7`; above due `REJECTED` `ABOVE_DUE`; a failure `APPLIED`, the rest unaffected by the refusals. Sent again: `DUPLICATE` with `firstOutcome` `APPLIED`, `APPLIED_WITH_EXCEPTION` (its reason) and `APPLIED`, nothing written; a proof id reused for another delivery `ID_IN_USE`; the other driver resending it `FORBIDDEN`.

Unit: `del/domain/deliveries.spec.ts` (+8), `del/domain/scheduling.spec.ts` (+2), `ord/domain/van-return.spec.ts` (+2), `ord/application/split-returned.spec.ts` (4, new).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The proof judged against the whole cash due (the part delivery's credit ignored) | red: 2 (the part delivery's cash to the pesewa, the paid-ahead part delivery) |
| M2 | `splitReturned` taking what came back from the first picks instead of the last | red: 2 (unit) |
| M3 | The sync's resend check removed (a resent proof answered as applied) | red: 1 (the resend's DUPLICATE and first outcome) |

## Test first, as it honestly happened

- The DEL and ORD domain rules (`judgeCancellation`, `judgeCancelReturn`, `judgePartDelivery`, `dueAtDoor`, `syncOutcomeOfProof`) were each written as unit tests and run red (no such function) before the code.
- CR-063's integration assertions were written before its code but **not run red first**; they passed on their first run. `splitReturned`'s unit spec was written after the function (its mutation M2 shows it bites).
- The integration blocks were written after the application code, against the gate's list. Their first runs failed on their own expectations or on real faults, each fixed in the code or the spec, never by loosening a rule: a cancellation with an unknown reason answered 500 (DEL wrote the delivery's reason before ORD judged it: the foreign key refused it), fixed by judging first; a draft credit note's gross reads 0 until issued (the spec now reads the approval's amount, as the older blocks do); the deferred proof check's trigger function named a field of the other table (`record "new" has no field "proof_id"`), fixed in the migration before it was committed; `CUSTOMER_REFUSED` and `CUSTOMER_PAID_SHORT` ask for a note, so the part delivery takes `returnedNote` (added) and the sync's short proof sends its note; the Manager holds `del.proof.create`, so the sync spec proves the Manager's records are each refused by ownership instead of the batch being 403.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (`cancelDelivery`), TB3 the till (CR-063), TB4 the driver's device (the part delivery, the sync), the database.
- **Identity, sessions and browser:** unchanged; `cancelDelivery` is a staff session write with CSRF and the idempotency key; `syncDriverEvents` takes CSRF and no key (each record's own client id is its key); CR-063 is a read with the device credential.
- **Authorisation:** deny by default, in the application layer. `cancelDelivery`: the Manager and the Owner only, at the delivery's branch (wrong roles and another branch tested). The part delivery and the sync: the delivery's own driver only (another driver `FORBIDDEN`, a Manager's records refused by ownership, tested); no ID is a key (an id reused for another delivery `ID_IN_USE`; another driver resending a proof by its id learns nothing). CR-063: the shift's own cashier on its enrolled device (another cashier 403, the Manager 403, no device 401, tested). The handler walk, the deny-by-default walk and the identifier walk include the three operations.
- **Input:** strict schemas, unknown fields 400, quantities as fixed decimal strings, batch sizes bounded (500 a kind, 200 lines a proof); parameterised SQL only.
- **Money and stock paths:** the driver never chooses an amount (the credit is BIL's preview at the document's own prices; the cash at the door never above the cash due less it, by the application and by `ck_proof_variance`); the cash due never changes; the credit note needs a different person's approval; a refund only once its credit note is issued, to the original method; goods move only through INV, never below zero (tested for the cancellation; the part delivery moves only what is on the van); the cancellation is the delivery return, never a new order edge.
- **Data protection and logging:** the new events carry ids, quantities, reasons and amounts, no phone or name; CR-063 answers names and counts, never an amount.
- **Webhooks, uploads, exports, rate limits:** not applicable beyond the proof's existing photograph rules; the console group as every back-office and driver call.
- **Abuse paths:** abuse case 51 (a false part delivery, or a cancellation used to move goods off the books) and 52 (an offline proof resent or another's id reused) added; their controls are in place and tested; their detection is B12's daily exception report, for which `del.DeliveryCompleted` (the returned lines, reason, credit and driver) and `del.DeliveryCancelled` are in the outbox. Residual: BL-111 (the returned goods leave the van at the door, so a false claim shows at the returns hold's count, not on the driver variance report).
- Findings: none open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need partial dispatch, credit-terms dispatch and the notifications, which are B11 continued 7's; its opener names them.

## Reused photographs

Not recorded here; B11 continued 7's opener carries it (B12's opener now says B12 must if B11 continued 6 or 7 does not).

## Contract requests (the frontend's `main` at `43acd8f`)

- **CR-063** (the till lists the drivers holding cash): **implemented** (2.35.0, with the parent session's leave), as asked: no amount, the hand-in's own shift check.
- **CR-055** (a part delivery): **implemented** for points 1 to 3 and in `DriverProofSync` (the sync takes the same proof). Two parts **declined for now, with reasons**: keeping the rest on the van for a reattempt (the rest goes into the returns hold at once, the conservative way: BL-111), and returning one pack of a weighed line of several (a weighed line is kept or returned whole: BL-113). `returnedNote` is added because three `DELIVERY_FAILURE` reasons ask for a note.
- **CR-057 point 3** (a resend's first outcome): **implemented** (`firstOutcome`, the first `reason`). Point 2 was answered in 2.32.0 (404 with no run).
- **CR-054 point 1**, **CR-039**, **CR-033 point 3**: B11 continued 7's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener. Older requests are answered in their phases. No request is left without a phase.

## Tests (this machine)

Run on commit `bcc1595` (the code of the final head; the commits above it add only documents) with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,129 passed, 345 files, none skipped, exit 0**, the whole integration suite included (`main` had not moved from `85ca8e9`, so no rebase or renumbering was needed). Coverage, whole: statements 94.13, branches 83.70, functions 97.91, lines 97.16 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them). |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.35.0 |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (546 operations from code, 118 planned) |

## Deferred

- **To B11 continued 7** (its opener): the checkout's slot carried onto the delivery (A-362 (e)); BL-096; partial dispatch and backorders with the fee once and the extra delivery's fee line (A-331 (b), approved); credit-terms dispatch (remove `CREDIT_DISPATCH_NOT_AVAILABLE`); collection; the store-credit choice; BL-097 (with a part delivery whose credit note is issued later); CR-054 point 1; returns of part of a crate; all of NTF (with the rescheduled, cancelled and part-delivered messages); CR-039; CR-033 point 3; the reused-photograph match; the UAT dry runs.
- **Backlog:** BL-111 (a part delivery's returned goods kept on the van until checked in), BL-112 (a van return's or cancellation's order closed `CANCELLED`), BL-113 (one pack of a weighed line returned at the door).
- **Seed:** nothing seeded (the tests build their deliveries over the seeded farm).

## Questions for the owner

1. **A cancelled delivery's goods (A-364 (a)).** As built they go into the returns hold to be inspected even though the van never left the yard. Agreed, or may a Manager put them straight back on the shelf they were picked from?
2. **A part delivery's returned goods (A-364 (b), ADR-0093).** As built they leave the van into the returns hold when the driver records the proof. Agreed, or should they stay on the van until a Manager checks them in (BL-111), so a missing crate lands on the driver variance report?
3. **The driver as the credit note's maker (A-364 (b)).** The credit note for what came back is asked in the driver's name and approved by someone else. Agreed?

## Notes for the frontend track

- **2.35.0:** the driver's stop offers a part delivery: per line, what the customer kept (`ProofOfDeliveryCreate.lines`, in the line's unit from `Delivery.contents`), a `DELIVERY_FAILURE` reason and its note where the reason asks; the cash to collect is the server's (`codDuePesewas` less the credit, answered as `proof.returnedCreditPesewas`): until the proof is answered, the phone cannot know the credit, so show the refusal `ABOVE_DUE` in words and let the driver correct the amount, or send the proof with the cash collected and let the server's answer stand. A weighed pack is kept or returned whole. The same proof goes through `syncDriverEvents`; a resend answers `DUPLICATE` with `firstOutcome` and the first `reason` (`COD_VARIANCE:<reason>`, `PART_DELIVERY:<reason>`). The back office offers `cancelDelivery` on a delivery waiting on the van (a returns hold, a `CANCELLATION` reason). The till's shift screen lists the drivers holding cash (`listShiftDriverCashHolders`) and can switch on the hand-in.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 7 (`b11c7-dispatch-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c6-dispatch-returns-notifications.md,
B11 continued 6, which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF, WHL and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0088 (credit control
reads exposure live), ADR-0091, ADR-0092 and ADR-0093 (dispatch loads the vehicle; the driver's cash is a payment held by
the driver; a part delivery is credited at the door), and the abuse cases 6, 43, 44, 48, 51 and 52 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 7 only, on branch b11c7-dispatch-returns-notifications. B11 built picking and packing (2.25.0);
B11 continued built dispatch of a whole delivery order and the proof with the cash held by the driver (2.27.0, ADR-0092);
B11 continued 2 built the driver's cash handed in at a till shift (2.31.0, A-345); B11 continued 3 built the driver's run
(2.32.0, A-347); B11 continued 4 built the van's two other ways out (`returnDeliveryToStock`, `writeOffDelivery`,
2.33.0, A-360); B11 continued 5 built reassignment, slot booking and the reattempt (2.34.0, A-362); B11 continued 6
built `cancelDelivery` (a delivery still on the van on no live run, its goods into the returns hold, the order through
DELIVERY_FAILED to RETURNED, the document credited), the part delivery (CR-055: `ProofOfDeliveryCreate.lines`,
`returnedReasonCode`, `returnedNote`; what was kept issued, the rest into the returns hold, the credit priced at the
door by BIL and the cash due standing, ADR-0093), `syncDriverEvents` (each record once by its client id, a resend
DUPLICATE with `firstOutcome`, CR-057 point 3) and CR-063 (`listShiftDriverCashHolders`); 2.35.0, A-364: build on them,
never again. The rest, in this order:
1. The rest of dispatch: the checkout's chosen slot carried onto the delivery at dispatch and booked (A-362 (e)); PAY's
   `Payment.driver` (BL-096). Partial fulfilment and backorders (FR-ORD-012; a short line back-ordered, a second dispatch
   of the same order, so an order may have more than one delivery over time, one live at a time) with the delivery fee
   once, on the first dispatch, never again (UAT scenario 2's rule, A-331 (b), approved by the owner 2026-11-23, steps
   2.12 and 2.13, test with exact pesewas): a later dispatch the farm makes to complete a short or part order carries no
   fee. The owner, 2026-11-23: a delivery the customer asks for as an extra is a separate, explicit fee line, added by
   staff who hold its permission (a new permission, granted by migration, its wrong-role test), never inferred from a
   second dispatch; test-first with exact pesewas, on the dispatch's document and its total; an order on account
   dispatched with its due date from the customer's terms (the owner, 2026-11-23: the credit check runs at dispatch,
   WHL's credit control through a port, ORD sitting below WHL, and the invoice is issued from the quantities actually
   dispatched; remove `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD); collectFulfilment (a collection order handed over and paid
   at the till); the checkout's store-credit choice for a lighter total (ADR-0021, A-338 (c)); a delivered order
   completed once later settled (BL-097, including a part delivery whose credit note is issued later); cracked eggs
   written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
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
   the final total, FR-ORD-011), the on-the-way (`del.DeliveryOnTheWay`, from 2.32.0), the rescheduled
   (`del.DeliveryRescheduled`, from 2.34.0, FR-DEL-003), the cancelled (`del.DeliveryCancelled`, from 2.35.0) and
   delivered messages (FR-DEL-012, once per event and recipient; `del.DeliveryCompleted` names a part delivery's returned
   lines from 2.35.0), abandoned-cart messaging (ADR-0026), the death report sent back
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
Stop at the gate and write docs/sessions/B11c7-dispatch-returns-notifications.md.
```
