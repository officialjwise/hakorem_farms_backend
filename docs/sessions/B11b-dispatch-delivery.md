# B11 continued: dispatch, delivery and the cash on delivery (lane B), split before the driver's run

Date: 2026-11-23 · Branch `b11b-dispatch-delivery`, from `main` at `d37ae55` (#124, lane A's B09b continued 4b) · Status: **the first part's gate passed locally; the phase split (A-341); CI below.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-337 | **Dispatch as built (ADR-0092).** A `PACKED` delivery order goes whole, every packed pick list on one dispatch, with a driver of the branch and a live vehicle of it, both required. The order's reservations end and each pick moves `TRANSFER_INTERNAL` from its pick location onto the vehicle (the trigger refuses a location below zero or another's promised stock, nothing written); at the proof each pick is issued `SALE_ISSUE` from the vehicle (`ord.fulfilment_issue`). ADR-0091's "consumes the reservations" is realised as ending them and moving the picks in one serializable transaction, since a pick may differ from its reservation. Grants: Manager and Owner dispatch, read and assign deliveries; the Driver reads and records only its own, records the proof, uploads a proof photograph or signature only and reads reason codes; the Owner and the Manager hold the Driver's too (FR-IAM-022: a Manager grants the Driver role); the Storekeeper does not dispatch. | Owner |
| A-338 | **The document and the money at dispatch.** An `INVOICE` for a customer account, a `RECEIPT` for a guest (BIL issues no invoice without a customer), no due date; an order on account (`CREDIT`) is refused `CREDIT_DISPATCH_NOT_AVAILABLE` until B11 continued 2 reads the customer's terms from WHL. The delivery fee is its own line, once. Deposits allocated oldest first (`Payments.allocateIn`); what they hold beyond the document is asked back (`WEIGHED_BELOW_PAID`, waiting for approval; the checkout's store-credit choice is B11 continued 2's); the rest is the cash due, fixed on the delivery. | Owner |
| A-339 | **Cash on delivery against the driver.** A PAY cash payment held by the driver (`driver_id`, never a register or shift), allocated to the delivery's document (`DriverCash.collectIn`); no `pay.PaymentCleared`; DEL's ◆ `del.CodCollected` posts Dr 1020 against the driver, Cr 1200 (ADR-0003's row). The hand-in at a till (CR-057) is B11 continued 2's. PAY's views still show `driver: null` (BL-096). | Owner |
| A-340 | **The proof of delivery.** A signature or a photograph the driver uploaded for that use and the scan has not held (a PENDING scan accepted, as for a death photograph); never more cash than due; less only with a `COD_VARIANCE` reason and note; the proof's id the device's (a resend answers and records nothing; another delivery's id `ID_IN_USE`); not captured before dispatch. The order is DELIVERED, then COMPLETED in the same transaction when nothing is outstanding; one still owing stays DELIVERED (BL-097). | Owner |
| A-341 | **B11 continued split at its first sub-domain boundary.** Everything after the proof moves to **B11 continued 2** (`b11c-driver-run-returns-notifications`), inserted before B12. | Parent session |

**No ADR conflict.** ADR-0003's matrix row `del.CodCollected` (Dr 1020, Cr 1200) is followed exactly; ADR-0021's dispatch half is followed (document on the weighed quantity, deposit allocated, overpayment refunded to the original method, balance collected on delivery), except that the store-credit choice is not yet read (A-338 (c), deferred with its reason, not contradicted); ADR-0091's dispatch half is followed (A-337 (b) records how the reservations end); ADR-0077 is untouched (no till cash moves in this part); ADR-0081: dispatch takes no location below zero (tested); ADR-0067: no `now()` in business SQL (the application clock writes every business time; `created_at` defaults and the test file's direct SQL inserts are the exceptions). ADR-0092 is new (Proposed). **Lane A's files were not touched:** `sale-posting.ts` and its types, PAY's till-cash rules (`Payments.writeIn`, `Refunds.markPaid`, `Receipts.reverseIn`), INV's negative-stock functions and all of POS are unchanged. The one POS operation the parent session allowed (CR-057's hand-in) is unused here and passes to B11 continued 2.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued, lane B (`b11b-dispatch-delivery`, from `main`), planned to split at the first sub-domain boundary the context would not get past.
2. **Scope built:** dispatch with the document on the weighed quantity, the deposit, the refund of a lighter total and the cash due fixed (FR-ORD-011, FR-BIL-005, ADR-0021); the delivery made at dispatch (FR-DEL-003); the driver's own reads and the ownership rule (FR-DEL-004); the proof of delivery with the cash collected against the driver (FR-DEL-008, FR-DEL-009); CR-055 point 1; CR-056 items 1 and 3.
3. **Gate of this part:** cash on delivery lands against the driver, with the amount due fixed at dispatch from the document on the weighed quantity, and the customer's dispatch message is written to the outbox in the dispatch's transaction. **Passed** (below). Sending the message (NTF) and the hand-in are B11 continued 2's.

## Contract changes

**2.27.0, minor, LOUD on three behaviours** (on top of lane A's 2.26.0; Redocly clean, no warnings; `contract:generate`: 523 operations from code, 134 planned, 657 in all).
- **Into code:** `dispatchFulfilment`, `listDeliveries`, `getDelivery`, `getMyDelivery`, `recordProofOfDelivery`, each described in full. **New error code** `DELIVERY_INVALID`.
- **Request (optional):** `listDeliveries?orderId`; `ProofOfDeliveryCreate.codVarianceReasonCode`, `codVarianceNote`; `listReasonCodes?domain` gains `COD_VARIANCE`.
- **Response (always sent):** `DeliveryContentsLine.orderLineId` (CR-055 point 1); `ProofOfDelivery.codVarianceReasonCode`, `codVarianceNote`.
- **LOUD:** `SalesOrder.delivery` is filled once dispatched (always null before); `uploadFile` takes `PROOF_OF_DELIVERY` and `SIGNATURE` from a holder of `platform.file.upload.proof` alone; `listReasonCodes` lists the new reasons.
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| Schema | 0299 (platform lookup: the `DELIVERY` document type, `DLN-…`); 0300 and 0301 (IAM: seven permissions and their grants); 0302 (MDM: `WEIGHED_BELOW_PAID`, the `COD_VARIANCE` domain, the published `mdm.reason_code_domain`); 0303 (DEL: `del.delivery` with `ck_delivery_assigned`, `ck_delivery_cod`, `ck_delivery_delivered`, `ck_delivery_transition`, the deferred `ck_delivery_proof`, `uq_delivery_order`; `del.delivery_attempt` and `del.proof_of_delivery`, LEDGER, with `ck_proof_evidence`, `ck_proof_payment`, `ck_proof_position`, `ck_proof_variance`); 0304 (ORD: `ord.fulfilment_issue`, LEDGER); 0305 (FIN: `del.CodCollected`, `uq_journal_entry_cod_collected`). Each has a tested rollback (the archive-link rollback walk). |
| DEL | Domain `deliveries.ts` (`judgeProof`, `codVariance`, `takesProof`), `numbering.ts`; `Deliveries` (`scheduleIn`, `assertAssignableIn`, `ofOrderIn`, `summariesOfOrdersIn`, `list`, `get`, `getMine`, `recordProof`); `PgDeliveryStore`; `DeliveriesController`, `DriverDeliveriesController`; events `del.DeliveryCompleted`, ◆ `del.CodCollected`. DEL now imports PAY and platform's `FileStore`. |
| ORD | Domain `dispatch.ts` (`planSettlement`); `Dispatches` (`dispatch`, `deliveredIn` on `del.DeliveryCompleted`); the store's dispatch writes; `Fulfilments.viewIn`; a dispatched pick list still shows its weighed total; `SalesOrder.delivery`. Events `ord.OrderDispatched`, `ord.OrderDelivered`. ORD now imports DEL. |
| PAY, FIN, DOC, MDM | `Payments.allocateIn`; `DriverCash.collectIn` (`NewPayment.driverId`); FIN's `del.CodCollected` translator; DOC's `platform.file.upload.proof`; MDM's `COD_VARIANCE` domain in the query enum. All additive. |
| Docs | ADR-0092 (indexed); A-337 to A-341; abuse cases 43 and 44; BL-096, BL-097; `data-model/del.md` and `ord.md`; the DEL, ORD and PAY cards and the published functions; `API.md` (ORD, DEL, `DELIVERY_INVALID`); the 2.27.0 changelog entry; the openers (B11 continued marked split, **B11 continued 2** inserted before B12, the reference table and the lane B order); ADR-0026 Amendments. |

## The gate, proved by running it

**`test/integration/ord/dispatch-delivery.integration.spec.ts` (19 tests), over the seeded farm, against the local Paystack fake.** Hand figures: beef MEAT-0005 online 3,213 a kg, 15 kg packs.
- **Order A, two packs paid ahead by mobile money at 96,390 (3,213 x 30.000):** picked 15.200 and 15.600 kg, 30.800 kg at **98,960** (98,960.4 half-up once). Every role but the Manager (and the Owner) 403, another branch's Manager 403, no session 401, nothing written; no driver or vehicle `DRIVER_REQUIRED` and `VEHICLE_REQUIRED`; the Cashier as driver `NOT_A_DRIVER`; the cold room as vehicle `NOT_A_VEHICLE`. Dispatched: the receipt `RCP-…` (a guest) on **30.800 KG**, gross 98,960; **96,390 allocated** (Dr 2200, Cr 1200 against the walk-in party); **2,570 due on delivery**; `PART_PAID`; the delivery `DLN-…` ASSIGNED to Kwabena Asare and VAN1 with its contents line naming the order line; each pack moved COLD to VAN1 (15.200 and 15.600), the van holding 30.800 and the cold room 14.200, the order's reservations ended; one `ord.OrderDispatched` (98,960, 96,390, 2,570, the weights); a replay by key the same answer and nothing more; another key `INVALID_STATE_TRANSITION`. The trial balance is zero.
- **The driver's own:** the driver reads the delivery with 2,570 to collect; another driver, the Manager, the Storekeeper and the Cashier 403 by that door; an unknown id 404; the Manager reads it at `getDelivery`, the Driver and others 403 there; another branch's list empty. The driver uploads a proof photograph and a signature; `EVIDENCE`, `PRODUCT_IMAGE`, `SUPPLIER_INVOICE` and `IMPORT` 403. Refused proofs: a name only `EVIDENCE_REQUIRED`; another driver's photograph `FILE_NOT_YOURS`; an unknown file `FILE_UNKNOWN`; 2,571 `ABOVE_DUE`; 2,000 with no reason `REASON_REQUIRED`, without its note `NOTE_REQUIRED`, with a REFUND reason `REASON_NOT_ALLOWED`; another driver 403. The cash due of the assigned delivery cannot be changed, as the app or as the owner role (HK004).
- **Cash on delivery lands against the driver:** **2,000 collected of 2,570** with `CUSTOMER_PAID_SHORT` and its note: DELIVERED, one attempt, the order DELIVERED with 570 outstanding, `del.DeliveryCompleted` short **570**; the payment CASH, `driver_id` the driver, no register and no shift, 2,000 allocated; **`del.CodCollected` Dr 1020 2,000 against Kwabena Asare, Cr 1200 2,000**; no `pay.PaymentCleared`; the packs issued VAN1 to the customer, once each, the van empty, each line naming its issue. The same proof sent again 200, one payment, one journal, one event.
- **Order B, goat meat paid ahead at its 15.000 kg estimate, picked 14.000 kg:** the document at 14 x its price (plus the fee when the zone charges one, as its own line), **one kilogram's price asked back** (`WEIGHED_BELOW_PAID`, `PENDING_APPROVAL`), nothing due; a reason with nothing short `REASON_NOT_NEEDED`; order A's proof id `ID_IN_USE`; delivered with no cash, **COMPLETED**, no payment, no journal.
- **Order C, a crate of eggs on cash on delivery:** with the shop down to 20 eggs after packing (the promise ended and a loss posted by hand), dispatch is **`INSUFFICIENT_STOCK` and nothing is written** (documents, deliveries, movements and outbox rows counted); with the eggs back it dispatches; the driver collects the crate's price exactly: COMPLETED and `PAID`, Dr 1020, Cr 1200 at that price, one SALE_ISSUE of 30 eggs from the van.
- **The database:** a delivered delivery's cash due HK004; a proof deleted 42501, changed HK001; an attempt changed HK001; a proof above its due HK010; a proof with no evidence 23514; cash collected with no payment 23514; a second proof 23505; a delivered delivery moved back HK004.

**Unit:** `ord/domain/dispatch.spec.ts` (9: FR-ORD-011's 84,000 of 86,240 leaving 2,240; a lighter total refunded; deposits oldest first; every pesewa kept over many totals; the largest amount) and `del/domain/deliveries.spec.ts` (11: FR-DEL-009's 2,000 of 2,240 flagging 240; above due; the reasons; the files), `numbering.spec.ts`; both domain specs were run red (no module) before their code.

**Contract:** `test/contract/b11/dispatch-delivery.contract.spec.ts` (a dispatch, the page, the delivery, the driver's view, a refused proof, the proof, the order against 2.27.0). **Walks extended:** the authorisation walk (five operations), the rollback walk (0299 to 0305), the operation counts, the request-schema check (`DispatchRecordBody`, `ProofOfDeliveryCreate`), the seeded role matrix (B11 continued's grants named). The identifier walk covers the new operations by their contract without change.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | A deposit applied whole, beyond the document (`planSettlement`) | red: 4 (unit) |
| M2 | No refusal of cash above the amount due (`judgeProof`) | red: 2 (unit) |
| M3 | The ownership rule bound to the caller instead of the delivery's driver | red: 6 |
| M4 | Dispatch not authorised at the pick list's branch (both checks) | red: 11 |
| M4a | Only the in-transaction branch check removed | green: the read-committed check before it still refuses (defence in depth, both kept) |
| M5 | The delivery fee line left off the document | red: 2 |
| M6 | No sale issue from the vehicle at delivery | red: 4 |
| M7 | The driver's cash not settled on the document (BIL) | red: 1 |
| M8 | The guard forgetting the cash due among the fixed columns | **green at first**, then red: 6 after the test was strengthened (its own commit) |
| M9 | Dispatch not ending the order's reservations | red: 11 |

## Test first, as it honestly happened

- **Domain first, red first:** `dispatch.spec.ts` and `deliveries.spec.ts` were written and run red (the modules did not exist) before their code.
- **The integration spec was written after the application code**, against the gate's list, then run. Its first runs failed on my mistakes, each fixed in the code or the test, never by weakening an expectation of the gate: the DEL module's missing `@Inject` (boot); the Owner lacking the Driver's grants (FR-IAM-022, the seed refused the role: the grant was added); `ord.fulfilment` and `del.delivery` updates without `version = version + 1` (the version trigger refused them); a dispatched pick list losing its weighed total (a filter on OPEN lines; FULFILLED and PARTIAL now count); the vehicle checked only after the stock moved (now asked first, `assertAssignableIn`); a second beef order impossible after the first took the cold room's beef (order B became goat meat); the virtual location's code (`V-CUSTOMER`); the proof guard firing before the evidence check in a direct insert (the test now inserts the due amount). Then all 19 passed.
- **A survived mutation, M8,** showed the cash-due test could not fail on its own (it ran on a delivered delivery, refused first as frozen); the test was strengthened in its own commit (`test(del)`), red with the mutation and green without.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, applied to the new paths)

- **Authorisation:** every handler authorises in the application layer, deny by default: dispatch at the pick list's branch (before and inside the transaction); deliveries at their branch; the driver's two operations by the ownership rule with no override (another driver, the Manager or an Owner not assigned is 403; an unassigned delivery is nobody's). Wrong roles, another branch and another driver are refused and mutation-checked.
- **Uploads:** the Driver's only upload is a `PROOF_OF_DELIVERY` photograph or a `SIGNATURE` (`platform.file.upload.proof`); the type is sniffed from the bytes and capped (images, 5 MB) by DOC as for every upload; no listing of files exists; a file is read by its id and its five-minute signed link goes only to its uploader or a holder of `platform.file.read.any`; a proof names only a file of its own use the driver uploaded and the scan has not held (INFECTED and FAILED refused).
- **Money:** integer pesewas; the settlement keeps every pesewa (allocated plus due is the document; allocated plus refunded is what was paid); the cash due fixed by the server and held by the database; never collected above due; the cash posted to 1020 against the driver.
- **New abuse paths:** abuse case 43 (a driver keeps cash: the short collection with its reason on `del.DeliveryCompleted`, 1020 by driver, `DRIVER_VARIANCE` for B12) and 44 (a false delivery: only the assigned driver, evidence of their own, insert-only proof and attempt; `DELIVERY_PROOF_REVIEW` for B12). Both reach the daily exception report's sources through the events published here.
- **Data:** the new tables are DC-13 and DC-22, CONFIDENTIAL: a recipient's name, phone, address, a photograph and a position; the driver reads only their own.
- **Not applicable here:** payments by provider, webhooks, exports.

## UAT dry runs (scenario 1 steps 1.11 to 1.16, scenario 5 case 6, scenario 2 from 2.12), by reading the built behaviour against the script

- **1.11, 1.12:** as built (B7 and B11).
- **1.13, difference:** a guest's order gets a **receipt** `RCP-…`, not an invoice `INV-…` (BIL issues no invoice without a customer, A-338 (a)); and the driver and van are named **at dispatch**, not afterwards (`assignDelivery` is B11 continued 2's). The cash to collect is fixed at dispatch and cannot be changed: as built.
- **1.14:** the driver sees only their own delivery by id (built); "On the way", the message and the driver's route list are B11 continued 2's.
- **1.15:** as built online: DELIVERED with the time and position, collected against due; the order shows **COMPLETED** and `PAID` (the script says "Delivered and Paid"; difference in the status word only). The offline proof is B11 continued 2's.
- **1.16 and scenario 5 case 6:** the hand-in and the reconciliation are B11 continued 2's. **Difference to settle there:** the UAT's ledger table books the driver's 696.00 into the safe (1010, ADR-0003's `del.DriverCashRemitted`), while the owner's rule of 2026-11-16 (A-212 (a), CR-057) has it handed in at a till shift (1000); B11 continued 2 follows the owner's rule and amends the script.
- **Scenario 2 from 2.12:** not run: an order on account, a partial dispatch and the fee once are B11 continued 2's (A-338 (a), A-331 (b)).

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-055:** point 1 built (`Delivery.contents[].orderLineId`); points 2 and 3 (a part delivery) are B11 continued 2's, in its opener.
- **CR-056:** items 1 and 3 built (A-337), with the Driver's upload limited to proof photographs and signatures (`platform.file.upload.proof`, a narrower permission than the `platform.file.upload` the request named, which would open every other use); `del.route.read` and `del.route.manage` and item 4 (the drivers' list) come with routes in B11 continued 2; item 2's Storekeeper `ord.order.read` stays **declined** (A-335, open with the owner).
- **CR-057:** points 1 to 3 are B11 continued 2's (the hand-in, `getMyRoute` with no run, a DUPLICATE's first outcome), with the parent session's leave for the one POS operation.
- **CR-054:** point 1 (cracked eggs on the pick) is B11 continued 2's.
- **CR-053:** built in B11. **CR-058:** done in PR #117 (A-323).
- **CR-059 to CR-062:** RPT and B12's; **larger, named for the parent session to schedule with B12**.
- **CR-050 part 1, CR-051, CR-052:** lane A's POS. Older requests are answered in their phases.

## Tests (this machine)

Run on commit `2213929` (the code of the final head; the commits above it change only this report), with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **3,935 passed, 329 files, none skipped, exit 0** (955 s). Coverage, whole: statements 94.02, branches 83.62, functions 97.84, lines 97.06 (each gate 80). **Every one of the 52 full-coverage gates holds at 100 percent**, among them `ord/domain/**` (with the new `dispatch.ts`); the new `del/domain/deliveries.ts` and `numbering.ts` are also at 100 on all four measures, though DEL's domain has no gate of its own |
| Unit alone | 1,888 passed, 161 files |
| Contract (`pnpm test:contract`) | 137 passed, 55 files, after the counts and the request-schema check were given the new operations |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (`contract:generate` unchanged: 523 operations from code, 134 planned) |

## Deferred

To **B11 continued 2** (its opener): routes and the drivers' list, assignment and reassignment, on the way, failures and returns to stock, rescheduling and slot booking with capacity and cut-offs, CR-055's part delivery, the driver's offline sync, the cash summary and reconciliation, CR-057's hand-in at a till, partial dispatch and backorders with the fee once (A-331 (b)), an order on account (due date from WHL), collection, the store-credit choice for a lighter total, CR-054 point 1, returns of part of a crate, all of NTF (the messages from `ord.OrderDispatched` and `ord.OrderDelivered` onward, the receipt and tracking SMS, the document sends, the death report's return, abandoned carts), CR-039 at the shop and the UAT dry runs. Backlog: BL-096 (PAY's `Payment.driver`), BL-097 (completing a delivered order once later paid).

## Questions for the owner

1. **A guest's delivery gets a receipt, not an invoice (A-338 (a)).** Agreed, or should a guest be given a customer record at checkout so dispatch can invoice?
2. **The driver and van are named at dispatch (A-337 (a)), not assigned later.** Agreed for the first version?
3. **A driver never collects more than is due (A-340 (b)).** Agreed (a customer who pays more is given change, never a credit by the driver)?
4. **The Owner and the Manager hold the Driver's permissions (FR-IAM-022: they grant the Driver role), so either can be assigned a delivery.** Acceptable?

## Notes for the frontend track

- **2.27.0:** dispatch is `dispatchFulfilment` with `driverId` and `vehicleLocationId` (both needed); the order page reads `SalesOrder.delivery`; the back office lists deliveries by `orderId`; the driver's stop reads `getMyDelivery` and records `recordProofOfDelivery` with a photograph or signature uploaded first as `PROOF_OF_DELIVERY` or `SIGNATURE` (the Driver's only upload), the cash collected never above `codDuePesewas`, and less with a `COD_VARIANCE` reason (`listReasonCodes?domain=COD_VARIANCE`) and its note; each contents line names its `orderLineId`. `getMyRoute`, on the way, failures, the sync and the cash hand-in are not built yet.

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 2, copied from `docs/prompts/session-openers.md` (this phase inserted it).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11b-dispatch-delivery.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0091 and ADR-0092 (dispatch
loads the vehicle; the driver's cash is a payment held by the driver), and the abuse cases 6, 43 and 44 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 2 only, on branch b11c-driver-run-returns-notifications. B11 built picking and packing (2.25.0,
A-332 to A-336); B11 continued built dispatch of a whole delivery order (the document on the weighed quantity, the
deposits allocated, a lighter total refunded, the cash due fixed, the goods onto the vehicle), the delivery, the driver's
own reads and the proof with the cash collected held by the driver on 1020 (2.27.0, A-337 to A-341, ADR-0092): build on
them, never again. The rest, in this order:
1. The driver's run and cash. Routes (createRoute, getRoute, listRoutes, reorderRouteStops, startRoute, getMyRoute; CR-057
   point 2, what a driver with no run gets), the drivers' list for dispatch (CR-056 item 4) and `del.route.*` for the
   Manager and the Owner; assignDelivery and reassignment, audited (FR-DEL-004); markOnTheWay; recordFailedDelivery,
   returnDeliveryToStock (from the vehicle to the returns hold, with the credit note and refund as applicable),
   rescheduleDelivery and cancelDelivery; delivery slot booking against capacity under a row lock, zone cut-offs and
   rescheduling (FR-DEL-001 to FR-DEL-003; the slot table and generation exist from B7, ADR-0026); CR-055, a part
   delivery (`ProofOfDeliveryCreate.lines` and `returnedReasonCode`: the rest back to stock or kept for a reattempt,
   the document credited for what came back, the cash due fixed again); the driver's offline sync (syncDriverEvents,
   idempotent by client id, CR-057 point 3: a DUPLICATE answers the first outcome); the driver's cash summary and the
   driver cash reconciliation by someone else (FR-DEL-010, 6900 for a variance, `DRIVER_VARIANCE` for B12); CR-057, the
   hand-in at a till shift: the parent session gives leave for one additive POS operation and its tests, which takes
   the cash only through the existing deciding function (tillTakesCash, ADR-0077 with the owner's late-entry amendment)
   onto the receiving cashier's own open shift, never a second cash path, each collection (a `pay.payment` held by the
   driver) handed in exactly once, its cash counted at that shift's close (A-212 (a)); test it with exact pesewas,
   including a short hand-in. Lane A's payInvoiceAtTill (#124, A-285 (g)) is the nearest pattern: reuse its shift check,
   never copy it. PAY's `Payment.driver` (BL-096). Partial fulfilment and backorders (FR-ORD-012) with the delivery fee
   once, on the first dispatch, never again (UAT scenario 2's rule, A-331 (b), steps 2.12 and 2.13, test with exact
   pesewas); an order on account dispatched with its due date from the customer's terms (WHL, through a port: ORD sits
   below WHL; A-338 (a)); collectFulfilment (a collection order handed over and paid at the till); the checkout's
   store-credit choice for a lighter total (ADR-0021, A-338 (c)); a delivered order completed once later settled
   (BL-097); cracked eggs written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
2. Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
   paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
   refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the
   egg cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per
   crate) less round(paid x previously returned / per crate), so the pieces always add up. Tests by SQL: a GH₵55.00 crate
   (5,500 pesewas) with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one
   egg at a time, all 30, refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding
   each egg on its own, turns a test red. Lane A's B09b continued 2 adds to createReturn's description that a line is
   returned in its sold unit; extend it to a part of a crate returned as single eggs.
3. Notifications (NTF): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers, preferences, opt-out,
   quiet hours, the message log and retry: the customer's messages from `ord.OrderDispatched` (one, with the weights and
   the final total, FR-ORD-011), the on-the-way and delivered messages (FR-DEL-012, once per event and recipient),
   abandoned-cart messaging (ADR-0026), the death report sent back by the malware scan (B06r, A-175: liv.MortalityReturned
   names the reporter and the reason), the document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202
   through the outbox, a bil.reprint_log row with the channel, the archived bytes or a lasting link, never a new
   document; the remittance advice from pur.SupplierRemittanceReady, once per payment; a send reaches only the document's
   own customer or supplier and a failed send is retried without a second archive row), CR-033 point 3 (the receipt SMS
   once when a counter sale with customerPhone syncs, with a fresh server-made token for a sale whose till token was
   refused, ADR-0074; the refused till token still opens nothing), and the guest's SMS tracking link with its own long
   random token (a guessed token or the order's id answers 404). CR-039 at the shop (the crate and the single egg, each
   at its own price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference. CR-056's Storekeeper `ord.order.read` stays withheld until the owner answers A-335.
Stop at the gate and write docs/sessions/B11c-driver-run-returns-notifications.md.
```
