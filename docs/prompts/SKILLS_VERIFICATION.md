# Skills verification

Whether each skill in `.claude/skills/` fires on the task it is meant for. The shared brief asks for this to be checked in a fresh session; this file records what has been checked and what has not.

## Run 1: blind description test (B1, 2026-11-13)

**Method.** Skills are discovered when a Claude Code session starts, so the session that wrote them could not load them. Instead, a separate agent with no other context read only the `name` and `description` of each `SKILL.md` and, for 32 tasks written for the purpose (two per skill), chose which skill should fire first and which others should also fire. The expected answers were written down before the results came back.

**Result.** The expected skill fired on 32 of 32 tasks, and fired first on 30 of 32. No task loaded a wrong skill.

| Task | Expected first | Chosen first | Also chosen | Result |
| --- | --- | --- | --- | --- |
| T01 Create the livestock module skeleton | module | module | | Pass |
| T02 Boundary lint fails on a cross-module import | module | module | | Pass |
| T03 Compute change due from cash tendered | money | money | | Pass |
| T04 Split a GHS 100.00 discount across three lines | money | money | | Pass |
| T05 Post journal lines on inv.StockWrittenOff | ledger | ledger | module, stock | Pass |
| T06 Lock the October 2026 period | ledger | ledger | | Pass |
| T07 Trigger that rejects negative stock | stock | migration | stock | Pass, order differs |
| T08 Cold room to shop transfer with receipt | stock | stock | | Pass |
| T09 Price resolution walk, customer list to base | pricing | pricing | | Pass |
| T10 Quantity breaks on price list entries | pricing | pricing | migration, money | Pass |
| T11 Add GET /stock/alerts with a filter | endpoint | endpoint | | Pass |
| T12 Frontend asks for a new cart field | endpoint | endpoint | frontend | Pass |
| T13 SQL for inv.stock_reservation | migration | migration | stock | Pass |
| T14 Backward-compatible column on mdm.product | migration | migration | endpoint | Pass |
| T15 Flaky goods receipt integration test | tests | tests | | Pass |
| T16 Which test layer for three-way match | tests | tests | | Pass |
| T17 Change refresh token rotation | security-review | security-review | endpoint | Pass |
| T18 Export the supplier list to XLSX | security-review | endpoint | security-review | Pass, order differs |
| T19 Detect device counter gaps at sync | offline | offline | | Pass |
| T20 Proof of delivery without signal | offline | offline | endpoint | Pass |
| T21 Receipt layout shows the levy breakdown | documents | documents | money | Pass |
| T22 Reprint marker on invoices | documents | documents | | Pass |
| T23 Build the POS tile screen | frontend | frontend | | Pass |
| T24 Catalogue: quantities or availability bands | frontend | frontend | endpoint | Pass |
| T25 Replace BullMQ with pg-boss | adr | adr | | Pass |
| T26 Decision to use row-level security | adr | adr | migration, security-review | Pass |
| T27 Outbox dead-lettered 40 messages | runbook | runbook | | Pass |
| T28 Response procedure for a WAL archive age alert | runbook | runbook | | Pass |
| T29 Seed 30 goats and a broiler batch | seed | seed | | Pass |
| T30 Load-test dataset of 150,000 orders | seed | seed | tests | Pass |
| T31 Prepare release 1.2.0 | release | release | migration, endpoint | Pass |
| T32 Is B9b ready for production | release | release | | Pass |

The two order differences are acceptable: in both, the expected skill still loads alongside, and the first skill chosen is a reasonable lead for the task as worded.

**Ambiguities found, and what was done**

| Overlap | Action |
| --- | --- |
| endpoint and frontend both claimed answering `../frontend/docs/CONTRACT_REQUESTS.md`, with no lead | Fixed: frontend now covers the screen-facing side and names endpoint as the lead |
| money and pricing both mention price | Kept: money states it applies underneath pricing whenever pesewas are computed; both loading is intended |
| stock and migration on triggers over `inv.*` tables | Kept: both should load; either may lead |
| offline and documents both mention provisional references | Kept: offline owns the flow, documents the printed layout; each names the other |
| ledger and stock on write-offs; release and migration on production migrations; runbook and release on a failed deploy | Kept: each description names the other for its part |

**Gap noted:** no skill is specific to procurement's three-way match. It is covered by hakorem-tests for its tests and by the SRS and ADRs for its rules; a dedicated skill is not planned.

## Run 2: fresh-session test (B2, 2026-11-14)

**Method.** Each task was given to a new, separate Claude Code session opened in `backend/` (`claude -p`, Claude Code 2.1.312), one session per task, with read-only tools (Skill, Read, Grep, Glob) so it could not change the repository, and at most four turns. The skills it invoked were read from its event stream. Task wording is in the B2 session's scratchpad and follows the Run 1 labels as plain requests ("Lock the October 2026 accounting period.").

**Finding before the run.** The B2 session itself was opened at the workspace root, as `docs/prompts/session-openers.md` instructs, and **none of the sixteen skills was available in it**: Claude Code discovers `.claude/skills/` in the directory a session opens in, and the skills live in `backend/.claude/skills/`. A session opened at `~/Desktop/hakorem-farms/` therefore never loads them. Run 2 opened its sessions in `backend/`, where all sixteen are listed. Recommendation for the owner: open backend sessions in `backend/` (they can still read `../frontend/docs/` by path), or accept that the skills do not load; the openers are unchanged until you decide (A-079).

**Result.** First pass: 27 of 32 loaded the expected skill, 26 of them first (T07 loaded migration before stock, as in Run 1). Five loaded nothing (T06, T18, T20, T23, T24): with no code in the repository yet, the session explored the documents or declined the task without loading a skill, because the descriptions said "use when writing or changing code". The four descriptions involved (ledger, offline, frontend, security-review) gained one sentence: "Load it first for a question, plan or estimate on these too, even before the code exists." The five tasks were then rerun in fresh sessions and all five loaded the expected skill. The 27 passing tasks were not rerun after the change.

| Task | Expected first | First pass | After the fix | Result |
| --- | --- | --- | --- | --- |
| T01 | module | module |  | Pass |
| T02 | module | module |  | Pass |
| T03 | money | money |  | Pass |
| T04 | money | money |  | Pass |
| T05 | ledger | ledger |  | Pass |
| T06 | ledger | none | ledger | Pass after fix |
| T07 | stock | migration, stock |  | Pass, order differs |
| T08 | stock | stock |  | Pass |
| T09 | pricing | pricing |  | Pass |
| T10 | pricing | pricing |  | Pass |
| T11 | endpoint | endpoint |  | Pass |
| T12 | endpoint | endpoint, frontend |  | Pass |
| T13 | migration | migration, stock |  | Pass |
| T14 | migration | migration |  | Pass |
| T15 | tests | tests |  | Pass |
| T16 | tests | tests |  | Pass |
| T17 | security-review | security-review |  | Pass |
| T18 | security-review | none | endpoint, security-review | Pass after fix, order differs |
| T19 | offline | offline |  | Pass |
| T20 | offline | none | offline | Pass after fix |
| T21 | documents | documents |  | Pass |
| T22 | documents | documents |  | Pass |
| T23 | frontend | none | frontend | Pass after fix |
| T24 | frontend | none | frontend | Pass after fix |
| T25 | adr | adr |  | Pass |
| T26 | adr | adr |  | Pass |
| T27 | runbook | runbook |  | Pass |
| T28 | runbook | runbook |  | Pass |
| T29 | seed | seed |  | Pass |
| T30 | seed | seed |  | Pass |
| T31 | release | release |  | Pass |
| T32 | release | release |  | Pass |

T07 and T13 load migration and stock together, and T12 endpoint and frontend, as Run 1 found and accepted. T18 loads endpoint before security-review, the order Run 1 also recorded.
