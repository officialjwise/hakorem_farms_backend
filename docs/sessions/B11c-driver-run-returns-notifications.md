# B11 continued 2: the driver's cash handed in at a till shift (lane B), split before the run, returns and notifications

Date: 2026-11-23 · Branch `b11c-driver-run-returns-notifications`, from `main` at `e25e470` (#128, lane A's B09c) · Status: **phase split (A-346): the driver's cash built to its own gate, passed locally; CI below. The rest is B11 continued 3.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-345 (a) | **One door, at the till.** The hand-in is POS's `handInDriverCash` (`POST /shifts/{id}/driver-cash-hand-ins`) on the receiving cashier's own open shift from an enrolled device, under the counter's own `pos.sale.create`, through `OwnOpenShift`: the shift check `payInvoiceAtTill` had inline, moved into one class both now call (behaviour unchanged, its tests unchanged and green), then `tillTakesCash`. The planned `createDriverCashReconciliation` and `postDriverCashReconciliation` (a count outside a till, then a post) are deprecated and never built; `del.cash_reconciliation.create` is not seeded. | Owner |
| A-345 (b) | **Everything held, once.** A hand-in takes every collection the driver still holds at the shift's branch, never a chosen few, each once ever (`uq_driver_cash_handed_in_proof`). A driver with nothing held is refused (`NOTHING_HELD`), so no till takes cash in a driver's name that no delivery collected; a collection at another branch is handed in at that branch. A former driver who still holds cash may hand it in (no current driving grant is asked for). | Owner |
| A-345 (c) | **More than one hand-in a day.** The dictionary's UNIQUE (driver, date) is dropped: a driver may hand in after each run; each collection is still handed in once. | Owner |
| A-345 (d) | **The money.** What was counted is a cleared cash payment onto the shift (method `COD`, kind CASH) naming the driver (`pay.payment.received_from_driver_id`, new column), settling nothing, never allocated, linked, refunded or reversed (the database refuses each), counted at the close as any of the shift's cash; nothing is written to the till when nothing was counted. ◆ `del.DriverCashRemitted` posts Dr 1000 the till for what was counted, Cr 1020 the driver for what was expected, Dr 6900 a short, Cr 6900 an over. ADR-0003's row named 1010 (the safe) as the debit: ADR-0092 and the owner's rule (A-212 (a), CR-057) put the cash through the till first; it reaches 1010 with the till's cash at the close (recorded as ADR-0003 "Applied in B11 continued 2"). | Owner, accountant |
| A-345 (e) | **Short is short.** The variance is the driver's, on the reconciliation and on ◆ `del.DriverCashRemitted` with `abuseCases` [6, 43] when not exact, for B12's `DRIVER_VARIANCE`; it never becomes the cashier's over or short (the close counts only what was counted). | Owner |
| A-345 (f) | **Reads.** The driver reads only their own cash still held (`getMyCashSummary`: collected up to the end of `date`, at every branch, `reconciled` when nothing is held); the driver variance report (`listDriverCashReconciliations`, `getDriverCashReconciliation`, `del.cash_reconciliation.read`) is the Manager's and the Owner's only, another branch's 403 as `getDelivery` answers. | Owner |
| A-345 (g) | **Not yet recorded against the run:** routes are B11 continued 3's, which adds the run's link to its hand-in (additive). | Owner |
| A-346 | **The split.** The phase carried B11 continued's whole remainder and the owner's 2026-11-23 decisions. It built the first sub-domain the parent session named, the driver's cash (CR-057's hand-in, the driver's summary, the variance report), to its own gate, and stopped. **B11 continued 3** (`b11c3-driver-run-failures-returns-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order), builds the rest in the parent session's order: the run and its close rule with the hand-in recorded against it; failures, partial dispatch and credit-terms dispatch; returns of part of a crate; notifications. | Owner |

**For the parent session to schedule:** everything in B11 continued 3's opener (below); it is still large and should expect to split again at its sub-domain boundaries. BL-096 (`Payment.driver`) and BL-097 stay in the backlog, named in that opener. No larger contract request was taken on here.

**No ADR conflict, and no stop.** ADR-0092's decision ("the hand-in moves the driver's 1020 into a till's 1000 through the receiving cashier's own open shift, each collection once") is followed; ADR-0003's matrix row is applied through it, in the "Applied in" form earlier phases used for owner-ruled changes (B09b continued 3b, 3c). ADR-0077: the cash goes onto a till only through its open shift, judged by `tillTakesCash`, `TillShiftCheck` and `trg_payment_a_till_shift`. ADR-0067: no `now()` in the new business SQL (the reconciliation's times are the application clock's). **Lane A's files:** `sale-posting.ts`, `Payments.writeIn`'s shift check, `Refunds.markPaid`, `Receipts.reverseIn` and `tillTakesCash` are unchanged. POS changed by the one additive operation the parent session allowed, with its shift check shared, not copied, from `payInvoiceAtTill`: `till-invoices.ts` now calls `OwnOpenShift` for the same steps in the same order (a refactor with no change of behaviour; `till-invoice.integration.spec.ts` unchanged and green). PAY changed additively (one new method `DriverCash.handInIn`, one column, its guards); FIN by one new translator and its rules.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 2, lane B, the last of lane B (`b11c-driver-run-returns-notifications`, from `main` `e25e470`).
2. **Scope:** planned to split from the start (the parent session's order): first the driver's cash and run, then failures with partial and credit dispatch, then returns, then notifications; built the driver's cash (CR-057's hand-in at a till shift, the driver's summary, the driver variance report) and split before the run.
3. **Gate (this phase's part):** the driver's cash is handed in once at a till shift through the receiving cashier's own open shift, and a short hand-in shows on the driver variance report; every write refuses the wrong role. **Passed** (below). The rest of the opener's gate (the run's close rule, credit-terms dispatch, returns of part of a crate, the outbox's messages) is B11 continued 3's.

## Contract changes

**2.31.0, minor, LOUD on two planned operations** (on top of lane A's 2.30.0; Redocly clean, no warnings; `contract:generate`: 528 operations from code, 131 planned, 659 in all).
- **New operation, `handInDriverCash`** (POS, `pos.sale.create`, the till's device credential), with the new schema `DriverCashHandInCreate` and the error code `DRIVER_CASH_INVALID` (`NOTHING_HELD`, `RECEIVER_IS_DRIVER`).
- **Into code with their planned shapes:** `getMyCashSummary`, `listDriverCashReconciliations`, `getDriverCashReconciliation`; new permission `del.cash_reconciliation.read` in `x-seeded-roles` (the Owner, the Manager).
- **Response fields (always sent), `DriverCashReconciliation`:** `shiftId`, `tillPaymentId` (null when nothing was counted). A hand-in is always `POSTED`.
- **Deprecated, LOUD (planned, never built):** `createDriverCashReconciliation`, `postDriverCashReconciliation`.
- No existing field removed, retyped or made required on a request.

## Built

| Item | What |
| --- | --- |
| DEL domain | `domain/driver-cash.ts`: `handInFigures` (expected the sum of what is held, received what was counted, short or over, the direction; balanced by construction) and `judgeHandIn` (`RECEIVER_IS_DRIVER`, `NOTHING_HELD`); `endOfBusinessDate` in `numbering.ts`. |
| DEL application and interface | `DriverCashReconciliations`: `receiveIn` (POS's port, serializable, authorises nothing), `summary`, `get`, `list`; `DriverCashStore` and `PgDriverCashStore`; `DriverCashController` (`getMyCashSummary`, `listDriverCashReconciliations`, `getDriverCashReconciliation`); `DriverCashInvalidError`; ◆ `del.DriverCashRemitted` declared in `DEL_LEDGER_EVENTS`. |
| POS (the one operation, leave) | `OwnOpenShift` (the shared shift check), `TillDriverCash.handIn`, `handInDriverCash` on `TillInvoicesController`; `TillInvoicePayments` calls `OwnOpenShift`; POS imports DEL (layer 10 over 8). |
| PAY (additive) | `DriverCash.handInIn` through `Payments.writeIn` (postsAtReceipt false, no allocation); `NewPayment.receivedFromDriverId`. |
| FIN (additive) | The `del.DriverCashRemitted` translator (received against the till, expected against the driver, short and over). |
| Schema | 0312 (platform: the `DRIVER_CASH_RECONCILIATION` document type); 0313 (PAY: `received_from_driver_id`, `ck_payment_driver_hand_in`, `pay.driver_hand_in_guard()` on payment, allocation, order link, refund and reversal); 0314 (DEL: `del.driver_cash_reconciliation` DOCUMENT frozen at once, `del.driver_cash_handed_in` LEDGER, the guards and the deferred expected-sum check); 0315 (FIN: rules 294 to 297, `uq_journal_entry_driver_cash_remitted`); 0316 and 0317 (IAM: `del.cash_reconciliation.read` and its grants). Each rolls back (the archive-link rollback walk runs them all down and up). |
| Docs | A-345, A-346; ADR-0003 applied; ADR-0026 Amendments; `data-model/del.md` and `pay.md`; the DEL, PAY and POS cards; API.md (the error code, POS and DEL); the 2.31.0 changelog; abuse case 47; the openers (B11 continued 2 marked built and split, B11 continued 3 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/del/driver-cash-hand-in.integration.spec.ts` (8 tests, over the seeded farm; two crates of big eggs on cash on delivery delivered by Kwabena Asare, each crate's price C collected exactly; Adwoa Darko's own open shift on an enrolled till with a float of 20,000):
- **The driver's cash:** his summary shows exactly 2C in two collections, not reconciled; 1020 against him is 2C; another driver's summary is empty and reconciled; the Cashier, the Storekeeper, Sales and the Accountant 403; an impossible date 400.
- **Refusals, nothing written** (payments, reconciliations, handed-in rows and journal entries counted before and after): the Driver, the Storekeeper, Sales, the Accountant and another branch's Manager 403; **another cashier on Adwoa's shift 403; the Manager, not the shift's cashier, 403**; no device credential 401; an unknown shift 404; **a driver with nothing held 422 `DRIVER_CASH_INVALID` `NOTHING_HELD`**; a negative count and an unknown field 400.
- **A short count is short, with exact pesewas:** 2C - 1,000 counted: 201 `POSTED`, expected 2C, declared 2C - 1,000, **variance 1,000 `SHORT`**, received by Adwoa, the shift named; by SQL, the till payment is 2C - 1,000 on her shift and till, method `COD`, `received_from_driver_id` the driver, no customer, nothing allocated, no `pay.PaymentCleared`; **the journal is exactly Dr 1000 T2 2C - 1,000, Cr 1020 Kwabena Asare 2C, Dr 6900 1,000**; 1020 against the driver 0; 1000 against the till the float plus 2C - 1,000; trial balance 0; ◆ `del.DriverCashRemitted` carries short 1,000, over 0, `SHORT`, abuse cases [6, 43]; his summary is now empty and reconciled.
- **Exactly once:** the same key answers the first body; a second hand-in finds nothing held (422) and writes nothing; the same key with another body 409; two handed-in rows in all.
- **The driver variance report:** the Manager sees the one short hand-in with `varianceOnly`, nothing for the other driver, the same body by id, 404 for an unknown id; the Cashier, the Driver, the Storekeeper, Sales and the Accountant 403 on both reads; another branch's Manager 403 by id and an empty list.
- **An exact count:** a third crate handed in exact: `EXACT`, variance 0, the journal Dr 1000, Cr 1020 and no 6900 line.
- **The database:** an allocation of the till payment HK010; its status changed HK010; its driver cleared HK010; the reconciliation changed HK004 (frozen); a handed-in row deleted 42501, updated HK001; the same collection handed in again 23505; a reconciliation received by the driver 23514; a variance that is not the difference 23514; a reconciliation whose collections do not add up to what was expected HK010 at commit.
- **Counted at the close:** the cashier declares float + 2C - 1,000 + C (cash method only); once the shift is closing a fourth collection's hand-in is **422 `SHIFT_NOT_OPEN`**, nothing written; the Manager signs the close off **`EXACT`, `expectedCashPesewas` the float plus both hand-ins**; 1000 against the till back to 0 (to the safe); the fourth collection is still held by the driver; trial balance 0.

Unit, `del/domain/driver-cash.spec.ts` (5, written first and run red: no module): the exact, short (to 1 pesewa and all of it), over (1 pesewa) figures, the balance identity, the two refusals. `numbering.spec.ts` gains the end of a business date.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | No short (`handInFigures` short always zero) | red: 2 (unit) |
| M2 | The cashier may be the driver (`judgeHandIn` without `RECEIVER_IS_DRIVER`) | red: 1 (unit) |
| M3 | A handed-in collection still counted as held (the store without its `NOT EXISTS`) | red: 4 (integration) |
| M4 | The hand-in without `tillTakesCash` (`takesCashIn` removed) | red: 1 (integration: the closing shift) |

## Test first, as it honestly happened

- `driver-cash.spec.ts` was written and run red (no module) before `driver-cash.ts`.
- The integration spec was written after the application code, against the gate's list, then run: two cases failed on their first run, both in the test or the store, not the rule: the reconciliation's `created_at` came from the database's `now()` where the view read the clock (fixed in the store: every time the application clock's, ADR-0067), and a database case inserted a reconciliation with no registered document (fixed in the test). The Accountant needed an enrolled login in the test. **The first whole run was red on one test:** the identifier walk (`no-id-is-a-key`) refused the new `getMyCashSummary` because it takes no identifier and was not listed as taking none, which is what the walk is for; it was listed (its own commit, `ec9ea49`) and the whole suite was run again, green. Mutations M3 and M4 show the integration cases can fail. Nothing was skipped, no assertion loosened, nothing re-run to turn red into green.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item, applied to the new paths)

Boundary crossed: TB2 back office (the till and the report), TB4 driver device (the summary), the database.
- **Identity, sessions and browser:** unchanged; the hand-in is a staff session with CSRF, the idempotency key and the till's device credential, as `payInvoiceAtTill`.
- **Authorisation:** deny by default; each handler authorises in the application layer (`OwnOpenShift.lockIn`, `DriverCashReconciliations.summary`, `get`, `list`); object level: only the caller's own shift, only the driver's own cash, the report only at a branch held whole; the receiver is never the driver (domain and `ck_driver_cash_receiver`). Wrong roles tested on every operation; the authorisation walk and the seeded role matrix include them.
- **Input:** strict schemas (`DriverCashHandInCreate`, the query schemas); unknown fields 400; parameterised SQL only.
- **Money paths:** the server works out what is expected; the client sends only what was counted; integer pesewas end to end; the idempotency key is the first write; no external call; the variance is reported, never corrected.
- **Webhooks, uploads, exports:** not applicable (no such path in this change).
- **Data protection and logging:** no new personal field; the event carries ids and amounts only (no phone, no name but the driver's, as `del.CodCollected` does).
- **Rate limiting:** the console group, as every till operation.
- **Database:** the new tables declare their class, grants follow it; the LEDGER table rejects update, delete and truncate; the DOCUMENT is frozen once written; the till payment cannot settle a document (allocation, order link, refund, reversal refused).
- **Abuse paths:** abuse case 47 added (a cashier keeping part of a count, a driver handing in only some collections, a collection handed in twice, the till payment reused); cases 6 and 43's detection now has its data (the variance report, ◆ `del.DriverCashRemitted` with abuse cases). The exception item itself (`DRIVER_VARIANCE`) is B12's, which builds the report; its test belongs there.
- Findings: none open. Residual: a cashier and a driver colluding (the cashier counts what the driver says) stays visible only as the driver's variance; the blind close signed off by a supervisor is the second control.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 need the run, failures and partial dispatch, which are B11 continued 3's; its opener names them. The B11 continued report's difference on 1.16 (the UAT's ledger books the driver's cash into the safe, 1010) is settled by A-345 (d): into the till's 1000 on the shift, reaching 1010 at its close.

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since B10 continued 4)

- **CR-057 point 1** (the hand-in counted into an open till shift, its cashier `receivedBy`, the cash in that shift's drawer, X and Z and the blind close seeing it): **implemented differently** as the owner decided: its own till operation `handInDriverCash` with the shift in the path rather than `DriverCashReconciliationCreate.shiftId`, because the hand-in is the till's (a POS operation under the till's session and device); `DriverCashReconciliation.shiftId` answers which shift. **Points 2 and 3** (`getMyRoute` with no run; a sync `DUPLICATE`'s first outcome): **B11 continued 3's**, in its opener.
- **CR-055, CR-056 item 4, CR-054 point 1, CR-039, CR-033 point 3:** B11 continued 3's, in its opener (not declined).
- **CR-059 to CR-062:** B12's, in its opener (larger; the parent session schedules). CR-059's `DRIVER_VARIANCE` now has its source (◆ `del.DriverCashRemitted`).
- **CR-050 to CR-052:** answered by lane A in B09b continued 3 to 4c. **CR-053, CR-056 items 1 to 3, CR-058:** done. Older requests are answered in their phases.

## Tests (this machine)

Run on commit `ec9ea49` (the code of the final head; the commit above it adds only this report), with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration (`pnpm test:coverage`) | **4,034 passed, 338 files, none skipped, exit 0**, the whole integration suite included. Coverage, whole: statements 94.07, branches 83.65, functions 97.91, lines 97.10 (each gate 80). **Every full-coverage gate holds at 100 percent** (the run exits 0 on them) |
| Unit alone | 1,933 passed, 165 files, before the end-of-date case was added (one more since, inside the run above) |
| Contract (`pnpm test:contract`) | 139 passed, 55 files, on 2.31.0 (the operation counts, the request-schema walk and the seeded role matrix given the new operations) |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate --check` | Clean (528 operations from code, 131 planned) |

## Deferred

- **To B11 continued 3** (its opener): routes (createRoute, getRoute, listRoutes, reorderRouteStops, startRoute, getMyRoute and CR-057 point 2), the run's close rule (delivered, returned to stock or written off with a reason; the unaccounted on the driver variance report) and the hand-in recorded against the run; the drivers' list (CR-056 item 4); assignment and reassignment; on the way; failures and returns to stock; rescheduling and slot booking; CR-055; the driver's offline sync (CR-057 point 3); partial fulfilment with the fee once; credit-terms dispatch (remove `CREDIT_DISPATCH_NOT_AVAILABLE`); collection; the store-credit choice; BL-096, BL-097; CR-054 point 1; returns of part of a crate (917 for five eggs of a 5,500 crate; 5,500 for all thirty one by one); all of NTF; CR-039; the reused-photograph match on the proof (the owner, 2026-11-23: B11 continued 3, or B12 if it does not); the UAT dry runs.

## Questions for the owner

1. **Everything held at once (A-345 (b)).** A hand-in takes every collection the driver holds at the branch. Agreed, or should a cashier be able to receive only some (a driver coming back between drops)?
2. **More than one hand-in a day (A-345 (c)).** Agreed?
3. **A former driver** who still holds cash can hand it in. Agreed?

## Notes for the frontend track

- **2.31.0:** the till's hand-in screen calls `handInDriverCash` with the till's device credential on the cashier's own open shift; show `expectedPesewas`, `declaredPesewas` and the variance as answered, never computed. The driver's cash screen reads `getMyCashSummary`. The driver variance report reads `listDriverCashReconciliations` (`varianceOnly`). Stop reading `createDriverCashReconciliation` and `postDriverCashReconciliation` (deprecated, never built).

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 3 (`b11c3-driver-run-failures-returns-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c-driver-run-returns-notifications.md, B11 continued 2,
which this phase continues), and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued).
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
Then execute B11 continued 3 only, on branch b11c3-driver-run-failures-returns-notifications. B11 built picking and packing (2.25.0,
A-332 to A-336); B11 continued built dispatch of a whole delivery order (the document on the weighed quantity, the
deposits allocated, a lighter total refunded, the cash due fixed, the goods onto the vehicle), the delivery, the driver's
own reads and the proof with the cash collected held by the driver on 1020 (2.27.0, A-337 to A-341, ADR-0092); B11
continued 2 built the driver's cash: `handInDriverCash` (POS, the receiving cashier's own open shift through `OwnOpenShift`
and `tillTakesCash`, every collection the driver holds at the branch handed in once, ◆ `del.DriverCashRemitted`: Dr 1000,
Cr 1020, the difference to 6900), `getMyCashSummary` and the driver variance report (`listDriverCashReconciliations`,
`getDriverCashReconciliation`), 2.31.0, A-345: build on them, never again. The rest, in this order:
1. The driver's run and cash. Routes (createRoute, getRoute, listRoutes, reorderRouteStops, startRoute, getMyRoute; CR-057
   point 2, what a driver with no run gets), the drivers' list for dispatch (CR-056 item 4) and `del.route.*` for the
   Manager and the Owner; assignDelivery and reassignment, audited (FR-DEL-004); markOnTheWay; recordFailedDelivery,
   returnDeliveryToStock (from the vehicle to the returns hold, with the credit note and refund as applicable),
   rescheduleDelivery and cancelDelivery; delivery slot booking against capacity under a row lock, zone cut-offs and
   rescheduling (FR-DEL-001 to FR-DEL-003; the slot table and generation exist from B7, ADR-0026); CR-055, a part
   delivery (`ProofOfDeliveryCreate.lines` and `returnedReasonCode`: the rest back to stock or kept for a reattempt,
   the document credited for what came back, the cash due fixed again); the driver's offline sync (syncDriverEvents,
   idempotent by client id, CR-057 point 3: a DUPLICATE answers the first outcome); the run's hand-in recorded against
   the run (`del.driver_cash_reconciliation` names its route, additive; A-345 (g)). PAY's `Payment.driver` (BL-096). Partial fulfilment and backorders (FR-ORD-012) with the delivery fee
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
record every difference. CR-056's Storekeeper order read was built in B10 continued 6 (A-335 decided, the owner
2026-11-23): its own narrower read, never `ord.order.read`.
The owner, 2026-11-23 (decisions 1 and 2, on A-337 and A-338):
- A-337 is approved, plus: a run cannot be closed while goods remain on the van. Every item is delivered, returned to
  stock or written off with a reason, and anything unaccounted for goes on the driver variance report. Test the refusal
  to close a run with goods still on the van, each of the three ways out, and the variance line.
- A-338: a guest's order gets a receipt: approved. Dispatch on credit terms is NOT deferred past launch: wholesale
  credit buyers are the main delivery customers. Build it here: the credit check runs at dispatch (WHL's credit control
  through a port, ORD sitting below WHL), and the invoice is issued from the quantities actually dispatched, with its
  due date from the customer's terms; remove `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD.
The owner, 2026-11-23 (from the frontend's F12 and F10n, with notifications): list the message templates so a reminder
level picks one instead of typing a code, and record each reminder's delivery per channel (sent, delivered, failed), so
a failed reminder shows as failed.
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c3-driver-run-failures-returns-notifications.md.
```

