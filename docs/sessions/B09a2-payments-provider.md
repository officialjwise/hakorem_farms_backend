# B09a continued: the provider port, webhooks, the provider sweep, allocations and refunds

Date: 2026-11-16 · Branch `b09a2-payments-provider`, from `main` (`c403e20`, with `028c1c9` merged in) · PR #62 · Status: **the gate passed; the phase split after it (A-211).** The remainder is **B09a continued 1b** (manual receipts, cheques, store credit, reversals, open items, settlement and bank reconciliation, the break endpoints), inserted before B09a continued 2.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-208 | **Approved as interim by the owner, 2026-11-16** (status recorded): no price below list until B9b, cash only until other tenders open, channels phase by phase; on (f), an unnumbered payment record is fine as long as every payment links to a numbered receipt or invoice the customer holds. Proved on B9a's trading day (below); how a mobile money deposit is linked is said plainly under "Receipt links". | Owner (done) |
| A-210 | **PAY's provider port, webhooks, allocations and refunds as built (ADR-0063), each the most conservative reading.** (a) Paystack's sandbox is not used: it needs a test key the repository never holds, so the adapter is tested against a local fake of Paystack's documented API (`test/support/fake-paystack.ts`); a live key is refused outside production; the farm's own mailbox is sent as the payer email Paystack requires. (b) Webhook order (the owner): signature (constant time, 401 with no detail), the signed event time within 300 seconds, once by provider reference (`<event>:<reference>`, unique among events that reached processing, so a stale or forged delivery never blocks the genuine one), then the lookup; a payload amount unlike the lookup is rejected with no effect. (c) One clearing path, `ProviderPayments.settleIn`; a provider payment clears as an unallocated deposit (Dr 1120 Cr 2200); money after the 15-minute window, or after the order released it, clears with an `UNMATCHED_PAYMENT` break and is never the order's; no automatic refund. (d) The `provider-sweep` job every minute (the owner): the provider's transaction list from the last window's end, every charge still open looked up after 30 seconds, an unknown reference and a charge missing after 30 minutes raised as breaks. (e) Timeout 10 s, three attempts with full jitter, a breaker opening after five failures for 30 s. (f) Initiation without an order at the caller's one branch; `shiftId` refused until B9b. (g) Allocation of a cleared deposit to issued documents of the same customer; `pay.DepositAllocated` carries `applied` or `unapplied`. (h) Receipt links as below. (i) Every refund a person asks for waits for a different approver with step-up (the SRS's 20,000 automatic limit only for B11's catch-weight refunds); refunds draw only on unallocated money; provider refunds retried after 5 and 10 minutes, then a break; a payout by hand needs its reference and someone other than the maker. (j) Grants as in migration 0165. | Owner (b, i, j), Accountant (c, g, i) |
| A-211 | **B09a continued split after its webhook and edge-case gate (ADR-0026 Amendments).** B09a continued 1b (`b09a2b-payments-reconciliation`) builds `recordPayment`, cheques, store credit, reversals, refunds against a credit note, open items, settlement and bank statement matching and the break endpoints; it runs next, before B09a continued 2, because voids and returns need reversals and store credit. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-064 (the sandbox run, before go-live), A-182 to A-207, A-209.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued (`b09a2-payments-provider`, from `main` at `c403e20`).
2. **Scope:** PAY's permissions and endpoints, the provider port with Paystack's adapter and a local fake, mobile money initiation with timeout, retry and breaker, the status lookup and its worker, the verified webhook and rejection log, deposits and the unmatched queue, refunds with maker-checker and step-up; further (store credit, reversals, cheques, settlement) as far as the gate needs, splitting settlement and bank reconciliation last.
3. **Gate:** every payment edge case in the brief passes test-first with exact amounts; a webhook is accepted only signed, in its window, unseen and with its amount re-verified; every PAY write refuses the wrong role.

The owner's three additions of 2026-11-16 (sent mid-session) are built: the webhook order with processing once by reference (A-210 (b)); the provider sweep with a cursor per run (A-210 (d)); A-208 approved as interim with the receipt-link test.

## Contract changes

**1.42.0, minor; no existing shape changed.** Thirteen planned PAY operations move into code: `listPayments`, `getPayment`, `initiateMobileMoneyCharge`, `checkPaymentStatus`, `allocatePayment`, `unallocatePayment`, `listUnmatchedPayments`, `receivePaymentWebhook`, `listRefunds`, `requestRefund`, `getRefund`, `retryRefund`, `markRefundPaid`, their descriptions made exact. New error code `REFUND_INVALID` (422). `markRefundPaid` is marked `x-requires-step-up` and refuses a missing `externalReference` in the handler (the schema keeps it optional). `requestRefund` always answers 202 today. `contract:generate --check`: up to date (384 operations from code, 251 planned); Redocly clean. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` record it.

## Built

| Area | What |
| --- | --- |
| Migrations | 0164 (PAY permissions; the `REFUND` approval policy, threshold 0, step-up; the webhook's own principal); 0165 (grants); 0166 (`pay.provider_transaction`, `pay.webhook_event`, `pay.refund`, `pay.reconciliation_break`, `pay.provider_sweep`; `trg_payment_provider_insert` and `trg_payment_provider_confirmed`, `trg_provider_transaction_guard`, `uq_webhook_event_reference`, `trg_refund_cap`, `trg_refund_guard`, `ck_refund_paid_by`, the open-break unique keys); 0167 (`pay.DepositAllocated` and `pay.RefundPaid` with their rules; MOBILE_MONEY and CARD tender to 1120; `uq_journal_entry_refund`); 0168 (the `REFUND` document type; `ix_number_allocation_document`). Each rolls back (`bil/archive-link-rollback` walks 0168 to 0155 back and applies them again). |
| platform | The Paystack adapter: mobile money charge (a duplicate reference answers PENDING), transaction list, refund status, webhook reading; `ResilientPaymentProvider` (timeout, retry with full jitter, circuit breaker) with a unit spec; configuration (`PAYSTACK_*`, a live key refused outside production); the raw body kept for webhook routes; `DocumentRegistry.numberedRefs`. |
| PAY | Domain (100 percent gate): `judgeProviderAnswer`, `judgeMissingCharge`, `maskPhone`, `judgeRefund`, `nextRefundAttempt`, `judgeWebhookEvent`, time helpers. Application: `Payments` (allocate, unallocate, get, list, the unmatched queue; `recordIn` unchanged); `ProviderPayments` (initiate, `checkStatus`, `settleIn`, `releaseChargeIn`, `sweep`); `PaymentWebhooks`; `Refunds` (request, the `REFUND` approval handler, retry, `markPaid`, `dispatch`); `Breaks`. Interface: three controllers and 13 fragments. Jobs `provider-sweep` and `refund-dispatch` in `src/worker-app.ts`. |
| FIN, BIL | FIN: `providerParty`, `depositAllocatedAmounts`, `refundPaidAmounts` and their translators. BIL: `Billing.settleableIn`. |
| Docs | ADR-0063; A-208 status, A-210, A-211; ADR-0026 amendment; openers (B09a continued marked; B09a continued 1b inserted; B09a continued 2 reads 1b's report and wires `cancelOrder` to `releaseChargeIn`); `pay.md`, PAY card, DOMAIN_MODEL 5.9, `API.md`, `CONTRACT_CHANGELOG.md`, `OPERATIONS.md` (settings, jobs), SRS traceability, THREAT_MODEL rows 4, 5 and 12, runbooks `payment-provider-down.md` and `reconciliation-break.md`, `.env.example`. |

## The gate, proved by running it

`test/integration/pay/payment-edge-cases.integration.spec.ts` (24 tests, real PostgreSQL, the seeded farm, the real adapter against the local fake):
- **Webhook verification:** a body with one byte changed is 401 with no detail; five forgeries give five `REJECTED_SIGNATURE` rows, five `pay.WebhookRejected` events, five audit rows and one identical answer; an event timestamped six minutes ago is `REJECTED_STALE`; a payload amount unlike the provider's record is `REJECTED_AMOUNT` and changes nothing; the valid event clears the payment once (`PROVIDER_CALLBACK`, Dr 1120 50,000 Paystack, Cr 2200 50,000 Tema Cold Store) and the replay is `REPLAYED` with one journal; a provider record of 49,000 for a 50,000 charge is never cleared, raises `PROVIDER_AMOUNT_DIFFERS` (requested 50,000, confirmed 49,000) and is on the unmatched queue. **Passed.**
- **Edge cases:** timeout after the charge: the retry reuses our reference (two `/charge` calls, one charge at Paystack), the payment stays PENDING with no journal, the same key sends nothing more, the sweep 30 s later clears it once (Dr 1120 44,000, Cr 2200 44,000), a second sweep posts nothing. Webhook before the API answer: cleared by the webhook, the answer shows CLEARED, the charge SUCCEEDED for 30,000, one journal. Same key twice: one payment, one provider call; another body 409. An order that no longer exists (released through `releaseChargeIn`): cleared into 2200 (26,500), `UNMATCHED_PAYMENT`, `heldAsUnmatched` on the event, on the unmatched queue. A late webhook after the 15-minute window: cleared with `UNMATCHED_PAYMENT` (`PAID_AFTER_WINDOW`). A reference never initiated: `IGNORED_UNKNOWN_REFERENCE`, a `PROVIDER_REFERENCE_UNKNOWN` break, nothing posted, the trial balance unchanged. The sweep clears a payment whose webhook never came; a second run raises and posts nothing; the windows are contiguous. The forged-amount payment is cleared later by the sweep for the provider's own 50,000, once. Provider down: five 503s open the breaker, the sixth asks nothing and writes nothing; the five stranded charges wait through the grace period and then fail with `PROVIDER_PAYMENT_MISSING`, no journal. **Passed.**
- **Over-, under- and partial payment:** 120,000 against 100,000 settles it (Dr 2200 100,000, Cr 1200 100,000) and leaves 20,000 in 2200; 60,000 against 100,000 leaves 40,000 PART_PAID, 20,001 more refused and 20,000 accepted; 100,000 against 60,000 and 50,000 allocates 60,000 and 40,000, leaves 10,000, 60,001 to the first refused, one more pesewa refused; an allocation taken off posts Dr 1200 40,000, Cr 2200 40,000 and the invoice is UNPAID again, twice refused; a pending payment or another customer's document refused. **Passed.**
- **The database, by direct SQL as `hk_app`:** a mobile money payment cleared with its charge INITIATED, or confirmed for 7,999 of 8,000, refused (`ck_payment_provider_confirmed`); a settled charge's amount and a requested amount frozen; the webhook log refuses update and delete (no grant; the trigger for the owner role); a second ACCEPTED row for an event id refused (`uq_webhook_event_reference`). **Passed.**
- **Wrong roles and the books:** the Storekeeper and the Farm hand refused every PAY read and write; the Cashier refused allocation; the trial balance sums to exactly 0 and 1120 holds every provider payment cleared. **Passed.**

`test/integration/pay/refunds.integration.spec.ts` (15 tests):
- 25,000 of a 30,000 payment: 202, `pay.RefundRequested` with abuse case 12, nothing paid, 25,000 held; 6,000 afterwards refused (5,000 left); 30,001 of a fresh 30,000 refused; beyond the cap, a payout by the maker, a changed amount and a jump to PAID refused by direct SQL. **Passed.**
- **The smallest team:** the Manager's approval of her own refund refused (`MAKER_CANNOT_CHECK`); the Owner without a fresh step-up refused (`STEP_UP_REQUIRED`), then approves with one. **A single Owner:** their own approval refused and the Manager of another branch refused; the refund stays PENDING_APPROVAL with no journal. A rejection gives the money back to the payment. **Passed.**
- Paid through the provider with the refund's id as the idempotency key, waiting while processed, then Dr 2200 25,000, Cr 1120 25,000 once. A refund failing after the stock was released: FAILED after attempts 1, 2 and 3 at 5 and 10 minutes, then `REFUND_FAILED` 40,000, no more attempts, no journal, the stock footprint (movements, reservations, on hand, reserved) identical. Paid by hand: the Cashier refused, no reference refused, then posted once (Dr 2200 40,000, Cr 1120 40,000) with the break closed; a replay answers the same; a second payout refused. The maker recording a payout refused. A retried refund paid once with its break closed. Wrong roles refused; the trial balance 0. **Passed.**

`test/integration/ord/sale-posting.integration.spec.ts` (the owner's A-208 (f) condition): every cleared payment of the trading day is allocated in full to a numbered RECEIPT or INVOICE, none unlinked, no deposit left. **Passed.** `test/contract/b9/payments.contract.spec.ts`: every new operation's responses, refusals and the 503 in the contract's shapes. **Passed.**

### Receipt links, said plainly (the owner's condition)

A counter or wholesale sale's payments are allocated in full to its numbered receipt in the sale's transaction (proved). A mobile money deposit in 2200 is linked to a numbered document only once it is allocated: until then it is linked through its order (`SO-...`, numbered when ORD places it, B09a continued 2), or, taken without an order, only by its customer and `listPayments?unallocatedOnly=true`; money held unmatched is also on the break queue. No such deposit exists on the seeded trading day.

## Decisions

- **ADR-0063** (proposed): the webhook's order, the one clearing path fed by the webhook, the lookup and the sweep, `pay.DepositAllocated`'s mirror row, `pay.RefundPaid`, every refund approved. It extends ADR-0003's matrix with the mirror of an existing row and contradicts no ADR. No stop.

## Deferred

- **B09a continued 1b (A-211):** `recordPayment`, `clearCheque`, `reversePayment`, store credit, refunds against a credit note, `listOpenItems`, settlement reports and bank statements with matching, the break endpoints with their approved postings; `pay.ProviderSettled`, `pay.ChequeCleared`, `pay.PaymentReversed`; 1100, 1130, 2210, 2290, 6910.
- **B09a continued 2:** `cancelOrder` calls `releaseChargeIn`; an order confirms on `pay.PaymentCleared` only when not `heldAsUnmatched`; the cancelled-order webhook proved again through `cancelOrder`.
- **B12:** the daily exception report reads `pay.WebhookRejected`, `pay.RefundRequested` and `pay.ReconciliationBreakRaised`. **B13:** breaker and provider-call metrics. **Before go-live (A-064):** one sandbox run with the owner's test key.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`072345d`); it lists CR-001 to CR-029. New since the last report: CR-027, CR-028, CR-029.
- **CR-027** (a processing reversal's approval names its order), **CR-028** (`getShopProfile`, anonymous contact details) and **CR-029** (`Cart.checkoutId`): **placed by the owner on 2026-11-16** (PR #61, merged into this branch from `main`): CR-027 and CR-028 in B09x, CR-029 in B09a continued 2. Not done here, as scheduled; none touches PAY.
- **CR-005 and CR-023:** scheduled by the owner in B09x. **CR-013:** the sales figures are B09a continued 2's. Others answered in earlier phases; nothing new asked of PAY.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,322 passed** (new: `pay/domain/charge`, `refund`, `webhook`, `time` specs, `tender` additions, `platform/payments/resilient-provider.spec.ts`, five FIN amount cases, one config case) |
| Integration | **1,309 passed** (new: `pay/payment-edge-cases` 24, `pay/refunds` 15, one `ord/sale-posting` case) |
| Coverage, merged (`pnpm test:coverage`) | **2,631 passed**, 217 files, exit 0. Statements 93.65 percent, branches 83.37 percent (gate 80). Every 100 percent gate held, `src/modules/pay/domain/**` included. |
| Contract | **92 passed** (new: `b9/payments`); `contract:generate --check` up to date (384 from code, 251 planned); Redocly clean |
| Lint, typecheck | Clean |
| End to end | CI only |

**Test first, honestly:** the domain specs and FIN's amount cases were run red before their code (missing modules, then five failing cases). The integration specs were written before the endpoints had run and failed first: 13 of 24 edge cases on the first run, on two real faults (a stale signed delivery took the event's unique key and blocked the genuine one, so the key now covers only events that reached processing; sessions expiring as the test clock ran for hours, given a 12-hour access token in the tests) and on the tests' own mistakes (a timed-out charge is retried and answers PENDING, not 503; a replay must send the same client id; the webhook log refuses update by privilege before its trigger). The refund spec failed twice on its own mistakes (a column name; a refusal list). Earlier tests changed on purpose because this phase made them stale: `bil/archive-link-rollback` (walks 0168 back), `iam/authentication` (the Cashier's four PAY permissions), `iam/authorisation` (13 operations and their valid bodies), `ord/order-payment-rules` (a mobile money payment written CLEARED is now refused first by the stronger `ck_payment_provider_confirmed`; `ck_payment_verified` is still proved with an unverified cash tender), the contract drift count and the request schema map. No flaky test seen; nothing skipped, loosened or retried; no database rule of B9a weakened.

## Gate

**Passed:** every payment edge case of the brief, test-first with exact amounts; a webhook accepted only signed, in its window, once by reference and re-verified; every PAY write built refuses the wrong role; B9a's sale posting proofs still green. **Split (A-211):** manual receipts, cheques, store credit, reversals and reconciliation are B09a continued 1b's.

## Notes for the frontend track

- Contract 1.42.0: payments, mobile money, the unmatched queue, allocation and refunds are live. Treat `PENDING` as a state: poll `getPayment` or call `checkPaymentStatus`; a 503 on initiation means take cash.
- `requestRefund` is always 202 (a different approver with step-up); `markRefundPaid` needs `externalReference` and a step-up, and is refused to the refund's maker.

## CI

- **`f7d51d3`** (the code, before `main` moved): run **43904872144 (push)**, completed, success. No `pull_request` run existed for it: the pull request was in conflict with `main` (the owner's PR #61 had changed the same two documents), so GitHub ran none; that commit is not called green on the pull request's side.
- **Green, the code head `1339557`** (`main` merged in, the ADR-0026 and openers conflict resolved by keeping both): run **43906620001 (push)** and run **43906632051 (pull_request**, the one that compares the contract with `main`), both completed, success. No red run on this branch; nothing was re-run.
- The runs on the final head (this report's commit) are named in the session's closing message: a commit cannot name its own runs. The pull request (#62) is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued 1b, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2-payments-provider.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, ADR-0003, ADR-0014, ADR-0017,
ADR-0056 and ADR-0063, the abuse cases 4 and 12 in docs/security/THREAT_MODEL.md, docs/runbooks/reconciliation-break.md,
and A-200, A-208, A-210 and A-211 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review,
hakorem-endpoint, hakorem-migration, hakorem-runbook and hakorem-tests. Use docs/prompts/module-build-prompt.md as the
recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 1b only, on branch b09a2b-payments-reconciliation, branched from main: the remaining PAY
permissions and grants; recordPayment (cash into a named till or with a driver, bank transfer PENDING until a matched
statement line, cheque PENDING in 1130, store credit, never mobile money or card); clearCheque (clear or bounce);
reversePayment with PAYMENT_REVERSAL approval by a different person, posting the exact mirror (pay.PaymentReversed);
store credit as a ledger of entries in 2210 (getCustomerStoreCredit, getMyStoreCredit, refunds to store credit,
redemption as a tender never beyond the balance); a refund against a credit note (Dr 1200); listOpenItems;
importSettlementReport, matchSettlementReport (pay.ProviderSettled: 1100, 6910, 1120), importBankStatement,
matchBankStatement and matchBankStatementLine; listReconciliationBreaks, getReconciliationBreak and
resolveReconciliationBreak with its posting through approval (2290 and the deposit or refund paths). PAY's remaining
◆ events in fin.posting_event_type with their determinations (1100, 1130, 2210, 2290, 6910), each with an
exact-amount matrix test (ADR-0056). Write every money rule test-first.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a2b-payments-reconciliation.md, and merge into main when every run on the pull
request is green.
```
