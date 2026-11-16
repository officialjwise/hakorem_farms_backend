# B08 continued 1b: journals, manual journals and posting rule changes

Date: 2026-11-16 · Branch `b08c1b-journals-rules-banks`, from `main` (`56af9fa`) · Status: **gate passed for what was built; the phase split before its bank accounts (A-192): the rest is B08 continued 1b2.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-190 | **Manual journals.** (a) The Owner and the Accountant each make and check (`fin.journal.read`, `.create`, `.approve` with step-up on the permission and the `MANUAL_JOURNAL` policy, whatever the amount); only the drafter changes or submits a draft (403); a single Owner can never post their own. (b) The approval publishes FIN's own ◆ `fin.ManualJournalApproved`, posted through `Ledger.postIn` by two seeded rules whose new determinant `ENTERED` takes each line's account; only that event posts so; a MANUAL or OPENING entry comes only from it; a posted journal's entry is its own, line for line. (c) A journal is dated today or earlier and posts on that date or not at all (`PERIOD_NOT_OPEN`, never moved). (d) Two to 200 lines, postable active accounts, a party exactly on a control account; a draft's lines are rewritten under a new revision, never edited; a rejected journal is final; an opening balance for a party never posted to waits for BL-065. (e) One opening balance journal ever, with a line on 3900. (f) No manual journal in the seed. | Accountant (b to e), Owner (a) |
| A-191 | **Posting rule and determination changes.** (a) The Owner and the Accountant make and check (`fin.posting_rule.read`, `.manage` with step-up, `.approve` with step-up); always 202 `POSTING_RULE_CHANGE`. (b) On approval the old rule or mapping is end-dated and the new one starts on the later of the date asked for (today or later) and the approval day; nothing posted is touched or re-posted; the checks run again at approval. (c) A rule change replaces a rule in force, never adds one, keeps its subledger kinds, must change something, one pending per rule; a determination change adds or replaces one key's row on an account of the subledger kind of its siblings. (d) `fin.account_determination.approval_request_id`, required except for System seeds. | Accountant |
| A-192 | **The split** before bank accounts: **B08 continued 1b2** builds `fin.bank_account` (encrypted numbers, step-up; its first decision is which key seals a number that belongs to no data subject), PUR's `bank_account_id` expand migration, the lifted `BANK_ACCOUNT_NOT_AVAILABLE` and the payment posted to the account's own party (A-185). `remittance_document_id` moves to B08 continued 2, which builds `doc.archived_document` (`docs/DATA_MODEL.md`, Migrations). B08 continued 1c then reads 1b2's report. | Owner |

Still open, proceeded on as stated: A-024 to A-029, A-182 to A-189.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 1b (`b08c1b-journals-rules-banks`, from `main`).
2. **Scope:** journals read only, manual journals with `fin.ManualJournalApproved` and the opening balance journal, posting rule and determination changes under `POSTING_RULE_CHANGE`, bank accounts with PUR's expand migration (A-185 lifted); split at bank accounts if it does not fit.
3. **Gate:** every journal, manual journal, rule, determination and bank account operation refuses the wrong role and a maker approving their own manual journal or rule change; a manual journal posts only after a different approver, as one exact balanced entry with its matrix row; bank numbers encrypted and shown as the last four digits; a supplier payment posts to its bank account's own party.

## Contract changes

**1.35.0, minor** (`docs/CONTRACT_CHANGELOG.md`). Thirteen planned FIN operations move into code (`listJournalEntries`, `getJournalEntry`, `listAccountActivity`, `listManualJournals`, `createManualJournal`, `getManualJournal`, `updateManualJournal`, `submitManualJournal`, `listPostingEventTypes`, `listPostingRules`, `createPostingRule`, `listAccountDeterminations`, `createAccountDetermination`), their descriptions stating the rules and their `x-error-codes` listed. **One response field becomes nullable:** `PostingRule.approvalRequestId` (null for the rules seeded by migration, which is every rule today). Two new error codes, `MANUAL_JOURNAL_INVALID` and `POSTING_RULE_INVALID`. No field removed, renamed or retyped; nothing a client sends made required. 337 operations from code, 298 planned; `contract:generate --check`, the versioning check against `main` and Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0129 (document types `MANUAL_JOURNAL`, `POSTING_RULE_CHANGE`); 0130 (`fin.manual_journal`, `fin.manual_journal_line`, `fin.posting_rule_change`; `fin.ManualJournalApproved` in `fin.posting_event_type` with its two `ENTERED` rules; `ck_posting_rule_entered`, `ck_journal_entry_manual`, `ck_manual_journal_posted`, `uq_manual_journal_opening`, the line and posted guards; `account_determination.approval_request_id` with `ck_account_determination_approved`; index for the journal search); 0131 (six permissions, the `MANUAL_JOURNAL` and `POSTING_RULE_CHANGE` policies, step-up, no threshold); 0132 (grants to the Owner and the Accountant only). |
| FIN domain | `manual-journal.ts` (`checkManualJournal`, `journalTotals`, `judgeSubmit`, `manualPostingAmounts`), `rule-change.ts` (`checkRuleChange`, `checkDeterminationChange`, `effectiveFrom`), `balance.ts` (`sidedBalance`, `signedLine`, `jsonPesewas`), and the `ENTERED` determinant in `posting.ts`; 100 percent on all four measures. |
| FIN application and interface | `Journals`, `ManualJournals` (the `MANUAL_JOURNAL` approval handler), `PostingRules` (the `POSTING_RULE_CHANGE` approval handler), `JournalStore` and `PgJournalStore`, three controllers, schemas, thirteen fragments. `Ledger.postIn` takes a manual journal's kind, description and exact date; `LedgerPostings` translates `fin.ManualJournalApproved`; FIN declares it as a ledger event. Submissions and rule requests run at serializable isolation; every write is idempotent and audited with before and after. |
| Tests | `fin/manual-journals` (17), `fin/posting-rules` (14), the matrix row for `fin.ManualJournalApproved` in `fin/posting-matrix`, the handler walk with the thirteen routes, `test/contract/b8/journals-rules.contract.spec.ts` (2), three domain specs. Five raw-SQL test entries of kind MANUAL in `journal-rules`, `accounts` and `trial-balance` now carry the event `ck_journal_entry_manual` requires; their assertions are unchanged. |
| Docs | A-190 to A-192, BL-065; `fin.md`; `API.md` (FIN section, two codes); FIN card; ADR-0003 applied note; ADR-0026 amendment; openers (1b as built, a new 1b2 section, 1c reading 1b2's report); `CONTRACT_CHANGELOG.md`. |

## The owner's ledger points, as built

- **Maker-checker, proved with the smallest team that could collude and with a single Owner.** In a team of one Owner and one Accountant, the Accountant approving their own journal is 422 `MAKER_CANNOT_CHECK`, and so is the Owner approving theirs; each posts only when the other approves (`fin/manual-journals`, first two tests). A single Owner's own journal or rule change stays pending (`MAKER_CANNOT_CHECK`); the same holds for rule and determination changes (`fin/posting-rules`). The Manager is 403 as approver; an Owner without a fresh step-up is `STEP_UP_REQUIRED`.
- **One posting path.** A manual journal is never inserted into the journal by its own code: the approval publishes `fin.ManualJournalApproved`, and FIN's subscriber posts it through `Ledger.postIn` (rules as data, the JNL number, the period trigger, the line and balance triggers). The database refuses a MANUAL or OPENING entry without that event, and a journal marked POSTED with any entry but its own, line for line.
- **Reversal, never update.** No journal entry or line is updated anywhere in this phase; a manual journal's lines are insert-only (`platform.reject_change()`), a draft's change writes a new revision, and a decided journal or change is frozen. A correction of a posted manual journal is a reversing journal (a new manual journal; a REVERSAL of an automatic entry stays ADR-0056's path).
- **A rule change takes effect from its approval day and never re-posts.** Proved on the seeded farm: a harvest posted before the change and one posted while it waited keep credit 5210; after approval a new harvest credits 4020; the old rule is end-dated on the approval day; a change dated tomorrow leaves today's postings alone. The boot assertion is re-run after each change and holds.
- **Exact pesewas.** Every amount asserted is an exact integer (500,000; 75,000; 2,500,000 + 1,200,001 = 3,700,001 against 3900; 960,000 + 40,001 = 1,000,001 in the matrix row; running balances recomputed line by line).

## Mutation checks (scratch migration `0999_fin_scratch_mutation.sql` and two code edits, run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 the Manager granted `fin.journal.read`, `.create`, `fin.posting_rule.read`, `.manage` | the Manager's wrong-role tests in `fin/manual-journals` and `fin/posting-rules` |
| M2 the drafter check in `ManualJournals` disabled | "lets only its maker change or submit the draft" |
| M3 `Ledger.postIn` ignoring a manual journal's own date (the late-event rule instead) | "is refused PERIOD_NOT_OPEN ... and never moved to today" |
| M4 `trg_manual_journal_posted_guard` dropped | "refuses a journal posted with an entry that is not its own" |
| M5 `ck_journal_entry_manual` dropped | "refuses a MANUAL entry posted from anything but fin.ManualJournalApproved" |
| M6 the `MANUAL_JOURNAL` policy without step-up | nothing went red: `fin.journal.approve` itself requires step-up, so the approval still needs one. Step-up is held twice, by the permission and the policy. |

## Decisions

- No new ADR: the `ENTERED` determinant applies ADR-0003's "As entered" row as data and is recorded on ADR-0003 as applied; maker-checker, step-up and the effective date apply ADR-0017 and FR-FIN-005 as written; the readings that were mine are A-190 and A-191. No ADR conflict found.
- **The split (A-192)** at the bank account sub-domain, the boundary the opener names. Encrypting the business's own account numbers needs a key decision first: ADR-0022's keys are per data subject (`platform.subject_key` knows customers, suppliers, investors and staff), and a business bank account is none of them. Starting that with this context left would have risked an unfinished security decision on a money path.
- `remittance_document_id` is not added with `bank_account_id`: its target `doc.archived_document` is built in B08 continued 2, and `docs/DATA_MODEL.md` (Migrations) has the column added by the session that builds its target.

## Deferred (to the opener sections, in order)

- **B08 continued 1b2:** `listBankAccounts`, `createBankAccount` (step-up), `updateBankAccount`; `fin.bank_account` with the number encrypted and its last four digits; PUR's `bank_account_id`, `BANK_ACCOUNT_NOT_AVAILABLE` lifted, `pur.SupplierPaymentMade` carrying the account, posted to its own party (A-185).
- **B08 continued 1c:** unchanged, now reading 1b2's report.
- **B08 continued 2:** adds `pur.supplier_payment.remittance_document_id` with `doc.archived_document`.
- **BL-065:** registering a subledger party before anything has posted to it (an opening balance per customer or supplier).

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`648ad26`); it lists CR-001 to CR-021, the same as at B08 continued. None concerns FIN.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-021:** answered in earlier phases; nothing new is asked.
Nothing is larger than this phase could take.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,112 passed** (27 new: `fin/domain/manual-journal.spec.ts` 8, `rule-change.spec.ts` 11, `balance.spec.ts` 4, `posting.spec.ts` 4 for `ENTERED`). |
| Integration | **1,131 passed**: `fin/manual-journals` 17 and `fin/posting-rules` 14 (new), `fin/posting-matrix` 25 (1 new, the `fin.ManualJournalApproved` row), the handler walk with the thirteen routes. |
| Coverage, merged (`pnpm test:coverage`) | 2,243 passed. Statements 93.57, branches 83.13 percent (gate 80). Every 100 percent gate holds, `src/modules/fin/domain/**` at 100 on all four measures (300 statements, 251 branches). |
| Contract | **79 passed** (2 new, `test/contract/b8/journals-rules.contract.spec.ts`); the drift test now counts 337 operations in code and 298 planned, and the request-example test parses the four new request bodies. |
| Lint, typecheck, Redocly, `contract:generate --check`, versioning against `main` | Clean |
| End to end | CI only |

**Test first, honestly:** the `ENTERED` posting tests were run red before `posting.ts` changed (two failed, as expected); the three new domain specs were written before their modules and could only fail until then, but were not run red on their own; the API tests were written after the services, so their permission and database tests were proved by the mutations above. The first runs found real failures, each fixed: five older raw-SQL test entries of kind MANUAL broke on the new `ck_journal_entry_manual` (they now carry the event), the handler walk needed valid bodies and the activity's required dates, and a test whose clock outran its session (the stale step-up check moved to its own block with fresh sessions, as B08 continued did). No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed for what was built (the split narrows it, A-192):**
1. **Every journal, manual journal, posting rule and determination operation refuses the wrong role** (Manager, Storekeeper, Cashier, Sales, Farm hand, Driver: 403 on all thirteen), and **a maker approving their own manual journal or rule change is refused** `MAKER_CANNOT_CHECK`, with one Owner and one Accountant and with a single Owner (`fin/manual-journals`, `fin/posting-rules`, the handler walk), M1, M2.
2. **A manual journal posts nothing until a different person approves it with step-up, then exactly one balanced entry with its exact amounts** (500,000 Dr 6000, Cr 1010, kind MANUAL, its own JNL number and date, one `fin.ManualJournalApproved` in the outbox, audited CREATE, SUBMIT, POST), M3 to M5.
3. **`fin.ManualJournalApproved` has its matrix row and exact-amount test** (`fin/posting-matrix`: 960,000 and 40,001 against a supplier, 1,000,001 credited, on the date entered).

Not part of this narrowed gate, and scheduled: bank accounts and the supplier payment's own bank account party (1b2).

## Notes for the frontend track

- 1.35.0: the journals, manual journal and posting rule screens (F8) can use the real API. Submissions and rule requests are always 202 and appear in the approvals inbox; only the drafter of a manual journal may edit or submit it.
- `PostingRule.approvalRequestId` may be null (seeded rules).
- Account activity answers its opening, closing and running balances as an amount and a side: never sum the page.

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 1b2, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b-journals-rules-banks.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
docs/data-model/pur.md (supplier_payment), the FIN and PUR cards in docs/MODULE_BOUNDARIES.md, ADR-0003, ADR-0017,
ADR-0022 and ADR-0056, and the accountant's answers on A-182 to A-192 in docs/ASSUMPTIONS.md (if still open, proceed on
them). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1b2 only, on branch b08c1b2-bank-accounts from main, building on what is merged (do not
rewrite it): FIN's bank account operations in contract/openapi.yaml (listBankAccounts, createBankAccount with step-up,
updateBankAccount), each test-first with its wrong-role refusal, on `fin.bank_account` with the number encrypted
(ADR-0022: decide first, by ADR or assumption, which key seals a number that belongs to no data subject) and shown only
as its last four digits; the account's GL account (1100 for a bank, 1110 for a wallet) and its own BANK_ACCOUNT subledger
party. Add, by an expand migration, pur.supplier_payment.bank_account_id with its foreign key (docs/DATA_MODEL.md,
Migrations; remittance_document_id waits for doc.archived_document in B08 continued 2, A-192), lift PUR's
BANK_ACCOUNT_NOT_AVAILABLE (a bank account of the payment's method, active; optional, so no client breaks) and carry the
bank account on pur.SupplierPaymentMade so FIN posts it to its own subledger party (A-185), with its exact-amount test.
If the phase does not fit, follow "If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1b2-bank-accounts.md.
```
