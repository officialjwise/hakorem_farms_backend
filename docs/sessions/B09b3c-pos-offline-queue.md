# B09b continued 2c: the queue's shift opens and cash movements, and the unverified tender

Date: 2026-11-18 · Branch `b09b3c-pos-offline-queue`, from `main` (`48c9226`, rebased onto `97e562f` after lane B's B10 continued merged) · Lane A · Status: **gate passed, no split.** The next lane A phase is B09b continued 3 (the till PIN).

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

One row, A-279, lettered. (f) is the parent session's interim reading, **not the owner's ruling**, and stays Open with A-278 (e).

| ID | What | Who confirms |
| --- | --- | --- |
| A-279 (a) | No split: all three items built. | Owner |
| A-279 (b) | A shift from the queue is `openShift` with the register's device credential: its hours-old `openedAt` kept; within the tolerance it is an online open at the server's time; more than the tolerance ahead of the server, or before the till's previous shift closed by more than it, it opens at the server's time and is flagged `TILL_CLOCK_OUT_OF_TOLERANCE`, never refused; older than `sync.max_sale_age_hours` flagged `OFFLINE_SHIFT_TOO_OLD`. Without a credential, B9b's online rule stands. | Owner |
| A-279 (c) | `OfflinePack.nextShiftSeq` and `ShiftOpen.shiftSeq` (both optional): the server's sequence stands, a different one is `SHIFT_SEQ_DIFFERS`; the sales then get `PROVISIONAL_REF_MISMATCH` as A-278 (j) holds. | Owner |
| A-279 (d) | The second of two devices opening one till offline: 422 `SHIFT_ALREADY_OPEN` `REGISTER_HAS_OPEN_SHIFT` (the contract's code since 2.5.0, not OFFLINE_SYNC 10's 409, so no shape changes), raised `OFFLINE_SHIFT_REFUSED` URGENT in its own transaction, every attempt. | Owner |
| A-279 (e) | Cash movements: decided once by client id in `pos.cash_movement_sync`, answered the same forever (a refusal is never applied later); after the batch's sales in the till's order; `recordCashMovement`'s rules against what the till holds then; a drop with no witness is unwitnessed and marked (the till cannot know who was signed in); a named witness must be a supervisor at the branch; till time kept, clamped and flagged outside the tolerance; attributed to the shift's cashier; a revoked `pos.cash.move` raised `AUTHORISATION_FAILURE`. | Owner |
| A-279 (f) **interim** | A closed, closing or force-closed shift's movement is recorded nowhere, `REJECTED` `SHIFT_NOT_OPEN`, raised; decided by the same `tillTakesCash` as a sale's cash (A-278 (e)), so one ruling by the owner changes both. | Owner, Accountant |
| A-279 (g) | The unverified tender is taken only while the branch allows it, only mobile money, only with `unverifiedMobileMoney`, only onto its own open shift and only with a wallet to hold it in; break REVIEW, URGENT when the pack did not offer the method or the named approver is no supervisor (or is the cashier). Anything else is not recorded, `UNMATCHED_PAYMENT` URGENT. A card is never taken unverified. | Owner |
| A-279 (h) | Recorded PENDING `UNVERIFIED` (the database never clears an unverified payment, `ck_payment_verified`; OFFLINE_SYNC 9.9's "cleared" read as "posted at receipt", as a cheque), allocated after the cash, posted **Dr 1110 against the farm's mobile money wallet** (9.9's account; never 1120, no provider took it; migration 0263 adds one determination row), Cr 1200. No wallet: not taken. | Owner, Accountant |
| A-279 (i) | The break carries `unverifiedWindowDays` and `urgentFrom`; nothing yet raises it to URGENT on that day (BL-086). | Owner |
| A-279 (j) | The unverified tender is in neither the shift's cash nor its tender totals, nor on the X and Z reports (BL-087). | Accountant |
| A-279 (k) | A manager cannot send a cashier's queued shift open for them (`ShiftOpen` names no cashier) (BL-088). | Owner |

**Contract 2.15.0, additive** (built as 2.14.0 and renumbered at the merge slot above lane B's 2.14.0): `ShiftOpen.shiftSeq` and `OfflinePack.nextShiftSeq` are new and optional; `openShift` and `syncOfflineSales` descriptions now state the queued open, the per-movement answers and the unverified tender; `CASH_MOVEMENT_NOT_TAKEN_AT_SYNC` is no longer answered (a behaviour the till relies on, named in the changelog). No field removed or retyped, no status or error code changed.

**No ADR conflict stopped the work.** No new ADR; ADR-0026, ADR-0027 and ADR-0077 gain Amendments notes. Migrations renumbered at the slot: `0262_pos_cash_movement_sync`, `0263_fin_unverified_mobile_money` (built as 0258 and 0259). The determination row's id sits in lane A's block (`...8200-000000000280`).

**Lane B's files:** none edited. ORD's `sale-posting.ts` was not touched: the unverified tender is recorded by POS through PAY after `postOfflineIn` returns, in the same transaction, and ORD reads an order's payments through PAY. Shared modules changed additively only: PAY (`UnverifiedTenders`, optional event fields, a break kind in the type), FIN (`BankAccounts.mobileMoneyWalletIn`, the posting branch for a payload marked `unverified`, one determination row), the contract.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 2c (`b09b3c-pos-offline-queue`, from `main`), lane A.
2. **Scope:** a shift opened offline and synced later; the cash movements of a sync batch; the unverified mobile money tender through PAY.
3. **Gate:** a shift opened offline is applied once at sync with its till time; a batch's cash movements are applied exactly once on their own open shift and answered per movement; an unverified mobile money tender is recorded `UNVERIFIED` with its `UNVERIFIED_PAYMENT` break only while the branch allows it; each test-first, every figure by SQL.

## Built

| Area | What |
| --- | --- |
| POS domain | `domain/offline-queue.ts` (100 percent gate): `offlineShiftOpenTime`, `cashMovementTimeAtSync`, `priorMovementAnswer`, `unverifiedTenderVerdict`, `inMovementOrder`. |
| POS application | `Shifts.open` with the device credential; `OfflineSync` applies `cashMovements` and records the unverified tender; the pack's `nextShiftSeq`; events `pos.OfflineShiftFlagged`, `pos.OfflineCashMovementFlagged`. |
| POS data | `pos.cash_movement_sync` (LEDGER, migration 0262) with `uq_cash_movement_sync_decided` and `pos.cash_movement_sync_guard`. |
| PAY | `UnverifiedTenders` (`recordIn`, `walletIn`), `domain/unverified.ts`; `pay.PaymentCleared` marked `unverified` with its wallet; `pay.ReconciliationBreakRaised` optional `severity`, `abuseCases`, `details`. |
| FIN | `BankAccounts.mobileMoneyWalletIn`; `paymentClearedAmounts` holds an unverified tender in its wallet (determinant `UNVERIFIED_MOBILE_MONEY` → 1110, migration 0263). |
| Docs | A-279, BL-086 to BL-088, the changelog, API.md, the POS, PAY and FIN cards, `data-model/pos.md` and `pay.md`, OFFLINE_SYNC's as-built note, abuse cases 4 and 17, ADR-0026, ADR-0027 and ADR-0077 Amendments, the B09b continued 3 opener (the PIN checks the approver and the witness this phase records). |

## The gate, proved by running it (`test/integration/pos/offline-queue.integration.spec.ts`, 19 tests)

Every figure by SQL over `pos.shift`, `pos.cash_movement`, `pos.cash_movement_sync`, `pay.payment`, `pay.reconciliation_break`, the journal lines and the outbox; every expected cash figure derived from the tables alone.

**A shift opened offline:** Kofi's till sends a shift opened five hours earlier with a float of 20,000 and the pack's `nextShiftSeq`: `opened_at` is the till's time, the sequence the pack gave, the float movement at the till's time, Dr 1000 20,000 / Cr 1010 20,000 posted on that date, no flag. Sent again: the same answer, one shift, one float movement, one journal. A till clock 301 seconds ahead opens at the server's time and is flagged `TILL_CLOCK_OUT_OF_TOLERANCE` (with the device, cashier and till); 300 seconds ahead is an online open, unflagged. Two devices on one till: the second (Abena, device Q4b, float 5,000) is 422 `REGISTER_HAS_OPEN_SHIFT`, no shift or document row, raised `OFFLINE_SHIFT_REFUSED` URGENT naming Yaw's open shift. A provisional sequence four ahead is flagged `SHIFT_SEQ_DIFFERS`, the server's kept. Refused, recording nothing: the storekeeper (403), an online open two hours old (`OPENED_AT_OUT_OF_WINDOW`), a revoked device (403 `DEVICE_REVOKED`), another till's device (403), an unknown credential (401).

**The batch's cash movements:** two sales (18,000 and 12,000), then a pay-out 1,500, an unwitnessed drop 25,000, a drop 2,000 witnessed by the manager and a pay-in 5,000, each hours old: `APPLIED` each, at the till's times, by Kofi; the till holds 20,000 + 30,000 - 1,500 - 25,000 - 2,000 + 5,000 = **26,500** by the tables and by 1000 over the shift's documents; 1010 -20,000 + 27,000 - 5,000; 6800 1,500; 1200 -30,000 for the payments; each movement's journal on its own date. Sent again whole: every movement and sale `DUPLICATE`, counts and 26,500 unchanged, four `DUPLICATE` log rows. A pay-out recorded online and then sent: `DUPLICATE`; an id reused at 1,600: `REJECTED` `ID_REUSED_WITH_OTHER_CONTENT`, the movement still 1,500, raised URGENT. A drop of one pesewa more than the till holds: `REJECTED` `TILL_OVERDRAWN`, nothing recorded, raised once; after a later sale of 6,000 lets the till cover it, sent again: `REJECTED` `TILL_OVERDRAWN` again, the second log row answering the first. A movement 301 seconds ahead: applied at the server's time and flagged; 300 seconds kept. The database refuses a second deciding row (`uq_cash_movement_sync_decided`), any update (`HK001`) and an applied row with no movement of its own (`HK010`).

**ADR-0077 offline, each through the sync path:** another cashier's shift: the batch is refused whole (403), nothing recorded; a closed shift (Esi's, declared and signed off by the manager): `REJECTED` `SHIFT_NOT_OPEN`, nothing recorded, the frozen expected cash and status unchanged, raised URGENT with the status; a force-closed shift (Ama's, by `forceCloseShift`): `REJECTED` `SHIFT_NOT_OPEN`, no movement but its float on it, raised URGENT.

**The unverified tender:** with the branch setting off, a mobile money tender of 12,000 is not recorded, no break, `UNMATCHED_PAYMENT` URGENT. With it on (OFFLINE_SYNC 9.9's sale, 5 crates = 30,000: mobile money 20,000 approved by the manager, cash 10,000): `APPLIED` with no exception; the payment PENDING `UNVERIFIED`, 20,000 allocated, on the shift and its till, the customer's reference and the phone masked `+233 24 *** *142`, received at the till's time, never cleared, in the farm's wallet; the receipt fully settled; **1110 +20,000 against the wallet, 1120 0, 1000 +10,000, 1200 0**; the break `UNVERIFIED_PAYMENT` OPEN 20,000 REVIEW, the approver as the till says (`approvalVerified: false`, a supervisor), the cashier, shift, sale, till, network, `unverifiedWindowDays` 3 and `urgentFrom` three days after the sale; its event carries REVIEW and abuse case 4; the shift's cash is 10,000 only. An approver who is the cashier: recorded, the break URGENT. Onto a force-closed shift: not recorded, `UNMATCHED_PAYMENT` URGENT `SHIFT_NOT_OPEN`. The sale sent again: `DUPLICATE`, still two unverified payments and two breaks, two break events.

## Mutations

Each applied alone to the committed source, the spec run, the source restored from git (`git status` clean afterwards).

| # | Mutation | `offline-queue` (19 tests) |
| --- | --- | --- |
| M1 | `tillTakesCash` takes money on any shift (ADR-0077 offline) | red: 3 failing |
| M2 | a refused movement is judged again on a later sync | red: 1 failing |
| M3 | a queued shift opens at the server's time | red: 6 failing |
| M4 | `openShift` ignores the device credential | red: 19 failing |
| M5 | the branch setting is not judged for the unverified tender | red: 2 failing |
| M6 | the queued movement's open-shift check removed | red: 2 failing |
| M7 | the unverified tender posts as any mobile money (1120) | red: 3 failing |

## Test first, as it honestly happened

- The domain unit spec was written first and seen red (the module did not exist), then green (13, later 15). The FIN unit tests for the wallet posting were written first and seen red (2 failing), then green. PAY's `unverifiedUrgentFrom` test came with its function, after lint moved the date arithmetic into PAY's domain.
- `Shifts.open`'s application change was written before the integration spec; the spec was then written for all three items and run before the cash movements and the unverified tender existed: 15 of 15 red (the shift-open tests failed on the pack's missing `nextShiftSeq` and `shiftSeq`). Faults found by it and fixed in the code: the 1120 posting needed a provider party the offline tender has none of, which led to A-279 (h) and the wallet. Test corrections, each because the test was wrong: a fuel pay-out needs its note (the reason's own rule).
- B09b continued 2b's test of the interim answer `CASH_MOVEMENT_NOT_TAKEN_AT_SYNC` now asserts the rule that replaces it (a pay-out with no note `REJECTED` `NOTE_REQUIRED`, raised).

## Contract requests (the frontend's `main` at `a0059c7`)

- **CR-051** (the offline pack names its units: `OfflinePack.uoms`): **not built in this phase, small and additive, named for scheduling.** It arrived after the opener; the phase was at the merge slot when it was weighed, and it needs an MDM unit read and the pack's tests. It fits B09b continued 3, which reads the pack, or a short phase of its own.
- **CR-032** (the till PIN) and **CR-050** (the drop witness): B09b continued 3, as placed; this phase records the approver and the witness for it to verify.
- **CR-033 points 1 and 2:** B09b continued 4. **CR-031 and CR-038:** answered in B09b continued 2b.
- **CR-039 to CR-049:** lane B's; not touched. Everything else answered in earlier phases. Nothing declined.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3, the POS device on shop wifi (the queue it sends), and the database.
- **Input:** strict schemas (unknown fields 400), `shiftSeq` an integer 1 to 1,000,000, the movement as `CashMovementCreate`; parameterised SQL only.
- **Authorisation, deny by default in the handlers:** `pos.shift.open` at the register for a queued open, then the device credential of that register (revoked 403, foreign 403, unknown 401); the sync's existing rules for the batch; each movement attributed to the shift's cashier, a revoked `pos.cash.move` raised. Wrong roles and devices tested.
- **Replay and tampering:** a shift once by its id; a movement once by its client id, held by `uq_cash_movement_sync_decided`; a refusal never applied later; other content under an id refused and raised.
- **Money paths (abuse case 4):** no payment is cleared on the device's word: the unverified tender is PENDING and never CLEARED (`ck_payment_verified`), only while the branch allows it (off by default), held in the wallet (1110) with a break until a statement matches it; the named approver is the till's word until the PIN (B09b continued 3), and a non-supervisor makes the break URGENT. Cash only onto its own OPEN shift (ADR-0077, `TillShiftCheck` and PAY's 0239 trigger for the unverified tender, `pos.cash_movement_guard` for movements).
- **Abuse case 17:** a refused queued movement and a refused second offline shift are raised URGENT with abuse case 17; an unwitnessed queued drop carries it on `pos.CashDropped`. Threat model rows 4 and 17 updated; the sources are `pos.OfflineShiftFlagged`, `pos.OfflineCashMovementFlagged` and `pay.ReconciliationBreakRaised`; B12 projects them.
- **Logging:** the payer's phone stored and raised masked; no credential logged; the rejected movement's audit carries the claim, no secret.
- **Database:** `pos.cash_movement_sync` LEDGER, insert only, grants by class; no now() in business SQL.
- **Findings:** [accepted, recorded] the unverified tender's approver is unverified until the PIN (B09b continued 3); [accepted, recorded] no sweep raises an unmatched break to URGENT after the window (BL-086).
- **Not applicable, with reason:** cookies, CSRF and CORS unchanged (the routes keep the CSRF token); no upload, webhook, outbound URL or export; no maker-checker change; scans run in CI.

## Deferred

- **BL-086** the window's escalation; **BL-087** the unverified tender on the X and Z reports; **BL-088** a manager sending a cashier's queued shift open. **BL-078** stays open for `recordCashMovement` online (the queue's movements and opens now check the device).
- **CR-051** (named above).

## Tests (this machine, 2026-11-18, on the rebased branch)

| Layer | Result |
| --- | --- |
| Unit | 147 files, 1,743 tests passed. `pos/domain/offline-queue.ts` and PAY's new domain file are under the 100 percent gate. |
| Integration | Full suite on the rebase onto `97e562f`: 151 files, 1,865 tests passed on its first run (before the rebase: 1,849 of 1,849). Nothing re-run. |
| Contract | On the rebase: 49 files, 130 tests passed (before it, 48 and 129). |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI. |

## Notes for the frontend track

- **2.15.0:** send a shift opened offline to `openShift` with the device credential and the client id as `Idempotency-Key`, its real `openedAt` and the `shiftSeq` you printed (from the pack's `nextShiftSeq`). A 422 `REGISTER_HAS_OPEN_SHIFT` means another device holds the till: keep the queue and show it to a manager.
- `cashMovementResults` is now real: store each answer; `REJECTED` means recorded nowhere, show the reason, never resend it hoping for a different answer.
- An unverified mobile money tender (setting on) gives the sale `APPLIED` with no exception; the break is the manager's.

## CI

The runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 3, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b3c-pos-offline-queue.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0016, ADR-0027, and the abuse cases 4, 10 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 3 only, on branch b09b4-pos-till-pin, branched from main: decide CR-032 point 2, the
offline PIN verifier (an operation that sets a till PIN and the salted verifier the device stores, or a statement in
OFFLINE_SYNC.md that the device derives it from the PIN typed at an online sign-in), record it as an ADR and answer it in
the report. The owner's rules for the till PIN (CR-032, 2026-11-17), which the frontend already enforces on the device
and the server must match, each test-first: a PIN verifier is PBKDF2-SHA256 with at least 600,000 iterations and a
random salt of at least 16 bytes per person, never weaker (refuse a weaker verifier, and test the parameters); at most
five wrong tries, enforced on the server too (counted at sync for offline attempts and at any online check, then
locked); signing out a locked cashier requires a supervisor's PIN, is audited, and reaches the daily exception report's
source (B12). The PIN never authenticates to the server and is never the only control (CR-032 point 5). An approval made
offline records which PIN approved it (CR-032 point 4) and is verified at sync: the unverified
mobile money tender's approver, kept on its UNVERIFIED_PAYMENT break as the till's word (A-279 (g)), and a queued cash
drop's witness, which sync records as named or unwitnessed (A-279 (e)), are checked against the PIN here. Load hakorem-security-review and write
its finding into the pull request body.
The drop witness (owner, 2026-11-18, from the frontend's till shift session; placed here, ADR-0026 Amendments), each
test-first:
1. A drop's witness is a supervisor who confirms by entering their PIN on the till, checked with the same rules as the
   till PIN (PBKDF2-SHA256 with at least 600,000 iterations and a 16-byte salt, five tries). Record the witness as
   PIN-verified. A named supervisor without a PIN is not a witness.
2. A read of which supervisors are signed in at the till's branch, so the till can offer them as witnesses. The server
   already accepts an unwitnessed drop when none is signed in (contract 2.6.0, A-273 (d)); keep that, and make the
   drop's witness rule use the same "signed in at the branch" source the new read answers from.
3. This is the frontend's request "Who can witness a cash drop now, and a drop with no witness when nobody can". The
   frontend renumbered it: it was CR-045 at the frontend's main `37e5c98`, and is **CR-050** at `81525f1` (its PR #30,
   the till's F10j session), where CR-045 is now the quote line's unit and CR-045 to CR-049 are lane B's quote and
   wholesale requests. Answer it as committed on the frontend's main when you read it, going by what the request
   says there, not by a number from an earlier message.
Stop at the gate and write docs/sessions/B09b4-pos-till-pin.md.
```
