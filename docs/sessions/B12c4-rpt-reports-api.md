# B12 continued 4: the reporting seed, the exception report's coverage and the Owner's exception rules setting (the phase split after them)

Date: 2026-11-24 · Branch `b12c4-rpt-reports-api`, from `main` at `c1872fd` (#147, B12 continued 3) · Status: **gate passed locally; split after the seed, the coverage check and the owner's setting (A-395). CI and the merge are named below and in the closing message to the parent session.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-390 | **Approved by the owner on 2026-11-24**, recorded verbatim: "A-390 approved: exceptions not tied to one branch sit at the head office; rates are shown only where there's a fair base to compare; an address is flagged for holding stock without buying after 3 unpaid checkouts in a day. Make the 3 a setting the Owner can change, audited, not a constant." Built here (A-394). | Owner (done) |
| A-392 | **The seeded farm's reporting slice.** Two investors' portal logins with no usable password until the reset; a GHS 350.00 CST labour run over the pens, made by the Accountant and posted by the Manager; the exception report's day: a split feed order and a product export made for real and swept, and one invented source event of each type the projector reads (with variants for the stateful and finer kinds) classified in RPT and **kept in RPT's projection only, marked SEED, never the outbox** (a rebuild drops them). Forged or broken records (a bad webhook signature, a failed audit verification) are not made by the seed. | Owner |
| A-393 | **The report grants (CR-062 point 2).** `rpt.report.read` and `rpt.report.export` for the Owner, the Manager and the Accountant; **`rpt.report.export.bulk` (step-up) for the Owner alone**, the most conservative holder, until the owner names anyone else. | Owner |
| A-394 | **The checkout holding threshold as a setting.** AUD's existing audited, effective-dated catalogue (`rpt.checkout_holding.unpaid_checkouts`, INTEGER, default 3, from 1, no upper bound, farm-wide); a catalogue entry may name its own permission (`rpt.exception_rules.manage`, the Owner's only). "In force for the report's day" read as **in force when each checkout ended**: changes apply from the moment made, never earlier, so no earlier day is rewritten, by a redelivery or a rebuild. | Owner |
| A-395 | **B12 continued 4 is split** after the seed, the coverage check, the owner's setting and CR-062's grants: **B12 continued 5** (`b12c5-rpt-reports-api`, inserted before B09r) builds the reports, exports and dashboard, then the public API. | Owner |

**For the parent session to schedule:** **B12 continued 5** (`b12c5-rpt-reports-api`, the new opener section before B09r). It carries, unchanged, the rest of this phase's opener: report definitions and schedules, runReport for every listed code (SALES_SUMMARY and PURCHASES, CR-018), the reporting facts and FR-RPT-010, **CR-060** (the egg reports), **CR-061** (the VAT return), **CR-062 point 1** (the statement and exception report exports), the owner dashboard's move, and **the public API** (keys and webhooks). Those three contract requests are larger than this phase could finish.

**ADR conflicts: none. No stop.** ADR-0103's answers are unchanged except three abuse case numbers added beside the ones items already carried (22, 39, 46) and `details.threshold` on R18's item. ADR-0011: the seed reads lookups by SQL and writes through services; RPT reads AUD's setting through platform `Settings`. **ADR-0104** (new, Proposed) records the setting's own permission and the seeded exception day.

**Shared modules (additive only):** AUD's settings catalogue gains a key and an optional per-entry `permission`, checked by `updateSetting` only for an entry that names one (no existing key names one, so every existing answer is unchanged); IAM gains four permissions and their grants (0374, 0375). Nothing existing changed. POS, IAM's code, PAY and `sale-posting.ts` untouched. **BL-108** (mobile money paid after failure) was already built in B12 continued 3 (A-390 (i), case 73); verified, not rebuilt.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B12 continued 4, reports, exports, the dashboard and the public API (`b12c4-rpt-reports-api`, from `main` `c1872fd`), the only lane building.
2. **Scope:** as the opener, in the parent session's order: the seed and the coverage check first, then reports, exports and dashboard, then API, splitting at the first boundary the context would not reach, after a merged green gate. Added mid-phase by the owner (2026-11-24): the checkout holding threshold as the Owner's setting.
3. **Gate (as split, A-395):** `pnpm db:seed` gives two investors a portal login that signs in only after the reset, a posted CST run, and an exception item of every kind on the seed's day; every abuse case 1 to 73 is on a kind or stated prevented; the threshold is the Owner's audited setting, read as in force. **Passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `c1872fd`, nothing changed in the worktree while it ran: **379 files, 4,732 tests passed, none failed or skipped.** Statements 94.25 %, branches 84.08 %, functions 97.91 %, lines 97.32 %.

## Contract changes

**2.49.0, minor, no shape changed** (its entry in `docs/CONTRACT_CHANGELOG.md`). No operation, field, parameter or status added, removed or retyped. `updateSetting`'s description names the new key and that it needs `rpt.exception_rules.manage` (403 otherwise); the seeded roles gain the report grants. 610 operations from code, 59 planned. Redocly clean.

## Built

| Item | What |
| --- | --- |
| Seed | `src/seed/farm-rpt.ts` (unit `rpt-reporting-day`, option `reporting`, run by `pnpm db:seed`); the projector's source payloads moved from `test/support` to `src/seed/exception-day-sources.ts` (the test support re-exports them), phones from the seed's block; `ExceptionProjector.seedDay`. |
| Coverage | `classify`: case 22 on stock take variances (`STOCKTAKE_LOSS`, `STOCKTAKE_GAIN`), 39 on a till override priced again from the pack (`pricedFrom` or `OFFLINE_PACK_PRICE`), 46 on `REFUND_FAILED` breaks. THREAT_MODEL section 4: every case 1 to 73 checked; 20, 23, 25, 37, 45, 54, 56, 60, 61 were named already (the sweep, a classifier fallback or the source's payload), now said in their rows; 38 and 52 stated as prevented with their rules and tests; new case **74** (the rule loosened), prevented. |
| The owner's setting | AUD's `rpt.checkout_holding.unpaid_checkouts` and per-entry permission; the projector reads it at each checkout's end; `details.threshold`. |
| Data | 0374 (`rpt.report.read`, `rpt.report.export`, `rpt.report.export.bulk`, `rpt.exception_rules.manage`, granted to no role); 0375 (the grants). Both in the rollback walk. |
| Docs | ADR-0104 and its index row; ADR-0026 Amendments; A-390 approved, A-392 to A-395; BL-132 (a cold room with no reading); THREAT_MODEL rows 20 to 61 and 74; `data-model/rpt.md`; the changelog; the openers (B12 continued 5 inserted before B09r, the reference table, B13 reads B12 continued 5's report). |

## The gate, proved by running it

**The seed** (`test/integration/rpt/seeded-reporting.integration.spec.ts`, 5 tests, the units `pnpm db:seed` runs): the Owner's daily report for the seed's day has an item of **every one of the 66 kinds**, every invented item ending `(SEED)` with `details.seed`, `ORDER_SPLITTING` and `BULK_EXPORT` raised from real records, and nothing invented in the outbox; **both portal logins refuse the seed's staff password and sign in only once a password is set** (the reset's effect, as the CAP specs set it), each seeing only its own investor; one POSTED labour run of 35,000 pesewas over `PENS`, its lines summing exactly, posted by someone other than its maker; the roles' report grants exactly as CR-062 asks, every other role none; **a second run writes nothing** and the journal lines balance. Seen red: with two lapsed checkouts instead of three the spec fails on `CHECKOUT_HOLDING`.

**The coverage** (`src/modules/rpt/domain/exceptions.spec.ts`, one new test): the three cases red before the classifier change, green after; RPT's domain at 100 percent statements, branches, functions and lines.

**The owner's setting** (`test/integration/rpt/checkout-holding-setting.integration.spec.ts`, 3 tests): the Manager, the Accountant (both stepped up), the Cashier, the Storekeeper, Sales and the Driver are 403 and nothing is written; only the Owner holds `rpt.exception_rules.manage`; 0, -1, 2.5, "4" and null are 422 `SETTING_INVALID`; **day one at the default 3 raises an item; the next day the Owner sets 5, audited with before 3 (the default), after 5, the Owner and the instant; that day 3 lapsed checkouts raise nothing and 5 raise one; a rebuild keeps day one's item at 3 and day two's at 5.** Seen red with the constant in place of the setting. `src/modules/aud/domain/setting-catalogue.spec.ts`: the key's type, default, bounds and permission (red first).

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB7 system administration (a setting), TB2 back office (the report), TB8 the database (grants).
- **Identity, sessions and browser:** unchanged; no cookie added or widened (the investor portal's subdomain is B13's). The seeded portal logins have random, discarded passwords; nothing secret is in the seed.
- **Authorisation:** deny by default; the new key needs `aud.setting.manage` and `rpt.exception_rules.manage`, both checked in AUD's application handler before the idempotency claim, the second granted to the Owner only; wrong roles tested. The report grants follow CR-062; the bulk export is the Owner's alone (A-393).
- **Input:** the value is judged by the catalogue (whole number from 1); a past `validFrom` refused; parameterised SQL only.
- **Money paths:** none changed. The seeded CST run posts through INV and FIN with a second person.
- **Exports:** none built (B12 continued 5); the seed's product export is audited and reaches the report as BULK_EXPORT.
- **Data protection and logging:** the invented exception payloads pass through `withoutPersonalData`; their phone numbers are the seed's own block; the audit of a setting carries no personal data.
- **Database:** two lookup migrations, rollback tested; no table added.
- **The parent's abuse paths:** an investor seeing another's figures (the seeded logins each see their own only, tested); a distribution paid without step-up (not touched); maker and checker the same (the seeded CST run is posted by another person, tested); an export leaking personal data (none built); a public API key too wide, a webhook replayed or forged (B12 continued 5).
- **New abuse path:** case **74** (the exception rule loosened or back-dated), prevented: Owner only, step-up, never retroactive, audited; tested. Findings: none open.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11u continued)

- **CR-062: point 2 implemented** (the grants, A-393). **Point 1** (the four export codes) **moved to B12 continued 5** with `runReport`.
- **CR-060 and CR-061: moved, unchanged, to B12 continued 5** (each is a `runReport` code, which that phase builds).
- **CR-059:** implemented in 2.48.0. **CR-063:** answered in 2.35.0. Every other request is answered in its phase, as the last reports left them.

## Tests (this machine)

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`) | **4,742 passed, 381 files, none failed or skipped**, run twice: on `3c0e9cb` after the last code change (94.27 / 84.09 / 97.93 / 97.33), and again on `62298f2` after the spec fix (statements 94.28 %, branches 84.12 %, functions 97.93 %, lines 97.33 %; the baseline was 94.25, 84.08, 97.91, 97.32). Every full-coverage gate held; RPT's domain is at 100 percent. Only documents followed. |
| The new specs | `rpt/seeded-reporting` 5 and `rpt/checkout-holding-setting` 3 (integration); one test each added to `rpt/domain/exceptions` and `aud/domain/setting-catalogue` (unit) |
| Contract (`pnpm test:contract`) | 145 tests, 58 files, passed |
| Lint (ESLint with module boundaries), typecheck, Redocly, `contract:generate` | Clean (610 operations from code, 59 planned) |

Existing specs changed only for what this phase added: the rollback walk (0374, 0375). Separately, UAT scenario 2's weighing time was made to respect the clock (the CI failure below, its own commit). No expectation weakened, nothing skipped.

## Deferred

- **To B12 continued 5** (the opener inserted before B09r): report definitions and schedules, runReport for every code, the reporting facts and FR-RPT-010, CR-060, CR-061, CR-062 point 1, the dashboard's move, the public API; a seeded report run and schedule.
- **BL-132** (a cold room with no reading in a day on the report); BL-130 and BL-131 stand.

## Questions for the owner

1. **A-393:** a bulk report export (more than 1,000 rows) is yours alone for now. Should the Accountant have it too?
2. **A-394:** a change to the checkout holding threshold applies from the moment you make it, to every checkout after it, the rest of that day included. Agreed?

## Notes for the frontend track

- **2.49.0.** No shape changed. `updateSetting` takes `rpt.checkout_holding.unpaid_checkouts` (whole number from 1, default 3), the Owner's alone (403 for anyone else, the Manager included). The seeded Owner, Manager and Accountant now hold `rpt.report.read` and `rpt.report.export`, so the reports section can show its codes once `runReport` lands (B12 continued 5). `CHECKOUT_HOLDING` items carry `details.threshold`.

## CI

A report cannot name the runs of the commit that adds it. Pull request #148.
- On `bc22566` (every code and document change of the phase): **45512940839, `push`, failure** and **45512804006, `pull_request`, failure**, both on the same test, `test/integration/quo/uat-scenario-2-rest.integration.spec.ts` in shard 2 of 3 (the coverage gate jobs then failed on "every shard passed"). The cause was not this phase's code: the spec weighed its goats at 06:00 of the clock's business day, and a run begun within 20 minutes of midnight starts a minute into the next day (`testStartTime`), so the weights were in the future and refused `IN_THE_FUTURE` (the runs started at 23:49 UTC). It was not re-run. It was fixed in its own commit (`62298f2`): the weights are taken at 06:00 or the clock's instant, whichever is earlier. The fix was proved by shifting the process clock: red at 2026-11-24T23:49:30Z before the change; green after it, there and at 05:00 and at the real time.
- On `62298f2` (the fix): **45514596163, `push`, success**; **45514603447, `pull_request`, success**.
- Every run on the final head (this report's commit) is named in the session's closing message to the parent session. The pull request merges only when each one is green.

## Next session

B12 continued 5 (`b12c5-rpt-reports-api`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B12c4-rpt-reports-api.md).
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
