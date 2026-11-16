# B9a: the order record, payments and the sale posting, proved in one transaction

Date: 2026-11-16 · Branch `b09a-order-core-payments`, from `main` (`c6e3a5a`) · PR #60 · Status: **the sale posting gate passed and is merged before anything is built on it, as the owner asked; the phase split after it (A-209).** The remainder is **B09a continued** (payments: the provider port, webhooks and every payment edge case) and **B09a continued 2** (the order endpoints, voids, returns, online placement and the dashboard's sales figures), both before B09x.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-208 | **The sale posting as built, each the most conservative reading.** (a) `SalePosting.postIn` posts in its caller's serializable transaction and authorises nothing (like `Billing.issueIn`); the caller declares `locksFor` (the branch's `SALES_ORDER`, `RECEIPT` and `JOURNAL` series); the order's client id is the idempotency key (`ord.postSale`, per person): a replay answers the first sale, a different request or another person's use of the id is 409 `IDEMPOTENCY_KEY_REUSED`. (b) It posts `ONLINE` and `WHOLESALE` sales fulfilled at once (`COUNTER`, `COLLECTION`) on `IMMEDIATE` terms as a RECEIPT on today's business date, carrying the sale's `occurredAt` (B9b's offline rule, A-200, stays open); `POS` (needs its shift; the database already refuses a POS order without one), `QUOTE` (B10) and `DELIVERY` (B11) are refused. (c) Every line is priced by the engine; unpriced is `QUOTE_REQUIRED`; until per-shift role limits exist (B9b) the allowance below list is **nothing**, so any price below list or outside the band is `PRICE_OVERRIDE_NEEDS_APPROVAL` (no approval taken yet); a price above list within the ceiling needs a `PRICE_OVERRIDE` reason without a required note, and posts to 4210. (d) Every completed line has its movement or exception, so `NON_STOCK` products are not sold on order lines; a lot-tracked product names its lot; a named reservation is checked and consumed whole. (e) Tenders are cash only, cleared at once into a till the caller names (id and code; B9b's registers supply them), `CASH` (POS, WHOLESALE) or `COD` (ONLINE, here at collection; B11 lands it with the driver), summing to the receipt's gross exactly; mobile money and card are `PAYMENT_METHOD_REQUIRES_VERIFICATION`; only cash's TENDER determination (1000) is seeded. (f) A payment is an unnumbered `PAYMENT` document; BIL's `bil.document_settlement` moves only through `bil.apply_settlement` via `Billing.settleIn` (A-200), so `pay.invoice_settlement` is not built; `pay.payment` adds `register_code`. (g) Not yet: `ord.sales_order_adjustment`, `delivery_id`, the order and payment endpoints. | Owner (b, c, e), Accountant (f) |
| A-209 | **B9a split after the sale posting gate (ADR-0026 Amendments).** The remainder is B09a continued (`b09a2-payments-provider`) and B09a continued 2 (`b09a3-orders-online`), in that order, both before B09x; their openers are in `docs/prompts/session-openers.md`. | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B9a, the order core and payments (`b09a-order-core-payments`, from `main` at `c6e3a5a`).
2. **Scope:** the sales order and its state machine, the sale posting service (stock, billing document and payment in one serializable transaction), payments and allocations first; then, if it fits, payment edge cases, the provider port and webhooks, refunds, returns, voids, online placement and the dashboard figures.
3. **Gate:** every payment edge case in the brief passes, and an order on any channel posts stock, document, payment and ledger in one transaction.

**Why the split.** The owner asked for the first real sale to be proved and merged before anything is built on it. That slice alone needed two new modules (ORD and PAY), five migrations, ports in MDM, INV, BIL and FIN, and the failure-injection, concurrency, replay and trading-day proofs. The rest of the opener (PAY's provider port, webhooks, every edge case, refunds and reconciliation; ORD's endpoints, voids, returns, override approval and online placement; RPT's figures) is two sub-domains of its own, each large enough to need a fresh context to reach a gate. Starting either here would have handed the next session half a module.

## Contract changes

**None.** No operation was added or changed (`contract:generate --check`: up to date, 371 operations from code, 264 planned; Redocly clean). The service is reached through operations of later phases: `completeCounterSale` (B9b), the order endpoints and online placement (B09a continued 2). `docs/API.md` lists the new error codes `SALE_INVALID` and `PAYMENT_INVALID` and what was built.

## Built

| Area | What |
| --- | --- |
| Migrations | 0159 (`platform.document_type` `SALES_ORDER`, numbered `SO`, and `PAYMENT`, unnumbered); 0160 (`pay.payment`, `pay.payment_allocation`: `ck_payment_verified`, `ck_payment_cash_holder`, `trg_payment_guard`, the allocation cap trigger); 0161 (`bil.apply_settlement`, `ck_document_settlement_outstanding`); 0162 (`pay.PaymentCleared` with its three rules, the cash TENDER determination to 1000, `uq_journal_entry_payment`); 0163 (`ord.sales_order`, `ord.sales_order_line`, `ord.order_status_history`: the machine, the line rules, the deferred completion check). Each rolls back (proved by `bil/archive-link-rollback`, which now walks 0163 to 0155 back and applies them again). |
| ORD (new, layer 9) | Domain: the thirteen-status machine (`canMove`), `judgeTenders` (immediate terms settle the gross exactly) and `paymentStatusOf` (FR-ORD-016), under a 100 percent gate. Application: `SalePosting.postIn` and `locksFor`; `ord.OrderCompleted` (outbox); errors `SALE_INVALID`, `QUOTE_REQUIRED`, `PRICE_OVERRIDE_NEEDS_APPROVAL`. Infrastructure: `PgOrderStore`. |
| PAY (new, layer 7) | Domain: clearing by method and `planTender` (allocated and deposit), under a 100 percent gate. Application: `Payments.recordIn` (cash cleared at once into a named till, allocations as ledger rows, BIL's settlement through `Billing.settleIn`), ◆ `pay.PaymentCleared` declared for the boot assertion; errors `PAYMENT_INVALID`, `PAYMENT_METHOD_REQUIRES_VERIFICATION`. |
| FIN | `paymentClearedAmounts` (tender by method kind against its till, allocated off 1200 and unallocated into 2200 against the customer, refusing parts that do not sum to the tender) and its translator. |
| BIL | `Billing.settleIn` and `AllocationExceedsOutstandingError` (`ALLOCATION_EXCEEDS_AVAILABLE`). |
| MDM, INV | `MasterDataRefs.paymentMethodsByCodeIn` and `paymentMethodsIn`; `Reservations.heldIn`. |
| Docs | A-208, A-209; ADR-0026 amendment; openers (B9a marked; B09a continued and B09a continued 2 inserted; B09x reads B09a continued 2's report; reference table); ORD, PAY and BIL cards; `ord.md`, `pay.md`; `API.md`; SRS traceability for FR-ORD-002 to 004, 006, 007, 016 and FR-PAY-002, 009. |

## The gate, proved by running it

`test/integration/ord/sale-posting.integration.spec.ts` (real PostgreSQL, the seeded farm, every journal posted by FIN's handlers):

1. **One transaction, proved by failure injection.** The day's first sale (goat G-0142 by tag, 2 crates of eggs from their lot, 3 cabbages, 3.500 kg of goat meat weighed at the scale, two cash tenders) fails in turn after the stock issue, after the receipt, after a payment, after every journal (transactional subscribers registered after FIN's, so each step and its journal are written before the throw) and **at commit** (a deferred constraint trigger refusing at COMMIT). Each time a footprint of fifteen tables (registry, number allocations, idempotency keys, outbox, audit, movements, billing documents and lines, payments, allocations, journal entries and lines, orders, lines, history), every series' next value, every stock balance and reservation state and every stock unit's status is **identical before and after**: no movement, no reservation consumed, no document, the receipt and order numbers back in their series, no payment or allocation, no journal, no outbox message, no audit row. A sale consuming a checkout's reservation that fails after its payment leaves the reservation ACTIVE; the same sale then succeeds and consumes it. **Passed.**
2. **Then it succeeds with every part at exact amounts.** Wholesale list prices: goat GOAT-M 58,500 (65,000 less 10 percent), eggs 6,000, cabbage 1,000, goat meat 1,980 a kg (6,930 for 3.500 kg); receipt gross 80,430; tenders 50,000 and 30,430, both CLEARED and allocated; order COMPLETED and PAID, `SO-<year>-DDW-<n>`, receipt `RCP-<year>-DDW-<n>`. Exactly 1 order, 4 lines, 2 history rows, 4 movements, 1 receipt, 2 payments, 2 allocations, 7 journal entries. The receipt's journal from SQL: Dr 1200 80,430 (Walk-in customer); Cr 4000 58,500; Cr 4020 12,000 and 3,000; Cr 4010 5,775; Cr 2100 VAT 866, NHIL 145, GETFund 144 (the inclusive 6,930 split by `allocate`). Each payment: Dr 1000 against till T1, Cr 1200 against the walk-in party. Each issue's cost of sales equals its movement's value exactly (the goat its whole cost pool; the eggs half_up(105,000 × 2 / 30) = 7,000; the cabbages 1,500). The settlement summary, written through BIL: allocated 80,430, outstanding 0, PAID. One audit event and one `ord.OrderCompleted`. Receipt numbers stay contiguous across the failed attempts. **Passed.**
3. **Concurrency.** Two tills selling goat G-0143 at once: exactly one sale, one SALE_ISSUE movement, the other refused 422. Two sales of the last cabbage at once: one succeeds, the other `INSUFFICIENT_STOCK`; no physical location below zero. **A serialization failure is retried:** a sale of G-0144 is held open before commit while a second sale of the same goat, without the series locks, takes its snapshot; when the first commits the second fails with 40001, the unit of work re-runs it (attempts 1 and 2 recorded), and the retry is refused because the goat is sold. **Passed.**
4. **Idempotent replay.** The same order id and request answers the first sale unchanged with the footprint unchanged; a different request under the same id, or the same id sent by another person, is 409 `IDEMPOTENCY_KEY_REUSED`, posting nothing. **Passed.**
5. **A trading day still ties.** After the day's sales (wholesale, an online collection paid by COD, the races above): the trial balance sums to exactly 0; the nightly reconciliation reports signed sum 0, no unbalanced entry and no break between the stock subledger and the inventory accounts; cost of sales (50xx) equals the value of every SALE_ISSUE movement exactly; the sales' receivables net to 0. **Passed.**
6. **Any channel:** `WHOLESALE` and `ONLINE` post through the one path today; `POS` (B9b) and `QUOTE` (B10) call the same `postIn`. **Every payment edge case of the brief: not built here (A-209), B09a continued's gate.**

`test/integration/ord/order-payment-rules.integration.spec.ts`: a price below list (BEYOND_ROLE_LIMIT) or outside the band (OUTSIDE_BAND) is `PRICE_OVERRIDE_NEEDS_APPROVAL`; above list within the ceiling needs its reason and posts Cr 4210 1,500 beside sales at 58,500; a quote-only ram is `QUOTE_REQUIRED`; POS, QUOTE, DELIVERY, no lines and no tenders are refused together; two goats on a line and a lot product with no lot are refused; tenders one pesewa short or over are refused; MOMO and CARD are `PAYMENT_METHOD_REQUIRES_VERIFICATION`; cash without a till and a method closed to the channel are `PAYMENT_INVALID`. By direct SQL as `hk_app`: a completed order moved anywhere but VOIDED, its total or lines changed, or its history deleted, is refused; a status outside the machine is refused even with triggers off; an order written COMPLETED, a POS order without a shift, agreed 75,000 on floor 80,000 unflagged (FR-ORD-003's case), a goat line of two or with no animal, and a flagged line without approval past PLACED are refused; a cleared payment's amount or a move back to PENDING is refused; a mobile money payment written CLEARED without the provider is refused; an allocation beyond the payment and a settlement beyond the outstanding are refused; `pay.PaymentCleared` with nothing allocated posts Dr 1000 120,000 (T2), Cr 2200 120,000 (Tema Cold Store Ltd). **Passed.**

## Mutation checks (run, then removed; never committed)

| Mutation | Went red |
| --- | --- |
| M1 the stock issue and receipt committed before the tenders (`COMMIT; BEGIN` after `Billing.issueIn`) | 6 tests, among them "fails after payment", "after journals", "at commit", the reservation test and the exact-amount test |
| M2 a payment committed outside the sale (`COMMIT; BEGIN` inside `Payments.recordIn`) | "fails after payment", "fails after journals", "at commit" |
| M3 the stock issue committed before the receipt (`COMMIT; BEGIN` after the issue loop) | "fails after billing", "after payment", "after journals", "at commit" |

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS item by item)

Boundaries: the back office and the POS device (through B9b's caller), the database. No endpoint, upload, export, login or webhook is added, so those groups have nothing to check here (each lands with its operation in B09a continued and continued 2). **Money paths:** no code path records mobile money or card as cleared from a caller (service and `ck_payment_verified`, proved by direct SQL); amounts are recomputed on the server (the engine's prices, BIL's levies, tenders judged against the issued gross); idempotency by the order's client id with a unique key; no external call inside the transaction; allocations bounded by the payment and the document in the database. **Price overrides (abuse case 3):** no override below list is possible without an approval, which is not built, so no new abuse path opens; the exception report's `PRICE_OVERRIDE` items arrive with the approval (B09a continued 2, B12). **Authorisation:** `postIn` authorises nothing by design; every caller to come authorises in its handler (recorded in A-208 and in both continuation openers). **Data:** no personal data in the audit `after` (the sale view carries no contact name or phone) nor in `ord.OrderCompleted`; no payment identifier in logs. **Database:** every new table declares its class with grants by class (the schema test passes); LEDGER tables reject update and delete; `hk_app` has no delete on any. No finding open.

## Decisions

- No new ADR: the sale posting follows ADR-0010 (commands down, one transaction) and ADR-0014; the settlement through `Billing.settleIn` is A-200's reading, recorded in A-208 (f). The split is in ADR-0026's Amendments. No ADR conflict; no stop.

## Deferred

- **B09a continued (A-209):** PAY's endpoints and permissions, the provider port and the Paystack adapter (a local fake if the sandbox is unreachable; never a live endpoint), webhook verification, every payment edge case of the brief, deposits and `pay.DepositAllocated`, unmatched payments, refunds, store credit, reversals, cheques, settlement and bank reconciliation, PAY's remaining ◆ events.
- **B09a continued 2 (A-209):** the order endpoints and permissions, confirmation, cancellation, voids, returns, override limits and approval, `issueProforma`, online placement and payment, the dashboard's B9a figures and tiles, a seeded trading day of sales.

## Contract requests

The frontend's `main` was fetched on 2026-11-16 (`035f736`, the same commit 2c read); it lists CR-001 to CR-026 and nothing new.
- **CR-005 and CR-023:** scheduled by the owner in **B09x** (after B9a's splits); not done here.
- **CR-013:** the sales figures are B09a continued 2's (the owner dashboard's B9a fields stay pending until then); the invoices tile needs payments (B09a continued).
- **CR-001 to CR-004, CR-006 to CR-012, CR-014 to CR-022, CR-024 to CR-026:** answered in earlier phases; nothing new is asked.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,281 passed** (new: `ord/domain/order.spec.ts` 9, `pay/domain/tender.spec.ts` 7, five `pay.PaymentCleared` cases in `fin/domain/event-amounts.spec.ts`) |
| Integration | **1,269 passed** (new: `ord/sale-posting` 16, `ord/order-payment-rules` 16; lists extended on purpose in `bil/archive-link-rollback`, `fin/posting-rules`, `platform/database-roles`) |
| Coverage, merged (`pnpm test:coverage`) | **2,550 passed**, 210 files, exit 0. Statements 93.79 percent, branches 83.54 percent (gate 80). Every 100 percent gate held, with two new ones: `src/modules/ord/domain/**` and `src/modules/pay/domain/**`. |
| Contract | **89 passed**; `contract:generate --check` up to date (371 from code, 264 planned) |
| Lint, typecheck, Redocly | Clean |
| End to end | CI only |

**Test first, honestly:** the unit specs (`ord/domain/order`, `pay/domain/tender`, FIN's payment amounts) were run red before their code; the integration specs were written before the service ran against them and failed first on real faults: the optimistic lock (`platform.touch_version`) refusing the allocation trigger's update of the payment and the completion update of the order (fixed by moving the version), the serialization test's own race (the second sale reaching the goat before the first was held; fixed by waiting for the hold), and three expectations of the test itself (two goats left, not one; virtual locations run below zero by design; the state guard refusing before the check constraint). Three earlier tests named things B9a made real and were changed on purpose: `bil/archive-link-rollback` now rolls 0163 to 0155 back; `fin/posting-rules` names `shp.CartViewed` as the event nobody posts (it was `pay.PaymentCleared`); `platform/database-roles` uses the migrated `ord.sales_order` instead of creating a stand-in schema. No flaky test seen; nothing skipped, loosened or retried.

## Gate

**The sale posting half passed and is merged:** an order on any channel B9a admits posts stock, document, payment and ledger in one transaction, proved by failure injection at every step with mutation checks, by concurrency with a retried serialization failure, by replay and by a trading day that ties. **Split (A-209):** every payment edge case of the brief is B09a continued's gate; the order endpoints and online placement are B09a continued 2's.

## Notes for the frontend track

- No contract change. The counter sale arrives with B9b (`completeCounterSale`), the order screens with B09a continued 2, payments with B09a continued.
- What the counter will see: a price below list needs a manager until B09a continued 2 builds override approval (`PRICE_OVERRIDE_NEEDS_APPROVAL`); tenders must add up to the receipt's total exactly; mobile money is never marked paid by hand.

## CI

- **Green, the code head `6e01372`** (every commit of the phase but this report): run **43881121266 (push)** and run **43881165481 (pull_request**, the one that compares the contract with `main`), both completed, success. No red run on this branch; nothing was re-run.
- The runs on the final head (this report's commit) are named in the session's closing message: a commit cannot name its own runs. The pull request (#60) is merged with a merge commit only once every run on its head is green.

## Next session

B09a continued, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9a row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09a-order-core-payments.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PAY requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pay.md,
the PAY, BIL and FIN cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL section 5.9, the sale posting sequences in
docs/ARCHITECTURE.md section 7, ADR-0003, ADR-0010, ADR-0014, ADR-0021 and ADR-0056, the abuse cases 4, 5 and 12 in
docs/security/THREAT_MODEL.md, the webhook section of docs/security/SECURITY_ARCHITECTURE.md, and A-200, A-208 and
A-209 in docs/ASSUMPTIONS.md. Load hakorem-money, hakorem-ledger, hakorem-security-review, hakorem-endpoint,
hakorem-migration, hakorem-runbook and hakorem-tests. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09a continued only, on branch b09a2-payments-provider, branched from main: PAY's permissions and
grants; recordPayment (cash, bank transfer and cheque pending in 1130, never mobile money or card cleared by hand),
getPayment, listPayments, allocatePayment and unallocatePayment through Payments and Billing.settleIn; the provider
port with the Paystack adapter (no secret in the repository; if the sandbox host is unreachable, a local fake that
implements Paystack's documented API, and never a live endpoint), initiateMobileMoneyCharge outside any business
transaction with a timeout, bounded retry with jitter and a circuit breaker, checkPaymentStatus and the status
lookup worker; receivePaymentWebhook with signature, timestamp window, replay cache and amount re-verification,
never trusting the webhook's amount, and the rejection log; deposits held in 2200 and pay.DepositAllocated,
unmatched payments in 2290, refunds with approval above the automatic limit, markRefundPaid and retryRefund, store
credit, reversePayment, cheque clearing, and settlement and bank statement matching with the break queue, as far as
the gate needs; PAY's remaining ◆ events in fin.posting_event_type with their determinations (1110, 1120, 1100,
1130, 2210, 2290, 6910), each with an exact-amount matrix test (ADR-0056). Write every payment edge case test-first.
If it does not fit, split at a sub-domain boundary (settlement and bank reconciliation last) after the webhook and
edge-case gate is proven and merged.
Stop at the gate, write docs/sessions/B09a2-payments-provider.md, and merge into main when every run on the pull
request is green.
```
