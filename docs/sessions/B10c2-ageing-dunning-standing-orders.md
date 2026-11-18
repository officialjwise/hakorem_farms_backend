# B10 continued 2: ageing, the statement's ageing summary and dunning (lane B), split before standing orders and the quote pipeline

Date: 2026-11-18 · Branch `b10c2-ageing-dunning-standing-orders`, from `main` at `97e562f` (B10 continued, #111), rebased at the merge slot on `main` at `c3c115a` (lane A's B09b continued 2c, #112: migrations renumbered 0264 to 0268 above lane A's 0262 and 0263, contract 2.16.0 above lane A's 2.15.0) · Status: **gate as split passed locally; the phase split at its sub-domain boundary (A-319).**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-317 | **Ageing and the statement's summary (ADR-0089):** (a) as at a date, from BIL's documents with their credit notes by then and PAY's allocations dated by the application clock's business day (`allocated_on`, 0264; older rows by `recorded_at`'s day), each balance whole in its band of days past due from the due date (issue date when none); (b) **SA-21's day counts win over FR-WHL-010's example**: an invoice due 14 October is 61 days past due on 14 December, so it is in **61 to 90**, not 31 to 60 (31 to 60 runs to 13 December); (c) what 1200 holds beyond the open items (an opening balance journal, a refund, an allocation at another branch) is shown as **not aged**, never put into a bucket, so the report ties to 1200 exactly; the till's walk-in customer is in the totals as `otherPartiesPesewas`; (d) **A-300 (i) decided the conservative way: the statement stays 1200 only, no deposit (2200) or store credit (2210) figure, nothing on it changes; flagged for the owner** (whether to show money on deposit as a figure apart); the summary is stored with the statement, tied by the database to its closing; (e) read by the Owner, the Manager, Sales and the Accountant (CR-048). | Accountant (a, b, c), **Owner (d)**, Owner (e) |
| A-318 | **Dunning:** (a) only invoices and debit notes of customers with a business account (held or not, never closed); (b) the highest level reached, once per level per document, never a lower one after a higher, held by the database; (c) queued through the outbox (`whl.DunningNoticeDue`) in one transaction per account; **NTF (B11) sends it and skips an opted-out channel for the next** (NTF's opt-outs do not exist yet); (d) daily at 08:00 Accra; (e) read by the four roles, levels replaced by the Owner and the Manager only, no step-up; (f) the seed sets 7, 14 and 30 days; an unseeded farm sends nothing until levels are set. | Owner, Accountant (a) |
| A-319 | **The split:** ageing, the statement's summary with A-300 (i) and dunning built; standing orders (FR-WHL-004), the bad-debt write-off (FR-WHL-012), QUO's remainder (document, pipeline, `listMyQuotes`, CR-047 point 2), the owner's QUO decisions of 2026-11-18 (several live links; subject to stock after ADR-0019) and UAT scenario 2's dry run move to **B10 continued 3** (`b10c3-standing-orders-quote-pipeline`), before B11. | Owner |
| A-314 (amended) | **The owner's decision 4 of 2026-11-18, approved and built after the first merge (B10 continued 2b, below):** paying off an overdue account releases the hold automatically only if the system placed it; a person's hold stays until an Owner or Manager who did not ask releases it. | **Approved by the owner, 2026-11-18** |

**No ADR conflict.** ADR-0089 is new (proposed). ADR-0067 is followed (the new column's default reads `platform.app_now()`, no `now()` in business SQL, the tests take their dates from `testStartTime` and the clock); ADR-0085 is followed (the statement's figures are unchanged; the summary is added beside them); ADR-0017 and ADR-0088 are untouched. ADR-0019 was not read: the subject-to-stock decision moved with QUO's remainder to B10 continued 3, untouched here.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B10 continued 2, lane B (`b10c2-ageing-dunning-standing-orders`, from `main`).
2. **Scope:** ageing as at a date, the statement's ageing summary with A-300 (i), dunning; split early at the sub-domain boundary, as the parent session advised, before standing orders, the write-off and QUO's remainder.
3. **Gate (as split):** ageing by Current, 1 to 30, 31 to 60, 61 to 90 and over 90 days from invoice due dates and allocations as at a date ties to SQL sums from the owning tables and to 1200; the customer statement carries its ageing summary; each dunning level reaches an invoice at most once however often the job runs; every write refuses the wrong role.

## Contract changes

**2.16.0, minor, additive** (on top of lane A's 2.15.0, renumbered at the merge slot; `scripts/contract/versioning.ts` against `main`: ok; Redocly clean, no warning; `contract:generate` up to date: 489 operations from code, 159 planned, 648 in all).
- **Into code:** `getAgeingReport`, `listDunningLevels`, `replaceDunningLevels`, `listDunningNotices`.
- **Planned shapes widened before any client used them:** `AgeingRow` and `AgeingTotals` gain `ledgerPesewas`, `ledgerCreditPesewas`, `notAgedPesewas`, `notAgedCreditPesewas`; `AgeingReport` gains `otherPartiesPesewas`, `otherPartiesCreditPesewas`; `DunningNotice` gains `daysPastDue`, `templateCode`; the level 2 example is 14 days.
- **Implemented operations:** `CustomerStatement.ageing` (new `StatementAgeing`), a new required, nullable response field on `listStatements`, `createStatement`, `getStatement`; null on a statement issued before.
- **New error code:** 422 `DUNNING_POLICY_INVALID`. Seeded role matrix: `whl.ageing.read`, `whl.dunning.read`, `whl.dunning.manage`.

## Built

| Item | What |
| --- | --- |
| Schema | 0264 (`pay.payment_allocation.allocated_on`, defaulted from the application clock), 0265 (the statement's eight ageing columns with `ck_statement_ageing_set` and `ck_statement_ageing_ties`; `whl.dunning_policy` MASTER; `whl.dunning_notice` LEDGER with `uq_dunning_notice_level` and `whl.dunning_notice_check`, HK010 `ck_dunning_notice_order`), 0266 (three permissions), 0267 (grants per CR-048), 0268 (statement template version 2 with the ageing section; version 1 retired only if still active). |
| Domain | `whl/domain/ageing.ts` (`bucketOf`, `ageCustomer`, `sumAgeing`), `whl/domain/dunning.ts` (`levelDue`, `judgeLevels`, `byLevel`), `statementRenderData`'s ageing, `pageFrom`. Under WHL's 100 percent domain gate. |
| WHL | `Ageing` (the report; `customerIn` for the statement), `Dunning` (levels, replace, notices, the job), `ReceivablesController`, `PgDunningStore`; `Statements` stores and answers the summary. The worker's `dunning` job, daily 08:00. |
| PAY, BIL, FIN (additive) | `AllocationsAsAt.netAppliedIn` (new class), `Billing.receivablesAsAtIn`, `Journals.customerReceivableBalancesIn`. Lane A's files untouched (`sale-posting.ts`, PAY's till rules). |
| Seed | `whl-dunning` (`farm-whl.ts`): the seeded Owner sets 7, 14 and 30 days. The seeded Tema statement now carries its summary. Every other seeded figure unchanged. |
| Docs | ADR-0089 and its index line; ADR-0026 Amendments (the split); A-317 to A-319; `data-model/whl.md` and `pay.md`; the WHL card; `API.md` (WHL, the code); `OPERATIONS.md` (the job); the changelog; the openers (B10 continued 2 marked, B10 continued 3 inserted, B11 reads its report, the lane list). |

## The gate, proved by running it

**`test/integration/whl/ageing-dunning.integration.spec.ts` (13 tests):**
- **FR-WHL-010:** 80,000 due in 30 days, 30,000 paid: as at today and the due date Current; due + 1 and + 30 in 1 to 30; + 31 and + 60 in 31 to 60; + 61 and + 90 in 61 to 90; + 91 over 90; each 50,000, total 50,000, ledger 50,000, nothing not aged; the day before issue, nothing. Every figure equals the SQL sum from `bil.billing_document` and `pay.payment_allocation`, and total plus not aged less not aged credit equals 1200 from `fin.journal_line`.
- **What is not aged:** an opening balance of 100,000 by manual journal and an invoice of 40,001: Current 40,001, ledger 140,001, not aged 100,000; the day before, total 0 and not aged 100,000.
- **Dated movements:** a credit note of 20,000 today and 30,000 paid ten days later (`allocated_on` the later day in SQL): 80,000 the day before the payment, 50,000 on it, 50,000 in 1 to 30 a day past due; 1200 ties every date.
- **The whole branch:** page by page by name (limit 2), the same totals on every page, each total the rows' sum plus the walk-in customer's; equal to the SQL buckets and tied to 1200 for every customer party at Dodowa; the account manager filter keeps only that manager's customer.
- **Roles:** the Owner, the Manager, Sales and the Accountant read; the Cashier and the Storekeeper 403; a customer 401; the Owner of another branch reads nothing of Dodowa.
- **The statement:** issued for two customers, its `ageing` equal to the report as at the period end, total plus not aged less not aged credit equal to closing less closing credit and to 1200 in SQL; `getStatement` answers the same to Sales. Template version 2 active, version 1 retired, its body accepted by DOC's checker and printing the section. The database refuses the summary changed afterwards (HK004) and a statement whose summary does not tie (23514).
- **Dunning levels:** the seeded 7, 14, 30; the Cashier and the Storekeeper 403 on reading; the Accountant, Sales and the Cashier 403 on replacing; a gap 422 `LEVELS_NOT_CONSECUTIVE`, a channel twice `CHANNEL_REPEATED`; the Manager replaces (given in reverse, answered in order), a replay answers the same; audited once each.
- **Once per level:** an invoice of 60,000 due today: nothing at 6 days; at 7 days the job run twice and then twice at once gives one level 1 notice and one outbox event; at 14 days level 2 once; at 31 days level 3; a paid invoice none; a customer whose account opens at 31 days gets level 3 only (9,999 outstanding, 31 days), its event carrying the document number, channels and template.
- **The notices:** newest first, with level, days, outstanding 60,000, channels and the document; paged; the Cashier 403; another branch's Owner nothing.
- **A crash mid-run:** a trigger stops the run on the second of two accounts: the first has its notice and its event, the second neither; the next two runs finish it once.
- **The database:** a level again, and a lower level after a higher, refused (HK010); a notice updated 42501 for `hk_app`, HK001 beneath; deleted HK001.

**Unit:** `ageing.spec.ts` (11), `dunning.spec.ts` (9), the statement's printed summary (3), `pageFrom` (1).

**Walks extended:** `iam/authorisation` (the four routes and the PUT body), `bil/archive-link-rollback` (0264 to 0268 rolled back and applied), `platform/seed` (21 units), the contract's request schemas and operation count; new `test/contract/b10c2/ageing-dunning.contract.spec.ts`.

## Mutation checks (each applied alone, the gate spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | Allocations counted whatever their date | red: 1 |
| 2 | Each band ends a day early | red: 3 |
| 3 | What 1200 holds beyond the open items put into Current | red: 4 |
| 4 | The job ignores the levels already sent (application only) | green: the database refuses the second notice and the store answers "already" |
| 5 | The lowest level reached sent, not the highest | red: 3 |
| 6 | The Cashier granted `whl.ageing.read` | red: 1 |
| 7 | The Accountant granted `whl.dunning.manage` | red: 1 |
| 8 | The whole run in one transaction | red: 1 (the crash test) |
| 9 | Mutation 4 with `uq_dunning_notice_level` and `trg_dunning_notice_check` removed | red: 4 |

## Test first, as it honestly happened

- **Red first:** `ageing.spec.ts` and `dunning.spec.ts` (modules missing) before the code; then 2 of the ageing spec red for my own mistakes in the test (61 days is 61 to 90, A-317 (b); a due date 92 days back is over 90), fixed in the test. The printed summary's tests red against the first rendering (`GHS` prefix, and the key kept off old statements).
- **The gate spec's first run:** 8 of 12 green, 4 red for my own defects: the walk-in customer's 1200 party (no MDM customer, a 500), the level replace missing `version + 1` (a 500), my expectation of Current for a ten-day-old invoice. The statement suite then showed the template's `<h3>` refused by DOC's checker (the archive never written), fixed and covered by a new test.
- **Not red first:** the contract spec and the walks' additions were written after the code; mutations 6 to 9 prove the role and once-only tests bite.
- **Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.**

## Security review (hakorem-security-review's checklist, item by item)

- **Boundary:** TB2 (back office), the worker and the database. No login, session, upload, webhook, export or payment change.
- **Authorisation:** every handler authorises first, deny by default; reads at whole-branch scopes; the four routes are on the identifier walk; wrong roles refused and mutation-checked. **Input:** strict zod (levels 1 to 10, days 1 to 365, one to three channels, the template's pattern). SQL parameterised only. **Money:** integer pesewas (bigint), sums only, exact against SQL. **Side effects:** through the outbox, in the notice's transaction. **Logging:** no personal data in the event beyond ids and amounts.
- **Abuse:** a reminder flood is bounded by the database (each level once per document); levels are changed only by the Owner or a Manager and audited. No new abuse case.

## Added after the first merge: B10 continued 2b (branch `b10c2b-automatic-hold-release`, contract 2.16.1)

The owner's decisions relayed by the parent session after #113 merged, answered here.

**Decision 4 on A-314 (built, test-first in the domain, a dated amendment to A-314):**
- Migration 0269: `whl.business_account.hold_automatic`, true exactly while the account is on a hold the overdue job placed, set only as it goes on hold and cleared as it leaves (HK010 `ck_business_account_hold_automatic`); the guard lets only such a hold leave without an approved release. Holds placed before 0269 count as a person's (the conservative reading).
- `whl/domain/credit.ts` `releasesOnPayment` (red first: 3 of 3): only a system hold, only when nothing owed is one day or more past due; what is owed but not yet due does not keep the hold.
- `BusinessAccounts.releasePaidIn`, run by WHL's new consumer `whl.hold-release-on-payment` of `pay.PaymentCleared` and `pay.DepositAllocated` (as the Outbox dispatcher, a SYSTEM principal) and by the `account-hold` job's daily pass (as the Scheduler) before it holds; audited `RELEASE_PAID`, `whl.AccountReleased` with `automatic: true`.
- **Tests** (`test/integration/whl/credit-control.integration.spec.ts`, two added, 17 in all): the seeded-in-test system hold on an invoice of 1,000: a cheque of 999 releases nothing (one pesewa overdue in SQL, still `ON_HOLD`, the daily pass releases nothing, no audit); the last pesewa releases it on the payment's own event; the daily pass and a second dispatch change nothing; exactly one `RELEASE_PAID` audit row, its actor a SYSTEM principal, and one `whl.AccountReleased` with `automatic: true`. A hold placed by the Accountant is not released by paying its invoice in full, by the event or the daily pass; the database refuses it made automatic afterwards and released without an approved change (HK010).
- **Mutation checks:** a person's hold released on payment in the application only: red 1 (the database refuses it, the release fails); in the application and the database: red 2; released whatever is still overdue: red 1; the overdue job marking no hold as the system's: red 1.

**F10l's quote link (the console shows a link once; a staff session behind an acceptance flagged):** QUO's work is B10 continued 3's (A-319), so this is **written into B10 continued 3's opener** as the owner's item 4, in the owner's words, with abuse case 40 reserved for it. **No CR number for it on the frontend's main at `aad2c91`** (the newest there are CR-051 and CR-052, both POS, lane A's).

## Deferred

To **B10 continued 3**: standing orders, the bad-debt write-off, QUO's document, pipeline and `listMyQuotes`, CR-047 point 2, the owner's QUO decisions (several live links on three conditions; subject to stock, after reading ADR-0019) and UAT scenario 2's dry run with its two owner questions (credit check and delivery fee on a partial dispatch). To **B11**: dunning's sends and the opted-out channel skipped (NTF), `sendStatement`.

## Contract requests (the frontend's `main` at `a0059c7`)

- **CR-048** `whl.ageing.read`: **implemented** (Owner, Manager, Sales, Accountant), with `getAgeingReport`.
- **CR-047** point 2 (`PublicQuote.acceptedName`, `decidedAt`): **moved to B10 continued 3** with QUO's remainder (small and additive); `supersededAt` stays declined (ADR-0087).
- **CR-051** (the offline pack names its units): **new on main, POS's: lane A's** (its module); named for the parent session to schedule.
- **CR-045, CR-046, CR-049, CR-050:** answered in B10 and B10 continued, or lane A's.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`) | **3,608 passed**, 298 files, none skipped, on `64c3893`. Statements 94.10 percent, branches 83.91 (the gate is 80), functions 97.81, lines 96.95; every 100 percent gate held, WHL's domain (`ageing.ts`, `dunning.ts`, `paging.ts`, `credit.ts`, `time.ts`, `statement.ts`) included. **The first full run was red on 5 tests in 2 files**, each a consequence of this phase, fixed in `64c3893` before the next run and never re-run to green: 0268's down step tried to make retired template version 1 active again, which DOC's guard refuses (HK004), breaking the migration runner's full rollback (4 tests); and the identifier walk did not yet list the two dunning level operations as taking no identifier. |
| After the rebase on `c3c115a`, at the merge slot | Unit **1,766 passed** (149 files); the affected integration suites (WHL, PAY, POS, BIL, platform, the authorisation and identifier walks) **471 passed** (48 files); contract **131 passed** (50 files); typecheck, `contract:generate`, Redocly and versioning against `main` clean. |
| Contract (`pnpm test:contract`) | **131 passed**, 50 files, with the new `test/contract/b10c2/ageing-dunning.contract.spec.ts`. The first contract run was red on 2 tests in 3 files, each this phase's: the operation count (now 489 in code, 159 planned), the request schema of `replaceDunningLevels` not yet in the walk, and the new spec signing in the Accountant without TOTP enrolment; fixed before the next run. |
| Lint (module boundaries, fixtures, placement, schema names), typecheck, Redocly (no warning), `contract:generate`, versioning against `main` | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied | Run in CI; the runs are named in the closing message. |

## Notes for the frontend track

- **2.16.0:** the ageing screen can use `getAgeingReport`: show the five buckets and the total from the server, and `notAgedPesewas` (or its credit) as "not on any open invoice" when not nil; `totals` is over the whole filter.
- **Statements:** `ageing` is the summary as at the period end; null on older statements.
- **Dunning:** levels are replaced whole by the Owner or a Manager; notices show level, days past due and the channels; they are queued, and sent by NTF from B11.

## CI

- **The code head:** every run on it is named in the session's closing message to the parent session, with its event and conclusion; the pull request merges only when every run on its head is green.
- **This report's own commit:** a report cannot name the runs of the commit that adds it, so they are named in the session's closing message.

## Next session

B10 continued 3, copied from `docs/prompts/session-openers.md` (inserted by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md, and "Two lanes" below.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c2-ageing-dunning-standing-orders.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
CR-047's remaining point 2 (PublicQuote.acceptedName and decidedAt) is this phase's to implement or decline; check the
numbers again on main (CR-051 and CR-052 are lane A's POS).
For this phase, read FR-WHL-004 and FR-WHL-012 of the WHL block of docs/SRS.md and FR-QUO-007, FR-QUO-008 and
FR-QUO-013 of the QUO block (nothing else from the SRS), docs/data-model/whl.md and quo.md, the WHL and QUO cards in
docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.12, ADR-0017, ADR-0019, ADR-0087, ADR-0088, ADR-0089, and A-309 to
A-319 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 continued 3 only, on branch b10c3-standing-orders-quote-pipeline from main, building on WHL and QUO as
B10 to B10 continued 2 merged them (do not rewrite them):
standing orders and their runs (FR-WHL-004: weekly on named days or every n days, a start and an end, one order per
standing order and date however often the scheduler runs, each run recorded with the order or the reason none was, a
paused order generating nothing, a held account's run recorded as skipped; a double run and a crash mid-run tested);
the bad-debt write-off (FR-WHL-012: maker the Accountant, checker the Owner, never the same person, held by the
database the way CR-043 is, with wrong-role and maker-is-checker tests, mutation-checked; Dr 6940 Cr 1200 with the
customer as subledger, the invoice never edited, the open item closed with a link to the journal; load hakorem-ledger
first; the ageing of B10 continued 2 then shows it closed).
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
   for review. Add the abuse path to docs/security/THREAT_MODEL.md as abuse case 40 (lane B's block). (c) The link
   token is shown once: returned only in the send's response, never readable again since only its hash is stored
   (ADR-0074, ADR-0087); test that no read returns it. Tests: an acceptance with no staff session is not flagged; one
   with a staff session is flagged with that staff member; a decline with a staff session is flagged too; a mutation
   that skips the flag turns a test red.
Run scenario 2 of docs/UAT.md as a dry run and record every difference, including the two rules that scenario flags for
the owner (credit check and delivery fee on a partial dispatch), decided conservatively and put to the owner.
Stop at the gate and write docs/sessions/B10c3-standing-orders-quote-pipeline.md.
```
