# B09b continued 1b: the force close, its drawer counted by a third person, and the anchor at each sign-off (split; continued in B09b continued 1c)

Date: 2026-11-17 · Branch `b09b2b-pos-force-close-held`, from `main` (`b8c4db0`), rebased in the merge slot on `main` at `25d2844` (lane B's statements: migrations 0240 to 0244 and contract 2.7.0, so this phase's migrations are renumbered 0245 and 0246 and its contract is 2.8.0) · Lane A · Status: **phase split (A-275 (a)); this part's gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-275 (a) | The split: built the force close, the later count of its drawer, ADR-0077's force-closed column with the real operation, and the audit anchor at each sign-off. Held sales and a cleared provider payment as a counter tender are **B09b continued 1c**. | Owner |
| A-275 (b) | Only an OPEN shift is force-closed; a CLOSING one already has its cashier's count, which is signed off (`SHIFT_NOT_OPEN`). | Owner |
| A-275 (c) | A force close posts nothing: the shift is CLOSED at its expected cash (frozen) with no count, the till's 1000 keeps the cash until the drawer is counted, and the expected figure stays hidden from every reader until then. | Owner, Accountant |
| A-275 (d) | The drawer of a force-closed shift is counted once, by a supervisor who is neither its cashier nor the manager who force-closed it (`pos.shift.close.approve`, step-up); that count posts the over or short. In a branch with one manager, the Owner counts. | Owner, Accountant |
| A-275 (e) | The anchor at each sign-off is asked for in the sign-off's transaction and answered by the worker once that transaction's audit events are chained; one anchor may answer several requests. The later count asks too; the force close itself does not (it moves no money). | Owner |
| A-275 (f) | The new `Shift` fields (`forceCloseReason`, `countedBy`, `countedAt`) and `ShiftReport.forceClosed` are optional in the contract and always sent; on a force-closed shift `closeApprovedBy` is the force-closer. | Owner |

**No existing shape changed.** Contract **2.8.0** (on top of lane B's 2.7.0), additive: `forceCloseShift` moves into code (its planned example answered an OPEN shift; it now answers CLOSED and `forceClosed`), `countForceClosedShift` is new, four optional response fields are new.

**No ADR conflict.** ADR-0078 (proposed) is new; ADR-0006 gains an amendment (the anchor at every shift close, which it already promised); ADR-0077's Verification table now names, in every cell of its force-closed column, the test that refuses cash on a shift closed by the real `forceCloseShift`. **No path accepts cash on a force-closed shift**, so ADR-0077, accepted by the owner on 2026-11-18 on condition of this re-proof (PR #103, merged into `main` while this phase ran), stays Accepted. Nothing outside lane A was changed: POS and the platform (shared, additively: two new tables, one new service, one new worker loop). The ORD exception (`sale-posting.ts`) was not needed this part.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 1b (`b09b2b-pos-force-close-held`, from `main` at `b8c4db0`), lane A.
2. **Scope:** the force close and its later count, ADR-0077's force-closed column re-proved with the real operation, held sales, a cleared provider payment as a counter tender, the audit anchor at each sign-off. Too large for one context: split after the force close and the anchor (A-275 (a)), at the sub-domain boundary.
3. **Gate:** a force close by a manager who is not the cashier, closed at its expected cash and its variance posted when the drawer is counted, mutation-checked. Held sales and the provider tender are B09b continued 1c's gate.

## Contract changes

**2.8.0, minor, additive** (changelog entry and cold-read line written, above lane B's 2.7.0).
- `forceCloseShift` into code (447 code operations on `main` before, 449 now; 195 planned before, 194 now; 643 in all).
- `countForceClosedShift` (`POST /shifts/{id}/late-count`, `pos.shift.close.approve`, step-up), body `ForceClosedShiftCount`, answer `Shift`.
- `Shift.forceCloseReason`, `countedBy`, `countedAt`; `ShiftReport.forceClosed` (optional, always sent).
- New details on existing codes: `SHIFT_CLOSE_SAME_PERSON` with `FORCE_CLOSER_IS_CASHIER`, `COUNTER_IS_CASHIER`, `COUNTER_IS_FORCE_CLOSER`; `SHIFT_INVALID` with `SHIFT_NOT_FORCE_CLOSED`, `SHIFT_ALREADY_COUNTED`.
- `approveShiftClose`'s description: the anchor at each sign-off is built.
- Checks: `contract:generate --check`, Redocly clean, `versioning.ts` against `main`: ok.

## Built

| Area | What |
| --- | --- |
| Migrations | 0245 (pos): `pos.shift.force_close_reason`, `ck_shift_force_close_reason`, `ck_shift_steps` with the force-closed CLOSED step, `ck_shift_over_short` rewritten, `pos.shift_guard` (OPEN to CLOSED only by a force close), `pos.shift_late_count` (LEDGER) and `pos.shift_late_count_guard`. 0246 (platform): `platform.audit_anchor_request` and `platform.audit_anchor_fulfilment` (LEDGER, the second written by `hk_sealer` only). Both rollbacks are in the rollback walk. |
| POS | `judgeForceClose`, `judgeLateCount` (domain); `Shifts.forceClose`, `Shifts.countLate`; `approveClose` asks for the anchor; views hide a force-closed shift's expected cash until counted; `pos.ShiftForceClosed` (abuse case 17, `SHIFT_FORCE_CLOSED`); `pos.ShiftClosed` gains `forceClosed` and `forceClosedBy` at the later count. |
| Platform | `AuditAnchorRequests.requestIn`; `AuditAnchor.answerRequests`; the worker's `audit-anchor-requests` loop as the sealer. |
| Docs | ADR-0078 and its index row, ADR-0006 Amendments, ADR-0077 Verification, ADR-0026 Amendments, the B09b continued 1c opener, A-275, API.md, the changelog, `data-model/pos.md` and `platform.md`, the POS card, THREAT_MODEL abuse case 17. |

## The gate, proved by running it

**The force close (`test/integration/pos/force-close.integration.spec.ts`, 14 tests).** Kofi's shift on T1: float 20,000, yams for 6,000 and 4,000 in cash, a drop of 5,000 witnessed by the owner. By SQL over `pay.payment`, `pay.refund` and `pos.cash_movement`, the drawer holds **20,000 + 6,000 + 4,000 − 5,000 = 25,000**, and T1's 1000 is 25,000.
- Refused, closing nothing: the cashier, another cashier, the accountant and another branch's manager (403); a manager with a stale step-up (403 `STEP_UP_REQUIRED`); no reason (400); a manager force-closing the shift she runs herself (422 `SHIFT_CLOSE_SAME_PERSON` `FORCE_CLOSER_IS_CASHIER`, and by the database `ck_shift_close_checker`).
- The manager force-closes: CLOSED, `forceClosed`, the reason, `closeApprovedBy` the manager, declared, expected and over or short all null; by SQL the shift holds expected **25,000**, equal to the SQL figure; **no** `pos.ShiftClosed` journal; T1's 1000 still 25,000; the published entry state no longer takes entries; `pos.ShiftForceClosed` carries the cashier, the manager, the reason, 25,000 and abuse case 17; one `FORCE_CLOSE` audit row by the manager. Its cashier and the X report see it flagged and blind. A replay closes and publishes nothing more; a second force close is `SHIFT_NOT_OPEN`.
- After it: a sale through ORD (`PAYMENT_INVALID` `SHIFT_NOT_OPEN`), a pay-out and the cashier's declaration are refused; the drawer stays 25,000. A CLOSING shift is refused. The database refuses the flag outside a force close, an OPEN shift closed without it, and any change to a force-closed shift (HK004).
- **The count:** the force-closer (422 `COUNTER_IS_FORCE_CLOSER`), a cashier who holds the sign-off and counts her own force-closed shift (422 `COUNTER_IS_CASHIER`), the cashier, the accountant and another branch (403), and a shift not force-closed (`SHIFT_NOT_FORCE_CLOSED`) are refused. The database refuses a count by the force-closer, by the cashier, against 26,000, by the accountant, and on a shift not force-closed, each by its own constraint.
- The owner counts **24,750**: short **250**; the journal is exactly Cr 1000 25,000, Dr 1010 24,750, Dr 6900 250; T1's 1000 is **0**; the trial balance sums to 0; `pos.shift_late_count` holds 24,750 against 25,000 (equal to the SQL figure) by the owner; `pos.ShiftClosed` names the cashier, the owner, `forceClosed`, the manager as `forceClosedBy`, 250 SHORT and abuse case 17; the Z report is flagged; one anchor request for the shift. A second count is `SHIFT_ALREADY_COUNTED`, the count cannot be updated, one journal only.

**ADR-0077's force-closed column, re-proved with the real operation.** `test/integration/pos/till-cash-paths.integration.spec.ts` no longer writes Kofi's shift by SQL: the manager force-closes it through `forceCloseShift` (asserted CLOSED, force-closed, expected 4,000, nothing declared). All 20 tests pass against it. Every cell of the force-closed column in ADR-0077's Verification table now names its test:

| Cash path | Refused on a shift closed by `forceCloseShift`, in |
| --- | --- |
| A sale's tender through ORD | "refuses another cashier shift, another till, a closed shift and a force-closed shift, recording nothing"; and `force-close` "takes no more cash on it: a sale, a cash movement and the cashier declaring a count are refused, the drawer unchanged" |
| `Payments.recordIn` directly | "refuses another cashier shift, a closed shift, a force-closed shift and a document that is no shift, recording nothing" |
| `Payments.writeIn` directly | the same test (`writeDirect`) |
| A mobile money charge by HTTP | "names the cashier own open shift, and refuses another cashier shift, a closed or a force-closed shift" |
| A mobile money charge through `chargeIn` | "refuses the same in a charge another module writes in its own transaction (ProviderPayments.chargeIn): a closed, a force-closed and another cashier shift" |
| A cash refund paid by hand | "refuses a payout with no shift, out of another till, by someone who may not reach the cashier shift, and out of a closed or force-closed shift" |
| An approved reversal | "refuses to reverse cash taken in a closed or a force-closed shift: nothing leaves the till" |
| A void | "refuses to void a cash sale whose shift has closed or was force-closed: the order stays COMPLETED and no reversing payment exists" |
| A cash movement | "refuses another cashier, a closed shift and a force-closed shift"; and `force-close` "takes no more cash on it: ..." |

The database cells ("a cash tender (...)", "a mobile money charge naming a shift (...)", "a reversing payment (...)", "a cash refund paid out of a till: ...", "a cash movement: ...") run against the same real force-closed shift and pass.

**The anchor at each sign-off.** `shift-close.integration.spec.ts`: the sign-off writes one `SHIFT_CLOSE` request for the shift, by the manager, in its transaction; `force-close.integration.spec.ts`: the later count writes one. `test/integration/platform/worker.integration.spec.ts` (7 tests): a request written with a sign-off's audit event in one transaction is answered by the running worker with an anchor of reason `SHIFT_CLOSE` whose sequence is at or past that event's chain row, once.

## Mutation checks (each applied alone, its spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `judgeForceClose` no longer refuses the cashier | red: 1 of 14 |
| 2 | The database without `ck_shift_close_checker` | red: 1 of 14 |
| 3 | `judgeLateCount` no longer refuses the force-closer | red: 1 of 14 |
| 4 | `pos.shift_late_count_guard` without the force-closer check | red: 1 of 14 |
| 5 | `judgeLateCount` no longer refuses the cashier | red: 1 of 14 |
| 6 | `pos.shift_late_count_guard` without the cashier check | red: 1 of 14 |
| 7 | POS's `TillCash` answers a force-closed shift as open | red: 7 of 20 (`till-cash-paths`): every application cell but the cash movement's |
| 8 | POS publishes a force-closed shift as taking entries (database) | red: 5 of 20 and 1 of 14 |
| 9 | `recordCashMovement` without its open-shift check | red: 2 of 34 (one in each spec) |

## Test first, as it honestly happened

- Unit tests first, seen red (6 failing) before `judgeForceClose` and `judgeLateCount` existed.
- The migration, the application code and the integration spec were written next, then run: 3 of 14 red on the first run, all test errors (a raw update missing its version step, an untyped SQL parameter, and an update the application role holds no privilege for, now asserted as `42501` with the immutability trigger checked); fixed in the test, no assertion weakened.
- The contract spec's first run was red (the cashier already had a shift open in an earlier test); it uses its own cashier now.
- The full integration run was red in one test I had not updated: the B9b X report's exact `toEqual` lacked the new `forceClosed: false`; the field was added to the expectation.

## Decisions

- **ADR-0078 (proposed):** a force-closed shift posts nothing until a third person counts its drawer.
- **ADR-0006 Amendments:** the anchor at every shift close through request rows the worker answers.
- Everything else is in A-275.

## Security review (hakorem-security-review)

The same finding goes into the pull request body.
- **Boundary:** TB2 (back office: the force close and the count), TB8 (the database: the new guards), TB7 (the worker as the sealer).
- **The standards, item by item:** SC-01 strict zod bodies, exact integers; SC-02 both handlers authorise in the application layer at the till's branch and location, deny by default, wrong roles and another branch tested, both join the route walks; SC-03, SC-04 parameterised SQL only; SC-05 kernel `Money`, the over or short by `overShort` and `closeAmounts`; SC-06 idempotency on both writes, a replay answers the first; SC-07, SC-08 events and audit carry ids and pesewas only; SC-14 no external call in a business transaction (the anchor's off-box write is the worker's, outside it); SC-15, SC-16 no empty catch, stable codes with details; **SC-17 maker and checker: the force-closer is never the cashier (`ck_shift_close_checker`), the counter is neither the cashier nor the force-closer (`pos.shift_late_count_guard`), each mutation-checked**; SC-22 `pos.shift_late_count` and both platform tables insert-only, a force-closed shift frozen; SC-23 serializable writes under the shift's row lock; SC-24 both audited.
- **Not applicable, with reason:** SC-09 to SC-11 (existing cookies, CSRF and CORS), SC-12 (no upload), SC-13 (no webhook), SC-18 (no restricted field), SC-19 (no outbound URL), SC-20, SC-21 (CI scans).
- **Abuse case 17:** a force close and its count reach the exception source (`pos.ShiftForceClosed`, and `pos.ShiftClosed` with `forceClosed`). **Residual:** until the drawer is counted, the till's 1000 shows the records' figure; the exception source shows the open force close.

## Deferred

- **B09b continued 1c:** held sales; a cleared provider payment as a counter tender (A-274 (f)).
- **B09b continued 2:** offline sales synced after a force close (OFFLINE_SYNC 9.4.2), with the rest of the sync.

## Contract requests

The frontend's `main` was read at `678f8c9`; it holds CR-001 to CR-044.
- **CR-042, CR-043, CR-044 (new since B09b continued):** placed by the owner in lane B's B09u (ADR-0026 Amendments, its opener); not lane A's. Not built here.
- **CR-031, CR-032 point 6, CR-038:** B09b continued 2. **CR-032 points 1 to 5:** B09b continued 3. **CR-033 points 1 and 2:** B09b continued 4. **CR-039 to CR-041:** lane B.
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | 134 files, 1,596 tests passed. |
| Integration (full suite) | 133 files, 1,699 of 1,700 passed; the one red was my own missing `forceClosed: false` in the X report's expectation, fixed, and that spec then passed 18 of 18. The new and changed specs: force close 14, till cash paths 20, shift close 18, worker 7, all green. |
| Contract | 46 files, 122 tests passed (after the contract spec's own cashier). |
| Coverage | No pricing, ledger, stock valuation or distribution code changed; the 100 percent gates are CI's. |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check`, versioning | Clean. |
| End to end, setup, the image, the scans, the rollback of the last migration | Run in CI. |

Nothing was re-run to turn red into green.

## Gate

**This part's gate passed:** a force close by a manager who is not the cashier, with a step-up and a reason, closes the shift at its expected cash derived by SQL (25,000), flagged force-closed and posting nothing; the variance is posted when the drawer is counted later by a third person (24,750, short 250, T1 back to 0); the checker is never the cashier and the counter is neither, in the handler and in the database, each mutation-checked; cash naming the force-closed shift is refused on every cash path of ADR-0077 with the real operation; every sign-off is anchored by the worker. Held sales and the provider tender are B09b continued 1c's gate.

## Notes for the frontend track

- **2.8.0.** The back office can force-close an abandoned shift (`forceCloseShift`, step-up, a reason) and later count its drawer (`countForceClosedShift`, by someone who neither ran nor force-closed it). Show `forceClosed`, `forceCloseReason`, `countedBy` and `countedAt`; expected cash stays null until the count.

## CI

- **`43bda41`** (the code and docs head after the rebase on `main` at `25d2844`, pull request #105): run **44238378529 (push)** succeeded and run **44238411587 (pull_request)** succeeded. Nothing was re-run.
- The runs on the head that adds this line are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 1c, copied from `docs/prompts/session-openers.md` (written by this split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b2b-pos-force-close-held.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md (sections 2 and 11),
ADR-0027, ADR-0077, ADR-0078, A-274 and A-275 in docs/ASSUMPTIONS.md, and the abuse cases 3 and 4 in
docs/security/THREAT_MODEL.md. Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 1c only, on branch b09b2c-pos-held-provider-tender, branched from main: held sales
(holdSale, listHeldSales, recallHeldSale on the till's open shift, pos.held_sale, re-priced on recall with exact pesewas
after a price change between hold and recall, recalled once (404 the second time), lapsing at the shift's close and at
its force close); a mobile money or card tender at the counter as a payment the provider already cleared
(TenderInput.paymentId, FR-POS-006): the payment must be linked to its sale so ORD's reads and a void see it (A-274 (f):
the cleared payment is frozen, so decide the link with an ADR and ask the parent session before changing an existing PAY
or ORD shape; the additive ORD change is in src/modules/ord/application/sale-posting.ts only), allocated once by
paymentId through SalePosting.postIn, never another customer's or another shift's nor one not yet cleared, test-first
with exact pesewas. Every write gets its wrong-role refusal test; every new read joins the identifier walk.
Stop at the gate and write docs/sessions/B09b2c-pos-held-provider-tender.md.
```
