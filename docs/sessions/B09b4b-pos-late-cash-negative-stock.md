# B09b continued 3b: late cash on a closed shift (split; negative stock offline and the clearing account move to B09b continued 3c)

Date: 2026-11-22 (opened 2026-11-18; the owner's rulings it builds are dated 2026-11-18) · Branch `b09b4b-pos-late-cash-negative-stock`, from `main` (`475378e`) · Lane A · Status: **split at a sub-domain boundary after its gate (A-281 (a)).** Built: the owner's decisions 0 and 1. Decisions 2 (negative stock offline) and 3 (the mobile money clearing account) move whole to **B09b continued 3c**, inserted before B09b continued 4; nothing of either was started.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-19)

One row, A-281, lettered; and two status changes the owner made (decision 0).

| ID | What | Who confirms |
| --- | --- | --- |
| A-279 | **Approved by the owner (2026-11-18), (a) to (k)**, with (f) amended (late entry, built here) and (h)'s Dr 1110 to be replaced by the clearing account (B09b continued 3c). | Owner (done) |
| A-278 (e) | **Approved by the owner as amended**: late cash recorded on its own shift as a late entry, never "recorded nowhere" (built here). | Owner (done) |
| A-281 (a) | The split: decisions 0 and 1 built and gated; decisions 2 and 3 (two more sub-domains, INV's stock and cost, PAY's and FIN's clearing) moved whole to B09b continued 3c. | Owner |
| A-281 (b) | One model for every shift state: the close leaves late entries out and each posts its own post-close adjustment at sync, whether the shift is CLOSING, signed off, force-closed and uncounted, or counted; order does not matter. | Owner, Accountant |
| A-281 (c) | A late entry is the shift's own cashier's only, never a recovering manager's (PAY and the database refuse `SHIFT_NOT_OWN`). | Owner |
| A-281 (d) | Only cash into the till as the till recorded it (a sale's cash, a drop, a pay-out, a pay-in); nothing leaves a closed shift late; every online path refuses as before. | Owner |
| A-281 (e) | `OFFLINE_LATE_CASH` URGENT when dated after the shift's close, REVIEW otherwise; the supervisor reviews it on the exception report's source, no review operation (BL-100). | Owner |
| A-281 (f) | The late payment and movement keep the till's time; the adjustment is dated at sync. | Accountant |
| A-281 (g) | Shift reads keep the close's figures; movements answer `lateEntry`; the adjusted over or short is the journal's (BL-101 for a read). | Owner, Accountant |
| A-281 (h) | An unverified mobile money tender on a closed shift stays not recorded (`UNMATCHED_PAYMENT`, URGENT): not cash in the drawer; B09b continued 3c may revisit. | Owner |
| A-281 (i) | A late movement is judged by `recordCashMovement`'s rules, the till's holdings counting earlier late entries; a drop the records never held is refused `TILL_OVERDRAWN`. | Owner |
| A-281 (j) | Contract 2.18.0, LOUD for the sync: `OFFLINE_LATE_CASH` replaces `OFFLINE_CASH_NOT_TAKEN`; a closed shift's movement `APPLIED`, no longer `REJECTED` `SHIFT_NOT_OPEN`; `CashMovement.lateEntry` new. | Owner |

**Contract 2.18.0, LOUD for `syncOfflineSales` on a closed shift, otherwise additive.** No field removed or retyped; one new optional field (`CashMovement.lateEntry`, always sent); no operation, status or error code new or removed. **Behaviour:** queued cash on a closing, closed or force-closed shift is recorded on that shift as a late entry (`OFFLINE_LATE_CASH`) instead of not recorded (`OFFLINE_CASH_NOT_TAKEN`); a queued movement on such a shift is `APPLIED` instead of `REJECTED` `SHIFT_NOT_OPEN`.

**No ADR conflict stopped the work.** ADR-0077 gains the owner's amendment (its intent kept: one deciding function, never another shift or another cashier's, every online path unchanged). ADR-0003 gains the row `pos.ShiftLateEntryPosted` ("Applied in B09b continued 3b"). ADR-0026 Amendments: the split. Migrations `0272_pay_late_entry`, `0273_pos_late_entry`, `0274_fin_pos_late_entry_postings`, renumbered at the merge slot if lane B merges first.

**Lane B's files:** none edited. ORD's `sale-posting.ts` was not touched (the late cash is recorded by POS through PAY after the sale posts, as the unverified tender is). Shared modules changed additively only: PAY (a column, an optional `TenderRequest.lateEntry`, `NewPayment.lateEntry`, `TillCashRequest.lateEntry`, two refusal codes; `shiftTotals` leaves late entries out, and the 0239 trigger function is replaced to judge a late entry by a new function, every other payment by 0239's rule unchanged: PAY's till-cash rules, lane A's until its phases end), FIN (one event type, four rule rows, one index, the event in `TILL_POSTING_EVENTS`), the BIL rollback test's list (three names), the contract.

**For the parent session to schedule:** CR-057 point 1 (a driver's cash handed in at a till shift) needs both lanes: DEL's reconciliation (lane B) and POS's and PAY's till-cash rules (lane A). It is B11's request; it is not built here.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 3b (`b09b4b-pos-late-cash-negative-stock`, from `main`), lane A.
2. **Scope:** the owner's decisions 0 to 3 of 2026-11-18: A-279's approval and OFFLINE_SYNC section 10's 422; late cash on a closed shift; negative stock offline; the unverified tender's clearing account.
3. **Gate:** late cash recorded on its own shift as a late entry with its post-close adjustment; an offline sale below zero valued and trued up with a count task; the unverified tender in its own clearing account until verified; each with exact pesewas by SQL. **Split after the first part's gate (A-281 (a)).**

## Built

| Area | What |
| --- | --- |
| POS domain | `tillTakesCash` now answers `ON_SHIFT` or `LATE_ENTRY` (the one deciding function, sales and movements alike); `lateEntrySeverity`, `lateEntryShiftState` (`offline-sync.ts`, 100 percent gate); `judgeLateTillCash`, `lateEntryEffect`, `lateEntryAdjustment`, `LateEntryKind` (`till.ts`). |
| POS application | `OfflineSync`: a late sale's cash is recorded after the sale posts through `Payments.recordIn` with `lateEntry`, allocated to the receipt; a late movement is `APPLIED` on its shift; each writes `pos.shift_late_entry` and publishes ◆ `pos.ShiftLateEntryPosted` (`lateEntryIn`), raised `OFFLINE_LATE_CASH`; what the till holds counts earlier late entries. `TillCash` judges a late entry by `judgeLateTillCash`. `CashMovementView.lateEntry`. |
| PAY (shared, additive; its till-cash rules are lane A's) | `TenderRequest.lateEntry`, `NewPayment.lateEntry`, `TillCashRequest.lateEntry`, refusals `SHIFT_STILL_OPEN`, `LATE_ENTRY_ONLY_IN`, `LATE_ENTRY_ONLY_CASH`; `shiftTotals` leaves late entries out. |
| Data | `0279_pay_late_entry` (`pay.payment.late_entry`, `ck_payment_late_entry`, `pay.till_shift_late_refusal`, `pay.payment_till_shift` replaced to judge a late entry by it and any other payment by 0239's rule unchanged); `0280_pos_late_entry` (`pos.cash_movement.late_entry`, `pos.cash_movement_guard` replaced, `pos.shift_late_entry` LEDGER with `pos.shift_late_entry_guard`); `0281_fin_pos_late_entry_postings` (`pos.ShiftLateEntryPosted`, rules 280 to 283, `uq_journal_entry_pos_late_entry`). |
| FIN (shared, additive) | `pos.ShiftLateEntryPosted` in `TILL_POSTING_EVENTS`. |
| Docs | ADR-0077 Amendments (the owner's), ADR-0003's row, ADR-0026 Amendments (the split), A-279 and A-278 (e) approved, A-281, BL-100, BL-101, OFFLINE_SYNC section 10's 422 and as-built note, the changelog (2.20.0), the data model (pos, pay), the POS card, the event catalogue, abuse case 17, the openers (B09b continued 3c inserted; B09b continued 4 reads its report). |

## The gate, proved by running it

`test/integration/pos/late-cash.integration.spec.ts` (10 tests), every figure by SQL over `pay.payment`, `pos.cash_movement`, `pos.shift_late_entry`, `fin.journal_line` and the outbox.

- **A late sale on a signed-off shift, cash not handed in.** Float 20,000, counted 20,000, EXACT, the till's 1000 at 0. Synced: one payment of 12,000 on that shift and till, `late_entry`, by the cashier, allocated 12,000 (the receipt's 1200 at 0); the late entry `SALE_CASH`, `RAISES`, `SHORT`, `CLOSED`, REVIEW; the adjustment Cr 1000 12,000, Dr 6900 12,000; the shift's 1000 at 0 and the till's 1000 at 0; **6900 short by exactly 12,000**; `pos.shift` row identical to before; `OFFLINE_LATE_CASH` REVIEW with abuse case 17; resent `DUPLICATE`, nothing twice.
- **Cash handed in.** Counted 26,000 against 20,000, OVER 6,000 at the close; the late sale's adjustment Cr 1000 6,000, Dr 6900 6,000; 6900, 1000 and the till at 0, 1010 at 6,000 (the count to the safe less the float).
- **A late sale on a CLOSING shift.** Declared 26,000, synced before the sign-off (adjustment SHORT 6,000 posted), then signed off: expected 20,000 (the late entry left out), OVER 6,000; 6900, 1000 and the till at 0.
- **A late drop on a force-closed shift.** Drop 5,000 before the force close, counted later 15,000 against 20,000 (SHORT 5,000, Dr 6900 5,000); synced `APPLIED`, the movement on that shift `late_entry` by the cashier; the late entry `CASH_DROP`, `LOWERS`, `OVER`, `FORCE_CLOSED`; the adjustment Dr 1000 5,000, Cr 6900 5,000; 6900, 1000, the till and 1010 all at 0.
- **A late sale after a force close.** URGENT, SHORT 6,000 posted before the count; the count of 26,000 against the frozen 20,000 posts OVER 6,000; 6900, 1000 and the till at 0.
- **Wrong roles.** A storekeeper and another cashier sync the late batch: 403, nothing recorded.
- **PAY and the database.** Through `Payments.recordIn`: a late entry by the manager (who may recover a till) and by another cashier `SHIFT_NOT_OWN`, on another till `SHIFT_OTHER_REGISTER`, on a shift still open `SHIFT_STILL_OPEN`; nothing recorded. By SQL: a late payment on an open shift (`ck_payment_till_shift` `SHIFT_STILL_OPEN`), by another person (`SHIFT_NOT_OWN`), an ordinary payment on a closed shift (`SHIFT_NOT_OPEN`, 0239's rule), a late mobile money payment (`ck_payment_late_entry`); a late movement on an open shift (`ck_cash_movement_late_entry`), by another person (`ck_cash_movement_own_shift`), an ordinary one on a closed shift (`ck_cash_movement_open_shift`); a late entry with a wrong source, direction, amount or shift, a second one for a movement, and any update or delete, each refused; one journal per late entry.

Changed by the owner's ruling (LOUD): `offline-queue.integration.spec.ts` (a closed shift's pay-in now `APPLIED` as a late entry with Dr 6900 400 Cr 1000 400; a force-closed shift's drop the records never held refused `TILL_OVERDRAWN`), `offline-conflicts.integration.spec.ts` (OFFLINE_SYNC 9.4.2's two sales recorded as late entries, each receipt settled, 6900 short 660 until counted, the one after the close URGENT). These three tests failed on the first POS run after the code change, as their old expectations said "recorded nowhere"; nothing else in the 18 POS files failed.

## Mutations

Each applied alone to the committed source, `late-cash.integration.spec.ts` run, the source restored (`git status` clean afterwards).

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `tillTakesCash` always `ON_SHIFT` | red: 8 failing |
| M2 | `shiftTotals` counts late entries | red: 1 failing (the CLOSING test, added for it) |
| M3 | the adjustment's direction reversed | red: 8 failing |
| M4 | `judgeLateTillCash` lets another person in | red: 1 failing |
| M5 | `pay.till_shift_late_refusal` without its holder check | red: 1 failing |
| M6 | `pos.cash_movement_guard` takes a late movement on an OPEN shift | red: 1 failing |

## Test first, as it honestly happened

- The domain specs (`offline-sync.spec.ts`, `till.spec.ts`) were written first and seen red (5 and 3 failing), then green.
- The PAY change, the migrations, the application and the event were written before the integration spec; the spec was then run and found a PL/pgSQL `IF` whose `CASE ... THEN` ended the condition early (a variable now), the business document's column name and two test expectations (a trigger fires before a check, so the check is proved with the triggers set aside in one rolled-back transaction). The CLOSING test was added after M2 first survived the original nine tests. The schema-names check refused a POS trigger reading `platform.business_document`; that read was dropped (PAY's trigger holds the payment side).

## Contract requests (the frontend's `main` at `5242161`)

- **CR-053 to CR-056** (pick lists, picking eggs, a part delivery, the B11 seed): lane B's B11, not touched.
- **CR-057** (a driver's cash handed in at a till shift, and two driver answers): B11's; **point 1 needs both lanes** (DEL's reconciliation and lane A's POS and PAY till-cash rules), named at the top for the parent session to schedule; not built here.
- **CR-052** and **CR-033 points 1 and 2**: B09b continued 4, as placed. Everything else answered in earlier phases. Nothing declined.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3, the POS device on shop wifi (the sync), and the database.
- **Identity, sessions:** unchanged; the sync still needs the staff session and the enrolled device of the shift's till.
- **Authorisation, deny by default in the handler:** the sync's rules stand (the shift's cashier with `pos.sale.create`, or a recovering manager with step-up; another cashier and a storekeeper 403, tested). A late entry is the shift's own cashier's only, in the domain (`judgeLateTillCash`), in PAY (`TillShiftCheck`) and in the database (`pay.till_shift_late_refusal`, `pos.cash_movement_guard`); never another shift (the batch's shift is the device's till's); never out of the till.
- **Input:** no new request field; parameterised SQL only.
- **Money paths (abuse cases 4, 7, 17):** cash kept back from the count can no longer vanish with its sale: the cash is recorded on its own shift and the shift shows short by exactly it, posted at once to 6900 against the till and raised `OFFLINE_LATE_CASH` (URGENT after the close), so a late sale is either handed in or visible as a shortage of that cashier's shift (abuse case 17). A drop recorded late reduces a shortage only by a movement that is judged by the drop rules (witness PIN or unwitnessed and marked, never beyond what the till held) and is itself raised. No mobile money is taken on a closed shift (abuse case 4 unchanged). No stock adjustment path changes (abuse case 7: negative stock offline is B09b continued 3c's).
- **Logging and data:** no new personal data; the late entry's event carries ids and amounts only.
- **Database:** `pos.shift_late_entry` is LEDGER (insert and select, update, delete and truncate refused, tested); the grants schema test covers it.
- **Findings:** [accepted, recorded] a late entry's review is on the exception report's source only (BL-100); [accepted, recorded] a shift read shows the close's figures, the adjustment is on the journal (BL-101); [accepted, recorded] a late drop can reduce a shortage the count found, which is its purpose, and it is raised for review. No new abuse case number: abuse case 17's control text is extended.
- **Not applicable, with reason:** cookies, CSRF, CORS unchanged; no upload, webhook, outbound URL or export.

## Deferred

- **B09b continued 3c:** the owner's decisions 2 (negative stock offline) and 3 (the mobile money clearing account), moved whole. **BL-100** a supervisor's review of late entries; **BL-101** the adjusted over or short on the shift read. BL-082, BL-086 to BL-089 stand.

## Tests (this machine, on the rebase onto `ec8d158`)

| Layer | Result |
| --- | --- |
| Unit | 152 files, 1,810 tests passed. `pos/domain/offline-sync.ts`, `offline-queue.ts` and `till-pin.ts` under the 100 percent gate, met in their own run. |
| Integration | Full suite on the rebase, first run: 158 files, 1,940 tests, **1 failed**: `posting-matrix.integration.spec.ts`'s boot assertion, because POS had not declared `pos.ShiftLateEntryPosted` among its ledger events while FIN handled it (a real defect, fixed in `fix(pos)`: added to `POS_LEDGER_EVENTS`). After the fix, the POS, FIN and PAY folders: 35 files, 461 tests passed. Nothing re-run to turn red green; the full suite runs again in CI. Before the rebase, the first POS run had the three tests the owner's ruling changed failing on their old expectations (rewritten, above). |
| Contract | 51 files, 132 tests passed. |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.20.0:** a sale queued on a shift that has since closed now comes back `APPLIED_WITH_EXCEPTION` with `OFFLINE_LATE_CASH` (no longer `OFFLINE_CASH_NOT_TAKEN`): its cash was recorded on that shift and the receipt is paid. A queued movement on a closed shift answers `APPLIED` (no longer `REJECTED` `SHIFT_NOT_OPEN`). `CashMovement.lateEntry` says which movements arrived so.

## CI

- **At the merge slot (taken 2026-11-22):** rebased onto `ec8d158` (lane B's B10 continued 3 and 3b, contract 2.19.0, migrations up to 0278, the BIL write-off change of ADR-0090 kept as merged); migrations renumbered `0279_pay_late_entry`, `0280_pos_late_entry`, `0281_fin_pos_late_entry_postings` (built as 0272 to 0274), the contract bumped to **2.20.0** above 2.19.0 with its changelog entry above lane B's. Conflicts resolved: the contract (regenerated), the planned version, the changelog, FIN's `postings.ts` (lane B's bad-debt posting kept beside the till events) and the rollback walk's list (both lanes' migrations kept). No BIL function is replaced by this phase's migrations. The `feat(pos)` commit's message still names 2.18.0 and 0272 to 0274, as written before the rebase; the documents say 2.20.0 and 0279 to 0281.
- The pull request merges only when every run on its head is green; the runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it.

## Next session

B09b continued 3c, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b4b-pos-late-cash-negative-stock.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pos.md,
inv.md and pay.md, the POS, INV, PAY and FIN cards in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md (sections 8,
9.3 and 9.9), ADR-0002, ADR-0003, ADR-0018, ADR-0027, A-278 (f), A-279 (h) and (i), A-281 in docs/ASSUMPTIONS.md, and
the abuse cases 4, 7 and 11 in docs/security/THREAT_MODEL.md. Load hakorem-offline, hakorem-stock, hakorem-ledger,
hakorem-money, hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 3c only, on branch b09b4c-pos-negative-stock-clearing, branched from main. The owner's
decisions 2 and 3 of 2026-11-18, moved here whole by B09b continued 3b's split, each test-first:
2. Negative stock offline (replaces A-278 (f)). An offline sale may take a location's stock below zero, since the goods
   were physically sold; value it at the last known cost and true it up when stock arrives; flag it on the exception
   report's source and raise a count task for that product at that location. Online sales keep today's rules, tested.
   INV is shared: changes are additive only; if INV's negative-stock rule needs a change to an existing function, ask
   the parent session first. The true-up on arrival is exact and insert-only (a reversing or adjusting movement, never
   an update). Exact quantities and values by SQL over the movements, the cost and the journal.
3. Unverified mobile money (replaces A-279 (h)'s Dr 1110). It is booked to a clearing account until verified with the
   provider, never straight into the wallet account 1110, the way a cheque waits in 1130, and moves to 1110 only when
   verified, posting exactly once. 1120 is "Payment provider clearing", which holds provider-cleared receipts awaiting
   settlement, not an unverified payment, so the parent session's reading is a new clearing account; confirm it with
   hakorem-ledger and record it as an ADR-0003 amendment. Test the posting, the move to 1110 on verification, and a
   verification that never comes (it stays in clearing past `pay.unverified_window_days` and is raised), with exact
   pesewas.
Load hakorem-security-review and write its finding into the pull request body (abuse cases 4, 7 and 11).
Stop at the gate and write docs/sessions/B09b4c-pos-negative-stock-clearing.md.
```
