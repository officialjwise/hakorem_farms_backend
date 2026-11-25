# B12f: the frontend's F10o follow-ups, who approved a quote version, and the receipt SMS for every till sale

Date: 2026-11-25 (begun 2026-11-24) · Branch `b12f-f10o-approver-receipt-sms`, from `main` at `96a0c42` (#148, B12 continued 4) · Status: **gate passed locally, with the receipt SMS's live half recorded and not built (A-397 (d), BL-133). CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

The container restarted once mid-phase (after the docs commit and the 0376 fix were written, before either was pushed). Nothing was lost: the worktree and the baseline log were intact, and the tests covering the uncommitted changes were run again before they were committed.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-396 | **The owner's decisions of 2026-11-24, from the frontend's F10o, recorded verbatim** (dated 2026-11-24): who approved each quote version, so the console can hide "Issue and send" from the approver; the receipt link by SMS, `/r/{token}` under the shop's configured address; every till sale where the buyer gave a phone number gets the receipt text, online or offline, amending A-349 (c). | Owner (decided) |
| A-397 | **How B12f built them, each the most conservative option** (dated 2026-11-25). (a) `QuoteVersion.approvedBy` is read from QUO's own `approved_by`, which QUO's approval handler writes from IAM's decision: no new column, no new IAM read, proved equal to IAM's `decided_by`. (b) Additive, LOUD, not in `required`; staff only, never on `PublicQuote`. (c) Issuing an approved version whose line is held by one reservation answered 500; fixed by migration 0376 (QUO). (d) **A live counter sale gets no receipt text:** its till makes no receipt link (ADR-0083, `ck_receipt_link_synced`), and the text may only link the till's receipt (ADR-0084, BL-118); queuing it would record `NO_LINK` and raise abuse case 60 on every live sale. NTF's rule is unchanged; the live half waits for a POS change (BL-133). (e) A synced sale with no phone stays `SUPPRESSED` `NO_ADDRESS`. (f) No new abuse path; threat model row 75 unused. | Owner (a, b, d); parent session (BL-133) |

**For the parent session to schedule: BL-133, the live counter sale's receipt link.** The owner's decision 2 is met for synced till sales only. A live sale (`completeCounterSale`) makes no receipt link, so the owner's "online" half cannot be sent without changing POS: `CounterSale.receiptToken` (additive in the contract) written as a `pos.receipt_link` in the live sale's transaction, which changes `completeCounterSale` and the database rule `ck_receipt_link_synced` (migration 0292). Both are existing POS behaviour, so per the brief they were not touched; they need the parent session's leave. Once POS makes the link, NTF's change is one condition (`!order.isOffline` in `LinkMessages.queueIn`) and the test this phase added flips.

**ADR conflicts: none. No stop.** ADR-0083 and ADR-0084 are kept exactly; ADR-0084 gains an Amendments entry recording the owner's decision and why the live half is not sent. No ADR-0105 was needed (no structural decision).

**Shared modules:** POS, IAM, PAY, `sale-posting.ts` untouched. QUO (lane B's) gained one view field and one migration (0376) that adds `APPROVED` to 0253's line guard; NTF (lane B's) a comment and a test.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12f, the frontend's F10o follow-ups (`b12f-f10o-approver-receipt-sms`, from `main` `96a0c42`), inserted before B12 continued 5; the only agent building.
2. **Scope:** QUO's `QuoteVersion.approvedBy`; NTF's receipt text for every till sale with the buyer's phone, live or synced, after checking whether a live sale's till makes a receipt link; POS unchanged.
3. **Gate:** an approved version names its approver, every other null, never on the buyer's views, the approver's issue refused and another's accepted; a till sale with the phone and a till link gets one text, never two, none without a phone, `NO_LINK` without a till link; a live sale whose till makes no link sends none, the reason recorded. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `96a0c42`, nothing changed in the worktree while it ran (it finished before the container restart; its log survived): **381 files, 4,742 tests passed, none failed or skipped.** Statements 94.27 %, branches 84.10 %, functions 97.93 %, lines 97.33 %.

## Contract changes

**2.50.0, minor, LOUD for `QuoteVersion.approvedBy`** (a new field on an existing answer, always sent, not in `required`): no field, parameter or status removed or retyped; no operation added. Every QUO example shows `approvedBy: null`. **Behaviour:** issuing an `APPROVED` version whose line is held by one reservation now issues where it answered 500. 610 operations from code, 59 planned; Redocly clean. Entry in `docs/CONTRACT_CHANGELOG.md`.

## Built

| Item | What |
| --- | --- |
| QUO | `QuoteVersionView.approvedBy` (`Ref` or null) from the version's `approved_by`, named through IAM's `PrincipalNames` like `issuedBy`; on every operation that answers a `QuoteVersion`; never in `PublicQuoteView`. |
| QUO fix | Migration **0376** (`quo.quote_line_guard`, 0253's with `APPROVED` beside `DRAFT` and `PENDING_APPROVAL` for naming a single reservation once). Found by this phase's test: "Issue and send" on an approved one-goat quote answered 500 (`the lines of a version that is APPROVED are frozen`). In the rollback walk. |
| NTF | Unchanged behaviour; `LinkMessages` comment names A-396, A-397 (d) and BL-133. |
| Docs | A-396, A-397, A-349 (c) marked amended; BL-133; ADR-0084 Amendments; ADR-0026 Amendments; `docs/API.md` (QUO); `data-model/quo.md`; the changelog; the openers (B12f inserted before B12 continued 5, its reference row, B12 continued 5 reads this report). |

## Decided

Nothing structural. The two readings (A-397 (a) and (d)) are the conservative ones the brief named.

## The gate, proved by running it

**Who approved** (`test/integration/quo/quote-approver.integration.spec.ts`, 4 tests): a below-floor version is `approvedBy: null` while drafted and while `PENDING_APPROVAL`; approved by the Manager it names `{ id, displayName: 'Akosua Boateng' }`, equal to IAM's `decided_by` by SQL; the Manager's issue is 422 `APPROVER_CANNOT_ISSUE` and the version stays `APPROVED`; Sales' issue is 200 `ISSUED` and the approver stays on the version, in `getQuote` and `listQuoteVersions`; a version issued at once and one whose approval the Owner rejected answer null (the column null by SQL). The buyer's link (`viewQuoteByLink`) and `listMyQuotes` contain neither the approver's id, nor name, nor the key `approvedBy`; the Cashier and another branch's Owner are 403 and a customer 401 on `getQuote` and `listQuoteVersions`, none showing the approver. **Seen red**: three failures before the view carried the field. The fix test: an approved one-goat version issued by Sales holds the goat once, names the hold on its line, and its lines stay frozen after (HK004). **Seen red**: 500 before 0376.

**The receipt SMS** (`test/integration/ntf/link-messages.integration.spec.ts`, one test added, the existing ones unchanged): a live sale with the buyer's phone, its replay with the same key (the same order), and a live sale without a phone each publish `ord.OrderCompleted` once, delivered to `ntf.link-messages`, and queue no message, no till link and no `ntf.MessageSuppressed`; a synced sale with the phone and its replayed sync (`DUPLICATE`) send exactly one text to that number, `SENT`, `…/r/rcp_…` under `RECEIPT_LINK_BASE_URL`. **Seen red** with the offline-only condition removed on purpose (a live sale then queues a message that can only be `NO_LINK`). The existing tests still hold the rest of the gate: one text per synced sale linking exactly the till's receipt, a replay and a redelivery one, a sale with no number `NO_ADDRESS`, a refused or absent till token `NO_LINK` with abuse case 60, a STOP not stopping it, the token never stored.

## Security review (hakorem-security-review)

Boundary crossed: TB2 back office (a read), TB1 public storefront (the buyer's views, unchanged), TB8 the database (one trigger function).
- **Identity, sessions, browser:** unchanged; no cookie, login or token added.
- **Authorisation:** no operation or permission added; `approvedBy` rides on the answers its callers may already read (`quo.quote.read` and branch scope in the handler, unchanged), tested with the wrong role, another branch and a customer. It names a staff member, so it is not on `PublicQuote` (tested through the link and `listMyQuotes`). Maker-checker unchanged: the approver's issue refused, the author never the approver (0253, 0278 and the handler).
- **Input:** none added; parameterised SQL only.
- **Money and stock:** 0376 lets an approved version's issue name its single hold once, as a draft's does; the reservation itself is INV's, unchanged; no amount changes.
- **Messages:** no text sent twice (a live sale and its replay none; a synced sale and its replay one); only to the number on the sale, read at send; no token stored (the existing `writtenAnywhere` check). A live sale gets no text rather than a `NO_LINK` flood on the exception report.
- **Data protection and logging:** a staff member's display name is already shown as `issuedBy` and `createdBy` to the same callers; nothing personal of a customer added.
- **Uploads, exports, webhooks, rate limits:** not applicable (none touched).
- **Abuse paths:** none new or altered (the approver's identity reaches no one who could not already see `approvalRequestId` and the approval inbox); threat model row 75 not used. Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

No new request. The owner's F10o decisions came by the parent session, not as a CR. **CR-060, CR-061 and CR-062 point 1** stay with B12 continued 5 (each is a `runReport` code, which that phase builds); CR-062 point 2 was built in B12 continued 4; every other request is answered in its phase, as the last reports left them.

## Seed

Not extended. The seed's quote (`farm-quo.ts`) is issued at once, so it answers `approvedBy: null`; a seeded approved version needs a second person's stepped-up approval through IAM, and a live till sale with a phone sends no text (A-397 (d)), so neither would show more than the tests do. Left for B12 continued 5's seed if the frontend asks.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`) | **4,747 passed, 382 files, none failed or skipped**, on `f619a53` after the last code change (statements 94.29 %, branches 84.12 %, functions 97.95 %, lines 97.34 %; the baseline was 94.27, 84.10, 97.93, 97.33). Every full-coverage gate held. Only this report followed. `main` gained nothing meanwhile, so no rebase. |
| The new and changed specs | `quo/quote-approver` 4 (new, integration); `ntf/link-messages` 1 added (10 in all); the rollback walk names 0376 |
| QUO's integration specs | 7 files, 77 tests, passed |
| Contract (`pnpm test:contract`) | 145 tests, 58 files, passed |
| Lint (ESLint with module boundaries), typecheck, Redocly, `contract:generate` | Clean (610 operations from code, 59 planned) |

Existing specs changed only for what this phase added: the rollback walk (0376). No expectation weakened, nothing skipped.

## Deferred

- **BL-133** (the live counter sale's receipt link, then its text): waits for the parent session's leave in POS (above).
- The seed's approved quote version (see Seed).

## Questions for the owner

1. **A-397 (d):** a sale rung up at the till while online sends no receipt text yet, because the till makes the receipt link only for a sale it queues offline. Making one for a live sale is a change to the till's sale (BL-133). Shall it be scheduled?

## Notes for the frontend track

- **2.50.0, LOUD:** `QuoteVersion.approvedBy` (`PrincipalRef` or null, always sent, not required). Hide "Issue and send" on an `APPROVED` version when `approvedBy.id` is the signed-in user: the server still refuses them (`APPROVER_CANNOT_ISSUE`). Never on `PublicQuote`.
- Issuing an approved version of one animal or one lot no longer answers 500.
- The receipt SMS still goes only for a sale the till synced (offline); a live `completeCounterSale` gets none until BL-133. No shape changed for it.

## CI

A report cannot name the runs of the commit that adds it. The branch was pushed at `4cce04b` and `f619a53` before the pull request was opened; every run on the final head (this report's commit), push and pull_request, is named in the session's closing message to the parent session, and the pull request merges only when each one is green.

## Next session

B12 continued 5 (`b12c5-rpt-reports-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it (it now reads this report):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12f-f10o-approver-receipt-sms.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and API requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/rpt.md and api.md, the RPT and API cards in docs/MODULE_BOUNDARIES.md, ADR-0023, ADR-0103, ADR-0104
and ADR-0026, and section 4 of docs/security/THREAT_MODEL.md (cases 9 and 73, and the rows 74 and 75 this phase may add).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 5 only, on branch b12c5-rpt-reports-api, in this order (CAP was finished in B12 continued,
ADR-0101, CST in B12 continued 2, ADR-0102, the daily exception report in B12 continued 3, ADR-0103, and the seed and
the exception rules setting in B12 continued 4, ADR-0104: never change their answers; a new exception source is a
classifier entry and its test, and a new seeded item goes through farm-rpt.ts):
1. RPT: report definitions and schedules (`rpt.report_definition`, `rpt.report_schedule`, `rpt.report_run`), with the
   reporting facts each report reads (`docs/data-model/rpt.md`) and FR-RPT-010's nightly comparison of their key totals
   (`rpt.ProjectionDriftDetected`). runReport must implement every report code listReportDefinitions lists,
   SALES_SUMMARY and PURCHASES included (CR-018), each matching its contract example's columns; every export audited
   with its row count (a bulk export needs `rpt.report.export.bulk` with step-up and lands on the exception report as
   BULK_EXPORT, which B12 continued 3 already reads from the audit trail). The permissions and their grants exist
   (migrations 0374 and 0375, A-393): decide in the application which reports the Accountant runs (the financial ones).
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES (the daily exception report answers them now: B12 continued 3).
The owner, 2026-11-23 (from the frontend's F12 and F10n): build CR-060 to CR-062. Every margin is over the selling
price, (price less cost) over price, and anything over cost is markup and named markup (the owner, 2026-11-23),
CR-060's margin per crate included. Add the egg report codes (CR-060), the VAT return (CR-061, tied to the ledger's tax
accounts to the pesewa), and the statement and exception report exports (CR-062: PROFIT_AND_LOSS, BALANCE_SHEET,
TRIAL_BALANCE and DAILY_EXCEPTIONS, their figures the operations' own). Extend farm-rpt.ts with a seeded report run and
schedule. Never seed a password, token or key.
2. API: the public API with keys (hashed, scoped, revocable, rate-limited) and webhooks (signed, replay-safe, retried
   through the outbox).
Stop at the gate and write docs/sessions/B12c5-rpt-reports-api.md.
```
