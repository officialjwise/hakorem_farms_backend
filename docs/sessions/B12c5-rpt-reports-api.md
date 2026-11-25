# B12 continued 5: the live counter sale's receipt link (BL-133), then split

Date: 2026-11-25 · Branch `b12c5-rpt-reports-api`, from `main` at `7569f0f` (#149, B12f) · Status: **phase split after BL-133 (A-399). BL-133's gate passed locally; CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

**Lane A** has finished (B09c merged 2026-11-23). Lane A items still open: the hand-paid sandbox card cases and the live card key, both B13's. This phase ran alone.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-398 | **How BL-133 was built, each the most conservative option** (dated 2026-11-25). (a) `CounterSale.receiptToken` optional, `OfflineSale.receiptToken`'s pattern: a token not of the form is 400 `VALIDATION_FAILED` and nothing posts, as a sync batch with one is refused; "badly formed" read as a token of the form shaped like a UUID (`TOKEN_IS_AN_IDENTIFIER`), which the sale survives. Absent, the sale is byte-for-byte as before. (b) Judged and recorded after posting, in the sale's transaction, through `ReceiptLinks.judgeIn`/`recordIn` (the synced sale's path and store): hash only, one TILL link, issued at the server's time, tenders as taken, change by `changeDue`. (c) A refusal is recorded as a synced sale's: the `pos.receipt_token_refusal` row once, and raised through a new additive POS event `pos.CounterSaleFlagged` (`RECEIPT_TOKEN_REFUSED`, URGENT, case 37), which RPT classifies as a synced sale's. (d) Migration 0377 widens both guards (`ck_receipt_link_synced` and `ck_receipt_token_refusal_synced`; the second because the refusal row would otherwise refuse the sale), each admitting only a live sale's own row as POS can see it: a registered document other than the shift that no sync logged, on an `OPEN` shift, written by its cashier, a link issued at its recording time. POS may not name `platform.business_document` (the schema-names check), so that the document is a sales order is the application's. (e) NTF's `SALE_RECEIPT` drops its offline-only condition only. **Until the till sends `receiptToken` on live sales, every live sale with a phone is `NO_LINK` on the exception report (case 60).** (f) A replay writes nothing; the token is nowhere stored but as its hash. (g) No new abuse path. | Owner (e); parent session (c, d) |
| A-399 | **The split** (dated 2026-11-25): after BL-133, the reports, exports, dashboard, BL-108's mobile money half and the public API move unchanged to B12 continued 6 (`b12c6-rpt-reports-api`), inserted before B09r with B12 continued 5's gate (ADR-0026 Amendments). | Parent session |

**For the parent session: two readings of the POS leave to confirm.** Both are additive and inside the leave's purpose, but each goes a step past its letter: (1) the new POS event `pos.CounterSaleFlagged`, so a live sale's refused token reaches the exception report as a synced sale's does (the leave says "recorded as it is for a synced sale", which for a synced sale is the row and the report); (2) 0377 also widens `ck_receipt_token_refusal_synced`, since the refusal row cannot be written for a live sale otherwise, and the guard would then refuse the sale. No existing POS function, answer or test changed: `completeCounterSale` with no token is unchanged, and every existing POS spec passed untouched.

**ADR conflicts: none. No stop.** ADR-0083 and ADR-0084 gain Amendments entries (a live sale's till also makes its link; the live half is sent); every rule they hold stands. No ADR-0105 was needed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued 5 (`b12c5-rpt-reports-api`, from `main` `7569f0f`), the only agent building.
2. **Scope:** BL-133 first (the parent session's leave in POS); then RPT's reports, exports and the dashboard; then the public API, splitting at the first boundary the context would not reach.
3. **Gate:** BL-133: a live sale with a phone and a token one text, without a phone none, without a token none (`NO_LINK`), a replay one, a synced sale one, a refused token never refusing the sale; then B12 continued 5's reports and API gate. **BL-133's passed; the rest moved to B12 continued 6 (A-399).**

## Baseline (before any change)

`pnpm test:coverage` on `main` at `7569f0f`: **382 files, 4,747 tests passed, none failed or skipped.** Statements 94.29 %, branches 84.12 %, functions 97.95 %, lines 97.34 %. One note: about a minute into the run I wrote the new spec into the worktree by mistake and moved it out again; Vitest had already collected its files, and the run's 382 files are exactly B12f's figure, so the baseline is clean.

## Contract changes

**2.51.0, minor, no existing shape changed:** `CounterSale.receiptToken` (new, optional, `^[A-Za-z0-9_-]{22,86}$`). **Behaviour:** the receipt SMS now goes for a live till sale with `customerPhone` and a till link; a live sale with a phone and no token is `NO_LINK`. `getPublicReceipt`'s description names the live token. 610 operations from code, 59 planned; Redocly clean. Entry in `docs/CONTRACT_CHANGELOG.md`.

## Built

| Item | What |
| --- | --- |
| POS | `CounterSales.complete` judges and records `receiptToken` through `ReceiptLinks` after posting, in the sale's transaction; a refusal publishes `pos.CounterSaleFlagged` (new event, `events.ts`). `CounterSale` schema gains the field; `pos.module.ts` injects `ReceiptLinks`. |
| Migration **0377** | `pos.receipt_link_guard` and `pos.receipt_token_refusal_guard`, 0292's each with a live sale's own row admitted; in the rollback walk; rollback restores 0292's. |
| RPT | One classifier entry: `pos.CounterSaleFlagged` read as `pos.OfflineSaleFlagged` (unit test in `exceptions.spec.ts`). |
| NTF | `LinkMessages.queueIn` drops `!order.isOffline`. |
| Docs | A-398, A-399, A-397 (d) superseded; BL-133 done; ADR-0083, ADR-0084 and ADR-0026 Amendments; threat model case 37; `data-model/pos.md`; `docs/API.md` (POS); the POS card; the changelog; the openers (B12 continued 6 inserted before B09r, its reference row, B12 continued 5's row and split note). |

## Decided

Nothing structural: the readings are A-398's.

## The gate, proved by running it

**POS** (`test/integration/pos/live-receipt-link.integration.spec.ts`, 7 tests, new): a live sale with a token binds exactly one TILL link holding the token's SHA-256, issued at its recording time, the tenders as taken and 4,000 change, read at once by `getPublicReceipt`; the token is in no link text, answer, audit row, outbox payload or order; a replay answers the first sale and makes no second link; a token already bound completes the sale with no link, one refusal row naming the first sale, one URGENT `pos.CounterSaleFlagged` (case 37, the sale's 6,000), the token still opening only the first sale, and its replay recording nothing more; a UUID-shaped token is refused `TOKEN_IS_AN_IDENTIFIER` and opens nothing; a token not of the form is 400 and posts nothing; without a token nothing is linked, refused or raised and the answer has its five keys. The database refuses a live link written by someone other than the shift's cashier, issued at another time, for the shift itself, or on a closing shift, and a refusal by someone else or for the shift; it admits the sale's own link. **Seen red:** 5 of 7 before the code (`UNKNOWN_FIELD`), and 5 of 7 again with the code but without 0377.

**NTF** (`test/integration/ntf/link-messages.integration.spec.ts`, the live block rewritten as B12f planned it to flip): a live sale with the phone and its token gets one text to that number, its `rcp_` link answering exactly the till link's receipt, the replay none; one without a phone `SUPPRESSED` `NO_ADDRESS`, not published; one without a token `NO_LINK`, published with case 60; a synced sale and its `DUPLICATE` one text, as before. **Seen red** with the offline-only condition put back.

**RPT** (`exceptions.spec.ts`): the new event classifies to `RECEIPT_TOKEN_REFUSED` on the sale, URGENT, case 37, the cashier, the amount. **Seen red** (2 failures) before the entry.

## Security review (hakorem-security-review)

Boundary crossed: TB3 the POS device (a new optional field), TB1 the public receipt (unchanged read), TB8 the database (two trigger functions).
- **Authorisation:** unchanged: `pos.sale.create`, the cashier's own open shift and an enrolled device, all checked before the token is looked at. The wrong role and another cashier's shift are already refused by the existing POS specs, which passed untouched.
- **Tokens:** only the SHA-256 is stored; the token is in no answer, audit row, event or log (tested). One link per sale and one sale per token in the database; a reused or UUID-shaped token is refused and opens nothing for the second sale.
- **Abuse case 37:** a till sending one token with two sales is now caught on a live sale as on a synced one, raised URGENT to the exception report. No new abuse path; rows 74 to 79 unused.
- **Messages (case 60):** one text per sale, only to the number on the sale, read at send; a live sale with no token is `NO_LINK` and reported.
- **Money:** no amount computed; the flag's amount is the receipt's gross.
- **Findings open:** none. A residual for the frontend: a till that never sends the token turns every live sale with a phone into a `NO_LINK` item.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

No new request. **CR-060, CR-061 and CR-062 point 1** move with the reports to B12 continued 6 (each is a `runReport` code); CR-062 point 2 was built in B12 continued 4; every other request is answered in its phase, as the last reports left them. Nothing declined.

## Seed

Not extended: BL-133 adds no seeded record, and the report schedule and API client belong to B12 continued 6's scope.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`) | **4,756 passed, 383 files, none failed or skipped**, on `f37124a` after the last code change (statements 94.29 %, branches 84.13 %, functions 97.95 %, lines 97.35 %; the baseline was 94.29, 84.12, 97.95, 97.34). Every full-coverage gate held. Only this report followed. `main` gained nothing meanwhile (still `7569f0f` when the merge slot was taken), so no rebase, no renumbering and no contract re-bump. |
| The new and changed specs | `pos/live-receipt-link` 7 (new); `ntf/link-messages` 10 (the live test rewritten); `rpt/domain/exceptions.spec` 198; the rollback walk names 0377 |
| POS and RPT integration specs, the rollback walk | 33 files, 327 tests, passed (every existing POS spec untouched) |
| Contract (`pnpm test:contract`) | 145 tests, 58 files, passed. One red run on the way, caused by me: I edited 0377 while the contract run was applying migrations, and `seeded-roles` refused the changed checksum (`was edited after it was applied`). The rerun on the final file passed; no test was changed. |
| Lint (ESLint, lint fixtures, test placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean. The schema-names check refused 0377's first draft, which read `platform.business_document`; the guard now names only POS's own tables. |

## Deferred

- **To B12 continued 6** (inserted before B09r): report definitions and schedules, runReport for every code, the reporting facts and FR-RPT-010, CR-060, CR-061, CR-062 point 1, the dashboard's move, BL-108's mobile money half, the public API; a seeded report run and schedule.
- BL-130, BL-131, BL-132 stand.

## Questions for the owner

1. A live sale whose till sends no receipt token now shows on the daily exception report as `NO_LINK` whenever the buyer gave a phone (A-398 (e)). The till should send a token with every sale; until it does, is that the reminder you want, or should a live sale without a token be left off the report?

## Notes for the frontend track

- **2.51.0:** send `CounterSale.receiptToken` with every live `completeCounterSale`, made exactly as for an offline sale (16 or more random bytes, base64url, no padding; never derived from an id), and kept with the sale so a retry of the same key carries the same token. Show and print `OfflinePack.receiptLinkTemplate` filled with it: the link reads as soon as the sale answers 201. A refused token still answers 201; the link then opens nothing.
- The receipt text now goes for live sales too, when the buyer gave a phone and the till sent the token.

## CI

A report cannot name the runs of the commit that adds it. The branch was pushed at `f37124a` before the pull request was opened; every run on the final head (this report's commit), push and pull_request, is named in the session's closing message to the parent session, and the pull request merges only when each one is green.

## Next session

B12 continued 6 (`b12c6-rpt-reports-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c5-rpt-reports-api.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and API requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/rpt.md and api.md, the RPT and API cards in docs/MODULE_BOUNDARIES.md, ADR-0023, ADR-0103, ADR-0104
and ADR-0026, and section 4 of docs/security/THREAT_MODEL.md (cases 9 and 73, and the rows 74 and 75 this phase may add).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 6 only, on branch b12c6-rpt-reports-api, in this order (CAP was finished in B12 continued,
ADR-0101, CST in B12 continued 2, ADR-0102, the daily exception report in B12 continued 3, ADR-0103, the seed and
the exception rules setting in B12 continued 4, ADR-0104, and BL-133 in B12 continued 5: never change their answers;
a new exception source is a classifier entry and its test, and a new seeded item goes through farm-rpt.ts):
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
TRIAL_BALANCE and DAILY_EXCEPTIONS, their figures the operations' own). Bring in BL-108 for mobile money: a success
the provider reports after the payment had failed is raised as a break (`PROVIDER_PAID_AFTER_FAILURE`), as a card's
is, and reaches the exception report (PAY is shared: additive only; ask the parent session before changing an
existing function). Extend farm-rpt.ts with a seeded report run and schedule. Never seed a password, token or key.
2. API: the public API with keys (hashed, scoped, revocable, rate-limited) and webhooks (signed, replay-safe, retried
   through the outbox).
Stop at the gate and write docs/sessions/B12c6-rpt-reports-api.md.
```
