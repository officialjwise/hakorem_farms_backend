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
| `del.DriverCashRemitted` | 1010; 6900 for a shortage | 1020; 6900 for an overage |
| `pos.ShiftOpened` (float) | 1000 | 1010 |
| `pos.CashDropped` | 1010 | 1000 |
| `pos.CashPaidOut` | 6xxx | 1000 |
| `pos.ShiftClosed` | 6900 if short; 1010 for cash returned | 1000; 6900 if over |
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
