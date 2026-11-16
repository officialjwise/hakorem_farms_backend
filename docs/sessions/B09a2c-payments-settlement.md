# B09a continued 1c: settlement reports, bank statements and the break queue

Date: 2026-11-16 · Branch `b09a2c-payments-settlement`, from `main` (`c3f295e`) · Status: **phase split (A-215).** Settlement reports, bank statements and the break queue are built and their gate proved; the refund against a credit note and a cheque refunded through a bank payout are **B09a continued 1d** (`b09a2d-payments-credit-refunds`), inserted before B09a continued 2.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-214 | **Settlement and bank reconciliation as built (ADR-0065), each the most conservative reading.** (a) Files are uploaded `IMPORT` files (CSV or XLSX, scanned clean): settlement `settlement_ref,settled_on,reference,amount,fee`; statement `value_date,direction,amount,balance,reference,narration`, its running balance adding up to the pesewa and its opening never below zero; amounts in cedis with two places; at most 5,000 rows. (b) The same file, settlement reference, provider reference or an overlapping statement period is refused, held by the database. (c) `bankAccountId` on a settlement import is required by the rule, optional in the schema; a line matches only a cleared payment of the same provider and reference for exactly its amount; an unconfirmed payment is never cleared from a settlement; matched lines post at the head office on `settledOn` (1120 nets across branches). (d) BANK accounts only; automatic matching only by reference (four characters at least) and exact amount, never amount alone; a tie, a difference or money out is a `BANK_LINE_UNMATCHED` break; a transfer clears into 2200 on the line's value date. (e) Every resolution, posting or not, waits for a different holder of `pay.reconciliation.approve` with step-up; a break matched by hand stays open until then; the one posting is the unidentified receipt into 2290; 2290 moves to a customer by approved manual journal; a break with no branch shows at the head office; `WEBHOOK_UNKNOWN_ORDER` is never raised. (f) Grants in 0179. (g) The nightly `settlement-match` job, a wallet's statement (BL-069) and a reclassification from 2290 (BL-070) are not built. | Accountant (a, c, d, e), Owner (b, e, f) |
| A-215 | **B09a continued 1c split after its reconciliation gate (ADR-0026 Amendments).** The refund against a credit note on a paid document and a cheque refunded through a bank payout are B09a continued 1d (`b09a2d-payments-credit-refunds`), the refunds sub-domain, run next, before B09a continued 2. | Owner |
| A-212 | **Approved by the owner, 2026-11-16, with changes** (recorded at the coordinator's request): cash only through a till shift (B9b, B11); investor capital through CAP to the bank (B12); store credit needs a named customer with a phone, never the walk-in (**built here**, migrations 0175 and 0176); every reversal with a different approver; a bounced cheque is a reversal (B10 counts it against credit standing). ADR-0064 accepted. | Owner (done) |

Still open, proceeded on as stated: A-033, A-034, A-062, A-064 (the real Paystack sandbox run, the first item of B09a continued 2, unchanged), A-182 to A-207, A-209, A-211, A-213, A-214, A-215.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 1c (`b09a2c-payments-settlement`, from `main` at `c3f295e`).
2. **Scope:** the remaining PAY permissions and grants; settlement import and matching (◆ `pay.ProviderSettled`); bank statement import and matching (a transfer cleared from its line, its tender determination seeded); the break queue with its resolution through approval (2290); every break on the published view; the refund against a credit note and the cheque's bank payout, split to 1d at the refunds sub-domain boundary, decided up front because the whole scope could not reach its gate in one context.
3. **Gate (for this part):** a settlement of three payments totalling 150,000 with a 1,500 fee matches all three and posts Dr 1100 148,500, Dr 6910 1,500, Cr 1120 150,000, and an extra 2,000 line not in the system raises a break; a bank transfer recorded PENDING clears (Dr 1100) only from its matched statement line, and an unmatched line raises `BANK_LINE_UNMATCHED`; a break resolves only through an approved posting (2290 for an unidentified receipt), never by hand; the trial balance still sums to zero; every PAY reconciliation write refuses the wrong role.

Also done in this phase, at the coordinator's request (the owner's decisions of 2026-11-16 on A-212), each in its own commit: store credit only for a named customer with a phone (test-first, refused in the application and by the database), and the documents (A-212 approved with changes, ADR-0064 accepted, one line each in the B9b, B10, B11 and B12 openers, ADR-0026 Amendments).

## Contract changes

**1.44.0, minor, with one LOUD change to a planned operation; no existing shape of an implemented operation changed.** Twelve planned PAY operations move into code (`listSettlementReports`, `importSettlementReport`, `getSettlementReport`, `matchSettlementReport`, `listBankStatements`, `importBankStatement`, `getBankStatement`, `matchBankStatement`, `matchBankStatementLine`, `listReconciliationBreaks`, `getReconciliationBreak`, `resolveReconciliationBreak`). **LOUD:** `resolveReconciliationBreak` answers **202 `ApprovalPending`** (kind `RECONCILIATION_BREAK`, subject a `BREAK_RESOLUTION`), not 200: it was never implemented. Additive: `SettlementImport.bankAccountId` (optional, required by the rule), `BankLineMatch.paymentId` (and `journalEntryId` no longer required: send exactly one), `BreakResolve.posting` (`NONE`, `UNIDENTIFIED_RECEIPT`), `SettlementLine.matchStatus` gains `UNMATCHED`, `ReconciliationBreak.kind` gains `PROVIDER_AMOUNT_DIFFERS`, `PROVIDER_REFERENCE_UNKNOWN`, `PROVIDER_PAYMENT_MISSING`, `ApprovalKind` gains `RECONCILIATION_BREAK`; new error code `RECONCILIATION_INVALID` (422). `requestRefund` to store credit for a customer with no phone is `REFUND_INVALID` (`STORE_CREDIT_NEEDS_PHONE`), behaviour only. `contract:generate` up to date (402 operations from code, 233 planned); Redocly clean; the versioning check against `main` passes. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` record it.

## Built

| Area | What |
| --- | --- |
| Migrations | 0175 (MDM's published `mdm.customer_has_phone`, ADR-0047, listed in `tooling/architecture.json`); 0176 (`trg_store_credit_entry_named_customer`: no store credit issued to a customer with no phone); 0177 (document types `SETTLEMENT_REPORT`, `BANK_STATEMENT`, `BREAK_RESOLUTION`); 0178 (`pay.reconciliation.read`, `.manage`, `.approve` with step-up; the `RECONCILIATION_BREAK` policy, threshold 0); 0179 (grants: read Owner, Manager, Accountant; manage Owner, Accountant; approve Owner, Manager); 0180 (`pay.settlement_report`, `pay.settlement_line`, `pay.bank_statement`, `pay.bank_statement_line` with their guards and unique keys, `ex_bank_statement_period`, `trg_payment_transfer_cleared`, the break's line columns and open-per-line indexes, `pay.break_resolution`, `trg_reconciliation_break_resolved`, `ck_break_resolution_checker`, the view's two new columns); 0181 (FIN: `pay.ProviderSettled` Dr 1100 net, Dr 6910 fee, Cr 1120 gross; `pay.UnidentifiedReceiptHeld` Dr 1100, Dr 6910, Cr 2290; the `BANK_TRANSFER` tender determination 1100; one entry per report and per line). Each rolls back (`bil/archive-link-rollback` walks 0181 to 0155 back and applies them again). |
| PAY | Domain (100 percent gate): `parseCedis`, `readSettlementFile`, `matchSettlementLine`, `settlementPosting`, `readStatementFile`, `chooseBankCandidate`, `judgeLineMatch`, `judgeResolution`; the store credit phone rule in `judgeRefund`. Application: `Reconciliation` (import, match, list and read settlement reports and statements; a transfer cleared from its line; a payout linked to its entry), `BreakQueue` (list, read, resolve; IAM's `RECONCILIATION_BREAK` handler); `PgReconciliationStore`. Interface: `ReconciliationController`, `BankStatementLinesController`, twelve fragments. ◆ `pay.ProviderSettled`, ◆ `pay.UnidentifiedReceiptHeld`, `pay.BreakResolutionRequested`; `pay.PaymentCleared` carries a transfer's `bankAccountId` and `clearedOn`. |
| FIN, MDM | FIN: `providerSettledAmounts`, `unidentifiedReceiptAmounts`, a bank transfer's tender against its bank account's party, two translators, `BankAccounts.bankLegIn` and `entryOfIn` (read only). MDM: `CustomerFacts.hasPhone`. |
| Docs | ADR-0065; A-214, A-215, A-212's approval; ADR-0064 accepted; ADR-0026 amendments (the owner's placements, the split); the ADR index; openers (1c marked, 1d inserted, B09a continued 2 reads 1d's report, the owner's lines in B9b, B10, B11, B12); `pay.md`, PAY, FIN and the schema-names note in `MODULE_BOUNDARIES.md`, DOMAIN_MODEL 5.9, `API.md`, `CONTRACT_CHANGELOG.md`, SRS traceability, THREAT_MODEL row 33 (a break made to disappear, `RECONCILIATION_BREAK`), runbook `reconciliation-break.md`, BL-069 and BL-070. |

## The gate, proved by running it

`test/integration/pay/settlement-reconciliation.integration.spec.ts` (14 tests, real PostgreSQL, the seeded farm, Paystack's local fake for the three provider payments):
- **Settlement:** three mobile money payments of 50,000, 40,000 and 60,000 cleared on the provider's webhook; a file of four lines (fees 500, 400, 600; an extra `T7730994017` of 2,000) imported as 202 `IMPORTED` with nothing posted; matched: 200 `HAS_BREAKS`, three `MATCHED`, one `NOT_FOUND`; **Dr 1100 148,500 GCB current account, Dr 6910 1,500, Cr 1120 150,000 Paystack**, once (a replay answers the same, a second match `ALREADY_MATCHED`); the extra line a `SETTLEMENT_NOT_FOUND` break of 2,000 on `pay.pub_reconciliation_break` read as `hk_report`. The same file, and a reference already settled, refused and nothing posted. A line one pesewa above its payment `SETTLEMENT_AMOUNT_DIFFERS` (amount 1), a pending payment `NOT_FOUND` (`NOT_CLEARED`) and left PENDING, nothing posted. By direct SQL as `hk_app`: a matched line re-opened, a report re-opened or its amounts changed, a line deleted, all refused. **Passed.**
- **Bank statement:** a transfer of 75,000 recorded `PENDING` with nothing posted; a statement of four lines imported (opening 1,000,000, closing 1,225,000); matched: the transfer `CLEARED` from its line, **Dr 1100 75,000 GCB, Cr 2200 75,000 Tema Cold Store**, dated the value date, the line naming its entry; the settlement payout of 150,500 linked to the `pay.ProviderSettled` entry; an unknown deposit of 2,000 and bank charges of 2,500 `BANK_LINE_UNMATCHED` (`NO_CANDIDATE`); a rerun raises and posts nothing new. Two transfers of 10,000 with one reference: a `CANDIDATES_TIE` break, neither cleared; matched by hand to one (cleared, Dr 1100 10,000), the other line refused at another amount, the line refused twice, the tie's break still open. A file again, an overlapping period and a balance broken by a pesewa refused. By SQL: a transfer cleared with no line (`ck_payment_transfer_cleared`), a matched line re-opened, a line matched to another account's transfer, an overlapping statement (`ex_bank_statement_period`), all refused. **Passed.**
- **Breaks:** the 2,000 settlement line resolved as an unidentified receipt by the Accountant: 202 `RECONCILIATION_BREAK`, nothing posted, a second ask `RESOLUTION_PENDING`; the Accountant refused (403, no approve permission); the Manager without step-up `STEP_UP_REQUIRED`; with step-up approved: **Dr 1100 2,000 GCB, Cr 2290 2,000**, the break `RESOLVED` by the Manager with the note; again `BREAK_NOT_OPEN`. The unknown deposit asked by the Owner: her own approval `MAKER_CANNOT_CHECK` with nothing posted, the Manager's approval Dr 1100 2,000, Cr 2290 2,000. Bank charges: suspense refused (`POSTING_NOT_FOR_BREAK`), a blank note 400, resolved with a note and no posting on the Owner's approval. By SQL: a break resolved by hand (`ck_reconciliation_break_approved`), a resolution approved by its maker (`ck_break_resolution_checker`), one suspense entry per line. **Passed.**
- **Wrong roles and the books:** the Cashier, Sales and the Storekeeper refused all twelve operations, the Manager the six writes; **the trial balance sums to exactly 0, and 2290 holds exactly 4,000.** **Passed.**

`test/integration/pay/receipts-reversals.integration.spec.ts` (the owner's store credit rule, written red first: without migrations 0175 and 0176 the SQL case failed; with them, green): the walk-in refused (`DESTINATION_NOT_AVAILABLE`), a customer with no phone refused (`STORE_CREDIT_NEEDS_PHONE`) and its ISSUE entry refused by direct SQL as `hk_app` (`ck_store_credit_entry_customer_phone`). **Passed.** `test/integration/ord/sale-posting.integration.spec.ts` (A-208's receipt link): still green. `test/contract/b9/reconciliation.contract.spec.ts`: every new operation's responses and refusals in the contract's shapes. **Passed.**

## Decisions

- **ADR-0065** (proposed): reference and exact amount only, ties and differences as breaks; imports idempotent by file and line in the database; a transfer clears only from its line; every resolution through a second person; one new ◆ event for the suspense posting. It extends ADR-0003's matrix with a row and contradicts no ADR. No stop.

## Deferred

- **B09a continued 1d (A-215):** the refund against a credit note on a paid document (Dr 1200, capped by the credit note in the database under concurrency, approved by someone other than both makers with step-up); a cheque refunded through a bank payout.
- BL-069 (the nightly `settlement-match` job, a cleared payment never settled, a wallet's statement) and BL-070 (reclassifying 2290 to a customer as a PAY operation).
- No seed extension: reconciliation data arrives as files the accountant imports, so the seeded day's trial balance is unchanged.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`cd810af`, unchanged since the last report); it lists CR-001 to CR-030. Nothing new. CR-005, CR-023, CR-027 and CR-028 stay with B09x as the owner placed them; CR-029 and CR-013 with B09a continued 2; the others were answered in earlier phases. None asks anything of reconciliation.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,384 passed** (new: `pay/domain/reconciliation` 32, the store credit phone rule in `pay/domain/refund`, FIN's settlement, transfer and suspense amounts) |
| Integration | **1,342 passed** (new: `pay/settlement-reconciliation` 14, two `pay/receipts-reversals` cases) |
| Coverage, merged (`pnpm test:coverage`) | **2,726 passed**, 221 files, exit 0. Statements 93.55 percent, branches 83.28 percent (gate 80). Every 100 percent gate held, `src/modules/pay/domain/**` and `src/modules/fin/domain/**` included. |
| Contract | **94 passed** (new: `b9/reconciliation`; the drift count and the request schema map updated); `contract:generate` up to date (402 from code, 233 planned); Redocly clean; the versioning check against `main` passes |
| Lint, typecheck | Clean |
| End to end | CI only |

**Test first, honestly:** `pay/domain/reconciliation.spec.ts` ran red (no module) before its code; `fin/domain/event-amounts.spec.ts`'s seven new cases ran red before `providerSettledAmounts`, `unidentifiedReceiptAmounts` and the transfer's bank party; `pay/domain/refund.spec.ts`'s phone case ran red before the rule. The integration spec was written before the endpoints had run; its first runs failed on real faults (every update of the new tables forgot `version`, which `platform.touch_version` refuses; a statement's branch read through `platform.business_document`, which the schema-names check refuses) and on its own setup (a day's clock advance outlived the sessions; a TOTP sign-in counts as a fresh step-up for five minutes). Earlier tests changed on purpose because this phase made them stale: `test/contract/api/openapi-drift` (402 from code, 233 planned), `test/contract/b3/slice-and-login` (four new request schemas), `fin/domain/event-amounts` (a bank transfer now names its bank account, so the "no party" case uses a cheque), `bil/archive-link-rollback` (walks 0181 back), `iam/authorisation` (twelve operations and their valid bodies). No flaky test seen; nothing skipped, loosened or retried; no database rule weakened.

## Gate

**Phase split (A-215).** Passed for what this phase built: the settlement of three payments with its exact posting and the extra line's break, a transfer cleared only from its line, `BANK_LINE_UNMATCHED`, a break resolved only through a different person's approved posting (2290), the trial balance at zero, every reconciliation write refusing the wrong role. Remaining for B09a continued 1d: the refund against a credit note posting Dr 1200, and the cheque's bank payout.

## Notes for the frontend track

- Contract 1.44.0: import a file with `POST /files` (`purpose: IMPORT`) first; imports answer 202 and post nothing; show `matchStatus: UNMATCHED` before a match.
- `resolveReconciliationBreak` is 202 `RECONCILIATION_BREAK` with subject `BREAK_RESOLUTION` for the approvals inbox; offer `posting: UNIDENTIFIED_RECEIPT` only for `SETTLEMENT_NOT_FOUND` and `BANK_LINE_UNMATCHED` money in.
- `matchBankStatementLine` takes `paymentId` or `journalEntryId`, exactly one. `RECONCILIATION_INVALID` is new. Store credit to a customer with no phone is refused.

## CI

- **`ca89c74`** (the code and the documents, pull request #65 opened on it): run **43933774581 (push)**, completed, success; run **43933835820 (pull_request**, which also compares the contract with `main`), completed, success.
- The runs on the final head (this report's commit), its `push` run and its `pull_request` run, are named in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green. No red run on this branch; nothing was re-run.
- The branch's history was rebuilt before its first push so that each commit's migration rollback test lists exactly the migrations that commit has (nothing pushed was rewritten).

## Next session

B09a continued 1d, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2c-payments-settlement.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PAY-012, FR-PAY-013 and FR-BIL-007 to FR-BIL-009 of docs/SRS.md (nothing else from the SRS),
docs/data-model/pay.md, docs/data-model/bil.md (credit notes and the settlement summary), the PAY, BIL and FIN cards
in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0017, ADR-0056, ADR-0060, ADR-0063, ADR-0064
and ADR-0065, the abuse case 12 in docs/security/THREAT_MODEL.md, and A-200, A-210, A-212, A-214 and A-215 in
docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint,
hakorem-migration and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other
document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1d only, on branch b09a2d-payments-credit-refunds, branched from main: a credit note on
a paid document (BIL refuses it today because outstanding would go below zero: a credit beyond what is outstanding
leaves the credited money refundable instead), and requestRefund with creditNoteId: the refund draws on the credit
note's uncredited amount, never beyond the credit note's amount less what was already refunded against it, held by
the database (a trigger under the credit note's lock) and proved under concurrency (two refunds of the last amount
at once: exactly one succeeds); approved by someone other than the refund's maker and other than the credit note's
maker, with step-up (the owner, 2026-11-16: refunds are where till fraud lives); paid, ◆ pay.RefundPaid posts Dr
1200 against the customer and Cr the tender (its rule and an exact-amount matrix test, ADR-0056). A cheque refunded
to its original method through a bank payout (Cr 1100 against the bank account, paid by hand with its reference by
someone other than the maker). Write every money rule test-first. Keep the A-208 receipt-link test green.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2d-payments-credit-refunds.md, and merge into main when every run on the
pull request is green.
```
