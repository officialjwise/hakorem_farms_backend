# B09b continued: devices, the counter sale and cash only through an open shift (split; continued in B09b continued 1b)

Date: 2026-11-17 · Branch `b09b2-pos-devices-counter`, from `main` (`96b2789`), with `main` merged in at `beec2f6` · Lane A · Status: **phase split (A-274 (a)); this part's gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-274 (a) | The split: built devices, the counter sale, the till cash rule on every PAY path, the cash refund out of an open shift, the unwitnessed drop. The force close, held sales, a cleared provider payment as a counter tender and the audit anchor are **B09b continued 1b**. | Owner |
| A-274 (b) | The device credential (`hkdev_<till>.` plus 256 random bits) is kept only as its SHA-256 hash, in no idempotency answer, audit row or outbox payload; a replayed `enrolDevice` is 409 `DEVICE_CREDENTIAL_SHOWN_ONCE`. Enrol and revoke need `pos.device.enrol` with step-up; only the Owner and the Manager hold it and `pos.device.read`. | Owner |
| A-274 (c) | The device is checked on `completeCounterSale` (and the sync, later); `openShift` and `recordCashMovement` stay on the staff session (BL-078). | Owner |
| A-274 (d) | `pos.shift.force_close` (step-up) is seeded now to the Owner and the Manager, because ADR-0077 lets its holder record cash, pay a refund or approve a reversal on another cashier's open shift. Nobody sells on another cashier's shift. | Owner |
| A-274 (e) | A till cash refund is paid only out of an open shift of that till and counts against it; a cash reversal or void needs the payment's own shift still open. Replaces A-273 (i)'s "whenever the refund was paid". | Owner, Accountant |
| A-274 (f) | Counter tenders are cash only for now: mobile money or card refused, a `paymentId` tender `PROVIDER_PAYMENT_NOT_AVAILABLE` (a cleared payment is frozen and ORD reads an order's payments by the order they name; linking them needs a decision, B09b continued 1b). | Owner |
| A-274 (g) | A counter sale's prices are tax-inclusive, as the seeded till sale is. | Accountant |
| A-274 (h) | The per-shift room is `PRICE_OVERRIDE_PER_SHIFT` less every price given below list on the shift, approved ones included; none is seeded (A-230). | Owner |
| A-274 (i) | A till clock outside 300 seconds never refuses a counter sale: recorded at the server's time, `pos.TillClockOutOfTolerance` to the exception source. | Owner |
| A-274 (j) | "Signed in at the branch" is a live staff session of a holder of `pos.shift.close.approve` at the branch, other than the cashier and the recorder. | Owner |
| A-274 (k) | The database holds the till rule too: the platform's published `document_entry_state` (kept by POS's trigger) and IAM's published `holds_permission_at`, read by PAY's triggers; PAY's till trigger fires before its other insert triggers. | Owner |

**Changed shapes and behaviour, named first (the parent's condition on ADR-0077):** contract **2.6.0**, LOUD for PAY. `markRefundPaid` now requires `shiftId` for a till cash refund; `initiateMobileMoneyCharge` now accepts `shiftId` (was refused); a cash reversal or void is refused once the payment's shift is not open; a shift's refunds count against the shift they were paid out of. No field removed or retyped. New response fields `CashMovement.unwitnessed`, `ShiftReport.unwitnessedDropsCount` and `unwitnessedDropsPesewas`; new request field `RefundMarkPaid.shiftId`.

**No ADR conflict.** ADR-0077 (proposed; the owner accepts it only from the per-path table below) adds a port, as MODULE_BOUNDARIES rule 6 allows, and, at the parent session's request for the owner, holds the rule in the database through two published facts (ADR-0077 Amendments): no schema reads another's tables, and the schema-names check is unchanged (two platform functions join `platformSharedObjects`, one IAM function joins `publishedFunctions`). The changes outside lane A were cleared with the parent session first: PAY's till cash rules (approved with conditions), the ORD and INV test files (approved), and the additive ORD change in `sale-posting.ts` only (approved; I built the per-shift room and left the `paymentId` tender, see A-274 (f)).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued (`b09b2-pos-devices-counter`, from `main` at `96b2789`), lane A.
2. **Scope:** devices, the counter sale, the force close, held sales, the cash refund out of an open shift, the audit anchor, every cash path refused off-shift, and the owner's unwitnessed drop (added mid-session). Too large for one context: split after the counter sale and the cash rule (A-274 (a)).
3. **Gate:** a device enrolled and revoked; a counter sale on the cashier's own open shift, change from cash only; a cash refund only out of an open shift. The force close and held sales are B09b continued 1b's gate.

## Contract changes

**2.6.0, minor, with PAY's four behaviour changes LOUD** (changelog entry and cold-read line written).
- Into code: `listRegisterDevices`, `enrolDevice`, `revokeDevice`, `completeCounterSale` (444 from code, 198 planned).
- `enrolDevice`, `revokeDevice`, `forceCloseShift` marked `x-requires-step-up`.
- New error codes `DEVICE_INVALID`, `DEVICE_CREDENTIAL_SHOWN_ONCE`, `COUNTER_SALE_INVALID`; `DEVICE_CREDENTIAL_INVALID` and `DEVICE_REVOKED` now answered; `PRICE_OVERRIDE_NEEDS_APPROVAL` gains `BEYOND_SHIFT_LIMIT`; `PAYMENT_INVALID` and `REFUND_INVALID` gain `SHIFT_*` details.
- Examples fixed: the cash movement reasons as built, a revoked device's times in order.
- Checks: `contract:generate --check`, Redocly clean, `versioning.ts` against `main`: ok.

## Built

| Area | What |
| --- | --- |
| Migrations | 0236 `platform.document_entry_state` and its owner-only setter; 0237 `iam.holds_permission_at`; 0238 POS publishes each shift's state and `ck_cash_movement_own_shift`; 0239 PAY's `ck_payment_till_shift` (`trg_payment_a_till_shift`) and the refund payout check. 0231 `pos.cash_movement.unwitnessed` and the new `ck_cash_movement_witness`; 0232 `pay.refund.paid_from_shift_id` and `ck_refund_till_shift`; 0233 and 0234 `pos.device.read`, `pos.device.enrol`, `pos.shift.force_close` (step-up) to the Owner and the Manager; 0235 `pos.device_enrolment` (MASTER, hashed credential, `pos.device_enrolment_guard`). Each rollback is in the rollback walk. |
| PAY (shared, cleared) | The `TillShiftCheck` port and `TillShiftRegistry` (ADR-0077, deny by default); `Payments.tillCashIn` and `tillCashAnswerIn`, asked in `writeIn`, the mobile money charge, `Refunds.markPaid` and `Receipts.reverseIn`; `shiftTotals` counts refunds by the shift they were paid out of. |
| POS | `TillCash` (the port's implementation, `judgeTillCash`), `Devices`, `CounterSales`, the unwitnessed drop (`isUnwitnessedDrop`), `shiftOverrideRoom`, `secondsAhead`, `pos.TillClockOutOfTolerance`. |
| ORD (cleared, `sale-posting.ts` only) | `SaleRequest.shiftOverrideRoomPesewas` and `OverrideApproval` `BEYOND_SHIFT_LIMIT`; no existing caller changed. |
| IAM | `Authoriser.signedInHoldersIn`; `limitIn` takes `PRICE_OVERRIDE_PER_SHIFT`. |
| Docs | ADR-0077 and its index row, ADR-0026 Amendments, the B09b continued 1b opener, A-274, BL-077, BL-078, API.md, the changelog, `data-model/pos.md` and `pay.md`, the POS and PAY cards and section 6, THREAT_MODEL abuse cases 3, 4 and 17. |

## The gate, proved by running it

**Every cash path through a till (`test/integration/pos/till-cash-paths.integration.spec.ts`, 20 tests).** Four cashiers on four tills: Adwoa's shift OPEN on T1, Nana's OPEN on T2, Efua's CLOSED on T3 (signed off), Kofi's CLOSED and force-closed on T4 (written as `forceCloseShift` will leave it; the operation is B09b continued 1b).
- **A sale's tender through ORD:** another cashier's shift (`SHIFT_NOT_OWN`), another till (`SHIFT_OTHER_REGISTER`), a closed and a force-closed shift (`SHIFT_NOT_OPEN`) refused; counts of payments, orders and cash movements unchanged; T2's 1000 still 0.
- **`Payments.recordIn` and `Payments.writeIn` called directly:** the same refusals, and `SHIFT_UNKNOWN` for a document that is no shift; nothing recorded. A manager (who holds `pos.shift.force_close`) may put cash on Adwoa's shift.
- **A mobile money charge naming a shift,** over HTTP and through `ProviderPayments.chargeIn`: the own open shift taken, the others refused.
- **A cash refund paid by hand:** no shift (`SHIFT_REQUIRED`), Nana's till (`SHIFT_OTHER_REGISTER`), the accountant who neither runs the shift nor recovers it (`SHIFT_NOT_OWN`), closed and force-closed (`SHIFT_NOT_OPEN`) refused; paid out of Adwoa's shift, 1,500 leaves both her expected cash and T1's 1000 (SQL); the database refuses a till cash refund PAID with no shift.
- **A reversal and a void:** a reversal out of the open shift takes exactly 2,000 off T1 and the shift; a reversal or a void of cash taken in the closed or the force-closed shift is refused at its approval, the payment CLEARED, the order COMPLETED, no reversing payment.
- **A cash movement:** another cashier (403), closed and force-closed (`SHIFT_NOT_OPEN`).
- **The shift then reconciles:** Adwoa declares the figure derived by SQL (6,000 + 1,000 + 4,000 − 1,500 + 2,000 − 2,000 = 9,500); the manager signs off EXACT and T1's 1000 returns to 0.

**The database holds it too (same spec, 6 tests, direct SQL as the application role in a rolled-back transaction):** a payment naming another cashier's shift, another till, a closed or force-closed shift, or a document that is no shift is refused `ck_payment_till_shift` with its reason; the same for a mobile money charge and a reversing payment (and a decider who cannot reach the shift); a refund paid out of another till, a closed or force-closed shift, or by a payer who cannot reach it is refused `ck_refund_till_shift`; a cash movement by another cashier `ck_cash_movement_own_shift`, on a closed or force-closed shift `ck_cash_movement_open_shift`; the application role cannot write the shift's published state and a closed shift's state never reopens.

**Every cash path, one row each** (the parent's table; ADR-0077 Verification holds the same):

| Cash path | Another cashier's shift | A closed shift | A force-closed shift | Database-level refusal (direct SQL) | Mutation turned red |
| --- | --- | --- | --- | --- | --- |
| A sale's tender through ORD | "refuses another cashier shift, another till, a closed shift and a force-closed shift, recording nothing" (`SHIFT_NOT_OWN`) | same test (`SHIFT_NOT_OPEN`) | same test (`SHIFT_NOT_OPEN`) | "a cash tender (a sale through ORD, recordIn, writeIn): ..." | `judgeTillCash` open check removed (6 red), own check removed (5 red); DB: open check removed (4 red), own check removed (4 red) |
| `Payments.recordIn` directly | "refuses another cashier shift, a closed shift, a force-closed shift and a document that is no shift" | same test | same test | "a cash tender (...)" | `writeIn`'s till check removed (2 red); DB as above |
| `Payments.writeIn` directly | same test (`writeDirect`) | same test | same test | "a cash tender (...)" | `writeIn`'s till check removed (2 red); DB as above |
| A mobile money charge by HTTP | "names the cashier own open shift, and refuses another cashier shift, a closed or a force-closed shift" | same test | same test | "a mobile money charge naming a shift (...)" | `initiate`'s check is masked by `writeChargeIn`'s; DB open and own checks removed (4 red each, this test among them) |
| A mobile money charge through `chargeIn` | "refuses the same in a charge another module writes in its own transaction (ProviderPayments.chargeIn): a closed, a force-closed and another cashier shift" (`SHIFT_NOT_OWN`) | same test (`SHIFT_NOT_OPEN`) | same test (`SHIFT_NOT_OPEN`) | "a mobile money charge naming a shift (...)" | `writeChargeIn`'s check removed (1 red) |
| A cash refund paid by hand | "refuses a payout ... by someone who may not reach the cashier shift, and out of a closed or force-closed shift" | same test | same test | "a cash refund paid out of a till: ..." | `markPaid` ignores the refusal (3 red); DB refund check removed (1 red) |
| An approved reversal | not reachable through the application, because every permitted approver (Owner, Manager, `pay.reversal.approve`) holds `pos.shift.force_close`; the decider who cannot reach the shift is refused by the database test "a reversing payment (...)" (`SHIFT_NOT_OWN`) | "refuses to reverse cash taken in a closed or a force-closed shift" | same test | "a reversing payment (an approved reversal or a void): ..." | `reverseIn`'s till check removed (2 red); DB open check removed (4 red) |
| A void | not reachable through the application, for the same reason (`ord.void.approve` is the Owner's and the Manager's); the database test "a reversing payment (...)" refuses a decider who cannot reach the shift | "refuses to void a cash sale whose shift has closed or was force-closed" | same test | "a reversing payment (...)" | `reverseIn`'s till check removed (2 red) |
| A cash movement | "refuses another cashier, a closed shift and a force-closed shift" (403) | same test (`SHIFT_NOT_OPEN`) | same test | "a cash movement: ..." (`ck_cash_movement_own_shift`, `ck_cash_movement_open_shift`) | DB own check removed (1 red); a shift published as always open (5 red) |

No cell is empty. Two cells are facts rather than tests through the application: no permitted approver of a reversal or a void lacks `pos.shift.force_close`, so "another cashier's shift" is refused only by the database there.

**Devices (`devices.integration.spec.ts`, 7 tests):** a manager with a fresh step-up enrols a device on T1; the credential matches `hkdev_T1.` and 43 base64url characters; the stored hash is its SHA-256 (SQL); its secret part is in no idempotency answer, audit row or outbox payload (SQL); a replay is 409 and enrols nothing; a retired till is refused; the cashier, the storekeeper, the accountant and another branch's manager are refused enrol, list and revoke; a stale step-up is refused; the Owner revokes with the reason, `deviceCount` goes from 1 to 0, a second revocation is refused; the database refuses un-revoking, a sync time on a revoked device and a new hash.

**The counter sale (`counter-sale.integration.spec.ts`, 12 tests):**
- 3 yams and 2 cabbages for **8,000**, cash handed over 10,000: 201, change **2,000**, receipt `RCP-...`, order POS COMPLETED on the shift; by SQL one cash payment of 8,000 on the shift and T1, 3 yams and 2 cabbages issued, T1's 1000 at 50,000 + 8,000. A replay posts nothing.
- Change from cash only: mobile money with `tenderedPesewas` (`CHANGE_ONLY_FROM_CASH`), cash handed over below its amount (`TENDERED_BELOW_AMOUNT`), mobile money (`PAYMENT_METHOD_REQUIRES_VERIFICATION`), a `paymentId` (`PROVIDER_PAYMENT_NOT_AVAILABLE`), 1,999 and 2,001 for a 2,000 sale (`TENDER_SHORT`, `TENDER_OVER`): nothing recorded (counts and number series unchanged).
- The device: none and unknown (401), revoked (403 `DEVICE_REVOKED`), another till's (403): nothing recorded. Another cashier, the storekeeper and the accountant 403; a CLOSING shift `SHIFT_NOT_OPEN`.
- **One transaction or nothing:** a failure injected after the payment and after every journal leaves no order, payment, movement, document, journal, number or series step behind, and T1's 1000 unchanged.
- **The per-shift limit** (300 a line, 500 a shift, set by SQL): 200 then 300 below list accepted, 4210 debited exactly 500 over the two receipts (SQL); one pesewa more is `BEYOND_SHIFT_LIMIT` and records nothing; a line 400 below list is `BEYOND_ROLE_LIMIT`.
- A till time an hour behind: recorded at the server's time, `pos.TillClockOutOfTolerance` with −3,600 seconds.
- The shift signs off EXACT at 50,000 + 15,500 derived by SQL, and T1's 1000 returns to 0.

**The unwitnessed drop (`cash-drop-witness.integration.spec.ts`, 6 tests):** with no supervisor signed in (SQL shows no live session), a drop of 15,000 is taken unwitnessed, posts 15,000 to 1010, and `pos.CashDropped` carries `unwitnessed` and abuse case 17; the X report shows 1 unwitnessed drop of 15,000; the database refuses a drop both witnessed and unwitnessed, neither, and a pay-out marked unwitnessed. With the manager signed in, a drop with no witness is `WITNESS_REQUIRED` and records nothing, and one witnessed by him is not marked; once he signs out, a drop goes unwitnessed again.

**Maker and checker:** the sign-off is still never the cashier's (B9b's tests, unchanged and green); the Owner holds the till permissions and is never the checker of their own action (the reversals and void specs); nobody sells on another cashier's shift.

## Mutation checks (each applied alone, its spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `judgeTillCash` no longer refuses a shift that is not OPEN | red: 6 of 13 |
| 2 | `judgeTillCash` no longer refuses another cashier | red: 5 of 13 |
| 3 | `Payments.writeIn` no longer asks the till check | red: 2 of 13 |
| 4 | `Refunds.markPaid` ignores the till check's refusal | red: 3 of 13 |
| 5 | `Receipts.reverseIn` no longer asks the till check | red: 2 of 13 |
| 6 | `writeChargeIn` no longer asks the till check | green at first (masked by `initiate`'s own check); the `chargeIn` test was then added, and the mutation is red: 1 of 14 |
| 7 | A drop with no witness always refused | red: 4 of 6 |
| 8 | No supervisor ever counted as signed in | red: 3 of 6 |
| 9 | `enrolDevice`'s replay answers the stored response | red: 1 of 7 |
| 10 | A second revocation allowed | red: 1 of 7 |
| 11 | The counter sale's own-shift check removed | red: 1 of 12 |
| 12 | A revoked device allowed | red: 2 of 12 |
| 13 | No per-shift room passed | red: 2 of 12 |
| 14 | `changeDue`'s refusal ignored | red: 1 of 12 |
| 15 | SalePosting never flags `BEYOND_SHIFT_LIMIT` | red: 2 of 12 |
| 16 | Database: `pay.till_shift_refusal` without the open check | red: 4 of 20 |
| 17 | Database: without the own-or-recover check | red: 4 of 20 |
| 18 | Database: without the till check | red: 2 of 20 |
| 19 | Database: the refund payout not judged | red: 1 of 20 |
| 20 | Database: the cash movement guard without the own-shift check | red: 1 of 20 |
| 21 | Database: POS publishes every shift as taking entries | red: 5 of 20 |

## Test first, as it honestly happened

- Unit tests first, each seen red before its code: the unwitnessed drop (`judgeCashMovement`, `isUnwitnessedDrop`), `judgeTillCash`, `shiftOverrideRoom`. `secondsAhead` was moved into the domain to satisfy the money lint rule, with its test in the same commit.
- The database rule (migrations 0236 to 0239) came after the application rule, at the parent session's request; its six direct-SQL tests were run red first against a missing grant and two other triggers that fired before it (fixed: the grant, the trigger order and a version step in the test), and each of mutations 16 to 21 turns them red.
- The four integration specs were written after their application code. Their first runs were red on real faults or test errors, each fixed before the commit: the journal subject of a drop, a location-scoped cashier who cannot ask a refund or a void (the specs use the manager), a charge at a till authorised at the branch only (fixed: authorised at the till's location), a sale's payment refunded only against its credit note (the spec uses a deposit), a refund guard that fires before mine (the trigger was simplified). Mutation 6 found a check no test reached; the test was added.
- The first run of ORD, PAY, INV and contract specs after the guard was red in 27 tests: they posted cash into fake tills with a test shift on another till. `test/support/till.ts` now opens the shift on the till the sale's cash names, one till per seller; no assertion was weakened (cleared with the parent session).
- The rollback walk, the handler walk, the identifier walk, the step-up walk and the contract counts each failed once on the new rows and were extended.

## Decisions

- **ADR-0077 (proposed):** PAY asks POS through the `TillShiftCheck` port before any cash moves into or out of a till.
- Everything else is in A-274.

## Security review (hakorem-security-review)

The same finding goes into the pull request body.
- **Boundary:** TB2 (back office), TB3 (the POS device on shop wifi: the device credential and the staff session), TB5 is untouched, and the database.
- **The standards, item by item:**
  - SC-01: strict zod bodies, exact integers and three-place decimals; unknown fields refused.
  - SC-02: every handler authorises at the till's branch and location, deny by default; the counter sale only on the caller's own shift; PAY's till cash rule holds whoever calls PAY; wrong roles and another branch tested; the two walks cover the four operations.
  - SC-03, SC-04: parameterised SQL only.
  - SC-05: kernel `Money`; the money lint rule holds (one finding fixed by moving clock arithmetic into the domain).
  - SC-06: idempotency on every write; the counter sale's key is its id.
  - SC-07, SC-08: the device credential is never logged, audited, put in the outbox or kept in the idempotency store (tested by SQL); events carry ids and pesewas.
  - SC-14: no external call inside a transaction (the mobile money charge is sent after commit, as before).
  - SC-15, SC-16: no empty catch; stable codes; errors carry the correlation id.
  - SC-17: maker and checker apart on the sign-off (unchanged); a refund's payer never its maker (unchanged); nobody sells on another's shift.
  - SC-22: cash movements stay insert-only; a paid refund and a revoked device never change (triggers).
  - SC-23: serializable writes, the shift locked for the sale and for every cash check.
  - SC-24: enrolment, revocation and the counter sale are audited (the credential left out).
- **Not applicable, with reason:** SC-09 to SC-11 (existing cookies, CSRF and CORS; `X-Device-Credential` was already allowed); SC-12 (no upload); SC-13 (no webhook); SC-18 (no restricted field returned; the credential hash is never read out); SC-19 (no outbound URL); SC-20, SC-21 (the CI scans).
- **Abuse cases:** 17 (an unwitnessed drop carries abuse case 17; every cash path off an open shift refused), 3 (the per-shift limit), 4 (the counter refuses unverified tenders), 1 (a void of a closed shift's cash refused). **Residual:** a device credential in a browser has no hardware store; it authorises nothing alone and is revocable at once (ADR-0016). BL-077: a void approved while a reversal of the same payment waits answers 500 (no money moves).

## Deferred

- **B09b continued 1b:** `forceCloseShift`, held sales, a cleared provider payment as a counter tender (A-274 (f)), the audit anchor at each sign-off, and the force-closed refusal proved with the real operation.
- **B09b continued 2:** the pack and sync, the settings, CR-031, CR-032 point 6, CR-038, the device credential on queued shift opens and cash movements (BL-078).
- BL-077 to lane B or the PAY owner.

## Contract requests

The frontend's `main` was read at `41ce67c`; it holds CR-001 to CR-041, none new since B9b.
- **CR-031, CR-032 point 6, CR-038:** B09b continued 2 (the pack and sync). **CR-032 points 1 to 5:** B09b continued 3. **CR-033 points 1 and 2:** B09b continued 4.
- **CR-039, CR-040, CR-041:** placed by the owner in B11, lane B's B09u and B10.
- **Everything else:** answered in earlier phases (CR-009 to CR-015 and CR-017 to CR-020 still read "Open" in the frontend's own table; their answers are in the 1.x reports, and closing them is the frontend's).

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | 134 files, 1,589 tests passed. |
| Integration (full suite) | 132 files, 1,684 of 1,685 tests passed, with the database rule: **one red**, `mdm/public-ids` "gives every customer a different public ID" (one of six concurrent `createCustomer` calls answered 500). It passed alone, was red again once in three parallel runs and green in four more; not re-run to turn it green, not changed, cause not proved; reported to the parent session, who is fixing it by its cause on its own branch (it is MDM's and is on `main` already). See CI. The four new POS specs pass (45 tests). |
| Unit and integration with coverage (`pnpm test:coverage`) | Started locally and stopped when the parent session asked for the database rule; the merged figures are CI's. |
| Contract | 46 files, 121 tests passed. |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check`, versioning | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied again | Run in CI. |

Nothing was re-run to turn red into green.

## Gate

**This part's gate passed:** a device is enrolled and revoked; a counter sale is taken on the cashier's own open shift with change from cash only, in one transaction; a cash refund is paid only out of an open shift of the till that took it; and every way cash is recorded refuses another cashier's shift, a closed shift and a force-closed shift. Each figure is derived by SQL, and each rule is mutation-checked. The force close and held sales are B09b continued 1b's gate.

## Notes for the frontend track

- **2.6.0.** The till can enrol its device (`enrolDevice`, keep `deviceCredential`, send `X-Device-Credential`) and take a counter sale (`completeCounterSale`, the `Idempotency-Key` equal to the sale's `id`, cash only, `tenderedPesewas` for change).
- **Refunds of till cash** now send `shiftId` on `markRefundPaid`; a mobile money charge taken at the till may send `shiftId`.
- **A drop** may leave `witnessId` out when no supervisor is signed in; show `unwitnessed` and the reports' `unwitnessedDropsCount`.

## CI

**A red seen locally, outside this phase:** `test/integration/mdm/public-ids.integration.spec.ts` "gives every customer a different public ID" answered statuses [201, 500, 201, 201, 201, 201] for six concurrent `createCustomer` calls, once in the full local integration run (132 files) and once in three parallel runs of the spec under load. It was green alone and in four more parallel runs, during which the 500 did not recur while the server's errors were being logged. Nothing was re-run to turn it green and nothing was changed. The parent session ruled it does not block this merge (the test, the code and the 500 are MDM's customer creation, on `main` already) and is fixing it by its cause on its own branch.

**The one gap in the per-path table, named for the owner:** "another cashier's shift" for an approved reversal or a void cannot be reached through the application, because every permitted approver (`pay.reversal.approve`, `ord.void.approve`: the Owner and the Manager) holds `pos.shift.force_close`. It is refused by the database test "a reversing payment (an approved reversal or a void): ..." (`SHIFT_NOT_OWN`).

- **`9ef3945`** (the code and docs head before the merge slot, pull request #100): run **44207791379 (push)** succeeded and run **44207873048 (pull_request)** succeeded. Nothing was re-run.
- The runs on the pushed heads are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 1b, copied from `docs/prompts/session-openers.md` (written by this split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b2-pos-devices-counter.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md (sections 2, 6.5, 9.4.2 and 11),
ADR-0016, ADR-0027, ADR-0077, A-273 and A-274 in docs/ASSUMPTIONS.md, and the abuse cases 1, 3, 4 and 17 in
docs/security/THREAT_MODEL.md. Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 1b only, on branch b09b2b-pos-force-close-held, branched from main: forceCloseShift
(pos.shift.force_close, seeded by B09b continued with step-up; a manager who is not the cashier, a reason, the shift
closed at its expected cash and flagged force-closed, audited; the variance posted when the drawer is counted later;
held at the database that the checker is never the cashier; mutation-checked), and prove that cash naming a
force-closed shift is refused on every cash path of ADR-0077 with the real operation (test/integration/pos/
till-cash-paths.integration.spec.ts simulates it today); held sales (holdSale, listHeldSales, recallHeldSale on the
till's open shift, pos.held_sale, re-priced on recall with exact pesewas after a price change between hold and recall,
recalled once, lapsing at the shift's close); a mobile money or card tender at the counter as a payment the provider
already cleared (TenderInput.paymentId, FR-POS-006): the payment must be linked to its sale so ORD's reads and a void
see it (A-274 (f): the cleared payment is frozen, so decide the link with an ADR and ask the parent session before
changing an existing PAY or ORD shape), allocated once, never another customer's or another shift's, test-first with
exact pesewas; the audit chain anchored at each sign-off through the worker (approveShiftClose's description promises
it). Every write gets its wrong-role refusal test; every new read joins the identifier walk.
Stop at the gate and write docs/sessions/B09b2b-pos-force-close-held.md.
```
