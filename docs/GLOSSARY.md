# HaKorem Farms Platform: Glossary

The words the business, the documents and the code share. A term here means exactly one thing; if code, a screen or a document needs the same idea under another name, it is the code that changes.

The first thirty-eight terms of `docs/DOMAIN_MODEL.md` section 2 (the ubiquitous language) are all here, extended with livestock, processing, retail, accounting, tax and system terms. The domain model remains the authority for the aggregates, invariants and events behind them.

## How to read this document

- **Term**: the word to use in documents, comments, commit messages and screens.
- **Meaning**: one definition, in plain words first.
- **In code**: where the idea lives. `schema.table` is a table (`docs/DATA_MODEL.md` and `docs/data-model/<schema>.md`), `column_name` is a column or field, `UPPER_CASE` is an enum value, `module.EventName` is a domain event, `GET /path` is a contract operation, `Money` and the other capitalised names are kernel types (`docs/DOMAIN_MODEL.md` section 4). JSON field names in the contract are the camelCase form of the column (`agreed_unit_price_pesewas` becomes `agreedUnitPricePesewas`).
- **Governed by**: the document that decides the rule. If two documents disagree, the ADR wins over the domain model, which wins over this glossary.
- **Do not say**: wrong synonyms that have crept into drafts before. Using one is a review comment.

Four rules of naming that cover most of the table:

1. Money is **pesewas**, an integer, in a field ending `_pesewas`. Never "amount in cedis", never a decimal, never a float.
2. **Cost** is what the farm paid or carries. **Price** is what a customer pays. They never share a field (`unit_cost_pesewas` against `unit_price_pesewas`).
3. Stock is never a number someone typed. It is the sum of **movements**. There is no "quantity" column on a product.
4. A ledger row is never updated. A mistake is corrected by a **reversal** and a new row.

## A

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Abuse case | One of the eighteen numbered ways a person might misuse the system, each with a control that blocks it and a detection that reports it | `rpt.exception_item.abuse_cases` (integer array of case numbers) | `docs/security/THREAT_MODEL.md` section 4 | fraud scenario, attack test |
| Accounting period | A calendar month in the ledger. It is open, then locked, then closed. A journal cannot be posted into a period that is not open | `fin.accounting_period`, trigger `fin.assert_period_open()` | ADR-0003, `docs/data-model/fin.md` | month end flag, financial month |
| Account (ledger) | One numbered line of the chart of accounts, such as 4000 Sales, live animals | `fin.account`, `code` (four digits) | ADR-0003 | GL code, category |
| Agreed price | What the customer actually pays per unit. It may differ from the resolved price, and the difference is the variance | `ord.sales_order_line.agreed_unit_price_pesewas` | `docs/DOMAIN_MODEL.md` section 2, ADR-0004 | selling price, final price, discounted price |
| Aggregate | A cluster of objects changed together in one transaction and saved whole. Its root is the only thing other code may hold a reference to | Domain layer classes; one aggregate per module per transaction | ADR-0005, `docs/DOMAIN_MODEL.md` section 1 | entity graph, object |
| Animal | One individually tagged live animal. A serialised stock unit with a register entry | `liv.animal` (its `id` is the `inv.stock_unit` id) | `docs/data-model/liv.md` | livestock item, head record |
| Approval request | A request that a different person approves a sensitive action. It is decided once, by someone other than the requester | `iam.approval_request`, `decided_by <> requested_by` | ADR-0017 | workflow ticket, authorisation record |
| Audit anchor | The signed hash of the audit chain head, written to storage off the server so that a rewrite of history on the server can be exposed | `platform.audit_anchor` | ADR-0006 | backup of the audit log |
| Audit chain | The hash-linked sequence of sealed audit events. Altering any row breaks every hash after it | `platform.audit_chain`, `GET /audit/integrity` | ADR-0006 | log integrity, checksum |
| Audit event | An insert-only record of who did what, when, from where, with before and after values | `platform.audit_event` | ADR-0006, `docs/security/SECURITY_ARCHITECTURE.md` | log line, history row |
| Available | On-hand minus reserved minus quantity under hold. Derived, never stored | Computed from `inv.stock_balance` and holds; `availableQty` in the contract | ADR-0019, `docs/DOMAIN_MODEL.md` section 2 | stock level, free stock, inventory quantity column |
| Average daily gain | Kilograms an animal or flock gains per day, from two weigh-ins: (later weight minus earlier weight) divided by days between them | Computed from consecutive `liv.weight_record` rows; summed in `rpt.livestock_fact.weight_gain_kg` | `docs/data-model/liv.md` | growth rate, ADG column |

## B

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Backorder | The part of an order line not yet fulfilled. It continues as a linked order through the same state machine | `ord.sales_order_line.qty_backordered`, `parent_order_id` | `docs/DOMAIN_MODEL.md` section 7, ADR-0026 | pending quantity, short ship |
| Base unit of measure | The unit a product's stock is counted in (head, kilogram, crate). Other units convert to it | `mdm.product.base_uom`, `mdm.product_uom_conversion` | `docs/data-model/mdm.md` | stock unit (a different thing), pack size |
| Batch | A group of animals bought or hatched together and managed as one, such as a broiler flock | `liv.batch` | `docs/data-model/liv.md` | group, flock record |
| Billing document | An invoice, receipt, proforma, credit note or debit note. Issued documents are frozen | `bil.billing_document.kind` | `docs/DOMAIN_MODEL.md` section 2, section 5.8 | bill, paperwork |
| Blind close | Closing a shift by counting the till and declaring the amount without seeing what the system expects. The expected amount is computed after the declaration is stored | `pos.shift.declared_cash_pesewas`, `expected_cash_pesewas`, `POST /shifts/{id}/close` | `docs/security/THREAT_MODEL.md` abuse case 17 | cash up, balance the till |
| Branch | A place the business trades from. The unit of authorisation, numbering and reporting | `mdm.branch`, `branch_id` | ADR-0007 | shop, site, store (store is a location kind) |
| Business date | A calendar date in Africa/Accra, derived from a UTC instant by the kernel clock. Never taken from the server's local zone | `BusinessDate` (kernel), `posting_date`, `value_date` | `docs/DOMAIN_MODEL.md` section 4 | local date, server date |
| Business document | The registry row that gives every document in every module one identity, so other modules can reference it without a cross-module foreign key | `platform.business_document` | ADR-0011 | document table, generic doc |

## C

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Carcass | The body of a slaughtered animal after dressing, before cutting. May be held as a lot and processed again into cuts | A stock unit with `tracking = LOT`, consumed by a `prc.processing_input` | `docs/data-model/prc.md`, ADR-0018 | meat (meat is the saleable output), dead stock |
| Cash drop | Moving cash from the till to the safe during a shift, so the till never holds more than it should | `pos.cash_movement.kind = CASH_DROP`, event `pos.CashDropped` (debits 1010, credits 1000) | `docs/data-model/pos.md`, ADR-0003 | skimming, cash out |
| Cash on delivery (COD) | The customer pays the driver when the goods arrive. The amount due is fixed by the server at dispatch | `payment_terms = COD`, `del.driver_cash_reconciliation`, event `del.CodCollected`, account 1020 | `docs/security/THREAT_MODEL.md` abuse case 6, ADR-0021 | pay on delivery, collect on delivery |
| Cash over and short | The difference between declared and expected cash at shift close, posted to the ledger either way | Account 6900, `over_short_pesewas`, `over_short_direction` | ADR-0003 | till variance, cash difference |
| Catch weight | A product sold by weight where the final weight, and so the final price, is only known at the scale. The order holds an estimate and a tolerance; the invoice is issued on the weighed quantity | `mdm.product.stock_policy = CATCH_WEIGHT`, `estimated_weight_kg`, `tolerance_percent`, `fulfilled_weight_kg` | ADR-0021 | variable weight, approximate weight, per-kg item |
| Channel | How a sale arrives | `ord.sales_order.channel`: `POS`, `ONLINE`, `WHOLESALE`, `QUOTE` | `docs/DOMAIN_MODEL.md` section 2 | source, sales type |
| Chart of accounts | The numbered list of ledger accounts, seeded and changed only through an approved rule change | `fin.account` | ADR-0003 | account list, GL |
| Checker | The different person who approves what a maker requested. See Maker and checker | `iam.approval_request.decided_by` | ADR-0017 | approver (when the maker is meant), reviewer |
| Cost element | The reason a cost entered a stock unit's value: what was bought, fed, treated, worked on or absorbed | `inv.stock_movement.cost_element`: `PURCHASE`, `FEED`, `VETERINARY`, `LABOUR`, `OVERHEAD`, `PROCESSING` | ADR-0018 | cost type, cost category |
| Cost of sales | The cost of what was sold, posted when stock is issued for a sale. Accounts 5000 to 5030 | `fin.account.type = COST_OF_SALES`, event `inv.StockIssuedForSale` | ADR-0003 | COGS in code, cost price |
| Cost pool | The total value and quantity of a stock unit, or of an untracked product at a branch. Valuation is specific identification for animals and weighted average for countable stock | `inv.cost_pool`; `valuationMethod` is `SPECIFIC_IDENTIFICATION` or `WEIGHTED_AVERAGE` | ADR-0018 | stock value column, average price |
| Cost (against price) | What the farm paid or carries. A price is what a customer pays. The two never share a field, a column or a variable | `unit_cost_pesewas`, `value_at_cost_pesewas` against `unit_price_pesewas` | `docs/CONTRACT_CHANGELOG.md` 1.0.0 (CR-001), ADR-0018 | price (for cost), unit price (for cost) |
| Counter sale | An order on channel `POS`, placed and completed in one transaction | `ord.sales_order` with `fulfilment_mode = COUNTER` | ADR-0026 | POS sale record, till transaction |
| Credit limit | The most a business account may owe. Checked when an order is confirmed | `whl.business_account.credit_limit_pesewas` | `docs/DOMAIN_MODEL.md` section 5.12 | spending limit |
| Credit note | A billing document that reduces an invoice or receipt after issue: a return, a void, a correction. It never deletes or edits the original | `bil.billing_document.kind = CREDIT_NOTE`, event `bil.CreditNoteIssued` | ADR-0003, `docs/DOMAIN_MODEL.md` section 5.8 | negative invoice, cancelled invoice, refund note |
| Credit override | An approved exception that confirms an order beyond a customer's credit limit. Always audited | `whl.credit_override`, exception kind `CREDIT_OVERRIDE` | `docs/security/THREAT_MODEL.md` abuse case 14 | credit bypass |
| Cull | Removing an animal from the herd on purpose, for example because it is unproductive. A cull is a write-off at the animal's cost, with a reason | `liv.mortality_record.kind = CULL`, animal status `CULLED`, reason domain `CULL` | `docs/data-model/liv.md` | kill, dispose, mortality (that is `DEATH`) |
| Customer deposit | Money received before it is matched to an invoice. A liability until allocated | Account 2200, event `pay.DepositAllocated` | ADR-0003 | advance, prepayment (use only for the online prepaid payment term) |
| Customer tier | A grouping that selects a price list: retail or wholesale | `mdm.customer_tier`, codes `RETAIL`, `WHOLESALE` | ADR-0004 | customer type, price class |

## D

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Data classification | The sensitivity level of a kind of data and the rule for handling it | `docs/security/DATA_CLASSIFICATION.md` | The same | data tier |
| Data subject request | A person's request to see or erase their personal data. Erasure destroys the key that protects it | `aud.data_subject_request`, `platform.subject_key` | ADR-0022 | GDPR ticket, deletion request (use only for the customer-facing wording) |
| Debit note | A billing document that increases an invoice after issue, for example an undercharge | `bil.billing_document.kind = DEBIT_NOTE`, event `bil.DebitNoteIssued` | `docs/DOMAIN_MODEL.md` section 5.8 | extra invoice |
| Delivery | The movement of an order to a customer, with a slot, a driver, attempts and proof | `del.delivery`, `del.delivery_attempt` | `docs/DOMAIN_MODEL.md` section 5.13 | shipment, dispatch (dispatch is the order status) |
| Delivery zone | An area with a delivery fee and a free-delivery threshold | `mdm.delivery_zone` | `docs/data-model/mdm.md` | region, route (route is a driver's day) |
| Device counter | A number the offline till increments for every sale it makes, with no gaps within a shift. A missing number at sync means a sale was removed from the device | `pos.sale_sync.device_counter`, `pos.device_enrolment.last_device_counter`, exception kind `DEVICE_COUNTER_GAP` | ADR-0015, ADR-0027 | offline id, sequence number |
| Device enrolment | A manager's approval of a physical device to act as a register, with a revocable credential | `pos.device_enrolment`, `POST /devices/{id}/revoke` | `docs/security/SECURITY_ARCHITECTURE.md` | device registration, pairing |
| Digital address | The GhanaPostGPS code for a location, in the form `GM-091-4471`. Stored beside the street address, not instead of it | `digital_address` on `mdm.customer_address` and in the delivery address objects | `docs/data-model/mdm.md` | postcode, zip code, GPS code |
| Distributable amount | The part of a period's net profit that is shared among investors: net profit minus the retained part | `cap.distribution_run.distributable_pesewas` | ADR-0028 | dividend, payout pool, profit |
| Distribution run | One computation of an investor profit share for a closed period, from draft through approval, posting and payment | `cap.distribution_run`, `cap.distribution_line` | ADR-0028 | dividend run, payout batch |
| Document number | An official, gap-free number issued only by the numbering mechanism, in the form `RCP-2026-DDW-T1-018834` | `platform.number_series`, `platform.number_allocation`, `platform.allocate_number()` | ADR-0015 | invoice id, reference number, sequence |
| Domain event | A fact, named in the past tense as `<module>.<Name>`. Events marked with a diamond in the domain model post to the ledger | `platform.outbox_message`, `module.EventName` | ADR-0010, `docs/DOMAIN_MODEL.md` section 1 | message, notification (notifications are a reaction) |

## E

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Effective date | The date from which something applies. For investor units it is the value date of the contribution, and that day counts | `value_date`, `valid_from`, `effective_from` | ADR-0028, ADR-0020 | start date, activation date |
| Estimate (weight source) | A weight guessed rather than weighed. Allowed, but recorded as such and reported | `weight_source = ESTIMATE` | `docs/DOMAIN_MODEL.md` section 4 | rough weight |
| Exception (daily report item) | A recorded fact that needs a person: a void, an override, a mortality, an unmatched payment. One row per thing on the daily exception report | `rpt.exception_item`, `GET /exceptions/daily-report`, `ExceptionKind` | `docs/security/THREAT_MODEL.md` section 4 | alert, flag |
| Exception (stock) | A stock conflict that could not be posted, such as a goat sold twice or countable stock gone negative offline. The sale and the money are still recorded | `inv.stock_exception.kind`: `NEGATIVE_STOCK`, `SERIAL_CONFLICT`, `HOLD_CONFLICT`, `RESERVATION_CONFLICT` and others | ADR-0027 | sync error, failed sale |
| Exempt | A tax treatment: the supply is outside the tax and the seller cannot reclaim tax paid on its inputs. Different from zero-rated | `mdm.tax_category_levy.treatment = EXEMPT` | ADR-0020 | tax free, untaxed |
| Expand then contract | The migration rule: add the new structure first and keep the old working for one release, then remove the old | `docs/ENGINEERING_STANDARDS.md`, skill `hakorem-migration` | ADR-0025 | breaking migration |

## F

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Feed conversion ratio | Kilograms of feed eaten divided by kilograms of weight gained. Lower is better | Derived from feed quantity and `rpt.livestock_fact.weight_gain_kg` | `docs/data-model/rpt.md` | feed efficiency (that is the inverse), FCR column |
| Fiscal year | The calendar year, in twelve monthly periods | `fin.accounting_period`, event `fin.YearClosed` | `docs/ASSUMPTIONS.md` A-028 | financial year |
| Float | The cash a cashier starts a shift with in the till. It comes from the safe and goes back at close | `pos.shift.opening_float_pesewas`, `pos.cash_movement.kind = FLOAT_IN`, event `pos.ShiftOpened` | ADR-0003, `docs/data-model/pos.md` | opening balance (that is stock or ledger), change fund |
| Fulfilment | Picking, weighing, packing and dispatching an order, or part of one | `ord.fulfilment`, `ord.fulfilment_line` | ADR-0026, `docs/DOMAIN_MODEL.md` section 5.10 | shipping, order processing |

## G

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Gap-free | A numbering property: no number is skipped, even after a rollback, because the number is allocated inside the caller's transaction | `platform.number_allocation` | ADR-0015 | sequential (a database sequence leaves gaps) |
| GETFund levy | The Ghana Education Trust Fund levy, 2.5 percent on the same base as VAT and NHIL, no compounding | `mdm.tax_levy.code = GETFUND`, shown as "GETFund Levy" | ADR-0020 | education tax, GETFUND in prose |
| GhanaPostGPS | The national digital addressing system. See Digital address | `digital_address` | `docs/data-model/mdm.md` | GPS, plus code |
| Goods receipt | The record that stock arrived: supplier delivery, harvest or opening balance. Posts movements from the supplier location to the receiving location | `inv.goods_receipt`, event `inv.GoodsReceived`, number prefix `GRN` | `docs/DOMAIN_MODEL.md` section 5.4, ADR-0003 | delivery note (the supplier's paper), purchase receipt |
| Goods received not invoiced (GRNI) | The liability for stock received before the supplier's invoice is matched | Account 2010 | ADR-0003 | accrued purchases |
| Grade | A quality class within a species, used for pricing | `mdm.grade` | `docs/DOMAIN_MODEL.md` section 2 | quality, class |

## H

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Head | One animal, as a count. The unit of measure for live animals | `uom = HEAD`, `liv.mortality_record.head` | `docs/data-model/mdm.md` | piece, unit (unit means investor unit or stock unit) |
| Head-days | Animals present multiplied by days present. The weight used to spread a shared cost, such as a feed issue to a pen, across the animals that ate it | `liv.feed_cost_allocation.head_days`, `cst.overhead_allocation_line.basis = HEAD_DAYS` | ADR-0018 | animal-days, pen days |
| Hold | A block on moving a stock unit out: a withdrawal period, a quarantine or an investigation. A withdrawal hold cannot be released early | `inv.stock_hold.kind`: `WITHDRAWAL`, `QUARANTINE`, `INVESTIGATION` | ADR-0019 | block flag, status on the animal |
| Held sale | A counter sale parked on the till while the cashier serves someone else. Not a stock hold | `pos.held_sale` | `docs/data-model/pos.md` | pending sale, suspended hold |

## I

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Idempotency key | A unique value (a UUID) the client sends with every state-changing request, so that a retry returns the first result instead of acting twice. A database unique key enforces it | Header `Idempotency-Key`, `platform.idempotency_key` unique on (`scope`, `key`) | ADR-0014 | request id (that is the correlation id), nonce, dedupe token |
| Inbox message | A record that a subscriber has already handled an outbox message, in the same transaction as its effect, so delivery at least once becomes processing exactly once | `platform.inbox_message` | ADR-0010 | processed flag |
| Investor | A person or entity that has put capital into the business and is paid distributions | `cap.investor`, number `INV-001` | `docs/DOMAIN_MODEL.md` section 5.15 | shareholder, partner, backer |
| Invoice | A billing document that asks for payment, issued on delivered quantity | `bil.billing_document.kind = INVOICE`, event `bil.InvoiceIssued` | `docs/DOMAIN_MODEL.md` section 5.8 | bill, statement (a statement lists many) |

## J

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Journal | A balanced set of debit and credit lines in the general ledger. The database refuses an unbalanced one | `fin.journal_entry`, `fin.journal_line`, trigger `fin.assert_balanced()` | ADR-0003 | transaction (ambiguous with a database transaction), posting (the act, not the record) |

## L

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Largest remainder | The way a total is split into whole pesewas with no loss: give each part the floor of its exact share, then hand the leftover pesewas one each to the parts with the biggest fractional remainders. Ties go to the lowest key | Kernel `allocate`, ADR-0001 rule 3 and 4 | ADR-0001 | round each part (loses or invents a pesewa), proportional split |
| Ledger (general) | The double-entry record of money. Insert-only | `fin.journal_entry`, `fin.journal_line` | ADR-0003 | books, GL table |
| Ledger (table class) | An insert-only table: nothing in it is updated or deleted | Class `LEDGER` | ADR-0012 | log table, history table |
| Levy | A named tax component charged with or beside VAT. Each has its own rate, base and reclaimable flag, in an effective-dated scheme version | `mdm.tax_levy`, `bil.billing_document_line_tax` | ADR-0020 | tax rate, surcharge |
| Lineage | The record of which stock units were consumed to make another, so a meat lot traces back to its animal | `inv.stock_unit_lineage`, `GET /stock-units/{id}/trace` | ADR-0002 | parent link, source id |
| Location | A place stock can be: pen, cold room, shop floor, vehicle. Belongs to a branch | `mdm.location`, `location_id` | ADR-0007 | warehouse, bin |
| Locked period | An accounting period closed to ordinary posting. Offline sales dated in a locked period post on the first open date and are flagged | `fin.accounting_period.status` | ADR-0003, ADR-0027 | frozen month |
| Lot | A stock unit that is a quantity produced or received together, with a batch number and dates. The unit of traceability | `inv.stock_unit.tracking = LOT`, identifier such as `MEAT-BEEF-261104-01` | `docs/DOMAIN_MODEL.md` section 2 | batch (a batch is a group of animals), consignment |

## M

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Maker and checker | The user who requests a sensitive action and the different user who approves it. The database refuses an approval by the requester | `iam.approval_request`, `iam.approval_policy`; contract response `ApprovalPending` (202) | ADR-0017 | four eyes, dual control, sign-off |
| Margin floor | The lowest margin a quote may carry without a second person's approval | `quo.quote_version.below_margin_floor`, `margin_percent` | `docs/DOMAIN_MODEL.md` section 5.12 | minimum profit |
| Master data | Slow-changing reference records: products, customers, suppliers, branches, locations, price lists | Table class `MASTER`, schema `mdm` | ADR-0012 | reference data, setup data |
| Mobile money (MoMo) | Payment from a mobile wallet, in Ghana MTN MoMo, Telecel Cash and AirtelTigo Money. A payment is recorded only from a verified provider callback or confirmed lookup, never on the cashier's word | `mdm.payment_method.kind = MOBILE_MONEY`, code `MOMO`, ledger account 1110 | `docs/security/THREAT_MODEL.md` abuse case 4, ADR-0027 | wallet transfer, airtime, "paid" button |
| Mortality | A death of an animal, reported with a reason, a photograph above a value threshold, and a second approver. Written off at the animal's cost | `liv.mortality_record.kind = DEATH`, exception kind `MORTALITY`, event `inv.StockWrittenOff` | `docs/security/THREAT_MODEL.md` abuse case 2 | loss, death record (use only in the screen title) |
| Movement | An immutable record that stock, or only cost, moved from one location to another. One row per transfer between two locations | `inv.stock_movement`, `movement_type` | ADR-0002 | stock transaction, stock update, adjustment (an adjustment is one kind of document that creates a movement) |
| Movement type | The kind of movement and the rules it carries: whether it needs a reason, whether negative balances are allowed | `inv.movement_type`, for example `SALE_ISSUE`, `SALE_ISSUE_OFFLINE`, `PROCESS_CONSUME`, `MORTALITY` | ADR-0002 | transaction type |

## N

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| NHIL | The National Health Insurance Levy, 2.5 percent on the same base as VAT and GETFund, no compounding | `mdm.tax_levy.code = NHIL` | ADR-0020 | NHIS tax, health levy |
| Net profit (for a distribution) | Income minus cost of sales minus expenses for the period, read from the ledger. Zero or negative means nothing is allocated | `cap.distribution_run.net_profit_pesewas`, `is_loss` | ADR-0028 | earnings, income |
| Number series | A configured stream of document numbers with a prefix, a year and a branch | `platform.number_series` | ADR-0015 | counter, sequence |

## O

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Occurred at and recorded at | The two times every transaction keeps: when it really happened, and when the server stored it. They differ for offline sales | `occurred_at`, `recorded_at` | ADR-0027 | created at (for a sale), timestamp |
| Offal | Edible internal parts and extremities of a slaughtered animal, sold or held separately from meat. Accounts 1325 and, for sales, the by-products line | `prc.processing_output.output_kind = OFFAL`, `mdm.category.gl_group = OFFAL` | `docs/data-model/prc.md`, ADR-0003 | waste, by-product (by-product is a different output kind) |
| Offline pack | The cached prices, products, serial units and role limits a register downloads before it goes offline | `GET /registers/{id}/offline-pack` | ADR-0027 | offline cache, sync package |
| On-hand | Quantity physically in a location, derived from movements by a database trigger into the balance table | `inv.stock_balance.on_hand_qty`, `on_hand_weight_kg` | ADR-0002 | inventory quantity column, stock count field, quantity in stock |
| Order | The single record of a sale on any channel | `ord.sales_order`, `order_no` of the form `SO-2026-DDW-004211` | ADR-0026, `docs/DOMAIN_MODEL.md` section 7 | sale record, transaction, basket |
| Order return | A return or exchange against an original order. It never exceeds what was sold and never changes the original order's status | `ord.order_return`, `POST /returns` | `docs/DOMAIN_MODEL.md` section 5.10 | refund (the money side), reverse sale |
| Outbox | The table written in the same transaction as a business change. A worker delivers each message at least once to subscribers that react after commit | `platform.outbox_message`, `platform.outbox_delivery` | ADR-0010 | message queue, event bus |
| Output tax and input tax | Levy charged to customers (liability, account 2100) and levy paid to suppliers that may be reclaimed (asset, account 1400). Both are control accounts with the levy as subledger | Accounts 2100 and 1400 | ADR-0020, ADR-0003 | VAT account |

## P

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Pack | A labelled, weighed piece of a meat lot. The unit a picker handles | `prc.pack`, `barcode`, `weight_kg` | `docs/DOMAIN_MODEL.md` section 2 | carton, portion |
| Payment | Money received from a customer by one method, cleared before it counts. It is matched to documents by allocations | `pay.payment`, `pay.payment_allocation`, event `pay.PaymentCleared` | `docs/DOMAIN_MODEL.md` section 5.9 | receipt (a receipt is a billing document), transaction |
| Payment allocation | The matching of part of a payment to part of an invoice. A payment can be allocated later than it is received | `pay.payment_allocation` | `docs/DOMAIN_MODEL.md` section 5.9 | payment link, settlement (settlement is the provider paying the farm) |
| Pesewa | One hundredth of a Ghana cedi. The only unit money is held in. GHS 459.00 is 45,900 pesewas | `Money`, `platform.pesewas` domain, columns ending `_pesewas`, contract fields ending `Pesewas` | ADR-0001 | cents, minor units, pence, an amount in cedis as a decimal |
| Posting | The act of creating journal entries from a business event. Done by FIN subscribing to events, never by another module calling it | `fin.posting_rule`, `fin.account_determination`, ◆ events | ADR-0003 | booking, writing to the GL |
| Posting matrix | The table of which event debits and credits which accounts | ADR-0003, `fin.posting_rule` | ADR-0003 | account mapping |
| Price band | A list price with a floor and a ceiling and the basis it multiplies (per head, per kilogram, per unit) | `PriceBand` (kernel), `mdm.price_list_entry` | ADR-0004 | price, price range |
| Price list | A set of prices for a channel, tier or customer, in approved, effective-dated versions that cannot overlap | `mdm.price_list`, `mdm.price_list_version`, `mdm.price_list_entry` | ADR-0004 | tariff, rate card |
| Pricing resolution | The fixed walk through price lists where the first hit wins. No hit is a typed "quote required" result, not an error | `POST /pricing/resolve`, outcome `QUOTE_REQUIRED` | ADR-0004 | price lookup, pricing fallback |
| Price override | A cashier or salesperson agreeing a price different from the resolved price. Limited by role, line and shift, with a mandatory reason; the difference posts to account 4210 | `variance_*` columns on `ord.sales_order_line`, exception kind `PRICE_OVERRIDE` | `docs/security/THREAT_MODEL.md` abuse case 3 | discount (a discount is a promotion, account 4220) |
| Processing order | A run that consumes animals or carcasses and produces meat lots, offal and waste, with yield and exact cost allocation | `prc.processing_order` | ADR-0018 | slaughter job, production order |
| Procurement | Buying: requisitions, purchase orders, supplier invoices, supplier payments | Schema `pur` | `docs/MODULE_BOUNDARIES.md` | purchasing module |
| Product | Something the farm stocks or sells. Carries a stock-keeping policy | `mdm.product`, `sku` | `docs/DOMAIN_MODEL.md` section 2 | item, SKU record |
| Projection | A table derived from ledgers and rebuildable from them. Written only by triggers or projectors | Class `PROJECTION`, for example `inv.stock_balance` | ADR-0012 | cache table, summary table |
| Proforma | A billing document that states what an invoice would be, before the sale is final. It posts nothing and is not a tax document | `bil.billing_document.kind = PROFORMA`, `POST /orders/{id}/proforma` | `docs/data-model/bil.md` | draft invoice, quotation (a quote is a priced offer with versions) |
| Proof of delivery | The record that goods arrived: recipient, position, time and cash collected | `del.proof_of_delivery`, `POST /driver/deliveries/{id}/proof` | `docs/DOMAIN_MODEL.md` section 5.13 | delivery confirmation, POD flag |
| Provisional reference | The reference an offline till prints, `P-<register>-<shift sequence>-<device counter>`, before the server assigns the official number | `bil.billing_document.provisional_ref`, `pos.sale_sync.provisional_ref` | ADR-0015 | temporary number, offline receipt number |

## Q

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Quantity | A number to three decimal places with a unit of measure. Never negative | `Quantity` (kernel), `qty` | `docs/DOMAIN_MODEL.md` section 4 | amount (amount is money) |
| Quote | A priced offer to a customer, made of immutable versions. A change is a new version | `quo.quote`, `quo.quote_version`, number `QUO-2026-DDW-000088` | `docs/DOMAIN_MODEL.md` section 5.12 | quotation record, estimate |
| Quote required | The pricing outcome when no price resolves, or the product is quote-only. The customer is invited to ask for a quote | `outcome = QUOTE_REQUIRED` | ADR-0004 | price not found, error |

## R

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Reason code | A code from a fixed list explaining an adjustment, override, void, refund, cull or hold release. Changed only by migration | `mdm.reason_code` | `docs/data-model/mdm.md` | free-text reason |
| Receipt | The billing document for a sale paid at once | `bil.billing_document.kind = RECEIPT`, number `RCP-2026-DDW-T1-018834` | ADR-0015 | invoice (for a paid counter sale), slip |
| Reclaimable | A levy paid on purchases that the business may recover from the tax authority. Posted to account 1400 instead of into the cost of what was bought | `mdm.tax_category_levy.is_reclaimable`, `pur.supplier_invoice_line_tax.is_reclaimable` | ADR-0020 | recoverable (the account name uses it, the flag does not), refundable |
| Reconciliation break | A difference found by the nightly reconciliation between a projection and its ledger, or between a provider report and recorded payments | `pay.reconciliation_break`, exception kind `RECONCILIATION_BREAK` | `docs/security/THREAT_MODEL.md` abuse case 15 | mismatch, drift (drift is the stock balance kind) |
| Refund | Money returned to a customer, tied to the original payment and approved above the automatic limit | `pay.refund`, event `pay.RefundPaid`, exception kind `REFUND` | `docs/security/THREAT_MODEL.md` abuse case 12 | chargeback, reversal |
| Register | A till: a counter position that can have one open shift at a time | `pos.register`, codes `T1`, `T2` | `docs/data-model/pos.md` | terminal, cash desk |
| Request for quote (RFQ) | A customer's request for a price, from the website form, a call or a visit | `quo.rfq`, `POST /shop/quote-requests` | `docs/DOMAIN_MODEL.md` section 5.12 | enquiry |
| Reservation | Quantity promised to an order, checkout or quote. Expires at a set time unless consumed | `inv.stock_reservation`, `reserved_qty` | ADR-0019 | allocation, soft hold |
| Resolved price | What the pricing engine returns: list price, floor and ceiling | `resolved_unit_price_pesewas`, `floor_unit_price_pesewas`, `ceiling_unit_price_pesewas` | ADR-0004 | list price (list is one part), standard price |
| Retention rate | The share of net profit the business keeps instead of distributing. An owner setting, default 40 percent, copied onto each run | `cap.distribution_run.retention_rate_percent` | ADR-0028 | reserve rate |
| Reversal | A new row that cancels an earlier ledger row. The only way to correct a ledger | `reverses_movement_id`, event `pay.PaymentReversed`, `fin.journal_entry` reversing entries | ADR-0002, ADR-0003 | edit, undo, delete, update a ledger row |

## S

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Sale posting | The one transaction that issues stock, issues the billing document and records the payments for an order, on every channel | Domain service `SalePosting` in ORD | ADR-0010, ADR-0026 | checkout logic, complete sale function |
| Scale (weight source) | A weight read from a connected or manually confirmed scale. The preferred source | `weight_source = SCALE` | `docs/DOMAIN_MODEL.md` section 4 | machine weight |
| Serialised | A stock-keeping policy for individually tracked animals: quantity one per stock unit, named on the order line | `stock_policy = SERIALISED`, `tracking = SERIAL` | `docs/DOMAIN_MODEL.md` section 3 | tagged item, unique item |
| Shift | One cashier's session on one register, from opening float to close | `pos.shift`, number `SHF-2026-DDW-000312` | `docs/DOMAIN_MODEL.md` section 5.11 | session (a session is a login), till day |
| Shrinkage | Stock lost without a recorded cause, found at a stock take | Reason code and account 5110, movement type `STOCKTAKE_LOSS` | ADR-0003 | missing stock, theft (do not guess a cause in the data) |
| Stock exception | See Exception (stock) | `inv.stock_exception` | ADR-0027 | |
| Stock-keeping policy | How a product's stock behaves | `mdm.product.stock_policy`: `SERIALISED`, `CATCH_WEIGHT`, `COUNTABLE`, `NON_STOCK` | `docs/DOMAIN_MODEL.md` section 2 | stock type, inventory type |
| Stock take | A count of physical stock against the system, with variances posted as approved adjustments | `inv.stock_take`, `inv.stock_take_line` | `docs/DOMAIN_MODEL.md` section 5.4 | inventory count, audit |
| Stock unit | One individually tracked thing: an animal (serial) or a lot | `inv.stock_unit`, `identifier`, `tracking` | `docs/DOMAIN_MODEL.md` section 2 | item, SKU (a product), unit (ambiguous) |
| Standard-rated | A tax treatment: the full rates apply and tax on inputs is reclaimable. Processed meat, delivery and other goods | `treatment = STANDARD` | ADR-0020 | taxable (zero-rated is also in scope) |
| Step-up | Re-entering a TOTP code within the last five minutes on the same session before a dangerous action: posting a distribution, a bulk export, a role change, a posting-rule change | `iam.approval_policy.requires_step_up`, JWT step-up time, contract note "Requires step-up" | ADR-0016, ADR-0017 | re-login, second password |
| Store credit | Value held for a customer instead of a cash refund. A liability | `pay.store_credit_entry`, account 2210 | ADR-0003 | gift card, voucher |
| Subledger | The breakdown of a control account by party: customer, supplier, investor, levy, register, driver, bank account | `fin.subledger_party`, `fin.account.subledger_kind` | ADR-0003 | detail ledger, customer ledger table |
| Supplier invoice | A supplier's bill, matched to the purchase order and the goods receipt before it can be paid | `pur.supplier_invoice`, `match_status` | `docs/DOMAIN_MODEL.md` section 5.7 | bill, purchase invoice |

## T

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Tag | The number on an animal. What people call the animal | `liv.animal.tag_no`, for example `G-0142` | `docs/DOMAIN_MODEL.md` section 2 | id (the id is a UUID), ear number |
| Tax category | A class assigned to products and charges that selects the levy rates: `LIVE_ANIMALS`, `RAW_PRODUCE`, `EGGS`, `PROCESSED_MEAT`, `FARM_INPUTS`, `DELIVERY_SERVICE`, `OTHER_GOODS` | `mdm.tax_category` | ADR-0020 | VAT class, tax code |
| Tax scheme version | An effective-dated, approved, immutable version of the whole tax matrix | `mdm.tax_scheme_version`, `taxSchemeVersionId` on documents | ADR-0020 | tax table, rate change |
| Tender | One payment method used to pay part of a sale. A sale may have several | `tenders` in `POST /pos/sales`, `pay.payment` per tender | `docs/DOMAIN_MODEL.md` section 2 | payment method (the method is the type, the tender is the use), split payment |
| Three-way match | Checking that the purchase order, the goods receipt and the supplier invoice agree on product, quantity and price before the invoice can be paid | `pur.supplier_invoice.match_status`: `UNMATCHED`, `MATCHED`, `MISMATCH`, `NOT_REQUIRED` | `docs/DOMAIN_MODEL.md` section 5.7, `docs/data-model/pur.md` | invoice check, 3-way |
| Tolerance (catch weight) | How far the weighed total may differ from the estimate before the customer must consent. Default 10 percent | `tolerance_percent`, `weightTolerancePercent` | ADR-0021, `docs/ASSUMPTIONS.md` A-044 | margin of error |
| TOTP | Time-based one-time password, the six digits from an authenticator app. Required for Owner, Accountant and Manager | `iam.totp_credential` | ADR-0016 | OTP, SMS code |
| Trial balance | The list of every account's debits and credits for a date range, whose total debits equal total credits. It is computed from journal lines, never stored | `GET /finance/trial-balance`, field `balanced` | ADR-0003, ADR-0005 | balance sheet (a different statement), summary |

## U

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Unit (investor) | A share in the business. Holdings are counted in units with effective dates | `cap.unit_holding.units`, `cap.capital_transaction.units` | ADR-0028, `docs/DOMAIN_MODEL.md` section 2 | share (use for the percentage), stock, equity |
| Unit of measure | The unit a quantity is counted in | `mdm.uom`: `HEAD`, `KG`, `CRATE`, `PACK`, `UNIT` | `docs/data-model/mdm.md` | measure, size |
| Unit-days | Units held multiplied by days held in a period. The weight for a distribution. Stored as units times days, then multiplied by 10,000 into an integer before allocation | `cap.distribution_line.unit_days`, `cap.distribution_run.total_unit_days` | ADR-0028 | weighted average percentage, share-days |
| Unmatched payment | Money received that cannot be tied to an order or invoice, or a mobile money tender not yet verified. It waits in a queue | `GET /payments/unmatched`, account 2290, exception kind `UNMATCHED_PAYMENT` | `docs/security/THREAT_MODEL.md` abuse case 4 | unknown payment, suspense item |

## V

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| VAT | Value Added Tax, 15 percent standard rate, on the same base as NHIL and GETFund, no compounding. Live animals, produce and eggs are zero-rated; processed meat is standard-rated | `mdm.tax_levy.code = VAT` | ADR-0020, `docs/ASSUMPTIONS.md` A-020, A-021 | sales tax |
| VAT registration threshold | The annual turnover (GHS 750,000) above which the business must register. Open for the accountant. If the business is below it, `tax.registered` is false and no levy is charged | `platform.setting` key `tax.registered` | ADR-0020, `docs/ASSUMPTIONS.md` A-033 | registration limit |
| Value date | The date money is deemed to have moved, for example a capital contribution's effective date | `value_date` | ADR-0028 | transaction date |
| Variance (price) | The difference between resolved and agreed price, with a direction (`BELOW` or `ABOVE`), a mandatory reason and sometimes an approval | `variance_pesewas`, `variance_direction`, `variance_reason_code` | ADR-0004 | discount, markdown |
| Variance (yield) | A processing order whose actual yield differs from the standard by more than the tolerance | `prc.processing_order.yield_variance_flag`, exception kind `YIELD_VARIANCE` | ADR-0018, `docs/security/THREAT_MODEL.md` abuse case 18 | shrink |
| Virtual location | The outside world as seen by stock: supplier, customer, loss, production. It lets every movement have a source and a destination | `mdm.location.kind` virtual values | ADR-0002, ADR-0007 | dummy location |
| Void | Cancelling a completed counter sale in the same shift, approved by a supervisor who is not the cashier. It leaves the order, a credit note and reversing entries | `POST /orders/{id}/void`, status `VOIDED`, exception kind `SALE_VOID` | `docs/DOMAIN_MODEL.md` section 7, abuse case 1 | delete sale, cancel (cancel is before completion) |

## W

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| Waste | Output of processing with no saleable value. Carries zero allocation weight and zero cost | `prc.processing_output.output_kind = WASTE` | ADR-0018 | loss (loss is a stock write-off), scrap |
| Webhook | A call from the payment provider into the API. Verified by signature, timestamp window, replay cache and re-verification of the amount. Also the name of the outbound calls the business sends to integrators | `pay.webhook_event` (inbound), `api.webhook_endpoint` (outbound), exception kind `WEBHOOK_REJECTED` | `docs/security/THREAT_MODEL.md` abuse case 5 | callback (use for the provider's confirmation only in prose), notification |
| Weight band | A range of live weight within a species, used for pricing | `mdm.weight_band`, codes `GOAT-S`, `GOAT-M`, `GOAT-L` | `docs/DOMAIN_MODEL.md` section 2 | size class, weight class |
| Weight source | How a weight was obtained: `SCALE`, `MANUAL` or `ESTIMATE`. Mandatory with any weight | `weight_source` | `docs/DOMAIN_MODEL.md` section 4 | weight type |
| Weighted average cost | The valuation of countable stock: the pool's value divided by its quantity, applied to each issue | `inv.cost_pool`, `valuationMethod = WEIGHTED_AVERAGE` | ADR-0018 | average price, moving price |
| Withdrawal (capital) | An investor taking capital out. Needs an approval. Not the same as a withdrawal period | `cap.capital_transaction.kind = WITHDRAWAL`, event `cap.CapitalWithdrawn` | `docs/data-model/cap.md` | redemption (use only in the units explanation), payout |
| Withdrawal period | The days after a veterinary treatment during which an animal may not be sold or slaughtered. Enforced by a hold that nobody can release early | `mdm.product.withdrawal_days`, `liv.health_event.withdrawal_days`, `withdrawal_ends_at`, `inv.stock_hold.kind = WITHDRAWAL` | ADR-0019, `docs/ASSUMPTIONS.md` A-046 | quarantine (a different hold kind), cooling-off |

## X, Y and Z

| Term | Meaning | In code | Governed by | Do not say |
| --- | --- | --- | --- | --- |
| X report | A reading of a shift taken in the middle of it. It does not close the shift and can be run any number of times | `pos.shift_report.kind = X`, `GET /shifts/{id}/x-report` | `docs/data-model/pos.md` | interim report, mid-day total |
| Yield | Output weight as a share of input weight, in percent | `prc.processing_order.actual_yield_percent`, `expected_yield_percent`; standard in `prc.yield_standard` | `docs/DOMAIN_MODEL.md` section 2, ADR-0018 | conversion rate, recovery |
| Z report | The final report of a shift, produced once when it closes. A shift has exactly one | `pos.shift_report.kind = Z`, partial unique on `shift_id`, `GET /shifts/{id}/z-report` | `docs/data-model/pos.md` | end of day report |
| Zero-rated | A tax treatment: tax is charged at zero percent, the supply stays in the tax system and the tax paid on inputs is reclaimable. Live animals, raw produce and eggs. Different from exempt | `mdm.tax_category_levy.treatment = ZERO_RATED` | ADR-0020 | tax free, no tax |

## Table classes and standard words

Used in every dictionary under `docs/data-model/`. Defined in ADR-0012.

| Class | Meaning | Rule |
| --- | --- | --- |
| `MASTER` | Slow-changing reference record | Soft-deleted, versioned |
| `DOCUMENT` | A business document with a status | Frozen once it reaches a posted status |
| `LEDGER` | A fact that happened | Insert-only. Corrected by reversal |
| `PROJECTION` | Derived and rebuildable | Written only by triggers or projectors |
| `WORK` | Operational scratch: queues, tokens, carts | May be deleted by retention jobs |
| `LOOKUP` | A fixed list changed only by migration | Seeded |

Three words that are used on purpose for exactly one thing each:

- **Unit** alone is ambiguous and should be avoided. Say **stock unit**, **unit of measure** or **investor unit**.
- **Session** means a login on a device (`iam.session`). A working period at a till is a **shift**.
- **Transaction** means a database transaction. A sale is an **order**; a movement of money is a **payment**; a ledger record is a **journal**.
