# B12 continued 6: the till sales without a receipt token counted (the owner's decision), CR-064, then split

Date: 2026-11-25 · Branch `b12c6-rpt-reports-api`, from `main` at `eb7a35a` (#150, B12 continued 5) · Status: **phase split after the owner's decision and CR-064 (A-401). Their gate passed locally; CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

**Lane A** has finished (B09c merged 2026-11-23). Lane A items still open: the hand-paid sandbox card cases and the live card key, both B13's. This phase ran alone.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-400 | **The owner's decision, 2026-11-25, recorded verbatim: "Count them, list only refusals."** As built, each the most conservative option: (a) "a till sale that sent no token" is read from NTF's own record, a `SALE_RECEIPT` message held back `NO_LINK` (`ntf.MessageSuppressed`), so a sale is counted when the buyer gave a phone number, live or synced; no other module publishes anything new. (b) A fact, `rpt.unlinked_receipt_fact` (migration 0378), once per message, counted once per sale, emptied and replayed on a rebuild. (c) The count line is a new field, `DailyExceptionReport.countLines` (`TILL_SALES_WITHOUT_RECEIPT_TOKEN`, case 60, contract 2.52.0, LOUD), with no actor and no amount, outside `counts`. (d) A sale with a `RECEIPT_TOKEN_REFUSED` item is never counted, whatever the day. (e) A held-back message naming no sale or no branch stays a `MESSAGE_SUPPRESSED` item, so nothing vanishes unseen; every other reason and template is unchanged. (f) No migration deletes items already projected (none exist outside tests; a rebuild drops them). | Owner (decided); (a) to (f) the owner |
| A-401 | **The split** (dated 2026-11-25): after the owner's decision and CR-064, the reports, exports, dashboard and public API move unchanged to **B12 continued 7** (`b12c7-rpt-reports-api`), inserted before B09r with B12 continued 6's gate (ADR-0026 Amendments). BL-108's mobile money half was already built in B12 continued 3; only its backlog row was open, now marked done. CR-065 is named for the parent session to schedule. | Parent session |

A-398 now records the parent session's confirmation (2026-11-25) of B12 continued 5's two readings of the POS leave: `pos.CounterSaleFlagged` and 0377's widening of `ck_receipt_token_refusal_synced` are both within its condition (c).

**For the parent session, to schedule: CR-065** (the frontend's F10p, 2026-11-25: the card page's return route and what it carries; a 503 with the order placed naming the order's number and tracking token). Point 1 needs a decision on whether the order's tracking token may travel through Paystack in the return address (today the return address is configuration, https, no query), and it touches the card provider (lane A's former, additive only); point 2 is ORD's `placeOrder`. Not started here.

**ADR conflicts: none. No stop.** ADR-0103 gains an Amendments entry; every rule it holds stands. No ADR-0105 was needed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued 6 (`b12c6-rpt-reports-api`, from `main` `eb7a35a`), the only agent building.
2. **Scope:** the owner's decision on the 'no link' receipt items; BL-108's mobile money half if it remained; then the reports, exports and dashboard; then the public API, splitting at the first boundary the context would not reach.
3. **Gate:** five live sales without a token and one with a refused token show one count line of 5 and one item, every seeded kind still present; then B12 continued 6's reports and API gate. **The first passed; the rest moved to B12 continued 7 (A-401).**

## Baseline (before any change)

`pnpm test:coverage` on `main` at `eb7a35a`: **383 files, 4,756 tests passed, none failed or skipped.** Statements 94.29 %, branches 84.13 %, functions 97.95 %, lines 97.35 %. One note: about a minute into the run I applied an edit to `src/modules/rpt/domain/exceptions.spec.ts` by mistake and reverted it within the minute (saved as a patch outside the worktree). The run's figures are exactly B12 continued 5's final ones and every test passed, which the edited spec could not have done (it imported a function that did not exist yet), so the baseline is clean.

## Contract changes

**2.52.0, minor, LOUD (no field, parameter, status or kind removed, renamed or retyped; no operation added):**
- `DailyExceptionReport.countLines` (new, always sent, not in `required`): `ExceptionCountLine { code, branchId, count, abuseCases, summary }`, the only code `TILL_SALES_WITHOUT_RECEIPT_TOKEN`. **Behaviour:** a till sale whose till sent no receipt token is no longer a `MESSAGE_SUPPRESSED` item on `getDailyExceptionReport` or `listExceptions`, nor in `counts`. A refused token stays its own `RECEIPT_TOKEN_REFUSED` item.
- `OrderFulfilmentView.pendingConsent` (CR-064; new, always sent, not in `required`): `FulfilmentPendingConsent { id, kind, lineId, proposed, askedAt }` or null, no money.
- `proposeShortPick` lists `x-error-codes` (`FULFILMENT_INVALID`, `INVALID_STATE_TRANSITION`).
- 610 operations from code, 59 planned; Redocly clean, no warnings. Entry in `docs/CONTRACT_CHANGELOG.md`.

## Built

| Item | What |
| --- | --- |
| RPT domain | `unlinkedTillReceipt(event)`; `ntf.MessageSuppressed` with `SALE_RECEIPT` and `NO_LINK`, naming a sale and a branch, raises no item. |
| RPT projector and store | The projector keeps the fact (`putUnlinkedReceipt`); `unlinkedTillSalesOn` counts distinct sales per branch for a day, leaving out a sale with a `RECEIPT_TOKEN_REFUSED` item; the report answers `countLines` for the branches the caller reads (or the one asked for). |
| Migration **0378** | `rpt.unlinked_receipt_fact` (PROJECTION, `SECURITY DEFINER` writer, `hk_report` reads), `rpt.clear_exception_projections()` replaced to empty it; down restores 0370's function. In the rollback walk. |
| ORD (CR-064) | `fulfilmentViewOf` copies `pendingConsent` by allow-list without its totals. |
| Docs | A-398 note, A-400, A-401; ADR-0103 and ADR-0026 Amendments; `data-model/rpt.md`; threat model case 60's detection; `docs/API.md` (POS, RPT, ORD); the changelog; BL-108 marked done; the openers (B12 continued 7 inserted before B09r, its reference row, B12 continued 6's row and split note). |

## Decided

Nothing structural: the readings are A-400's.

## The gate, proved by running it

**RPT** (`test/integration/rpt/exception-report.integration.spec.ts`, a new block of 3 tests): five sales whose receipt was held back `NO_LINK` (one of them twice) and one whose token was refused (`pos.CounterSaleFlagged` plus its `NO_LINK`) show exactly one count line `{ TILL_SALES_WITHOUT_RECEIPT_TOKEN, the branch, 5, [60], '5 till sales sent no receipt token' }` and one item, `RECEIPT_TOKEN_REFUSED`, URGENT, case 37, the cashier, 6,000, the sale; no `MESSAGE_SUPPRESSED` item; `counts` only the refusal. Another branch's report has no line, and the list has no item for those sales; a rebuild from the outbox gives the same line and the same item id. **Seen red** (2 of 3, `countLines` undefined) before the code. The block's whole file passes (18 tests), so every kind and case 1 to 73 is still present. `rpt/seeded-reporting` (the seeded reporting day) passes unchanged: every kind still present.

**Unit** (`exceptions.spec.ts`): the till's `NO_LINK` receipt raises nothing and is named by `unlinkedTillReceipt`; one with no branch or no sale is not, and stays an item; a rate-limited receipt and a cart reminder with no link stay `MESSAGE_SUPPRESSED`. **Seen red** before the code.

**ORD, CR-064** (`ord/fulfilment`, `ord/storekeeper-order-read`): the Storekeeper's read of an order waiting for a higher total and for a short pick carries exactly `{ id, kind, lineId, proposed, askedAt }` (no money), null once answered; the view's keys gain `pendingConsent` and still no money key anywhere. **Seen red** (4 tests) before the code.

**BL-108:** `pay/payment-edge-cases` "BL-108" passes on `main` unchanged (built in B12 continued 3).

## Security review (hakorem-security-review)

Boundary crossed: TB2 back office (two reads), TB8 the database (one projection). SECURE_CODING_STANDARDS.md run item by item.
- **Authorisation:** unchanged permissions (`rpt.exceptions.read`, `ord.order.read.fulfilment`), checked in the application layer. The count lines are scoped like the items: only branches the caller reads in full, or the one asked for once authorised; tested (another branch's report shows no line). Wrong roles stay refused by the existing specs.
- **Data:** the fact holds ids only; a count line carries no actor, amount or contact detail. The store's view gains no money field (tested by key walk).
- **Database:** new PROJECTION table, `SELECT` only for the application roles and `hk_report`, written by a `SECURITY DEFINER` function with a fixed `search_path`; nothing granted to `PUBLIC`.
- **Abuse cases:** 60's detection changes from an item per sale to a count per branch and day, as the owner decided; 37 (a refused token) stays an URGENT item. Threat model row 60 updated. No new abuse path; rows 75 to 79 unused.
- **Not applicable:** identity, sessions, uploads, webhooks, payments, exports (none touched).
- **Findings open:** none.

## Contract requests (the frontend's `main` at `953fbc8`)

- **CR-064** (new): **implemented** in 2.52.0 (`OrderFulfilmentView.pendingConsent` without money; `proposeShortPick`'s `x-error-codes`).
- **CR-065** (new): **not built here, named for the parent session to schedule** (see the top): point 1 needs a security decision on the return address and touches the card provider; point 2 is small but belongs with it.
- **CR-060, CR-061 and CR-062 point 1** move with the reports to B12 continued 7. Every other request is answered in its phase, as the last reports left them (the frontend marks CR-033, CR-039, CR-055 and CR-063 answered). Nothing declined.

## Seed

Not extended: the count line comes from a fact that carries no SEED mark, so an invented one would read as a real till sale; the seeded day's items are unchanged. The report schedule and API client belong to B12 continued 7.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`) | **4,760 passed, 383 files, none failed or skipped**, on `af0ba80` after the last code change (statements 94.31 %, branches 84.17 %, functions 97.97 %, lines 97.35 %; the baseline was 94.29, 84.13, 97.95, 97.35). Every full-coverage gate held. Only this report followed. |
| The new and changed specs | `rpt/exception-report` 18 (3 new); `rpt/domain/exceptions.spec` 199 (1 new); `ord/fulfilment` and `ord/storekeeper-order-read` 24; the rollback walk names 0378; `rpt/seeded-reporting`, `ntf/link-messages`, `pos/live-receipt-link`, `rpt/checkout-holding-setting` pass unchanged |
| Contract (`pnpm test:contract`) | 145 tests, 58 files, passed, on `af0ba80` |
| Lint (ESLint, lint fixtures, test placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean |

## Deferred

- **To B12 continued 7** (inserted before B09r): report definitions and schedules, runReport for every code, the reporting facts and FR-RPT-010, CR-060, CR-061, CR-062 point 1 (with the count lines in `DAILY_EXCEPTIONS`), the dashboard's move, the public API; a seeded report run and schedule.
- CR-065, for the parent session to schedule. BL-130, BL-131, BL-132 stand.

## Questions for the owner

None.

## Notes for the frontend track

- **2.52.0:** the daily exception report no longer lists a till sale whose till sent no receipt token; show `countLines` (one line per branch: "5 till sales sent no receipt token", case 60). A refused token is still its own `RECEIPT_TOKEN_REFUSED` item.
- **2.52.0, CR-064:** `getOrderFulfilmentView` answers `pendingConsent` (kind, line, proposal, when asked; never a total), null when nothing waits.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head (this report's commit), push and pull_request, is named in the session's closing message to the parent session, and the pull request merges only when each one is green.

## Next session

B12 continued 7 (`b12c7-rpt-reports-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c6-rpt-reports-api.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the RPT and API requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/rpt.md and api.md, the RPT and API cards in docs/MODULE_BOUNDARIES.md, ADR-0023, ADR-0103, ADR-0104
and ADR-0026, and section 4 of docs/security/THREAT_MODEL.md (cases 9 and 73, and the rows 75 to 79 this phase may add).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 continued 7 only, on branch b12c7-rpt-reports-api, in this order (CAP was finished in B12 continued,
ADR-0101, CST in B12 continued 2, ADR-0102, the daily exception report in B12 continued 3, ADR-0103, the seed and
the exception rules setting in B12 continued 4, ADR-0104, BL-133 in B12 continued 5, and the count of till sales
without a receipt token in B12 continued 6, A-400: never change their answers; a new exception source is a classifier
entry and its test, and a new seeded item goes through farm-rpt.ts):
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
TRIAL_BALANCE and DAILY_EXCEPTIONS, their figures the operations' own; DAILY_EXCEPTIONS carries the report's count
lines as well as its items). Extend farm-rpt.ts with a seeded report run and schedule. Never seed a password, token
or key.
2. API: the public API with keys (hashed, scoped, revocable, rate-limited) and webhooks (signed, replay-safe, retried
   through the outbox).
Stop at the gate and write docs/sessions/B12c7-rpt-reports-api.md.
```
