# B08 continued 1b2: bank accounts and the supplier payment's bank account

Date: 2026-11-16 · Branch `b08c1b2-bank-accounts`, from `main` (`adf5316`) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-193 | **Which key seals a number that belongs to no data subject (ADR-0057, Proposed).** Each of the farm's own bank and wallet numbers is sealed with a data key of its own (fresh 256-bit key, AES-256-GCM, bound to column and row), wrapped by the key-encryption key and stored on the row (`account_no_data_key`, `account_no_kek_version`): DC-40's rule and ADR-0022's hierarchy exactly. `platform.subject_key` stays a list of data subjects, so no erasure can touch the farm's accounts. KEK rotation re-wraps the data key and changes no ciphertext (the job is BL-066). The idempotency hash takes a keyed digest of the number; the log scrubber and audit writer redact any field named `accountNo`, `account_no` or `accountNumber`. | Owner (security) |
| A-194 | **Bank accounts and the payment's account.** (a) Owner and Accountant only; `fin.bank_account.manage` requires step-up, so **renaming and deactivating need it too** (`updateBankAccount` gains `x-requires-step-up`, CR-007's rule). (b) A bank number is 6 to 20 digits, a wallet number +233 and nine digits; kind, number, last four digits and GL account never change (`ck_bank_account_change`), so DC-40's "a change needs a different approver" never arises: a wrong number is a new account. No archiving. Duplicate numbers are not detected (BL-067); names are unique. (c) GL by kind (1100, 1110), never chosen by the client (`ck_bank_account_gl`); each account gets its own `BANK_ACCOUNT` party when it is added (`ck_bank_account_party`), so A-185's postings can be reclassed to it by manual journal at once; a rename does not rename the party. (d) `bankAccountId` stays optional; a named one must be an active account of the method's kind (bank for `BANK` and `CHEQUE`, wallet for `MOBILE_MONEY`, none for `CASH`), else `BANK_ACCOUNT_NOT_AVAILABLE` (also unknown ids); the database holds "cash names none" and "never changes"; the kind check is application-only (a PUR trigger may not read `fin`). The approval payload hash includes the account only when named. (e) Seed: one GCB current account and one MTN merchant wallet, SEED, nothing posted. | Accountant (b to e), Owner (a) |

Still open, proceeded on as stated: A-024 to A-029, A-182 to A-192.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B08 continued 1b2 (`b08c1b2-bank-accounts`, from `main`).
2. **Scope:** `listBankAccounts`, `createBankAccount` (step-up), `updateBankAccount` on `fin.bank_account` with the number encrypted and shown as its last four digits, its GL account and its own subledger party; PUR's expand migration for `bank_account_id`, `BANK_ACCOUNT_NOT_AVAILABLE` lifted, `pur.SupplierPaymentMade` carrying the account.
3. **Gate:** every bank account operation refuses the wrong role; the number is stored encrypted and shown only as its last four digits, and adding one needs step-up; a supplier payment naming an account posts to that account's own party, one naming none as A-185 says.

## The key decision (first, before any bank account code)

ADR-0022 and `docs/security/` were read in full on encryption. `DATA_CLASSIFICATION.md` DC-40 already names `fin.bank_account.account_no_enc` with the rule "a data key per value wrapped by the key-encryption key (ADR-0022)", and ADR-0022 defines data keys wrapped by the KEK without limiting them to subject keys. So a choice that fits ADR-0022 as written exists, and it is the most conservative: **ADR-0057 (Proposed)**, recorded as A-193. Rejected: a `BUSINESS` subject in `platform.subject_key` (widens ADR-0022's list of data subjects with something that is not one, under a key meant to be destroyed); encrypting with the KEK directly (ADR-0022 rules it out); not storing the number (bank reconciliation needs it). No ADR conflict; no stop.

## Contract changes

**1.36.0, minor** (`docs/CONTRACT_CHANGELOG.md`). `listBankAccounts`, `createBankAccount`, `updateBankAccount` move into code with descriptions and `x-error-codes`; **`updateBankAccount` gains `x-requires-step-up: true`** (a planned operation; the permission both writes check requires step-up, A-194); one new error code `BANK_ACCOUNT_INVALID`; `createSupplierPayment` accepts `bankAccountId` and its description says so; `createBankAccount`'s response example now matches its request. No field removed, renamed or retyped; nothing a client sends made required. 340 operations from code, 295 planned; `contract:generate --check`, the versioning check against `main` and Redocly clean.

## Built

| Area | What |
| --- | --- |
| Migrations | 0133 (`fin.bank_account`, MASTER, with `account_no_enc`, `account_no_data_key`, `account_no_kek_version`, `account_no_last4`; `fin.bank_account_guard()` holding `ck_bank_account_gl` and `ck_bank_account_change`; the deferred `ck_bank_account_party`); 0134 (`pur.supplier_payment.bank_account_id` with its foreign key, `ck_supplier_payment_bank_account`, the never-changes guard, an index); 0135 (`fin.bank_account.read`, `fin.bank_account.manage` with step-up); 0136 (grants to the Owner and the Accountant). |
| Platform | `src/platform/crypto/value-keys.ts` (`sealWithOwnKey`, `openWithOwnKey`); the log scrubber redacts `accountNo`, `account_no`, `accountNumber` (and so do the audit writer and the event guard, which share the rule). |
| FIN | `domain/bank-account.ts` (`normaliseAccountNo`, `glCodeOf`, `bankAccountKindFor`, `judgePayoutAccount`), `BankAccounts` (list, create, update, `payoutAccountsIn` for PUR, `subledgerRefIn` for the ledger), `PgBankAccountStore` (never selects the sealed columns), `BankAccountsController`, three fragments; `LedgerPostings` credits the named account's party for `pur.SupplierPaymentMade`. |
| PUR | `SupplierPayments.create` takes `bankAccountId` through FIN's public door (`payoutAccountsIn`, `judgePayoutAccount`), answers `bankAccount` as `BankAccountRef`, publishes it on `pur.SupplierPaymentMade`; the approval payload hash includes it when named; PUR imports FIN. |
| Seed | `src/seed/farm-fin.ts`: GCB current account (SEED) and MTN MoMo merchant wallet (SEED) through `BankAccounts`. |
| Tests | `fin/bank-accounts` (10), `pur/supplier-payment-bank-account` (4), a new `posting-matrix` row (named account by bank, cheque and wallet), `value-keys.spec.ts` (3), `bank-account.spec.ts` (7), one scrubber test, `test/contract/b8/bank-accounts.contract.spec.ts`, the handler walk, the drift count and the request-example parser. |
| Docs | ADR-0057 and its index row; A-193, A-194; BL-066, BL-067; `fin.md`, `pur.md`; FIN and PUR cards; `API.md` (FIN section, the code); DC-40; the keys table of `SECURITY_ARCHITECTURE.md`; the changelog; the openers (1b2 built, 1c reads A-182 to A-194). |

## The full number never leaves FIN, proved

`fin/bank-accounts` keeps every response body it receives and, at the end, searches them, every log line the application wrote, and **every base table in the database** (each row's text, and the hex of each bytea, so the audit trail's `before` and `after` are covered) for every number the file typed, in each form it could leak in (as typed, normalised, national, without the prefix): none found. It also opens the stored ciphertext with the application's key ring to the exact number, checks the ciphertext does not contain it, and checks the idempotency record's hash is not the hash of the plain request. Error envelopes name the rule (`ACCOUNT_NUMBER_INVALID`) and never the value.

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 `LedgerPostings` ignoring the payment's `bankAccountId` | the new `posting-matrix` row |
| M2 the Manager granted both bank account permissions (scratch migration 0999) | the wrong-role test |
| M3 `trg_bank_account_guard` dropped (same scratch migration) | "keeps the kind, the sealed number ..." and "refuses an account on the wrong control account ..." |
| M4 `fin.bank_account.manage` without step-up (same scratch migration) | the stale step-up test |
| M5 the number written into the audit payload under a field the redactor does not know | the leak scan (`platform.audit_event`, three forms). Under the field name `accountNo` it stayed green, because the audit writer now redacts that name: defence in depth, so the mutation used another name |
| M6 the idempotency claim given the plain request | "seals a bank number ... once per key" |
| M7 PUR accepting any existing account, whatever its kind or state | "refuses an account of another kind, one for cash ..." |

## Security review (hakorem-security-review)

Boundary: back office (staff session), the database. `SECURE_CODING_STANDARDS.md` SC-01 to SC-24 run in order: SC-01 strict schemas, unknown fields 400, the number checked in the domain so a refusal never echoes it; SC-02 every handler authorises first (permission rows granted to the Owner and the Accountant only, step-up on both writes), wrong roles refused in tests; SC-03, SC-04 parameterised queries only; SC-05 the payment amounts are integer pesewas, exact in tests; SC-06 every write is idempotent, the stored hash keyed; SC-07, SC-08 the number in no log, setting, event or commit, scrubber test added; SC-09 to SC-11 unchanged console defaults (cookies, CSRF, origin, rate limit group `console`); SC-12 not applicable (no upload); SC-13 not applicable (no webhook); SC-14 no external call; SC-15 no empty catch; SC-16 errors carry the correlation id (asserted); SC-17 the number can never change, so no maker-checker is needed for it (A-194 b); a supplier payment keeps its own maker-checker, and its approval binds the account; SC-18 the number is `*_enc`, sealed in the owning module, and no operation opens it (bank reconciliation will, audited as `DECRYPT`); SC-19 not applicable; SC-20, SC-21 run in CI; SC-22 no ledger row is updated; SC-23 the payment posting runs inside PUR's serializable command as before; SC-24 create and update audited with before and after, last four digits only. **No new abuse path moves money:** the account a payment leaves from changes only which ledger party is credited, and a wrong choice is found by the bank reconciliation (B9a); adding, renaming and deactivating are audited and need step-up. No finding open.

## Decisions

- **ADR-0057 (Proposed):** the farm's own account numbers are sealed with a data key of their own per value, wrapped by the key-encryption key. Fits ADR-0022 and DC-40 as written.
- Everything else is the most conservative reading, in A-193 and A-194. No ADR conflict found; no split.

## Deferred

- **BL-066:** a key-encryption key rotation job (re-wraps `platform.subject_key` and every `*_data_key`).
- **BL-067:** finding an account by its number and refusing duplicates (`account_no_hash`), for the bank reconciliation in B9a.
- `pur.supplier_payment.remittance_document_id`: B08 continued 2 (A-192), unchanged.
- Opening a sealed number: no use case yet; the bank reconciliation (B9a) is the first, under its own permission, audited as `DECRYPT`.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`648ad26`, unchanged since B08 continued 1b); it lists CR-001 to CR-021. None concerns bank accounts or FIN.
- **CR-005:** standing decline, unchanged (named empty examples on every list).
- **CR-001 to CR-004, CR-006 to CR-021:** answered in earlier phases; nothing new is asked. CR-007's rule (the step-up marker equals the permission's) is why `updateBankAccount` gains `x-requires-step-up`.
Nothing is larger than this phase could take.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,123 passed** (11 new: `bank-account.spec.ts` 7, `value-keys.spec.ts` 3, the scrubber's account number test). |
| Integration | **1,146 passed** in the merged run (the first full run had 3 failures, all lists to extend: the handler walk did not yet name the three new routes and their bodies, and the seed test counted twelve units, not thirteen; fixed in the test files). New: `fin/bank-accounts` 10, `pur/supplier-payment-bank-account` 4, `posting-matrix` 26 (1 new). |
| Coverage, merged (`pnpm test:coverage`) | **2,269 passed**. Statements 93.63, branches 83.22 percent (gate 80). Every 100 percent gate holds: `src/modules/fin/domain/**` at 100 on all four measures (323 statements, 270 branches); `value-keys.ts` and `bank-account.ts` at 100. |
| Contract | `b8`, `api` and `b3` pass (29), with `test/contract/b8/bank-accounts.contract.spec.ts` new and the drift count at 340 in code, 295 planned. |
| Lint, typecheck, Redocly, `contract:generate --check`, versioning against `main` | Clean |
| End to end | CI only |

**Test first, honestly:** `value-keys.spec.ts`, `bank-account.spec.ts` and the scrubber test were run red before their code (module missing, or one failing case). The matrix row and the API tests were written after the code; each permission, database and leak rule they prove was shown to bite by the mutations above. One real failure found by the first API run and fixed: `updateBankAccount` answered 500 because the store did not move `version` (`platform.touch_version`). One migration error fixed before any test ran: PL/pgSQL ends an IF condition at its first THEN, so a `CASE ... THEN` inside it failed to parse (the expected code is now a variable). No flaky test seen; nothing skipped, loosened or retried.

## Gate

**Passed:**
1. **Every bank account operation refuses the wrong role:** the Manager, Storekeeper, Cashier, Sales, Farm hand, Driver and Investor get 403 on list, create and update (`fin/bank-accounts`, M2), and the handler walk refuses a user with no grant.
2. **The number is stored encrypted and shown only as its last four digits, and adding one needs step-up:** sealed with its own data key and opened to the exact number by the key ring; nowhere in clear in the database, responses, logs, audit, outbox or idempotency records (M5, M6); the kind, number and GL account cannot change (M3); a stale step-up is refused on create and update (M4).
3. **A supplier payment naming a bank account posts to that account's own subledger party, and one naming none still posts as A-185 says:** 1,000,001 pesewas by bank from GCB: Dr 2000 (Awutu Poultry Farm) 1,000,001, Cr 1100 (GCB current account) 1,000,001, through the API end to end with maker, checker and mark-paid; the matrix row posts 1,000,001 by bank, 250,050 by cheque and 1 pesewa by wallet to the named parties (M1); a wallet payment naming none credits 1110 "Bank account not yet named" 40,050. A wrong kind, cash, an unknown or a deactivated account is refused (M7), and the database refuses a cash payment naming one and a change of the account.

## Notes for the frontend track

- 1.36.0: the bank accounts screen (F8) can use the real API. Ask for the TOTP code before adding, renaming or deactivating. Show the number as "ending 6620"; it is never returned. A wrong number is a new account.
- On the supplier payment form, offer only active accounts of the method's kind; `bankAccountId` stays optional.

## CI

CI runs are listed in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B08 continued 1c, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B08c1b2-bank-accounts.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the FIN requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/fin.md,
the FIN card in docs/MODULE_BOUNDARIES.md, ADR-0001, ADR-0003, ADR-0005 and ADR-0056, and the accountant's answers on
A-024 to A-029 and A-182 to A-194 in docs/ASSUMPTIONS.md (if still open, proceed on them).
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B08 continued 1c only, on branch b08c1c-statements-assets from main, building on what is merged (do not
rewrite it): FIN's planned operations in contract/openapi.yaml, each test-first with its wrong-role refusal: the trial
balance, profit and loss, balance sheet and cash flow for any range (FR-FIN-011 to FR-FIN-013), the period balance
projection (`fin.period_balance`, computed at lock and refreshed nightly), year close moving current year earnings to
retained earnings (FR-FIN-010, `fin.YearClosed`), fixed assets and depreciation runs (FR-FIN-014, FR-FIN-015,
`fin.DepreciationRun`, `allocate` so the schedule sums exactly), each ◆ event with its matrix row and exact-amount test.
Coverage: the 100 percent gate on src/modules/fin/domain/ holds for every new rule.
Make the owner dashboard's cash figure live (B05x, A-149): remove `cash` from RPT's PENDING_FIGURES
(src/modules/rpt/domain/dashboard.ts) and answer it from the ledger (accounts 1000 to 1130) through a published view,
and build the planned tile getCashPositionTile, test-first with its wrong-role refusal.
If the phase does not fit, split at a sub-domain boundary (for example fixed assets and depreciation) and follow
"If a session cannot finish".
Stop at the gate and write docs/sessions/B08c1c-statements-assets.md.
```
