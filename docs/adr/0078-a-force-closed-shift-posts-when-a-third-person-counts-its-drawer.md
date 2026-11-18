# ADR-0078: A force-closed shift posts nothing until a third person counts its drawer

- **Status:** Proposed (2026-11-17)
- **Date:** 2026-11-17
- **Session:** B09b continued 1b
- **Deciders:** backend track; owner approves

## Context

FR-POS-020: a manager force-closes a shift that was abandoned (the tablet died, the cashier went home), with a reason; "the shift closes at its last known expected cash, a variance is posted when the cash is later counted". The blind close of B9b is two people: the cashier declares the count, a supervisor who is not the cashier signs it off (`ck_shift_close_checker`), and the sign-off posts the over or short (Cr 1000 expected, Dr 1010 counted, 6900 the difference). A force close removes the cashier from that pair. If the manager who forces the close may also count the drawer and post the over or short, one person both decides the shift is over and says what was in it: the gap abuse case 17 (a shift closed short) names. OFFLINE_SYNC 9.4.2 shows a manager force-closing after counting the drawer; FR-POS-020 and the B09b continued 1b opener say the variance is posted when the drawer is counted later.

## Options considered

1. **The force close takes the manager's count and posts it.** One step, as OFFLINE_SYNC 9.4.2 tells it. One person decides and counts: no check on either.
2. **The force close posts the expected cash to a suspense account, the count clears it.** Moves the cash out of the till's 1000 before anyone has seen it, and needs a new account and two postings for one count.
3. **The force close posts nothing; the drawer is counted later by someone who is neither the cashier nor the force-closer, and that count posts as a sign-off does.**

## Decision

Option 3.

- `forceCloseShift` (`pos.shift.force_close`, step-up): a manager who is not the shift's cashier (`judgeForceClose`; the database's `ck_shift_close_checker` on `close_approved_by`, the force-closer) closes an **OPEN** shift with a reason. It becomes CLOSED, `force_closed`, `force_close_reason`, at its expected cash (`expected_cash_pesewas`, frozen) with nothing declared. No journal: the till's 1000 keeps the cash until it is counted. The shift stops taking entries at once (the platform's published entry state), so ADR-0077's rule refuses every cash path through it. Its expected cash stays hidden from every reader until the count. `pos.ShiftForceClosed` carries abuse case 17 for the exception source.
- `countForceClosedShift` (`pos.shift.close.approve`, step-up, new in 2.8.0): a supervisor who is **neither the cashier nor the force-closer** counts the drawer once into `pos.shift_late_count` (LEDGER). The over or short is the count less the frozen expected cash; ◆ `pos.ShiftClosed`, marked `forceClosed` with `forceClosedBy`, posts it exactly as a sign-off does; the Z report is stored and the audit chain anchored (ADR-0006 Amendments).
- The database holds it: `ck_shift_steps` gains the force-closed CLOSED step and refuses the flag on any other; `pos.shift_guard` lets OPEN become CLOSED only by a force close; `pos.shift_late_count_guard` refuses a count of a shift not force-closed, by its cashier, by its force-closer, by someone without the sign-off permission at its branch, or against any other expected figure.

## Consequences

- Two people stand behind every posted over or short of a till, force-closed or not. A branch with one manager has the Owner count the drawer.
- Until the count, the till's 1000 shows the cash the records say is there, and the shift's report shows no over or short; the daily exception report's source has the force close (`pos.ShiftForceClosed`).
- Offline sales synced after the force close (B09b continued 2) post on the first open date, flagged, as OFFLINE_SYNC 9.4.2 says; whether their cash is in the count is the accountant's reading of the exception, as there.
- Binds `docs/data-model/pos.md`, the POS card, `docs/API.md`, THREAT_MODEL abuse case 17, A-275.

## Verification

- `src/modules/pos/domain/till.spec.ts`: `judgeForceClose` and `judgeLateCount`, written before the code and seen red.
- `test/integration/pos/force-close.integration.spec.ts` (14 tests): the drawer derived by SQL (20,000 + 6,000 + 4,000 - 5,000 = 25,000); wrong roles, another branch, a stale step-up refused; a manager force-closing her own shift refused in the handler and by `ck_shift_close_checker`; the close at 25,000 with no journal and T1's 1000 unchanged; no sale, movement or declaration after it; a CLOSING shift refused; the count refused to the force-closer and the cashier in the handler and in the database, and to the accountant, another branch and a cashier; a count of 24,750 posting Cr 1000 25,000, Dr 1010 24,750, Dr 6900 250 with T1 back to 0 and the trial balance at zero; counted once.
- Six mutations, each turning that spec red (the B09b continued 1b report lists them).
