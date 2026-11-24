# ADR-0003: Chart of accounts, and which business event posts which entries

- **Status:** Proposed (awaiting B0 gate; chart and matrix to be reviewed by the accountant before B8)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires a real double-entry ledger from which investor reporting is derived, automated postings from sales, purchases, stock movements and processing, a database constraint that no journal posts unbalanced, and an equity account per investor. It also requires that modules never reach into each other's tables.

The build schedule delivers the ledger in B8, after inventory (B5), livestock and processing (B6) and procurement (B7). Whatever mechanism posts to the ledger must therefore not require those earlier modules to import it.

## Options considered

1. **Each module holds account codes and writes journal lines.** Chart knowledge spreads across a dozen modules and the accountant cannot review one matrix.
2. **Each module calls a ledger posting function directly.** One place knows accounts, and a missing call fails to compile. But modules built in B5 to B7 cannot call a module that arrives in B8 without being reopened.
3. **Modules publish financial events; the ledger subscribes inside the same transaction and maps events to accounts.** Only the ledger knows accounts, earlier modules are untouched when it arrives, and the posting still commits or fails with the business change.

## Decision

Option 3, with two safeguards against a silently missing subscriber.

**Mechanism**

- A module that does something with a financial effect publishes a domain event (ADR-0010). The event carries named amounts and determinants, never account codes. Example: `inv.StockIssuedForSale { value_pesewas, gl_group, branch_id, source_document_id }`.
- The FIN module registers an in-transaction handler for every event listed in `fin.posting_event_type`. The handler builds a balanced journal from `fin.posting_rule` and `fin.account_determination` and writes it in the caller's transaction. If posting fails (closed period, missing rule, unbalanced result), the whole business operation rolls back.
- `fin.posting_rule` is effective-dated and changes only through a maker-checker approval.
- Safeguard one: at start-up, and in a CI test, FIN asserts that every event type flagged `posts_to_ledger` in the event catalogue has a handler and a complete rule set. A gap stops the application booting.
- Safeguard two: nightly reconciliation compares each subledger with its control account (stock value against inventory accounts, open invoices against receivables, cleared payments against cash accounts) and asserts the trial balance sums to zero.

**Journal shape**

- `fin.journal_entry` and `fin.journal_line` are insert-only. A line has `account_id`, `side` (`D` or `C`), `amount_pesewas > 0`, `branch_id`, and a `subledger_id` that is required exactly when the account has a `subledger_kind`.
- A deferred constraint trigger checks at commit that debits equal credits for every entry touched by the transaction.
- A trigger rejects any entry whose `posting_date` falls in a period that is not `OPEN`.
- A correction is a new entry with `reverses_entry_id` set (unique).

**Subledgers instead of an account per party**

Receivables, payables, investor capital, tax levies, tills, drivers and bank accounts are control accounts with a subledger. "An equity account per investor" is account 3000 with the investor as subledger: each investor has their own balance, statement and history, through the same mechanism as a customer's receivable. A new investor or a new levy needs no new account.

**Seeded chart**

Basis: perpetual inventory; livestock at accumulated cost (cost model); feed and veterinary cost capitalised onto growing animals and expensed for breeding stock.

| Code | Account | Subledger |
| --- | --- | --- |
| 1000 | Cash on hand, tills | Register |
| 1010 | Cash, safe | |
| 1020 | Cash held by drivers | Driver |
| 1100 | Bank accounts | Bank account |
| 1110 | Mobile money wallets | Bank account |
| 1120 | Payment provider clearing | Provider |
| 1130 | Cheques awaiting clearance | |
| 1200 | Trade receivables | Customer |
| 1300 | Inventory, feed and medication | |
| 1310 | Inventory, live animals | |
| 1320 | Inventory, meat | |
| 1325 | Inventory, offal and by-products | |
| 1330 | Inventory, produce and eggs | |
| 1340 | Processing work in progress | |
| 1360 | Inventory, packaging and supplies | |
| 1400 | Input VAT and levies recoverable | Tax levy |
| 1510 to 1540 | Fixed assets at cost: vehicles, cold rooms, housing, equipment | |
| 1590 | Accumulated depreciation | |
| 2000 | Trade payables | Supplier |
| 2010 | Goods received not invoiced | |
| 2020 | Accrued processing and other costs | |
| 2100 | Output VAT and levies payable | Tax levy |
| 2200 | Customer deposits and unallocated receipts | Customer |
| 2210 | Store credit | Customer |
| 2290 | Suspense, unidentified receipts | |
| 2300 | Distributions payable | Investor |
| 2310 | Withholding tax payable | |
| 2400 | Loans payable | Investor |
| 2410 | Accrued interest | |
| 2450 | Deferred grant income | |
| 3000 | Investor capital | Investor |
| 3100 | Retained earnings | |
| 3200 | Current year earnings | |
| 3300 | Distributions declared | Investor |
| 3900 | Opening balance equity | |
| 4000, 4010, 4020, 4030 | Sales: live animals, meat, produce and eggs, by-products | |
| 4100 | Delivery fee income | |
| 4200 | Sales returns and allowances | |
| 4210 | Price variance, overrides and negotiated prices | |
| 4220 | Promotional discounts | |
| 4910 | Grant income | |
| 5000, 5010, 5020, 5030 | Cost of sales: live animals, meat, produce and eggs, by-products | |
| 5100 | Mortality and cull losses | |
| 5110 | Shrinkage and stock adjustments | |
| 5120 | Wastage and expired stock | |
| 5140 | Purchase price variance | |
| 5200 | Breeding herd upkeep | |
| 5210 | Own production capitalised | |
| 6000 to 6800 | Operating expenses: wages, delivery and vehicles, utilities and cold chain, repairs, marketing, administration | |
| 6500 | Depreciation | |
| 6900 | Cash over and short | |
| 6910 | Payment provider fees | |
| 6920 | Bank charges | |
| 6930 | Interest expense | |
| 6940 | Bad debts | |

**Event-to-posting matrix**

Inventory accounts (`13xx`), sales (`40xx`) and cost of sales (`50xx`) are selected by the product's GL group. Tender accounts are selected by payment method. Levy lines are selected by levy.

| Event | Debit | Credit |
| --- | --- | --- |
| `inv.GoodsReceived` | 13xx | 2010 |
| `inv.ProductionReceived` (harvest, lay, at standard cost; no entry at zero) | 13xx | 5210 |
| `inv.OpeningStockLoaded` | 13xx | 3900 |
| `inv.CostCapitalised` (feed or medication onto growing stock) | 1310 | 1300 |
| `inv.UpkeepExpensed` (feed or medication for breeding stock) | 5200 | 1300 |
| `inv.StockConsumedInProcessing` | 1340 | 1310 or 1320 |
| `prc.DirectCostIncurred` | 1340 | 2020 |
| `inv.ProcessingOutputReceived` | 1320, 1325 | 1340 |
| `inv.StockIssuedForSale` | 50xx | 13xx |
| `inv.SaleReturnReceived` | 13xx | 50xx |
| `inv.StockWrittenOff` (mortality, cull, shrinkage, wastage, expiry, count loss) | 5100, 5110 or 5120 by reason | 13xx |
| `inv.StockGainRecorded` | 13xx | 5110 |
| `inv.StockTransferredBetweenBranches` | 13xx at receiving branch | 13xx at sending branch |
| `inv.SupplierReturnIssued` | 2010 | 13xx |
| `pur.SupplierInvoiceMatched` | 2010 at receipt value; 1400 per reclaimable levy; 5140 for an unfavourable price variance | 2000 gross; 5140 for a favourable variance |
| `pur.ExpenseInvoiceApproved` | 6xxx; 1400 per reclaimable levy | 2000 |
| `pur.SupplierCreditNoteRecorded` | 2000 | 2010 or 5140; 1400 |
| `pur.SupplierPaymentMade` | 2000 | 1100, 1110 or 1010 |
| `bil.InvoiceIssued` | 1200 at agreed gross; 4210 where agreed is below resolved; 4220 for promotions | 40xx at resolved net; 4100 delivery fee; 2100 per levy; 4210 where agreed is above resolved |
| `bil.CreditNoteIssued` | 4200 net; 2100 per levy | 1200 |
| `bil.DebitNoteIssued` | 1200 | 40xx; 2100 per levy |
| `pay.PaymentCleared` | 1000, 1110, 1120, 1100 or 1130 by method; 2210 for store credit redeemed | 1200 for the allocated part; 2200 for the unallocated part; 2290 if the payer is unknown |
| `pay.DepositAllocated` | 2200 | 1200 |
| `pay.RefundPaid` | 1200 or 2200 | Tender account, or 2210 if refunded to store credit |
| `pay.PaymentReversed` | Reverse of the original | Reverse of the original |
| `pay.ProviderSettled` | 1100; 6910 fees | 1120 |
| `pay.ChequeCleared` | 1100 | 1130 |
| `del.CodCollected` | 1020 | 1200 |
| `del.DriverCashRemitted` | 1000 the till that counted it, for what was counted; 6900 for a shortage | 1020 the driver, for what was expected; 6900 for an overage |
| `pos.ShiftOpened` (float) | 1000 | 1010 |
| `pos.CashDropped` | 1010 | 1000 |
| `pos.CashPaidOut` | 6xxx | 1000 |
| `pos.ShiftClosed` | 6900 if short; 1010 for cash returned | 1000; 6900 if over |
| `pos.ShiftLateEntryPosted` (B09b continued 3b) | 6900 if short; 1000 if over | 1000 if short; 6900 if over |
| `cap.CapitalContributed` | 1100 or 1110 | 3000 |
| `cap.CapitalWithdrawn` | 3000 | 1100 or 1110 |
| `cap.DistributionDeclared` | 3300 | 2300; 2310 for tax withheld |
| `cap.DistributionPaid` | 2300 | 1100 or 1110 |
| `cap.LoanDrawn` | 1100 | 2400 |
| `cap.InterestAccrued` | 6930 | 2410 |
| `cap.LoanRepaid` | 2400; 2410 | 1100 |
| `cap.GrantReceived` | 1100 | 2450 |
| `whl.BadDebtWrittenOff` | 6940 | 1200 |
| `fin.DepreciationRun` | 6500 | 1590 |
| `fin.ManualJournalApproved` | As entered | As entered |
| `fin.YearClosed` | 4xxx | 3200, then 3100; 5xxx and 6xxx closed to 3200; 3300 closed to 3100 |

A cash sale posts three linked entries (stock issue, invoice, payment) sharing one `posting_group_id`. Receivables is the clearing account between the invoice and the payment and nets to zero.

## Consequences

- The accountant reviews one chart and one matrix. Changing an account for an event is a rule change with approval, not a deployment.
- Modules B5 to B7 are built and tested before the ledger exists, and B8 adds handlers without editing them. Seed data is regenerated in B8 so every seeded movement has its journal.
- A module that forgets to publish an event posts nothing. The two safeguards catch a missing handler at boot and a missing event the next night.
- The price override abuse case is covered: every variance between resolved and agreed price lands on account 4210 with the cashier's shift as source.
- Livestock is carried at cost, not fair value. This is an assumption for the accountant (see `docs/ASSUMPTIONS.md`).
- No general ledger balance is maintained synchronously (ADR-0005). Trial balance is a period snapshot plus lines since.
- The ledger is not partitioned in version one. Expected volume is about ten million lines over five years, and partitioning would force the partition key into every unique key, weakening the idempotency constraints.
- Binds: `docs/data-model/fin.md`, the `hakorem-ledger` skill, every module that publishes a financial event.

## Verification

- B8 gate: trial balance sums to zero on a seeded trading day; an unbalanced journal is rejected by the database itself.
- B8: a posting into a closed period is rejected by trigger.
- B8: the boot assertion fails when a `posts_to_ledger` event has no handler (test removes one deliberately).
- B8: each row of the matrix has a test asserting exact debit and credit amounts.

**Applied in B8 (2026-11-16, ADR-0056).** The chart, the determinations and the rules of every row whose event is published today are seeded as data (migration 0123, A-182); the rows of BIL, PAY, POS, DEL, CAP, WHL and FIN's own events are added, each with its exact-amount test, by the session that publishes the event (B08 continued, B08 continued 2, B9a, B9b, B10, B11, B12). Proved: an unbalanced, single-line or empty entry is refused at commit, and a posting into a locked or closed period by trigger, each by raw SQL with a mutation check; the boot assertion names a removed handler and a removed rule, and stops the application; each published row posts exact amounts (`test/integration/fin/posting-matrix.integration.spec.ts`); the seeded trading day sums to zero and its inventory accounts equal the cost pools (`test/integration/fin/trial-balance.integration.spec.ts`).

**Applied in B08 continued 1b (2026-11-16, A-190).** The row `fin.ManualJournalApproved` ("As entered") is catalogued with two amount keys, `debit` and `credit`, whose seeded rules take the determinant `ENTERED`: each amount posts to the account the accountant entered for it, through the same rules, numbering and database triggers as every other row; only that event posts so, and its rules cannot be changed (migration 0130). Its exact-amount test is in `test/integration/fin/posting-matrix.integration.spec.ts`. The decision is unchanged.

**Applied in B08 continued 1c (2026-11-16, ADR-0058, A-197).** The row `fin.YearClosed` is catalogued with six amount keys (an account with a debit or a credit balance closed to 3200 or to 3100, the profit and the loss moved from 3200 to 3100), whose closing side takes the determinant `CLOSED_ACCOUNT` (the account whose balance the amount closes) and whose other side names 3200 or 3100 as a fixed account, as the row says. FIN publishes it when period 12 closes, one per branch; its exact-amount test is `test/integration/fin/year-close.integration.spec.ts`, because the database admits a CLOSING entry only with the close of its period. The decision is unchanged.

**Applied in B08 continued 1c2 (2026-11-16, ADR-0059, A-199).** The row `fin.DepreciationRun` (Dr 6500, Cr 1590) is catalogued with one amount key, `depreciation`, one per asset with the asset as cost object, its credit through the determination `ASSET_CATEGORY`/`ACCUMULATED_DEPRECIATION`, seeded to 1590 for every category. ADR-0059 adds one row this matrix did not have, FIN's own `fin.FixedAssetDisposed`: Dr 1590 accumulated depreciation and the proceeds account, Cr 1510 to 1540 at cost by `ASSET_CATEGORY`/`ASSET`, the gain or loss to the new account 4920. Both rows' exact-amount tests are `test/integration/fin/depreciation-runs.integration.spec.ts` and `test/integration/fin/fixed-assets.integration.spec.ts`. The decision is unchanged.

**Applied in B09a continued 1b (2026-11-16, ADR-0064, A-212).** The rows `pay.PaymentCleared` (a cheque to 1130 at receipt, store credit redeemed to 2210 against the customer), `pay.ChequeCleared` (Dr 1100 against the bank account, Cr 1130), `pay.PaymentReversed` ("Reverse of the original": the mirror of each entry the payment posted, an event type with no amount keys and no rules, refused without its original) and `pay.RefundPaid` to store credit (Cr 2210) are seeded (migration 0173), each with its exact-amount test in `test/integration/pay/receipts-reversals.integration.spec.ts`. `pay.ProviderSettled`, a bank transfer's 1100, 2290 and the refund against a credit note follow in B09a continued 1c (A-213). The decision is unchanged.

**Applied in B09a continued 1d (2026-11-16, ADR-0066, A-216).** The row `pay.RefundPaid` gains the amount key `creditRefund` for a refund against a credit note: Dr 1200 against the customer, Cr the tender (migration 0184), the row's "1200 or 2200"; a cheque's bank payout credits 1100 against its bank account through the `BANK_TRANSFER` tender. Exact-amount tests in `src/modules/fin/domain/event-amounts.spec.ts` and `test/integration/pay/credit-note-refunds.integration.spec.ts`. The decision is unchanged.

**Applied in B09b continued 3b (2026-11-19, ADR-0077 Amendments, A-281).** The row `pos.ShiftLateEntryPosted` is catalogued with two amount keys, `short` (Dr 6900, Cr 1000 against the till's REGISTER party) and `over` (Dr 1000 against the till, Cr 6900), migration 0281, one of the two zero: the post-close adjustment of a late entry on a till shift, exactly the entry's amount, posting once per late entry (`uq_journal_entry_pos_late_entry`). No existing row, account or determination changes. Its exact-amount test is `test/integration/pos/late-cash.integration.spec.ts`. The owner's clearing account for unverified mobile money (replacing A-279 (h)'s Dr 1110) is B09b continued 3c's.

**Applied in B09b continued 3c (2026-11-23, the owner's decisions 2 and 3 of 2026-11-18, ADR-0081, A-282, A-283).** Two accounts are added, with new rows only; no existing rule, account or determination changes.
- **1115 Mobile money awaiting verification** (asset, against the wallet, BANK_ACCOUNT). An unverified offline mobile money tender is booked here, never straight to 1110, the way a cheque waits in 1130. 1120 is not used for it, because 1120 holds provider-cleared receipts against the provider. `pay.PaymentCleared` marked `unverified` debits it through the determinant `MOBILE_MONEY_AWAITING_VERIFICATION` (determination 281). 0263's `UNVERIFIED_MOBILE_MONEY` (1110) is no longer named.
- **`pay.UnverifiedPaymentVerified`** (rules 284, 285) moves the tender from 1115 to 1110 against the wallet, exactly once per verification (`uq_journal_entry_unverified_verified`). A tender reversed as never received mirrors its receipt (Dr 1200, Cr 1115), so 1110 is never touched.
- **1335 Stock sold ahead of receipt** (asset, credit balance while open).
  - `inv.NegativeStockCosted` (rules 286, 287): Dr cost of sales by GL group, Cr 1335.
  - `inv.NegativeStockTrueUp` (rules 288 to 291): `cleared` Dr 1335, Cr cost of sales; `trueUp` Dr cost of sales, Cr inventory by GL group.
  - Each posts once per subject (`uq_journal_entry_negative_stock`).

Migrations 0285 and 0287. The exact-amount tests are `test/integration/pos/unverified-clearing.integration.spec.ts` and `test/integration/pos/negative-stock.integration.spec.ts`. The decision is unchanged.

## Amendments

- **2026-11-23, the owner:** "a driver's cash goes to the till (1000) and reaches the safe when the till closes." The row `del.DriverCashRemitted` debits 1000 against the till (REGISTER) that counted the cash for what was counted, credits 1020 against the driver for what was expected, and takes a shortage as a debit and an overage as a credit on 6900 (migration 0315, rules 294 to 297, as A-345 (d) built; ADR-0092, ADR-0077); the cash reaches 1010 with the rest of the till's at the shift's close (`pos.ShiftClosed`). Its exact-amount test is `test/integration/del/driver-cash-hand-in.integration.spec.ts`. "Accounting documents must say what the system does."
- **2026-11-24, the owner (2026-11-23, UAT scenario 2):** "post list price to sales (4000) and the difference to price variance (4210), above or below list. This reverses A-310 (a) in the booking only; the customer still pays the quoted price." The row `bil.InvoiceIssued` already reads "40xx at resolved net; 4210 where agreed is below or above resolved": a line converted from an accepted quote now carries as its resolved price the list its quote line recorded at issue, and the quoted price as agreed (B11u, ADR-0098, A-350, migration 0348's reason `QUOTED_PRICE`), so its invoice credits 40xx at list and debits or credits 4210 with the difference; a line the engine did not price keeps its quoted price as list and posts no variance. No rule, account or determination changed, and every other line posts as before. Its exact-amount test is `test/integration/quo/uat-scenario-2-corrections.integration.spec.ts` (sales 65,000 and 4210 credited 10,000 for a goat quoted at 75,000; sales 6,000 and 4210 debited 600 for three yams quoted at 1,800; no 4210 line at list). "Accounting documents must say what the system does."
