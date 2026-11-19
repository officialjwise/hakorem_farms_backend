# B10 continued 3: standing orders and the bad-debt write-off (lane B), split before QUO's remainder

Date: 2026-11-18 to 2026-11-19 · Branch `b10c3-standing-orders-quote-pipeline`, from `main` at `48c9808` (B10 continued 2b, #114), rebased at the merge slot on `main` at `475378e` (lane A's B09b continued 3, #115: migrations renumbered 0272 to 0277 above lane A's 0270 and 0271, contract 2.18.0 above lane A's 2.17.0) · Status: **gate as split passed locally; the phase split at its module boundary (A-322).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-320 | **Standing orders:** (a) `WEEKLY`/`FORTNIGHTLY` on named `weekdays`, `MONTHLY` on a day 1 to 28, `EVERY_N_DAYS` (1 to 365) from the start; the planned enum kept and `EVERY_N_DAYS` added, `weekday` deprecated; (b) only for a customer with an open business account, at the maker's one branch, no named animal, a line with no unit in the base unit; (c) **the job places a credit order, PLACED, and never confirms it**: staff confirm it and CR-046's credit check runs then; the run judges it too and records `HELD_FOR_CREDIT` when the check would refuse it, `SKIPPED_ON_HOLD` for a held account (no order), `SKIPPED_NO_PRICE`, `FAILED` with the reason; (d) once per date by the run key, in the order's transaction under the standing order's row lock; **the job runs hourly**; a date the worker missed is `MISSED` (31 days back at most), never made late; (e) paused makes and records nothing, resume does not make up the dates; (f) delivery refused until B11; (g) read by the Owner, Manager, Sales, Accountant; kept by the Owner, Manager, Sales. | Owner (c, d, f), Sales (a) |
| A-321 | **The write-off:** (a) all or part of an issued invoice, receipt or debit note of a named customer, to the pesewa, never more than outstanding, one waiting per document; (b) asked with `whl.bad_debt.write_off` (the Accountant, **and the Owner**, because IAM lets an Owner grant only a role whose permissions it holds), approved with step-up by a holder of `whl.bad_debt.approve` (the Owner only) who did not ask, in IAM, WHL and the database; (c) on approval BIL's summary takes it off, FIN posts Dr 6940 Cr 1200 against the customer, the insert-only write-off links the entry, the ageing takes it off from that day; (d) **no new payment status**: UNPAID when nothing was paid or credited, else PART_PAID (BL-094); (e) **a system overdue hold of a customer with a write-off is not released by itself**; (f) money received afterwards is never posted as a recovery: the database refuses any allocation onto the amount written off and each payment of such a customer publishes `whl.WrittenOffCustomerPaid` for the exception report (B12); the recovery rule goes to the owner (BL-091); (g) the reversal of a write-off made in error is BL-092. | Accountant (a, c, d), **Owner (b, e, f)** |
| A-322 | **The split** (ADR-0026 Amendments): WHL's remainder built here; QUO's remainder (the quote's document and `documentUrl`, `getQuotePipeline`, `listMyQuotes`, CR-047 point 2), the owner's QUO decisions (several live links; subject to stock after ADR-0019; F10l's quote link and abuse case 40; and the owner's item 5 of 2026-11-19, below) and UAT scenario 2's dry run move to **B10 continued 4** (`b10c4-quote-pipeline`), before B11. | Owner |

**The parent session's leave (2026-11-18), named as asked:** lane B may change BIL's settlement functions for the write-off (`written_off_pesewas` on `bil.document_settlement`; `document_settlement_keep`, both `apply_settlement` forms and `credit_note_refund` subtracting it; new `bil.apply_write_off` and `Billing.writeOffIn`; nothing else in BIL; no signature changed). Its seven conditions are met: (1) only these; (2) identical behaviour with nothing written off, proved by the whole integration suite after the rebase, by `test/integration/bil/settlement-write-off.integration.spec.ts` (every step run under 0182's and 0187's bodies and under the new, compared) and by the rollback restoring the old bodies word for word; (3) the database refuses an allocation and a credit note onto the amount written off (tested and mutation-checked, mutations 10, 11 and 11b), and the write-off is insert-only; (4) maker and checker, posted by ◆ event through FIN, tied to 1200 by SQL; (5) money after a write-off is refused onto it, raised, and the recovery rule put to the owner (BL-091); (6) ADR-0090 (proposed) and A-321; (7) lane A's till paths are unchanged (their suites pass in the full run after the rebase).

**No ADR conflict.** ADR-0090 is new (proposed). ADR-0003's `whl.BadDebtWrittenOff` row is followed as written (Dr 6940, Cr 1200). ADR-0017 (maker never checker) and ADR-0067 (no `now()` in business code: the run's and write-off's dates are the application clock's; tests take dates from `testStartTime` and the clock) are followed. ADR-0019 was not read: subject-to-stock moved with QUO's remainder to B10 continued 4.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued 3, lane B (`b10c3-standing-orders-quote-pipeline`, from `main`).
2. **Scope:** standing orders and their runs (FR-WHL-004) and the bad-debt write-off (FR-WHL-012), then a split at the WHL/QUO boundary: QUO's remainder, the owner's QUO decisions and UAT scenario 2 do not fit this context to their gate.
3. **Gate (as split):** a standing order makes one order per date however often its run fires, records a held account's run as skipped and survives a crash mid-run; a bad-debt write-off posts Dr 6940 Cr 1200 exactly on approval by someone other than its maker, held by the database, and closes the open item the ageing shows; every write refuses the wrong role.

## Contract changes

**2.18.0, minor, additive** (on top of lane A's 2.17.0; versioning against `main`: ok; Redocly clean; `contract:generate`: 502 operations from code, 150 planned, 652 in all).
- **Into code, planned shapes widened before any client used them:** `listStandingOrders`, `createStandingOrder`, `getStandingOrder`, `updateStandingOrder`, `pauseStandingOrder`, `resumeStandingOrder`, `endStandingOrder`, `listStandingOrderRuns`, `writeOffBadDebt`. `StandingOrder` gains `weekdays`, `intervalDays`, `EVERY_N_DAYS` (`weekday` deprecated; `deliveryAddress` null until B11); `StandingOrderRun` gains `reason`, `HELD_FOR_CREDIT`, `MISSED`; `writeOffBadDebt` answers only 202 (planned 200 removed) and 404.
- **New error codes:** 422 `STANDING_ORDER_INVALID`, 422 `BAD_DEBT_WRITE_OFF_INVALID`.
- **Behaviour on implemented operations, no shape changed:** a billing document with something written off shows that much less outstanding, keeps UNPAID or PART_PAID, and refuses a payment onto the amount written off with the existing 422 `ALLOCATION_EXCEEDS_AVAILABLE`.
- Seeded role matrix: `whl.standing_order.read`, `whl.standing_order.manage`, `whl.bad_debt.write_off`, `whl.bad_debt.approve`.

## Built

| Item | What |
| --- | --- |
| Schema | 0272 (document types `STANDING_ORDER`, `BAD_DEBT_WRITE_OFF`), 0273 (BIL: `written_off_pesewas`, the four replaced functions, `bil.apply_write_off`; rollback restores 0182's and 0187's bodies and refuses once anything is written off), 0274 (WHL: `standing_order` DOCUMENT with its guard, `standing_order_line` retired never deleted, `standing_order_run` LEDGER keyed by order and date, `bad_debt_write_off_request` DOCUMENT with `ck_..._checker` and its guard, `bad_debt_write_off` LEDGER with `ck_bad_debt_write_off_checker` and `whl.bad_debt_write_off_check`), 0275 (FIN: `whl.BadDebtWrittenOff`, rules D 6940 / C 1200 against the customer, `uq_journal_entry_bad_debt`), 0276 and 0277 (permissions, the `BAD_DEBT_WRITE_OFF` approval policy, grants). |
| Domain | `whl/domain/schedule.ts` (`occursOn`, `nextOccurrence`, `occurrencesBetween`, `judgeSchedule`), `whl/domain/write-off.ts` (`judgeWriteOff`). Under WHL's 100 percent domain gate. |
| WHL | `StandingOrders` (eight operations and the hourly `standing-orders` job), `BadDebts` (`writeOffBadDebt`, the approval handler, the consumer `whl.written-off-customer-paid`), `PgStandingOrderStore`, `PgBadDebtStore`, `StandingOrdersController`; `Ageing` takes write-offs off as at the date; `BusinessAccounts.releasePaidIn` never releases a customer with a write-off. |
| BIL, FIN, ORD (additive) | `Billing.writeOffIn`; FIN's translator for `whl.BadDebtWrittenOff` and `Journals.entryForSubjectIn`; ORD's `Orders.placeStandingIn` (createOrder's own path, extracted as `placeIn`, never confirming) and the export of `OrderInvalidError`. Lane A's files untouched (`sale-posting.ts`, PAY's till rules). |
| Docs | ADR-0090 and its index line; ADR-0026 Amendments (the split; the owner's decisions of 2026-11-19); A-320 to A-322; BL-091 to BL-094; threat model abuse case 41; `data-model/whl.md`, `bil.md`; the WHL card; `API.md`; `OPERATIONS.md` (the job); `DOMAIN_MODEL.md` (the event); the changelog; the openers (B10 continued 3 marked, B10 continued 4 inserted, B11 reads its report and gains CR-054 to CR-057). |

## The gate, proved by running it

**`test/integration/whl/standing-orders.integration.spec.ts` (10 tests):**
- **One order per date:** a weekly order on today's weekday; the job run twice in turn and twice at once makes one `CREATED` run and one order (SQL: one `ord.sales_order` with the standing order as source, PLACED, CREDIT, WHOLESALE, its total the engine's, salesperson the maker, `credit_check` null); next run a week on; `listStandingOrderRuns` answers it; confirming the order passes the credit check; the next day nothing, a week on exactly one more.
- **Held account:** on hold by the Accountant: `SKIPPED_ON_HOLD` with the reason, no order, recorded once.
- **Credit:** a limit one pesewa under the order: the order is made, PLACED, `HELD_FOR_CREDIT` naming "over the credit limit by GHS 0.01"; confirming it is 422 `CREDIT_LIMIT_EXCEEDED`; at exactly the limit, `CREATED`.
- **Paused:** nothing made or recorded; resume runs from the next date, the paused date not made up; `NOT_PAUSED`, `NOT_ACTIVE`; ended, and the database refuses it changed (HK004).
- **Missed:** every three days, the clock six days on: two `MISSED` with the reason, today's `CREATED`, one order.
- **Crash mid-run:** a trigger kills the run on the second of two orders: the first is done with its order, the second untouched; the next two runs make the second once and the first not again.
- **Rules, replay, versions:** each refusal named; a create replayed by its key; lines and days replaced at the version read, a stale version 409, the old line retired, not deleted.
- **Roles:** the Accountant, Cashier and Storekeeper 403 on every write; the Cashier and Storekeeper 403 on reads; a customer 401; another branch's Owner sees nothing and its id opens nothing (404).
- **The database:** a run updated 42501 for `hk_app`, HK001 beneath, deleted HK001, a date again 23505, an inconsistent outcome 23514.

**`test/integration/whl/bad-debt.integration.spec.ts` (6 tests):**
- **50,000 written off:** 202 and nothing moves (SQL: outstanding 50,000, 1200 50,000, 6940 nil); on the Owner's approval the entry's lines are exactly D 6940 50,000 (no party) and C 1200 50,000 against the customer; 1200 for the customer nil, 6940 50,000; BIL's summary outstanding 0, written off 50,000, UNPAID; **the invoice row byte for byte as before**; the write-off names that entry, its maker and checker, today. The ageing as at today: total, ledger, not aged all nil; as at yesterday 50,000 over 90 days, ledger 50,000, nothing not aged (ties to 1200 both days). Audited once.
- **Part:** 20,001 of 50,000 written off leaves 29,999; a cheque of 30,000 onto it 422; 29,999 exactly accepted; 1200 nil, 6940 20,001; the database itself refuses one more pesewa (HK010).
- **Refusals:** more than outstanding, nothing, a second ask while one waits; another branch's Accountant and an unknown document 404.
- **Maker and checker:** the Manager, Sales, Cashier and Storekeeper 403 on the ask; the Owner who asked cannot approve it, nor can the Manager or the Accountant; nothing moved; a second Owner approves and it posts.
- **The database:** an ask applied by its maker 23514; a write-off with no approved ask HK010 (whoever approved), and beneath the trigger its maker as checker 23514; updated 42501 and HK001, deleted HK001, the ask changed HK004.
- **After a write-off:** a system overdue hold stays though nothing is past due; a payment on a new invoice is applied there and raised once as `whl.WrittenOffCustomerPaid` (its amount and the 40,000 written off); nothing posted as a recovery.

**`test/integration/bil/settlement-write-off.integration.spec.ts` (2 tests):** the old bodies (from 0273's down step) and the new run the same eight steps on two invoices of the same figures (both `apply_settlement` forms, a credit note through the trigger, a refund held and released, an allocation taken off, one refused): every summary equal. With 4,000 written off: a write-off beyond outstanding refused; a credit note reaching it refused at approval (BL-093: answered 500, not 422); 2,000 credited and 4,000 paid exactly; both `apply_settlement` forms refuse one pesewa more; the column's check holds.

**Unit:** `schedule.spec.ts` (8), `write-off.spec.ts` (3), red first (modules missing) before the code. **Contract:** `test/contract/b10c3/standing-orders-bad-debt.contract.spec.ts`. **Walks extended:** the authorisation and identifier walks (nine routes, their bodies), `bil/archive-link-rollback` (0272 to 0277 rolled back and applied), the operation count and the request schemas.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The job ignores the dates already run (application only) | green: the next run date had moved on |
| 1b | Mutation 1 and the next date never moved on | red: 7 (the run key refuses, after the fix below) |
| 2 | The whole run in one transaction | red: 1 (crash) |
| 3 | An account on hold not skipped | red: 1 |
| 4 | The credit check not judged at the run | red: 1 |
| 5 | A paused order still due | red: 1 |
| 6 | The Cashier granted `whl.standing_order.manage` | red: 1 |
| 7 | WHL's maker check removed (application only) | green: IAM and the database refuse it |
| 7b | Mutation 7 and both WHL database checks removed | red: 1 (the database test; on the API path IAM's own `ck_approval_request_maker_not_checker` still refuses) |
| 8 | The Manager granted `whl.bad_debt.write_off` | red: 1 |
| 9 | The Accountant granted `whl.bad_debt.approve` | red: 1 |
| 10 | `apply_settlement` not subtracting what is written off | red: 1 |
| 11 | The trigger's credit note refusal removed | green: the column check refuses it beneath |
| 11b | Mutation 11 and the column check removed | red: 1 |
| 12 | The ageing not taking write-offs off | red: 1 |
| 13 | A system hold released for a customer with a write-off | red: 1 |
| 14 | Money after a write-off not raised | red: 1 |
| 15 | `whl.bad_debt_write_off_check` removed | red: 1 |
| 16 | `ck_bad_debt_write_off_request_checker` removed | red: 1 |
| 17 | `ck_bad_debt_write_off_checker` removed | red: 1 |

**Found by mutation 1, fixed in its own commit (`fix(whl)`):** the run row was written with `ON CONFLICT DO NOTHING`, so had the application ever made an order for a date already run, the order would have been kept beside the first. A plain insert lets the run key refuse it and roll the order back.

## Test first, as it honestly happened

- **Red first:** the two domain specs (modules missing), then green.
- **Integration specs written after the code**, then run: standing orders 9 of 10 green on the first run, 1 red for my defect (pause, resume and end answered 201, the contract says 200: `@HttpCode(200)`). The write-off spec's first runs were red for my test's own mistakes (invoices dated before issue, `subledger_party_id`, the error code `ALLOCATION_EXCEEDS_AVAILABLE`, the trigger firing before the check), fixed in the test; the BIL spec red for my arithmetic of the expected outstanding (the old and new bodies agreed throughout) and for the 500 at a credit note's approval (BL-093). The seed first refused to run: an Owner cannot grant a role holding a permission the Owner lacks, so the Owner holds `whl.bad_debt.write_off` (A-321 (b)).
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, item by item)

- **Boundary:** TB2 (back office), the worker, the database. No login, upload, webhook or export change.
- **Authorisation:** every handler authorises first, deny by default; reads at whole-branch scopes; an id outside them is 404; all nine routes on both walks; wrong roles refused and mutation-checked. **Maker and checker:** IAM, WHL's handler and the database, each layer mutation-checked. **Input:** strict zod; SQL parameterised. **Money:** integer pesewas (bigint), no arithmetic beyond sums and one comparison; exact against SQL and 1200. **Side effects:** the posting in the approving transaction, the events through the outbox.
- **New abuse path:** abuse case 41 (a debt written off to hide money taken), detected through ◆ `whl.BadDebtWrittenOff` and `whl.WrittenOffCustomerPaid` for B12's report.

## Deferred

To **B10 continued 4**: QUO's remainder, CR-047 point 2, the owner's QUO decisions 2 to 5 and UAT scenario 2's dry run with its two owner questions (credit check and delivery fee on a partial dispatch). To **B11**: delivery on standing orders; CR-054 to CR-057 (written into its opener). Backlog: BL-091 (recovery rule, the owner's), BL-092 (reversing a write-off), BL-093 (BIL's credit note approval answering 422), BL-094 (a `WRITTEN_OFF` status).

## Questions for the owner

1. **Recovery after a write-off (BL-091):** when a customer pays a debt that was written off, which account takes it, and does the hold lift? Until then the payment cannot be put onto the amount written off and is raised for review.
2. **Standing orders confirmed by staff (A-320 (c)):** the job makes each order and leaves it PLACED for staff to confirm; should a passing order be confirmed (and stock reserved) by the job instead?
3. **A system hold after a write-off (A-321 (e)):** it stays until a person releases it. Agreed?

## Contract requests (the frontend's `main` at `5242161`)

- **CR-047** point 2: moved to B10 continued 4 with QUO's remainder (small, additive).
- **CR-051, CR-052:** POS, lane A's (CR-051 answered in lane A's B09b continued 3).
- **CR-053 to CR-057 (new):** B11's (picking, part delivery, its seed, the driver's cash); written into B11's opener with the owner's decisions of 2026-11-19; **named for the parent session to schedule with B11**. CR-050 part 1 (who is signed in at the till) is lane A's.
- **CR-045, CR-046, CR-048, CR-049:** answered in B10 to B10 continued 2.

## The owner's decisions of 2026-11-19 (relayed while this phase was open)

1. **A below-floor approval only approves** (F10m): this phase's quote work moved to B10 continued 4 (A-322), so it is written into that opener as the owner's item 5, test-first, with the finding that B10's `QUOTE_BELOW_MARGIN` handler issues the version on approval today (a LOUD change to record there). Not built here.
2. **B11:** CR-056, CR-057 (with leave for one additive POS operation), CR-054 and CR-055 written into B11's opener with an ADR-0026 Amendments line. Not built.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, after the rebase on `475378e` (`vitest --project unit --project integration --coverage`) | **3,732 passed**, 309 files, none skipped, on `1eaaf54`, the whole integration suite once (lane A's POS sync, counter and till suites and every BIL, PAY and WHL suite among them, unchanged). Statements 94.07 percent, branches 83.82 (the gate is 80), functions 97.81, lines 96.99; every 100 percent gate held, WHL's domain (`schedule.ts`, `write-off.ts`) included. |
| Unit before the rebase | 1,780 passed, 151 files |
| Contract (`pnpm test:contract`) | **132 passed**, 51 files, after the rebase. The first contract run (before the rebase) was red on 4 tests in 3 files, each this phase's: the operation counts, the seeded role matrix not regenerated after the Owner's grant, and the new request schemas missing from the walk; fixed before the next run. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate`, versioning against `main` | Clean |
| End to end, setup, the image, the scans | Run in CI; the runs are named in the closing message |

## Notes for the frontend track

- **2.18.0:** standing orders take `weekdays` (several named days) or `intervalDays`; show `nextRunOn` and each run's `outcome` with its `reason`; a `HELD_FOR_CREDIT` run's order needs a credit override to be confirmed (the order page's existing flow). A delivery address is refused until B11.
- **The write-off** always answers 202; the approval inbox shows `BAD_DEBT_WRITE_OFF`; only an Owner who did not ask approves. Afterwards the invoice's outstanding drops by the amount and the payment screen cannot allocate onto it (422 `ALLOCATION_EXCEEDS_AVAILABLE`).

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B10 continued 4, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c3-standing-orders-quote-pipeline.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
CR-047's remaining point 2 (PublicQuote.acceptedName and decidedAt) is this phase's to implement or decline; check the
numbers again on main (CR-051 and CR-052 are lane A's POS).
For this phase, read FR-QUO-007, FR-QUO-008 and FR-QUO-013 of the QUO block of docs/SRS.md (nothing else from the
SRS), docs/data-model/quo.md, the QUO card in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.12, ADR-0017, ADR-0019,
ADR-0074, ADR-0087, ADR-0090, scenario 2 of docs/UAT.md, and A-309 to A-322 in docs/ASSUMPTIONS.md. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 continued 4 only, on branch b10c4-quote-pipeline from main, building on QUO as B10 to B10 continued 3
merged it (do not rewrite it):
QUO's remainder (FR-QUO-007, FR-QUO-013): the quote rendered and archived as a document when a version is issued
(DOC's template, `documentId` and `PublicQuote.documentUrl`), getQuotePipeline (win rate by salesperson and product
line, reconciling to listQuotes) and listMyQuotes (a customer's own quotes only; another customer's quote id opens
nothing).
The owner's decisions of 2026-11-18 for QUO (A-309 as amended), each test-first:
1. Built in B10 continued (A-316): a quote line with no unit is in the sale unit. Nothing to do.
2. Several live links per quote version are approved provided all three hold, each tested and mutation-checked: (a)
   each link can be revoked on its own and the others keep working (build a per-link revoke if none exists: authorised,
   wrong-role tested, joined to the identifier walk); (b) the quote is accepted only once across all its links, a second
   accept through another link refused; (c) every link of a version stops working when that version is replaced,
   accepted or expires.
3. Do not refuse to issue a quote for stock not on hand: issue it marked subject to stock (a field on the version and on
   the public quote), show the quantity available, and reserve only what is on hand, never more; test fully, partly and
   not on hand with exact quantities; LOUD on 2.12.0 (a refusal removed), a dated amendment to A-309. Read ADR-0019
   first; if this would contradict it, stop this item and report the options to the parent session.
4. The owner, 2026-11-18, from the frontend's F10l (no CR number on the frontend's main at aad2c91): the console shows a
   quote link once, right after sending, so staff can send it by WhatsApp. Load hakorem-security-review. (a) Record the
   device and session behind every acceptance and decline through the link: the user agent, the IP (as the platform
   records it for public calls, per the data classification) and whether a staff session cookie was present and whose.
   (b) Flag, on the exception report's source, any acceptance or decline made from a browser with a signed-in staff
   session, as a new source kind naming the staff member (B12 builds the report); the flag never blocks, it is raised
   for review. Add the abuse path to docs/security/THREAT_MODEL.md as abuse case 40 (lane B's block; 41 is the bad-debt
   write-off's). (c) The link token is shown once: returned only in the send's response, never readable again since
   only its hash is stored (ADR-0074, ADR-0087); test that no read returns it. Tests: an acceptance with no staff
   session is not flagged; one with a staff session is flagged with that staff member; a decline with a staff session
   is flagged too; a mutation that skips the flag turns a test red.
5. The owner, 2026-11-19 (from the frontend's F10m): approving a below-floor quote only approves it. It neither issues
   the version nor makes a link; the salesperson then issues and sends it and sees the link once, as for any quote. No
   live link may exist that nobody has seen. B10's `QUOTE_BELOW_MARGIN` handler issues the version on approval today
   (`Quotes.issueIn` from `onApproved`), so this is a LOUD behaviour change on 2.12.0's approval: record it as a dated
   assumption. Tests: the approval leaves the version approved, not issued, with no token; issuing and sending after
   approval returns the link once; no read ever returns a token; a mutation that makes a link at approval turns a test
   red.
Run scenario 2 of docs/UAT.md as a dry run and record every difference, including the two rules that scenario flags for
the owner (credit check and delivery fee on a partial dispatch), decided conservatively and put to the owner. The
standing orders and the bad-debt write-off of B10 continued 3 are in it where the scenario touches them.
Stop at the gate and write docs/sessions/B10c4-quote-pipeline.md.
```
