# B09a continued 1d: the refund against a credit note and the cheque's bank payout

Date: 2026-11-16 · Branch `b09a2d-payments-credit-refunds`, from `main` (`01a885e`; `main` merged in at `c19ec6c` for the cheque test fix and B09r) · Pull request #68 · Status: **gate passed.** No split.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-216 | **The refund against a credit note and the cheque's bank payout as built (ADR-0066), each the most conservative reading.** (a) A credit beyond what is outstanding is issued and leaves the money owed back on the original: one balance per document (gross less credited less allocated plus refunded), `outstandingPesewas` above zero and `refundablePesewas` below; a document that owes money back takes no allocation; no refund is created automatically. (b) A refund against a credit note holds its amount from the request (released on rejection), never beyond the credit note's gross less what is held against it nor beyond what its original owes back (`ck_credit_note_refund_cap`, under the credit note's row lock), and goes back only through a CLEARED payment of the same customer and branch whose net allocation to the credited document covers every credit note refund that payment carries (stricter than per document). It leaves the payment's `refunded_pesewas` alone. (c) The approver is neither the refund's maker nor the credit note's maker (`created_by`); recorded once as `approved_by`; 422 `MAKER_CANNOT_CHECK`. (d) `creditRefund`: Dr 1200 against the customer, Cr the tender. (e) A cheque to its original method is a bank payout out of the account it was paid into, paid by hand with its reference by someone other than the maker, tender `BANK_TRANSFER` (Cr 1100); never sent to the provider. (f) `pay.RefundRequested` names the credit note and its maker. | Accountant (a, b, d, e), Owner (b, c) |
| A-215 | Closed: built here. | Owner (done) |

Still open, proceeded on as stated: A-033, A-034, A-062, A-064 (the real Paystack sandbox run, the first item of B09a continued 2, unchanged), A-182 to A-207, A-209, A-211, A-213, A-214, A-216.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 1d (`b09a2d-payments-credit-refunds`, from `main` at `01a885e`).
2. **Scope:** a credit note on a paid document; `requestRefund` with `creditNoteId`, capped in the database under the credit note's lock and proved under concurrency; the approver other than both makers, with step-up; ◆ `pay.RefundPaid` Dr 1200 Cr the tender with its rule and exact-amount tests; a cheque refunded to its original method through a bank payout; the frontend's contract requests.
3. **Gate:** a credit note on a paid document is issued and a refund against it posts Dr 1200 against the customer and Cr the tender; the refund never exceeds the credit note's amount less what was already refunded against it, held by the database, and two refunds of the last amount at once leave exactly one; the refund is approved with step-up by someone other than its maker and other than the credit note's maker; a cheque is refunded to its original method through a bank payout; the trial balance still sums to zero; every write refuses the wrong role.

## Contract changes

**1.45.0, minor, additive; no existing shape changed, nothing a client sends made required.** No operation moves into code (402 from code, 233 planned). `Settlement` (on `BillingDocument`) gains `refundedPesewas` and `refundablePesewas`, always sent. `Refund.creditNote` is now filled. `requestRefund` accepts `creditNoteId` (it was `REFUND_INVALID`, `CREDIT_NOTE_NOT_AVAILABLE`) and a cheque to `ORIGINAL_METHOD` (it was `DESTINATION_NOT_AVAILABLE`). New error code `REFUND_EXCEEDS_CREDIT_NOTE` (422). A refund approved by the credit note's maker is 422 `MAKER_CANNOT_CHECK`. `requestRefund`'s 202 example subject is a `REFUND`. Planned POS shapes for CR-031 and CR-032 point 1: `OfflineProduct.taxInclusive`, `SyncResultItem.grossPesewas` (nullable) and `currency`, and `CASH_MOVEMENT` reasons in the `getOfflinePack` example. `contract:generate` is up to date, Redocly is clean, and the versioning check passes. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` record the changes.

## Built

| Area | What |
| --- | --- |
| Migrations | **0182** (BIL): `bil.document_settlement.refunded_pesewas` and `refundable_pesewas`; `document_settlement_keep` and `apply_settlement` keep one signed balance (a credit beyond outstanding is no longer refused; an allocation to a document that owes money back is); `bil.credit_note_refund(id, amount, HOLD/RELEASE)` under the credit note's row lock (`ck_credit_note_refund_cap`, not granted to `hk_app`) and `bil.credit_note_facts(id)`, both published (ADR-0047, `tooling/architecture.json`). **0183** (PAY): `pay.refund.approved_by` (`ck_refund_approved_by`), `ix_refund_credit_note`; `trg_refund_cap` (now SECURITY DEFINER) holds a credit note refund through BIL and requires a payment that paid the credited document (`ck_refund_credit_note_payment`), releasing it on rejection; `trg_refund_guard` records the approver and refuses the credit note's maker (`ck_refund_credit_note_checker`). **0184** (FIN): `pay.RefundPaid` amount key `creditRefund` (Dr 1200 customer, Cr tender by `PAYMENT_METHOD_KIND`). Each migration rolls back: `bil/archive-link-rollback` walks 0184 back to 0155 and applies them again. |
| PAY | Domain (100 percent gate): `judgeRefund` with `CreditNoteFacts` (`REFUND_EXCEEDS_CREDIT_NOTE`, `CREDIT_NOTE_NOT_AVAILABLE`) and the route `BANK_PAYOUT` for a cheque. Application: `Refunds` reads the credit note through `Billing.settleableIn`, refuses the credit note's maker in the `REFUND` handler, and names the credit note on the view and the events. ◆ `pay.RefundPaid` carries `creditNoteId` and `bankAccountId` (tender `BANK_TRANSFER` for a bank payout); `pay.RefundRequested` carries `creditNoteId` and `creditNoteMakerId`. |
| BIL, FIN | BIL: `creditRefundableOf` (domain); the settlement view's two new fields; `Billing.settleableIn` adds the original, the maker and what is left to refund. FIN: `refundPaidAmounts` (`creditRefund`, a bank account's party for a bank payout) and the handler's bank account lookup. |
| Docs | ADR-0066 (proposed); A-216, and A-215 closed; ADR-0003's applied note; ADR-0026 Amendments; the ADR index; `pay.md`, `bil.md`, the PAY, BIL and FIN cards, DOMAIN_MODEL 5.9 (an invariant row and the events), `API.md` (PAY and the error code), `CONTRACT_CHANGELOG.md`, the SRS trace for FR-PAY-012, THREAT_MODEL row 12; openers: 1d marked built, B09a continued 2 reads A-216 and ADR-0066, and CR-031 and CR-032 added to B9b. |

## The gate, proved by running it

`test/integration/pay/credit-note-refunds.integration.spec.ts` (14 tests, real PostgreSQL, the seeded farm, Paystack's local fake):
- **A credit note on a paid document:** an invoice of 86,240 to Tema Cold Store, paid in full by mobile money and allocated (`PAID`), credited 30,000 by the Accountant and approved by the Manager with step-up. The credit note is issued and posts **Dr 4200 30,000, Cr 1200 30,000 Tema**. The invoice then shows outstanding 0 and refundable 30,000; the credit note shows refundable 30,000. A further allocation to the invoice is refused by the database (`ck_document_settlement_outstanding`). **Passed.**
- **Approval:** a plain refund of the fully allocated payment is refused (`REFUND_EXCEEDS_PAYMENT`). 10,000 against the credit note is 202, held on the credit note (refunded 10,000, refundable 20,000), with nothing posted. `pay.RefundRequested` names the credit note, its maker and abuse case 12. The refund's maker (the Manager) and the credit note's maker (the Accountant), each with step-up, are refused with 422 `MAKER_CANNOT_CHECK`, and the refund stays pending. The Cashier is refused (403). The Owner past her step-up window gets `STEP_UP_REQUIRED`; with step-up she approves it, and `approved_by` is the Owner. Dispatched through the provider, it posts **Dr 1200 10,000 Tema, Cr 1120 10,000 Paystack** once; a second dispatch posts nothing. **Passed.**
- **The cap under concurrency:** two refunds of the last 20,000 at once (Cashier and Sales) give exactly one 202 and one 422 `REFUND_EXCEEDS_CREDIT_NOTE`. Two refunds stand, totalling 30,000; the invoice's refundable is 0. One pesewa more is refused over the API, and by direct SQL as `hk_app` (`ck_credit_note_refund_cap`). `hk_app` calling `bil.credit_note_refund` itself is refused (42501). By SQL, the credit note's maker approving the refund is refused (`ck_refund_credit_note_checker`). The Owner rejects the pending 20,000 and it is released (refunded 10,000, refundable 20,000). The 20,000 then goes to store credit, paid at once on approval: **Dr 1200 20,000 Tema, Cr 2210 20,000 Tema**. Another customer document's payment is refused (`REFUND_EXCEEDS_PAYMENT`, `REFUND_EXCEEDS_CREDIT_NOTE`), and so is a credit note id that is an invoice (`CREDIT_NOTE_NOT_AVAILABLE`). **Passed.**
- **A cheque's bank payout:** a 50,000 invoice is paid by a cheque that is then cleared, and credited 12,500. The Manager asks for 12,500 to `ORIGINAL_METHOD` and the Owner approves. The provider dispatch leaves it `APPROVED`. The Manager (its maker) recording the payout is refused (403 `MAKER_CANNOT_CHECK`); the Accountant without a reference is refused (`REFUND_INVALID`); with the reference `GCB-TRF-88120` it is paid: **Dr 1200 12,500 Tema, Cr 1100 12,500 GCB current account**. An unallocated cheque deposit of 7,500 paid back the same way posts **Dr 2200 7,500 Tema, Cr 1100 7,500 GCB**. **Passed.**
- **Wrong roles and the books:** the Storekeeper is refused a refund; the Cashier, Sales and the Storekeeper are refused a payout. **The trial balance sums to exactly 0, and the customer's 1200 balance ends exactly where it started.** **Passed.**

**The database cap is load-bearing:** with the two cap conditions in `bil.credit_note_refund` removed, five of the spec's tests went red (the direct SQL insert succeeded, the holds went past the credit note); restored, green. The concurrency case also stayed green without the cap, because serializable isolation and the application's check catch it; the lock and the cap are what hold it for a script at read committed.

Kept green: `test/integration/ord/sale-posting.integration.spec.ts` (A-208's receipt link), `test/integration/pay/receipts-reversals.integration.spec.ts` (store credit refused for the walk-in and for a customer with no phone), and every `pay`, `bil`, `ord` and `fin` integration spec (23 files, 314 tests before the merge of `main`). `test/contract/b9/credit-note-refunds.contract.spec.ts`: the billing documents with the new settlement fields, `ApprovalPending`, `Refund` with its credit note, `RefundPage` and the refusals, all in the contract's shapes. **Passed.**

## Decisions

- **ADR-0066** (proposed): the credit note leaves money owed back on its original; the refund draws on it through BIL's published function under the credit note's lock; neither maker approves; `creditRefund` Dr 1200; a cheque goes back by bank payout. It contradicts no ADR: ADR-0003's row already reads "Dr 1200 or 2200", ADR-0063's refund out of deposit is unchanged, and ADR-0060's settlement rule is extended, not reversed. No stop.

## Deferred

- No seed extension: refunds are asked for and approved by people, so the seeded day's trial balance is unchanged.
- The nightly comparison of `bil.document_settlement` with the payments ledger stays with B12's reconciliation work (A-200 (e)).
- CR-031 and CR-032 behaviour, and the decision on CR-032 point 2, go to B9b (its opener says so).

## Contract requests

I fetched the frontend's `main` on 2026-11-16 at `be34787`. It lists CR-001 to CR-032; two are new since the last report (CR-031, CR-032).
- **CR-031 (offline pack tax basis, sync result total): implemented in the contract.** `OfflineProduct.taxInclusive` is per product, because a pack can mix price lists. `SyncResultItem.grossPesewas` is nullable and comes with `currency`. Both are planned shapes; B9b fills them when it builds the pack and the sync.
- **CR-032 point 1 (`CASH_MOVEMENT` reasons in the pack): implemented.** This was an example change; B9b sends them.
- **CR-032 point 2 (the offline PIN verifier): not built here.** It is a design decision on B9b's offline unlock (OFFLINE_SYNC section 3, ADR-0016), so it goes to the B9b opener: B9b either adds an operation, or adds a statement to OFFLINE_SYNC that the device derives the verifier from the PIN typed at an online sign-in.
- CR-005, CR-023, CR-027 and CR-028 stay with B09x, and CR-029 and CR-013 with B09a continued 2, as the owner placed them. The others were answered in earlier phases.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,397 passed** (new: 8 credit note refund and bank payout cases in `pay/domain/refund`, 2 in `fin/domain/event-amounts`, 4 in `bil/domain/billing`) |
| Integration | **1,356 passed** (new: `pay/credit-note-refunds` 14) |
| Coverage, merged (`pnpm test:coverage`) | **2,753 passed**, 222 files, exit 0. Statements 93.57 percent, branches 83.33 percent (gate 80). Every 100 percent gate held, including `src/modules/pay/domain/**` and `src/modules/fin/domain/**` |
| Contract | **95 passed** (new: `b9/credit-note-refunds`). `contract:generate` is up to date (402 from code, 233 planned), Redocly is clean, and the versioning check against `main` passes |
| Lint, typecheck | Clean (locally eslint was run with `.claude/**` ignored: the parent session's worktree inside the checkout ran eslint out of memory and tripped the test placement check; CI has no such folder) |
| End to end | CI only |

**Test first, as it honestly happened:** `pay/domain/refund.spec.ts` (8 failing cases) and `fin/domain/event-amounts.spec.ts` (2 failing cases) ran red before their code. `bil/domain/billing.spec.ts`'s `creditRefundableOf` was written as I extracted the rule from the application layer, not red first. The integration spec was written after the application code. Its first run failed on its own expectations: IAM answers a maker approving with 422, not 403; and a refund through another payment names two refusals. Those expectations were corrected, and the PAY handler's refusal was aligned to IAM's 422. The database cap was then proved load-bearing by removing it, as described above. Tests changed on purpose because this phase made them stale: `pay/domain/refund.spec.ts` (a cheque to its original method is now a bank payout) and `bil/archive-link-rollback` (it walks 0184 back). No flaky test was seen; nothing was skipped, loosened or retried; no database rule was weakened.

## Gate

**Passed.** A credit note on a paid document is issued. A refund against it posts Dr 1200 against the customer and Cr the tender (1120 Paystack, 2210 store credit, 1100 GCB for a cheque). The database caps the refund at the credit note's amount less what was already refunded, and two refunds of the last 20,000 at once leave exactly one. The approval needs step-up and someone other than the refund's maker and the credit note's maker, refused in the handler and by the database. A cheque is refunded to its original method through a bank payout, paid by hand with its reference by someone other than its maker. The trial balance sums to zero, and every write refuses the wrong role.

## Notes for the frontend track

- Contract 1.45.0: show `settlement.refundablePesewas` on a credited paid invoice and on its credit note, and offer "refund against this credit note" (`requestRefund` with `creditNoteId`, choosing a payment that paid the invoice) up to that figure.
- `REFUND_EXCEEDS_CREDIT_NOTE` is new. A refund against a credit note cannot be approved by the credit note's maker (422 `MAKER_CANNOT_CHECK`): the approvals inbox should not offer it to them.
- A cheque refund to `ORIGINAL_METHOD` waits for `markRefundPaid` with the bank payout's reference.
- CR-031 and CR-032's planned fields are in 1.45.0. They are filled when B9b builds the pack.

## CI

- **`8c442ae`** (the code, the documents and `main` merged in; pull request #68 opened on it): run **43959870733 (push)**, completed, success; run **43959932042 (pull_request**, which also compares the contract with `main`), completed, success.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green. No run on this branch was red, and nothing was re-run.

## Next session

B09a continued 2, copied from `docs/prompts/session-openers.md`.

```text
Before anything else in this phase, the real Paystack sandbox run the owner moved into B9 (A-064, 2026-11-16).
The parent session obtains the owner's Paystack TEST key through the secure credential form before this phase
starts; the network proxy injects it for the Paystack host, so the key never appears in the repository, a log,
a test or a fixture (send a dummy bearer value; the proxy replaces it). Never use or ask for a live key (B13).
Write a sandbox suite, run on demand and never in CI (it needs the network and the owner's key): every edge case
B09a continued proved against the local fake, mobile money included (initialise, charge, verify, the transaction
list the sweep reads, refunds, a timeout retry reusing our reference), run against the real sandbox. Webhooks
cannot reach this machine; say so, and check the signature scheme against a captured sandbox payload if one can
be obtained. Report every place where Paystack's real behaviour differs from its documentation or from the fake,
and fix the fake (and the adapter, test-first) to match the real behaviour.
Also in the sandbox run (owner, 2026-11-16, ADR-0065): call Paystack's Settlements API (the settlements list and the
transactions inside a settlement) and report exactly what it returns, field by field, and whether it covers what the
settlement matching needs (our reference, the amount, the fee, the settlement date and id, the bank payout). The
settlement is to be read from that API, never from a dashboard CSV export. A sandbox account may hold no settlement:
say so plainly, and record what the empty answer looks like. Do not rewrite the matching here; that is B09r.
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a2d-payments-credit-refunds.md, or the
last report of its own splits).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (core) requirement block of docs/SRS.md and FR-RPT-001 (nothing else from the SRS),
docs/data-model/ord.md, the ORD, PAY, BIL and RPT cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 7,
ADR-0010, ADR-0021 and ADR-0026, the abuse cases 1, 3 and 12 in docs/security/THREAT_MODEL.md, and A-149, A-200,
A-201, A-208, A-209, A-210, A-211, A-212, A-213 and A-216 in docs/ASSUMPTIONS.md, ADR-0063, ADR-0064 and ADR-0066 (a void's refund is a reversal or a refund to store credit; returns use the refund against a credit note, built in B09a continued 1d). Load hakorem-pricing, hakorem-money, hakorem-stock, hakorem-ledger,
hakorem-documents, hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Use
docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued 2 only, on branch b09a3-orders-online, branched from main: ORD's permissions and
grants; createOrder, getOrder, listOrders, listOrderHistory, confirmOrder (reserving every line or staying PLACED
with the shortfall), cancelOrder (releasing reservations and requesting the refund in one transaction) and voidOrder
(a supervisor who is not the cashier, a credit note and reversing entries, every void on the exception report),
each test-first with its wrong-role refusal; returns against the original sale (createReturn, getReturn,
submitReturn, never more than sold less returned, by database trigger); price variance and override limits per
role with approval by a different user (PRICE_OVERRIDE_NEEDS_APPROVAL becomes an approval request); issueProforma
(POST /orders/{id}/proforma) on Billing.issueIn (A-201); online order placement and payment (placeOrder, trackOrder,
listMyOrders, getMyOrder) on B09a continued's provider port (cancelOrder
releases the order's pending charges through ProviderPayments.releaseChargeIn, an order confirms on pay.PaymentCleared
only when it is not heldAsUnmatched, and the webhook for a cancelled order is proved again through cancelOrder, A-210); and the owner dashboard's B9a figures (A-149): remove
`salesTodayPesewas`, `salesYesterdayPesewas`, `salesMonthToDatePesewas`, `salesByChannel`, `salesSeries` and
`topMovers` from RPT's PENDING_FIGURES and answer them from completed orders through a published view, and build
the planned tiles getSalesTodayTile and getSalesSeries, each test-first with its wrong-role refusal. Extend the seed
with a trading day of sales posted through SalePosting, keeping the B5 hand count and the trial balance tests true.
CR-029 (owner, 2026-11-16): `Cart.checkoutId` (uuid or null), the open checkout while the cart's status is CHECKOUT
and null otherwise, additive, so a second device or tab with the same cart cookie can open the checkout it is in;
test that it is null again once the checkout completes, expires or is abandoned, and never names another cart's.
If it does not fit, split at a sub-domain boundary after a proven, merged gate.
Stop at the gate, write docs/sessions/B09a3-orders-online.md, and merge into main when every run on the pull
request is green.
```
