# B09a continued 1b: payments recorded by hand, cheques, reversals, store credit and open items

Date: 2026-11-16 · Branch `b09a2b-payments-reconciliation`, from `main` (`3a74d76`) · Status: **phase split (A-213).** The gate's receipts, cheques, reversals and store credit are built and proved; settlement reports, bank statements, the break endpoints and the refund against a credit note are **B09a continued 1c** (`b09a2c-payments-settlement`), inserted before B09a continued 2.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-212 | **Receipts, cheques, reversals and store credit as built (ADR-0064), each the most conservative reading.** (a) `recordPayment` takes a cheque, a bank transfer or store credit only; **cash is refused there** (a till named by a caller is an unverifiable party on 1000: cash comes through a sale with an open shift's till, B9b, or a driver, B11); a cheque needs its `BANK` account and its number; a bank transfer takes no allocation until a statement line matches it (1c); cheques and store credit stay disabled in the seed until the owner turns them on (A-115). (b) A cheque posts into 1130 at receipt, as ADR-0003's row reads, and clears on a business date from its receipt to today. (c) **Every reversal waits** for a different Owner or Manager (`pay.reversal.approve`) with step-up, threshold 0 as data; a bounce is a reversal (`CHEQUE_DISHONOURED`), not a second path on `clearCheque`; a payment with a live refund, a pending provider payment or transfer, and a reversing payment are not reversed; the approval binds the payment's status and amounts. (d) Store credit is per customer across branches; refunded to store credit only for a payment with a customer, paid at once by the approver; a cheque is not refunded to its original method until the bank payout (1c). (e) Open items are what is outstanding now; `asOf` sets only the day overdue counts from. (f) Grants as in 0171; abuse case 32 is new (`PAYMENT_REVERSAL`). | Owner (a, c, f), Accountant (b, d, e) |
| A-213 | **B09a continued 1b split (ADR-0026 Amendments).** B09a continued 1c builds settlement and bank statement import and matching (`pay.ProviderSettled`: 1100, 6910, 1120; a bank transfer cleared by its line; 2290), the break endpoints with their approved postings, and the refund against a credit note (Dr 1200, with a credit note on a paid document, which BIL refuses today because outstanding would go below zero). It runs next, before B09a continued 2. | Owner |
| A-200 (c) | **Amended by the owner, 2026-11-16** (from F8): credit notes are raised by the Owner, the Accountant and the Manager (migration 0174), never a Cashier; approved by the Owner or a Manager other than the maker. | Owner (done) |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211. A-210 and ADR-0063 were approved by the owner on 2026-11-16 (merged from `main`, PR #63); A-064, the real Paystack sandbox run, is now the first step of B09a continued 2 (still after 1c, which does not change its opener).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 1b (`b09a2b-payments-reconciliation`, from `main` at `3a74d76`).
2. **Scope:** the remaining PAY permissions, `recordPayment`, `clearCheque`, `reversePayment` under approval, store credit, refunds to store credit, `listOpenItems`, the published break view for B12; settlement, bank statements and the break endpoints split to 1c at the reconciliation sub-domain boundary, decided up front because the whole scope could not reach its gate in one context.
3. **Gate (for this part):** a cheque of 100,000 is PENDING debiting 1130 only and clears 1130 to 1100, or bounces and reopens the 100,000 item; reversing a 50,000 payment posts the mirror of its journal on a different person's approval and reopens its allocations; store credit of 6,000 is never redeemed for 6,001 (and two redemptions of the last of it at once leave exactly one), redeeming 6,000 debits 2210; the trial balance still sums to zero; every PAY write built refuses the wrong role.

Also done in this phase, at the coordinator's request (the owner's two decisions of 2026-11-16 from F8), each in its own commit: the Manager raises credit notes (0174, test-first), and CR-030.

## Contract changes

**1.43.0, minor; no existing shape changed.** Six planned PAY operations move into code: `recordPayment`, `reversePayment`, `clearCheque`, `getCustomerStoreCredit`, `getMyStoreCredit`, `listOpenItems`, their descriptions and examples made exact (`reversePayment`'s 202 names the payment; `recordPayment`'s example is a cheque answered `PENDING`). New error codes `STORE_CREDIT_INSUFFICIENT` and `PAYMENT_REVERSAL_INVALID` (422). `listReasonCodes`'s `domain` takes `PAYMENT_REVERSAL` (a new enumeration value: a client validating domains against a fixed list must add it). `requestRefund` now takes `STORE_CREDIT`. `issueCreditNote`'s description names the roles. CR-030's six examples fixed. `contract:generate --check` up to date (390 operations from code, 245 planned); Redocly clean. `docs/CONTRACT_CHANGELOG.md` (entry and the cold-read summary) and `docs/API.md` record it.

## Built

| Area | What |
| --- | --- |
| Migrations | 0169 (reason domain `PAYMENT_REVERSAL`: `CHEQUE_DISHONOURED`, `RECORDED_IN_ERROR`); 0170 (permissions `pay.payment.create`, `.clear_cheque`, `.reverse`, `pay.reversal.approve` with step-up, `pay.store_credit.read`, `pay.receivable.read`; the `PAYMENT_REVERSAL` policy, threshold 0, step-up); 0171 (grants); 0172 (`pay.payment.clearance_ref`, `ck_payment_bank_account`, `ck_payment_store_credit_customer`, `ck_payment_cheque_clearance`, `ck_payment_reversal_row`, the guard refusing REVERSED or FAILED with money still allocated or refunded; `pay.payment_reversal`; `pay.store_credit_entry` LEDGER; `pay.store_credit_balance` PROJECTION with `trg_store_credit_apply` and `ck_store_credit_balance`; the view `pay.pub_reconciliation_break` for hk_report); 0173 (FIN: `pay.ChequeCleared` Dr 1100 Cr 1130, `pay.PaymentReversed` with no amount keys, tender determinations CHEQUE 1130 and STORE_CREDIT 2210, `uq_journal_entry_cheque_cleared`); 0174 (MANAGER gets `bil.credit_note.create`). Each rolls back (`bil/archive-link-rollback` walks 0174 to 0155 back and applies them again). |
| PAY | Domain (100 percent gate): `judgeReceipt`, `judgeRedemption`, `judgeChequeClearance`, `judgeReversal`, `daysOverdue`, the store credit route in `judgeRefund`. Application: `Receipts` (record, clear, request a reversal, IAM's `PAYMENT_REVERSAL` handler), `StoreCredit`, `Receivables`; `Payments.writeIn`, the one write path a sale's tender and a receipt share; `Refunds` pays a refund to store credit at approval. Interface: three new controllers, six fragments. |
| FIN, BIL, MDM | FIN: the mirror event in the catalogue rule and `Ledger.postIn` (`MIRROR_WITHOUT_ORIGINAL`), `chequeClearedAmounts`, store credit's party on 2210, two translators. BIL: `Billing.openItemsIn`. MDM: `MasterDataRefs.customerOfPrincipalIn`. |
| Docs | ADR-0064; A-212, A-213, A-200 (c); ADR-0026 amendment; ADR-0003 applied note; the ADR index; openers (1b marked, 1c inserted, B09a continued 2 reads 1c's report and ADR-0064, **B12 reads PAY's breaks through `pay.pub_reconciliation_break` and the reversals of case 32**, B09x's role matrix must show the credit-note grants); `pay.md`, PAY and BIL cards, DOMAIN_MODEL 5.9, `API.md`, `CONTRACT_CHANGELOG.md`, SRS traceability, THREAT_MODEL row 32, runbook `reconciliation-break.md`. |

## The gate, proved by running it

`test/integration/pay/receipts-reversals.integration.spec.ts` (16 tests, real PostgreSQL, the seeded farm, cheques and store credit turned on by the Owner through `updatePaymentMethod`):
- **Cheque:** 100,000 against an invoice of 100,000 is 201 `PENDING`, Dr 1130 100,000 (no party), Cr 1200 100,000 Tema Cold Store, the invoice at 0; a replay answers the same, another body 409. Cleared by the Accountant: Dr 1100 100,000 GCB current account, Cr 1130 100,000, once (a second clearing `CHEQUE_NOT_PENDING`; the Cashier 403; a date before receipt refused). **Passed.**
- **Bounce:** a second cheque of 100,000; the Manager's request is 202 `PAYMENT_REVERSAL` (subject the payment) with `pay.PaymentReversalRequested` carrying abuse case 32; nothing changes; her own approval `MAKER_CANNOT_CHECK`, the Owner without step-up `STEP_UP_REQUIRED`, the Accountant 403; the Owner with step-up approves: the cheque `FAILED`, the mirror Cr 1130 100,000, Dr 1200 100,000, the invoice outstanding 100,000 again, a reversing payment `REVERSED` naming it. A cleared cheque reversed in error mirrors both entries (Cr 1130, Dr 1200, Cr 1100 GCB, Dr 1130, 100,000 each). **Passed.**
- **Reversal of 50,000:** a mobile money deposit of 50,000 allocated to an invoice of 50,000, reversed on the Owner's approval of the Manager's request: the mirror Cr 1120 50,000 Paystack, Dr 2200 50,000; the allocation taken off Dr 1200 50,000, Cr 2200 50,000; the invoice outstanding 50,000. A pending transfer, a reversing payment, a dishonoured reason for a non-cheque and a missing note are refused by name. **Passed.**
- **Store credit:** 6,000 refunded to store credit on approval (Dr 2200 6,000, Cr 2210 6,000), balance 6,000 for the Cashier and for the customer's own sign-in; 6,001 refused; 6,000 redeemed against an invoice (Dr 2210 6,000, Cr 1200 6,000), balance 0; the redemption reversed gives 6,000 back (Cr 2210, Dr 1200); **two redemptions of the last 6,000 at once: exactly one 201, the other `STORE_CREDIT_INSUFFICIENT`, balance 0**; by direct SQL as hk_app a redemption of 1 beyond the balance is refused (`ck_store_credit_balance`), an entry cannot be updated or deleted, the balance cannot be written. **Passed.**
- **Refusals and the database:** mobile money `PAYMENT_METHOD_REQUIRES_VERIFICATION`; cash `TENDER_NOT_AVAILABLE`; a cheque into a mobile money wallet with no number dated ahead named at once; a transfer with an allocation `ALLOCATION_WHILE_PENDING`; store credit with no customer. By SQL: a cheque failed with money allocated (`ck_payment_transition`), a second reversing payment (`uq_payment_reverses`), an edit of a cleared payment, a reversal written approved. **Passed.**
- **Wrong roles and the books:** the Storekeeper refused all five operations, the Cashier and Sales clearing and reversing, the Cashier open items, the customer the staff read; open items' total equals the database's sum over the filter; **the trial balance sums to exactly 0, and 1130 equals the cheques still awaiting clearance (3,000).** **Passed.**

`test/integration/bil/billing-documents.integration.spec.ts` (the owner's credit-note rule, written red first): the Cashier 403, a Manager raises a credit note, her own approval `MAKER_CANNOT_CHECK`, another Manager approves, the Owner approves a second. **Passed.** `test/integration/ord/sale-posting.integration.spec.ts` (A-208's receipt link): still green. `test/contract/b9/receipts.contract.spec.ts`: every new operation's responses and refusals in the contract's shapes. **Passed.**

## Decisions

- **ADR-0064** (proposed): a cheque posts at receipt; a mirror event type with no rules; one reversal path for a bounce and an error; allocations at receipt reopened by the mirror, those from deposit by `pay.DepositAllocated`; store credit's balance held by a row lock in a trigger. It extends ADR-0056's correction path and contradicts no ADR. No stop.

## Deferred

- **B09a continued 1c (A-213):** settlement reports and bank statements with matching, `pay.ProviderSettled` (1100, 6910, 1120), a bank transfer cleared by its line, 2290, the break endpoints with approved postings, the refund against a credit note (Dr 1200), a cheque refunded through a bank payout.
- **B9b:** cash recorded by hand at a till comes with shifts. **B11:** cash with a driver. **B12:** the exception report reads `pay.pub_reconciliation_break` and `pay.PaymentReversalRequested` (the opener says so).
- No seed extension: the seeded farm keeps cheques and store credit off (A-115), so the seeded day's trial balance is unchanged.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`cd810af`); it lists CR-001 to CR-030. New since the last report: **CR-030** (the billing examples contradict their operations): **implemented** in 1.43.0, examples only, all six points (named `thermal` and `pdf` reprint examples; the credit note's 202 names the draft `CREDIT_NOTE`; a `DEBIT_NOTE` 201 with `originalDocument`; the archive's `sha256` and `businessDocument` agree with the billing document's; reprint count 5, five copies, next copy 6; `listReasonCodes` lists the seeded `REFUND`, `RETURN`, `BILLING_ADJUSTMENT` and `PAYMENT_REVERSAL` codes), each changed example validated against its schema. CR-005, CR-023, CR-027 and CR-028 stay with B09x as the owner placed them (B09x's opener now also requires the credit-note grants in the matrix); CR-029 and CR-013 with B09a continued 2. The others were answered in earlier phases; nothing else asks anything of PAY.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,343 passed** (new: `pay/domain/receipt` 14, the store credit refund route, `daysOverdue`, FIN's mirror catalogue and the cheque, store credit and clearing amounts) |
| Integration | **1,326 passed** (new: `pay/receipts-reversals` 16, one `bil/billing-documents` case) |
| Coverage, merged (`pnpm test:coverage`) | **2,669 passed**, 219 files, exit 0. Statements 93.65 percent, branches 83.42 percent (gate 80). Every 100 percent gate held, `src/modules/pay/domain/**` and `src/modules/fin/domain/**` included. |
| Contract | **93 passed** (new: `b9/receipts`); `contract:generate --check` up to date (390 from code, 245 planned); Redocly clean; every changed example validated against its schema |
| Lint, typecheck | Clean |
| End to end | CI only |

**Test first, honestly:** the domain specs (`receipt`, the store credit refund route, `daysOverdue`), FIN's mirror catalogue and the cheque and store credit amounts were run red before their code (a missing module, then failing cases). The integration spec was written before the endpoints had run; its first runs failed on its own setup (a customer row's version, a clock advanced past the session's life) and on one real fault: a reversal already approved was reported as `REVERSAL_PENDING` beside `NOT_REVERSIBLE`, so only a request still waiting counts now. The realm check answers 401, not 403, to a staff session on the customer's route and back; the tests say so. The credit-note test failed red (403) before 0174 and once on its own expectation (`MAKER_CANNOT_CHECK` is 422). Earlier tests changed on purpose because this phase made them stale: `bil/archive-link-rollback` (walks 0174 back), `iam/authentication` (the Cashier's two new permissions), `iam/authorisation` (six operations and their valid bodies; `getMyStoreCredit` is an own-account operation), `mdm/reference-data` (52 reasons), `pay/refunds` (store credit is refused now only for a payment with no customer), the contract drift count and the request schema map. No flaky test seen; nothing skipped, loosened or retried; no database rule weakened.

## Gate

**Phase split (A-213).** Passed for what this phase built: the cheque cleared and bounced, the 50,000 reversal's mirror with a different approver, store credit never beyond its balance under concurrency, the trial balance at zero, every PAY write built refusing the wrong role. Remaining for B09a continued 1c: the settlement of three payments with a fee and the extra line's break, a break resolved only through an approved posting, the refund against a credit note.

## Notes for the frontend track

- Contract 1.43.0: a cheque or transfer is `PENDING` after `recordPayment`; never show it as paid money. `reversePayment` is always 202 `PAYMENT_REVERSAL` (subject the payment) for the approvals inbox.
- `STORE_CREDIT_INSUFFICIENT` and `PAYMENT_REVERSAL_INVALID` are new; `PAYMENT_REVERSAL` is a new reason domain. The Manager may raise credit notes.
- CR-030's examples now agree; `Prefer: example=pdf` gives the PDF reprint on the mock.

## CI

- **`c2fcbfd`** (the code, CR-030 included, pushed before the pull request was opened): run **43918110154 (push)**, completed, success. No `pull_request` run existed for it: the pull request was opened after the documentation commits.
- The runs on the final head (this report's commit), the `push` run and the `pull_request` run that compares the contract with `main`, are named in the session's closing message: a commit cannot name its own runs. The pull request is merged with a merge commit only once every run on its head is green. No red run on this branch; nothing was re-run.

## Next session

B09a continued 1c, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2b-payments-reconciliation.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0014, ADR-0017,
ADR-0056, ADR-0063 and ADR-0064, the abuse cases 4, 12 and 32 in docs/security/THREAT_MODEL.md,
docs/runbooks/reconciliation-break.md, and A-200, A-208, A-210, A-212 and A-213 in docs/ASSUMPTIONS.md. Load
hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint, hakorem-migration, hakorem-runbook and
hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase
needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1c only, on branch b09a2c-payments-settlement, branched from main: the remaining PAY
permissions and grants; importSettlementReport and matchSettlementReport (◆ pay.ProviderSettled: Dr 1100 net against
the bank account, Dr 6910 the fee, Cr 1120 against the provider; SETTLEMENT_AMOUNT_DIFFERS and SETTLEMENT_NOT_FOUND
breaks; nothing corrected automatically); importBankStatement, matchBankStatement and matchBankStatementLine (a bank
transfer recorded PENDING by recordPayment clears from its matched line with pay.PaymentCleared Dr 1100 against the
bank account, its tender determination seeded; an unmatched line raises BANK_LINE_UNMATCHED; a receipt from an
unknown payer is held in 2290); listReconciliationBreaks, getReconciliationBreak and resolveReconciliationBreak with
its posting through approval by a different person (2290 for an unidentified receipt, the deposit or refund paths),
every break kind on the published view pay.pub_reconciliation_break (B09a continued 1b) that the daily exception
report reads; a credit note on a paid document and the refund against it (Dr 1200, the refund drawing on the credit
note's uncredited amount, held by the database); a cheque refunded to its original method through a bank payout.
PAY's remaining ◆ events in fin.posting_event_type with their determinations (1100 for a bank transfer, 2290, 6910),
each with an exact-amount matrix test (ADR-0056). Write every money rule test-first. Keep the A-208 receipt-link
test green.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2c-payments-settlement.md, and merge into main when every run on the pull
request is green.
```
