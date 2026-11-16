# ADR-0065: Settlement reports, bank statements and the break queue as built

- **Status:** Proposed. **Not to be accepted from documentation (owner, 2026-11-16):** the file formats and matching rules are rewritten against one real Paystack settlement and one real statement export from the farm's bank, each rule citing the file it came from (phase B09r).
- **Date:** 2026-11-16
- **Session:** B09a continued 1c
- **Deciders:** backend track; the accountant reviews the posting rows and the file formats (A-214); the owner's rules of 2026-11-16 (a matched line posts exactly once, held by the database; never auto-match on amount alone when two candidates tie; an import is idempotent by file hash and line; a break resolves only through an approved posting)

## Context

ADR-0003 names `pay.ProviderSettled` (Dr 1100, Dr 6910 fees, Cr 1120) and puts an unknown payer's receipt in 2290 on `pay.PaymentCleared`'s row. FR-PAY-016 and FR-PAY-017 say lines are matched by reference and amount, a line that does not match is a break, nothing is corrected automatically, and a break's resolution goes "through the normal approval path for any posting". Building them left open: the file formats (the contract takes a `fileId`); which bank account a settlement paid into (the planned `SettlementImport` has none); what a statement line matches (the planned `BankLineMatch` names a journal entry, but a pending bank transfer has none yet); how a break no branch is known for is shown (`branchId` is required); how an unknown payer's money reaches 2290 when it never was a payment of ours; and how "never by hand" is held.

## Options considered

1. **Match on amount and date, and let the accountant mark breaks resolved with a note.** Fast, but two transfers of 75,000 on one day tie silently, and a note that resolves a break hides money with one person.
2. **Record every unknown line as a payment with no customer and let it clear through `pay.PaymentCleared` into 2290.** Reuses ADR-0003's row, but a provider line is not a mobile money payment the provider confirmed to us (the database refuses that, `trg_payment_provider_confirmed`), and it would put suspense money in the allocation and refund paths.
3. **Reference and amount only, ties and differences as breaks; every resolution through a second person; one new ◆ event for the suspense posting.**

## Decision

Option 3.

- **Files (A-214).** An uploaded `IMPORT` file (CSV or XLSX, scanned `CLEAN`, read by its uploader or a holder of `platform.file.read.any`). A settlement: `settlement_ref,settled_on,reference,amount,fee`, one settlement on one date no later than today. A statement: `value_date,direction,amount,balance,reference,narration` in the bank's order, its running balance adding up to the pesewa and its opening never below zero. Amounts are cedis with exactly two places, read as integer pesewas. Every broken row is named at once.
- **Idempotent by file and line, in the database.** A settlement report is unique per provider and file hash and per settlement reference; a provider reference is settled once ever (`uq_settlement_line_reference`); a payment is matched by one line (`uq_settlement_line_payment`). A statement is unique per account and file hash, and no two statements of an account overlap in period (`ex_bank_statement_period`). A statement line matches one payment or one journal entry, each once. Lines, reports and statements are written `IMPORTED`/`UNMATCHED`, change once, and freeze.
- **Settlement matching.** Each line against the payment of the same provider its reference names: matched only when that payment is `CLEARED` for exactly the line's amount (held by `trg_settlement_line_guard`). A payment the provider has not confirmed is never cleared from a settlement (FR-PAY-005): the line is `NOT_FOUND` (`NOT_CLEARED`) until the sweep clears it. The matched lines post one `pay.ProviderSettled` (net, fee, gross; once per report, `uq_journal_entry_provider_settled`), dated `settledOn`, against the bank account named at import (`bankAccountId`, optional in the schema and required by the rule, `BANK` accounts only) and the provider's party on 1120, at the head office. Every other line is `SETTLEMENT_AMOUNT_DIFFERS` or `SETTLEMENT_NOT_FOUND`.
- **Bank matching, never on amount alone.** Automatically, a money-in line matches a candidate only when its reference or narration carries the candidate's reference (four characters at least once spaces and punctuation are taken out) at exactly its amount: a bank transfer still `PENDING` into the account, or a settlement's payout (its report's net). Exactly one such candidate is a match; two are a tie (`CANDIDATES_TIE`); the right reference at another amount is `AMOUNT_DIFFERS`; money out is matched by hand. By hand, `matchBankStatementLine` takes a pending transfer (`paymentId`, additive) or a journal entry whose net leg on the account shows the line exactly (read through FIN's `BankAccounts.bankLegIn`). A transfer clears only from its line: `pay.PaymentCleared` with the bank account's party on 1100 (its tender determination, seeded) and Cr 2200, dated the value date; the database refuses a transfer cleared with no line naming it (`trg_payment_transfer_cleared`).
- **Breaks.** Every unmatched line is a break naming its line, raised once while open, published on `pay.pub_reconciliation_break` with the line columns added. A break no branch is known for (a provider reference never ours) is held and shown at the head office. A break is resolved only through `resolveReconciliationBreak`: always 202 `RECONCILIATION_BREAK` (threshold 0, step-up, approver `pay.reconciliation.approve`, subject a `BREAK_RESOLUTION` document), the approval binding the break and what was asked. Its one posting, `UNIDENTIFIED_RECEIPT`, holds an unknown payer's money in suspense through the new ◆ `pay.UnidentifiedReceiptHeld` (Dr 1100 what reached the bank, Dr 6910 any provider fee, Cr 2290 the whole; once per line), allowed only for a `SETTLEMENT_NOT_FOUND` line no payment carries and a `BANK_LINE_UNMATCHED` money-in line still unmatched. Anything else is resolved with a note after the correction was made through its own operation (an allocation, a refund, a reversal, a match by hand, an approved manual journal). The database refuses a break resolved without an approved resolution by someone other than its maker (`trg_reconciliation_break_resolved`, `ck_break_resolution_checker`); a failed refund's break still closes when its refund is paid (ADR-0063).

## Consequences

- No line is matched on a guess; the accountant sees every tie and difference, and one person cannot make a break disappear. The smallest team that can resolve is two people (the Accountant or Owner asks, the Owner or Manager approves).
- 1120 is settled at the head office branch dimension: it nets across branches, not per branch (one branch today; A-214).
- 2290 holds unknown money until the payer is found; moving it to a customer is an approved manual journal (FIN) until a later session builds a reclassification.
- `pay.UnidentifiedReceiptHeld` is a new matrix row beside ADR-0003's; ADR-0003's rows are unchanged.
- Binds: `docs/data-model/pay.md`, `docs/API.md` (PAY), the PAY and FIN cards in `docs/MODULE_BOUNDARIES.md`, `docs/runbooks/reconciliation-break.md`, A-214.

## Verification

- `test/integration/pay/settlement-reconciliation.integration.spec.ts`: three payments of 150,000 with a 1,500 fee matched, Dr 1100 148,500 GCB, Dr 6910 1,500, Cr 1120 150,000 Paystack, once; the extra 2,000 line a break on the published view; a replayed or repeated import posting nothing; a difference of one pesewa and an unconfirmed payment raised, nothing posted; a transfer of 75,000 cleared only from its line (Dr 1100, Cr 2200); a tie raised and matched by hand; the 2,000 held in 2290 on a different person's step-up approval; the database's rules by direct SQL; every write refusing the wrong role; the trial balance at zero and 2290 at the suspense held.
- `src/modules/pay/domain/reconciliation.spec.ts` (100 percent gate) and `src/modules/fin/domain/event-amounts.spec.ts`: the files, the matching, the resolution rules and the exact amounts of each new row.

## Evidence required before acceptance (owner, 2026-11-16)

The formats and matching rules above were written from documentation and from a file layout this repository invented (`value_date,direction,amount,balance,reference,narration`; `settlement_ref,settled_on,reference,amount,fee`). No real file has been read. The owner's rule: a format that looks settled in a provider's documentation turns out different in the file (a carrier's API stub this month gave six fictional answers and every test passed against them), so this ADR is accepted only once:

1. **Paystack:** the settlement is read from Paystack's Settlements API (the settlements and the transactions inside each one, as structured data), not parsed from a dashboard export. A CSV export is a rendering of that data and is not built on. B09a continued 2's sandbox run reports what the API returns and whether it covers what the matching needs. One real settlement covering real payments is then read before the rules are final.
2. **The bank:** one real statement export from the bank the farm uses, in the format its internet banking offers. The parser and the matching rules are written against it.
3. **Provenance:** each format and matching rule names the file it came from (the Paystack API response, or the bank export and its date), in this ADR and in the test that holds it.
4. **No production data in the repository:** the real files are read, never committed. Fixtures replicate their layout, encoding, dates, separators and quirks with invented values (hakorem-seed).

