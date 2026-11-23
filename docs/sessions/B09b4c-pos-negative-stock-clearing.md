# B09b continued 3c: negative stock offline and the mobile money clearing account

Date: 2026-11-23 · Branch `b09b4c-pos-negative-stock-clearing`, from `main` (`f065dec`) · Lane A · Status: **gate passed locally; both of the owner's decisions of 2026-11-18 moved here (2 and 3) are built.** No split.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-282 (a) | A new account, **1115 Mobile money awaiting verification**, against the wallet. It is not 1120, which holds provider-cleared receipts against the provider. | Owner, Accountant |
| A-282 (b) | Verification is a person's: the break is resolved `VERIFIED` with the evidence in the note and a second person's approval, which posts Dr 1110, Cr 1115 once. A matched statement line verifying it by itself is BL-102. | Owner |
| A-282 (c) | A second verification posts nothing (the break is closed, and a unique row refuses it). A verified tender is never bounced; a wrong one is corrected by manual journal. | Accountant |
| A-282 (d) | **Refused as fake:** bounced with the new reason `MOBILE_MONEY_NOT_RECEIVED`. It becomes `FAILED`, its receipt is mirrored (**Dr 1200, Cr 1115**), the receivable is the customer's again and **1110 is never touched**; any loss is the owner's bad debt decision. | Owner, Accountant |
| A-282 (e) | **A verification that never comes:** the hourly `unverified-tender-overdue` job raises it URGENT exactly once when its window ends (`pay.UnverifiedPaymentOverdue`). It stays in 1115 and nothing posts. This closes BL-086 for this kind. | Owner |
| A-282 (f) | A bare close of a tender still waiting is refused (`VERIFICATION_REQUIRED`). | Owner |
| A-282 (g) | A-281 (h) unchanged: no unverified tender is taken onto a closed shift. | Owner |
| A-283 (a) | `SALE_ISSUE_OFFLINE` may go below zero at any physical location, countable and lot stock alike. Never a SERIAL unit, never an online sale, never any other type. | Owner |
| A-283 (b) | The last known cost is the pool's own average when it covered part of the issue. Otherwise it is the latest of an earlier uncovered row's basis and a valued movement of the pool that was not itself short. It is rounded half-up once. The pool covers per branch. | Owner, Accountant |
| A-283 (c) | **Oldest first:** an arrival settles the oldest uncovered rows of its pool first. A part arrival settles what arrived and takes all of its value. | Owner, Accountant |
| A-283 (d) | An arrival is any movement that raises the pool: from a virtual location, or a transfer between branches. A void or return of the very sale is trued up as an arrival (BL-103). | Accountant |
| A-283 (e) | **No cost ever known:** costed at nil with `cost_known` false and raised URGENT, never nil without a flag. On arrival its whole cost goes to cost of sales. | Owner, Accountant |
| A-283 (f) | One open `inv.count_task` per product, unit and location, raised with the first `NEGATIVE_STOCK`. It has no read or close operation yet (BL-104). | Owner |
| A-283 (g) | The flag is `STOCK_EXCEPTION`/`NEGATIVE_STOCK` with abuse cases 11 and 36. The trigger's `RESERVATION_CONFLICT` beside it, raised when nothing is reserved, stands (A-278 (f), BL-105). | Owner |
| A-283 (h) | Contract 2.22.0, LOUD: an offline line beyond stock now moves its stock below zero, where before it moved nothing. | Owner |

**For the parent session to schedule (larger contract requests, not built here):**
- **CR-059** (an exception review operation, five new `ExceptionKind`s, the seed for `rpt.exceptions.*`): RPT's, B12. Its point 4 asks about `NEGATIVE_STOCK`: it lands today under `STOCK_EXCEPTION`, with `details.stockExceptionKind = NEGATIVE_STOCK` (with `countTaskId`, `uncoveredQty`, `costKnown` and `valuedAtLastKnownCostPesewas`).
- **CR-060, CR-061, CR-062** (egg reports, the VAT return, statement exports and the reports seed): RPT's, B12.
- **CR-057** point 1 still needs both lanes (as the last report said).

**ADR-0082 (new, with the parent session's leave):** CI shards the unit and integration job in three and judges coverage once, merged (NFR-016; see CI). A flaky test helper was fixed (`fix(test)`, see CI).

**ADR conflicts: none stopped the work.** The owner's decision 2 contradicted two rules, and the parent session gave leave for both:
- ADR-0018's "uncovered quantity carries zero value";
- ADR-0002's "type and location must both allow negative".

Each rule is amended by the owner's decision through a new ADR-0081, with amendments to ADR-0002 and ADR-0018. The parent session gave leave (SendMessage, 2026-11-23) for exactly one change to an existing INV function: `inv.apply_movement`'s two "allowed negative" conditions, the rest byte for byte. `inv.check_movement` was first asked for too, then withdrawn, because the paired true-up needs no change to it (the parent session approved the change of design). ADR-0003 gains its "Applied in B09b continued 3c" paragraph (1115, 1335, five new rule pairs).

**Contract 2.22.0, LOUD for `syncOfflineSales` beyond stock and `resolveReconciliationBreak` on an unverified tender; no field removed or retyped.**
- `BreakResolve.posting` gains `VERIFIED`.
- Two refusal details are new (`VERIFICATION_REQUIRED`, `TENDER_NOT_PENDING`), and one reversal reason (`MOBILE_MONEY_NOT_RECEIVED`).
- An offline line beyond stock now moves below zero.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 3c (`b09b4c-pos-negative-stock-clearing`, from `main`), lane A.
2. **Scope:** the owner's decisions 2 (negative stock offline, replacing A-278 (f)) and 3 (the unverified tender's clearing account, replacing A-279 (h)'s Dr 1110) of 2026-11-18.
3. **Gate:** an offline sale may take a location below zero, valued at the last known cost and trued up when stock arrives, with a count task, while online sales keep today's rules; the unverified tender held in its own clearing account until verified, then moved to 1110 exactly once, and one never verified stays in clearing past the window and is raised. Each is test-first, with exact pesewas and quantities by SQL.

## Built

| Area | What |
| --- | --- |
| Data, INV (shared, with leave) | `0286_inv_negative_stock_offline`:<br>- `inv.movement_type.negative_anywhere` (only `SALE_ISSUE_OFFLINE` and `NEGATIVE_TRUE_UP`); `inv.apply_movement` replaced with its two conditions only; the movement types `NEGATIVE_TRUE_UP_IN` and `NEGATIVE_TRUE_UP`.<br>- `inv.negative_stock_cost` (LEDGER, written by `trg_stock_movement_negative_cost`, never by hand).<br>- `inv.negative_stock_settlement` (LEDGER, written by `inv.settle_negative_stock`, capped and unique).<br>- The deferred `trg_stock_movement_true_up_named`.<br>- `inv.count_task` (WORK), with `trg_stock_exception_count_task`. |
| INV application | `Stock.postIn` wraps an arrival into an owing pool: a nil lift, the arrival, a pool-valued issue, the settlement, and ◆ `inv.NegativeStockTrueUp`. An arrival into a pool that owes nothing is unchanged. `Stock.postOfflineIssueIn` publishes ◆ `inv.NegativeStockCosted` and names the count task and the cost in the exception's fact. `Stock` reads MDM's ADJUSTMENT location. |
| Data, FIN | `0285`: 1115, determination 281, `pay.UnverifiedPaymentVerified` (rules 284, 285, once per verification). `0287`: 1335, `inv.NegativeStockCosted` (286, 287) and `inv.NegativeStockTrueUp` (288 to 291), once per subject. |
| FIN | The unverified determinant now `MOBILE_MONEY_AWAITING_VERIFICATION`; `unverifiedVerifiedAmounts`, `negativeStockCostedAmounts` and `negativeStockTrueUpAmounts` (100 percent gate); three new handlers. |
| Data, PAY | `0284`: `posting` `VERIFIED`; `pay.unverified_verification` (LEDGER, `ck_unverified_verification`); `pay.unverified_overdue` (LEDGER, `ck_unverified_overdue`, `ck_unverified_overdue_due`); `trg_payment_a_unverified_bounce` (`ck_payment_verified_bounce`). `0283` (MDM): the reason `MOBILE_MONEY_NOT_RECEIVED`. |
| PAY (lane A's till cash rules; shared otherwise, additive) | `judgeResolution` (`VERIFIED`, `VERIFICATION_REQUIRED`, `TENDER_NOT_PENDING`); `judgeReversal` (an unverified tender still waiting bounces); `BreakQueue.verify`; `UnverifiedOverdue` with the worker's `unverified-tender-overdue` job (hourly at :40). |
| POS | A `NEGATIVE_STOCK` is URGENT when no cost was known and carries abuse cases 11 and 36. |
| Docs | ADR-0081; ADR-0002, ADR-0018 and ADR-0003 amendments; A-282, A-283; BL-102 to BL-105 and BL-086 done; abuse case 36 and case 4's text; the data model (inv, pay); the INV and PAY cards; the event catalogue; OFFLINE_SYNC 9.3 and 9.9 as built; OPERATIONS' job; three runbooks; the changelog (2.22.0). |

## The gate, proved by running it

`test/integration/pos/negative-stock.integration.spec.ts` (10 tests). Every figure is read by SQL over `inv.stock_movement`, `inv.stock_balance`, `inv.cost_pool`, the cost and settlement rows and `fin.journal_line`, and 1330 is checked against the pools after every step.
- **End to end through the sync:** 5 at 24,000, the till sells 8.
  - The shop floor drops by 8 to -3 and the pool is (-3, 0).
  - The movement carries 24,000, and the cost row is 3 at 4,800 = 14,400.
  - Journal: Dr 5020 24,000 Cr 1330 24,000; Dr 5020 14,400 Cr 1335 14,400.
  - `NEGATIVE_STOCK` is REVIEW with `abuseCases: [11, 36]`, and its fact names the count task, 3.000, the cost known and 14,400.
  - A second sale raises its exception but no second count task. A product with no known cost is URGENT with `costKnown: false`.
- **Dearer arrival:** 10 at 50,000.
  - Lift 3 (nil), receipt 10, issue 3 at 15,000; settlement 3, cleared 14,400, true-up 15,000.
  - Shop 7, pool (7, 35,000).
  - 5020 = 39,000 (5 at 4,800 and 3 at 5,000), 1335 = 0, 1330 = 35,000.
- **Cheaper overfill:** 4 at 18,000 settles 3 at 13,500 against 14,400, so 5020 moves down by 900. Pool (1, 4,500); 1335 = 0.
- **Part arrival:** 5 owed at 4,500 (22,500).
  - 3 arrive at 14,100: settled 3, value out exactly 14,100, cleared 13,500. 2 stay owed (1335 = -9,000, the count task open, the shop at -2).
  - Then 6 arrive at 28,800: settled 2 at 9,600, cleared 9,000, 1335 = 0.
  - 5020 = 32,700 (2 at 4,500, 3 at 4,700, 2 at 4,800).
- **Two sales, two last known costs, oldest first:**
  - The rows are 2 at 5,000, then 2 at 6,000, after a part arrival of 1 at 6,000.
  - 5 then arrive at 27,500 and settle 1 (5,000 to 5,500), then 2 (12,000 to 11,000).
  - 1335 = 0; 5020 = 32,500.
- **No cost ever known:** nil, no journal; on arrival of 3 at 15,000 the 2 owed take 10,000 to 5020 and 1335 stays 0.
- **Transfers between branches:**
  - Exact fill: ACC owes 2, and 2 arrive from DDW at 9,600. The ACC pool ends at (0, 0), with no refusal.
  - Part then over: 2 (9,600) then 3, of which 1 settles at 4,800; ACC pool (2, 9,600).
  - 1335 = 0, 5020 = 19,400.
- **An arrival that owes nothing:** one movement per receipt and its `inv.GoodsReceived` journal only. No lift, no issue, no cost row.
- **Online:** `SALE_ISSUE` beyond stock is refused `INSUFFICIENT_STOCK`, and nothing moves.
- **Database guards:**
  - A hand-written `NEGATIVE_TRUE_UP_IN` is refused at commit (`ck_negative_true_up`).
  - A hand-written cost row is refused (`ck_negative_stock_cost`), and so is a settlement beyond what is uncovered (`ck_negative_stock_settled`) and one with a false lift (`ck_negative_true_up`).
  - Update and delete are refused on both ledgers.

`test/integration/pos/unverified-clearing.integration.spec.ts` (7 tests), by SQL over `pay.payment`, the break, the verification and overdue rows, the journal lines and the outbox.
- **Posted:** 20,000 mobile money plus 10,000 cash. 1115 against the wallet is 20,000; 1110, 1120 and 1200 are 0; no line on 1110 at all.
- **Wrong roles and a bare close:** a cashier and a storekeeper get 403 on `VERIFIED`. A bare close is refused `VERIFICATION_REQUIRED`. Nothing is written.
- **Verified:** the accountant asks; the accountant cannot approve their own ask (403); the manager approves with step-up. Dr 1110 20,000 and Cr 1115 20,000 against the wallet; 1115 = 0, 1110 = 20,000; one verification row; the break is RESOLVED; the payment stays PENDING/UNVERIFIED.
- **A second verification attempt:**
  - The operation answers 422 `BREAK_NOT_OPEN`, and a second row by SQL is refused (`uq_unverified_verification_payment`), with one journal only.
  - A bounce answers 422 `NOT_REVERSIBLE`, and so does SQL (`ck_payment_verified_bounce`).
  - Update and delete are refused.
- **Never verified:**
  - A minute before `urgentFrom` the job raises nothing.
  - At `urgentFrom` it raises once (URGENT, abuse case 4, 6,000); later runs raise nothing.
  - 1115 stays at 6,000, 1110 at 0, and the break stays OPEN.
- **Refused as never received:** approved by the owner. The payment is `FAILED` ("Mobile money not received: ..."); 1115 = 0, 1110 = 0, 1200 = 6,000; the receipt is outstanding 6,000 again; no new line on 1110. Then `VERIFIED` is refused `TENDER_NOT_PENDING`, and a close with a note is accepted.
- **Database:** an overdue row for a break that is not its own, or not yet due (`ck_unverified_overdue_due`), is refused; so is a verification through another break's resolution (`ck_unverified_verification`). Both ledgers are insert-only.

Changed by the owner's ruling (LOUD), each failing on its old expectation first:
- `offline-conflicts` 9.3: the eggs now move to -30, the uncovered 30 is at the lot's average, and 5020 and 1335 are exact. Two later egg sales in that file raise `NEGATIVE_STOCK` too.
- `offline-sync-500`: the 10 yams beyond stock move to -10, each with its exception beside the movement, and one count task.
- `seeded-stock-gate`: the online sale is still refused; the offline sale takes the seeded shop floor to -1 with no drift.
- `stock-invariants`: `SALE_ISSUE_OFFLINE` goes below zero where the location does not allow it, `SALE_ISSUE` is still refused there, and the cost row is 7,000.
- `posting-matrix`: INV declares the two new events.
- `offline-queue`: the unverified tender is 1115, not 1110.

## Mutations

Each mutation was applied alone to the committed source, the named spec was run, and the source was restored (`git status` clean afterwards).

| # | Mutation | Spec | Result |
| --- | --- | --- | --- |
| M1 | `inv.apply_movement` without `OR mt.negative_anywhere` (today's rule) | negative-stock | red: 8 failing |
| M2 | `SALE_ISSUE` given `negative_anywhere` (an online sale beyond stock) | negative-stock | red: 1 failing (the online refusal) |
| M3 | the true-up without its nil lift | negative-stock | red: 7 failing |
| M4 | settlement newest first instead of oldest | negative-stock | **survived the first spec**: the arrival settled every row, so order changed no figure. The FIFO test was then strengthened with a part arrival across two rows (`test(inv)` commit): red, 1 failing |
| M5 | the last known cost taken as nil when the pool covered part | negative-stock | red: 6 failing |
| M6 | the unverified tender's determinant back to 1110 | unverified-clearing | red: 6 failing |
| M7 | the overdue query without its "not yet raised" check | unverified-clearing | survived, as designed: the unique `uq_unverified_overdue_break` and the job's `if (!first) continue` still raise it once |
| M7c | that check and the job's `continue` removed together | unverified-clearing | red: 1 failing (raised twice) |
| M8 | a bare close of a waiting tender allowed | unverified-clearing | red: 5 failing |
| M9 | a verified tender bouncible | unverified-clearing | red: 1 failing |

`inv.check_movement` is untouched, so no mutation of it applies. A SERIAL unit's refusal is `ck_stock_serial_location`, byte for byte as before (`offline-conflicts` 9.1 and `stock-invariants`).

## Test first, as it honestly happened

- **Domain specs:** PAY's `receipt.spec.ts` and `reconciliation.spec.ts` were written first and seen red (5 failing), then green. FIN's `event-amounts.spec.ts` for the negative-stock amounts was seen red (1 failing), then green. The FIN unverified determinant's spec line was changed with the code.
- **The clearing integration spec** was written before the first run. That run found 3 failures:
  - two in the test (the cash payment's Cr 1200 was missing from its documents);
  - one real defect: `trg_payment_unverified_bounce` fired after `trg_payment_guard`, so the guard's own refusal hid it. It was renamed `trg_payment_a_unverified_bounce`, after 0239's precedent.
- **The negative-stock integration spec** was written before the first run. It found:
  - in the test: the seeded eggs are lot-tracked, and the order of three same-transaction movements by id;
  - four defects in the migration: a PL/pgSQL `IF` holding a `CASE`, a column alias `at` (a keyword), a record whose types differed between two branches, and a settlement guard that needed `SECURITY DEFINER` to read with `FOR UPDATE`.
- **The paired design itself** came from the test-first reasoning: a value-only true-up could not survive an exact fill (ADR-0081, the latent `ck_cost_pool_empty` defect). The transfer cases were added on the parent session's condition 1.

## Contract requests (the frontend's `main` at `66b1be7`)

- **CR-058** (issue after a margin approval): lane B's QUO, built in 2.19.0.
- **CR-059** (the exception review, five kinds, the seed): **declined here as larger, for B12; named at the top.** Its point 4 is answered: `NEGATIVE_STOCK` lands under `STOCK_EXCEPTION`, with `fact.stockExceptionKind`. An unwitnessed drop and late cash already land under `CASH_MOVEMENT_REJECTED`/`OFFLINE_LATE_CASH` (POS's flags), and the rest are B12's.
- **CR-060, CR-061, CR-062:** RPT's reports and exports, B12. Named at the top.
- **CR-057** point 1: both lanes, still to schedule. **CR-052** and **CR-033** points 1 and 2: B09b continued 4, as placed. Everything else was answered in earlier phases.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3 (the till's sync) and the database.
- **Authorisation, deny by default in the handler:**
  - `SALE_ISSUE_OFFLINE` is reached only through the offline sync: the shift's cashier on the enrolled device of the shift's till, as before.
  - The true-up types have no endpoint and no permission. They are made only inside `Stock.postIn`, and the database refuses them unless their settlement names them.
  - A verification is a resolution: `pay.reconciliation.manage` to ask and `pay.reconciliation.approve` with step-up to approve, and the maker never checks (tested: the asker's approval is 403; a cashier and a storekeeper are 403).
  - A bounce is `PAYMENT_REVERSAL` (a second person with step-up).
- **Input:** one request enum value; parameterised SQL only.
- **Money and stock paths:**
  - **Abuse case 4 (forged confirmation):** the tender never reaches 1110 on the cashier's or the supervisor's word. It waits in 1115 until a second person verifies it against the provider. Unverified past the window, it is raised URGENT. Fake, it is bounced back to the receivable without touching 1110.
  - **Abuse case 7 (an adjustment hiding a shortage):** the true-up is not an adjustment. It moves only value, and only when real stock arrives, so no reason code or approval is bypassed. A genuine shortage still needs an adjustment loss under approval after the count.
  - **Abuse case 11:** a serial animal still never goes negative (`ck_stock_serial_location`, tested in `offline-conflicts` 9.1).
  - **New, abuse case 36 (selling offline beyond stock to hide stock taken):** threat model row added. It reaches the exception report's source as `NEGATIVE_STOCK` with `abuseCases: [11, 36]` and a count task at once. The uncovered cost sits visibly in 1335, never at nil without a flag.
- **Logging and data:** no new personal data; the events carry ids, quantities and pesewas.
- **Database:**
  - Four new LEDGER tables are insert-only (tested). One WORK table holds no money.
  - The cost rows are written only by their trigger (`pg_trigger_depth`).
  - The true-up is checked at commit.
  - The grants schema test covers all of it.
- **Findings:**
  - [accepted, recorded] verification is by a person's approval, not a statement match (BL-102);
  - [accepted, recorded] a void of the very sale is trued up as an arrival (BL-103);
  - [accepted, recorded] count tasks have no read yet (BL-104);
  - [accepted, recorded] the nil-reserved `RESERVATION_CONFLICT` beside `NEGATIVE_STOCK` (BL-105);
  - [fixed in this phase] the latent `ck_cost_pool_empty` refusal of an exact-fill arrival, for every pool that owes stock.
- **Not applicable, with reason:** cookies, CSRF, CORS unchanged; no upload, webhook, outbound URL or export.

## Deferred

BL-102 to BL-105 (above). BL-100, BL-101, BL-082 and BL-087 to BL-089 stand. BL-086 is done for the unverified tender.

## Tests

On this machine, at `9098ab9`; `main` has not moved since `f065dec`, so no rebase was needed.

| Layer | Result |
| --- | --- |
| Unit | 152 files, 1,817 tests passed. `pay/domain/**` and `fin/domain/**` are under the 100 percent gate and met it in their own run. |
| Integration | Full suite, once: 161 files, 1,969 tests, **1 failed**: `mdm/reference-data`'s count of reason codes (64), which the new `MOBILE_MONEY_NOT_RECEIVED` makes 65. That is the test's expectation, not a flake; it was updated, and the file then passed with the rollback walk (35 tests). Before that, the INV, POS, FIN and platform folders: 71 files, 785 tests, 9 failing on the old rule, all rewritten to the owner's ruling (above). The two new specs pass: 10 and 7 tests. The whole INV suite (in that run) and the stock reconciliation (`stock-balance-recompute` finds no drift after an offline sale takes the seeded shop floor below zero, `seeded-stock-gate`) pass. Nothing was re-run to turn red green. |
| Contract | 52 files, 133 tests passed; `contract:generate --check` up to date; Redocly clean. |
| Lint (boundaries, fixtures, placement, schema names, money arithmetic), typecheck | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.22.0:**
  - An offline sale beyond stock now answers `APPLIED_WITH_EXCEPTION` with `NEGATIVE_STOCK` and the stock moved; the line names its movement. Its flag's `fact` carries `countTaskId`, `uncoveredQty`, `costKnown` and `valuedAtLastKnownCostPesewas`, and it is URGENT when the cost was unknown.
  - The break queue can resolve an `UNVERIFIED_PAYMENT` break `VERIFIED`. A bare close of one still waiting answers 422 `VERIFICATION_REQUIRED`.
  - `reversePayment` takes `MOBILE_MONEY_NOT_RECEIVED` for an unverified tender.

## CI

- **Merge slot:** taken 2026-11-23. `main` was still `f065dec` (lane B idle), so there was nothing to rebase or renumber: migrations 0283 to 0287 sit above main's 0282, and the contract's 2.22.0 sits above 2.21.0.
- **Pull request #120.**
  - **`c89ad4c`** (the code, contract and docs commits and the `test(inv)` commit): every run green, push 45103026079 success and pull_request 45103076291 success.
  - **`a37e9ab`** (this report's first version, docs only): push 45104107067 and pull_request 45104112126 were both **cancelled at the job's 12-minute timeout**. No test failed: the job log showed 106 of 161 integration files passed. The single "unit and integration with the coverage gate" step had come to use 568 to 574 s of its 720 s.
    - I asked the parent session to raise the timeout. It refused: 12 minutes is NFR-016, the owner's.
    - It gave leave instead to **shard the job (ADR-0082)**: three shards, each under 12 minutes, writing blob reports with their coverage. The gate job keeps its name, fails unless every shard passed and all three reported, and merges the reports to judge every threshold once (today's, with every 100 percent gate). Nothing was re-run.
  - **`ecc16f3`** (the sharding, plus a deliberate red with shard 2 made to fail): push 45106043187 **failure** and pull_request 45106049807 **failure**. In both, the gate job failed at "every shard passed", as it must.
    - The pull_request run also showed **a real failing test** in shard 3 of 3: `ord/price-override`'s "refuses an approval asked for by one cashier and spent by another", `uq_register_code`. `test/support/till.ts` gave each test till `X` plus three random digits, which collides about one run in a thousand with the spec's other till.
    - Reproduced by making the code constant (`X000`: the same error). Fixed in its own commit (`fix(test)`): the first free `X000` to `X999`. Five specs that use the helper passed.
  - **`b5b8f47`** reverts the deliberate red, then this report's update follows. The runs on the final head, and the merged gate's test counts against the local full run (unit 1,817 plus integration 1,969), are named in the closing message to the parent session. The PR merges only when every one of them is green.

## Next session

B09b continued 4, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b4c-pos-negative-stock-clearing.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0074 (the receipt link's token) and its Amendments, and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 4 only, on branch b09b5-pos-receipts, branched from main.
CR-052 (the owner, 2026-11-18, from the frontend's F10l; low priority, BL-080 scheduled here, A-277 (f)): the offline
pack gives each sellable animal priced by grade or weight its price, so the till can sell it: the price is resolved
by the pricing engine from that animal's own latest weight and grade, never derived; it carries the weight's date and
source; the server re-prices at sync, as every synced sale is; an animal with no weight or no grade stays priceless and
is answered as such; exact pesewas tests. The owner's clarification on prices (2026-11-18) with it: an animal whose
weight changed between the pack and the sale posts the price charged, the server's price from the latest weight is
worked out only to compare, and the difference is flagged (REVIEW within the cashier's limit, URGENT beyond it), with
exact pesewas by SQL over the order line and the journal lines.
The owner's addition (2) to A-200 (2026-11-16), test-first: a business buyer at the counter may have their name and TIN
printed on the VAT invoice without opening a customer account, so they can reclaim the input tax: optional buyer name
and TIN on the counter sale and the billing document, validated in format, printed on the invoice, and never creating a
customer; the walk-in party stays.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first.
CR-033 points 1 and 2 (owner's rule, 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer
is optional): a public receipt read with no session, by an unguessable token, answering the official number, the sale
reference, the lines, the tenders, the change and the business's details (read through AUD's `BusinessProfiles`, B09x continued), and "being recorded" until the sale has
synced. No QR code (owner, 2026-11-17: the TOTP enrolment QR is the only QR in the system): the link reaches the
customer by SMS. The token is its own long random value (owner, 2026-11-17: no ID is ever a key), generated by the till
from a cryptographically secure source when the sale is made, so the link exists offline, and sent with the sale at
sync; never the sale's client id. Record the choice as an ADR with hakorem-security-review. Rate-limit the read, expose
no other customer's data, and test that a guessed token, another sale's token or the sale's own id answers 404. The SMS on sync (point 3) is B11's.
The receipt token (owner, 2026-11-17, ADR-0074 Amendments): at least 128 random bits from a secure generator (the `rcp_`
token's 32 bytes meet it), base64url, made by the till offline and sent with the sale at sync; the server stores only
its hash, unique, valid for 12 months, and revocable. The public receipt read takes the token and nothing else. Test
that a sale UUID, a document number or a SKU opens no receipt, and that a token reused for a second sale is refused at
sync (the second sale is still recorded; only its link is refused, and the refusal reaches the exception source).
A reused token (owner, 2026-11-17): a 128-bit token cannot repeat by chance, so every reuse goes to the exception
report's source as a possible till fault or tampering, naming the device, the shift, the cashier and both sales,
whatever the reason; and the second sale is marked as needing a fresh server-made link, which B11's receipt SMS sends
(ADR-0074: a link sent by message gets its own token from the worker, never stored in clear). Test that the reuse
reaches the exception source exactly once per refused sale, and that a replayed sync adds no second entry. If the
sale carried no customer phone, say how the customer still gets a working receipt, the most conservative choice
recorded as an assumption. The thermal receipt (FR-POS-021) is the counter sale's escPosBase64.
Stop at the gate and write docs/sessions/B09b5-pos-receipts.md.
```
