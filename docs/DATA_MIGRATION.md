# HaKorem Farms Platform: Data Migration and Opening Balances

How the farm's starting position enters the system on day one, how it is checked, who signs it off, and what to do if the owner later decides to bring in historical records.

**The decision (ASSUMPTIONS A-005, confirmed by the owner on 2026-11-13): a fresh start.** No existing records are migrated. The accountant enters an opening balance journal on day one, stock and animals are loaded from a physical count, investors' capital is entered as dated contributions. History before the opening date stays in the old records, which are archived read-only.

This document is the specification of that process. The import templates, the validators and the dry-run mode are built in B13 (`docs/BUILD_PROMPT.md`), with the stock side landing in B5 and B6 and the capital side in B12. Where this document needs something the committed contract or data model does not yet have, section 16 lists it, so the build does not have to rediscover it.

Terms: **opening date** is the first day of trading on the new system. **Cut-over** is the close of business on the day before. Opening balances are the position at cut-over, posted dated the opening date. All money is integer pesewas (GHS 1.00 = 100).

## 1. Principles

1. **Each balance lands once, by exactly one route.** The most common way to wreck an opening position is to enter the same thing twice: once by import and once in the journal. Section 3 fixes the route for every balance. The route table is the rule; if a figure is not in the route table it does not go in.
2. **The ledger is never edited.** Opening entries are ordinary, immutable, audited entries. A mistake found after the first trading day is corrected with a reversing entry, never by an update.
3. **Nothing is written until it has been validated.** Every import has a dry run; the journal is a draft until approved.
4. **Two people.** The opening journal is a manual journal: maker the accountant, checker the owner, with the checker's step-up. Opening stock is applied by an administrator and signed off by the manager and the owner. The same person never makes and checks.
5. **Real counts, not old records.** Stock, animals and cash are counted physically at cut-over. The old stock book is evidence, not the source.
6. **Rehearse first.** The whole process runs on staging, with the real figures for stock, cash and capital and synthetic names for people, before it runs on production.
7. **Personal data is minimised.** Customers and suppliers are imported only if they will be used. Consent flags are imported only where consent was really given and can be shown.

## 2. People and responsibilities

| Role | Does |
| --- | --- |
| Owner | Confirms the cut-over date; approves the opening journal with step-up; signs the sign-off sheet |
| Accountant | Prepares and enters the opening balance journal; reconciles cash, bank and mobile money to statements; reviews the validation checks; confirms the accounts and tax setup (A-020 to A-029) |
| Manager / storekeeper | Runs the physical count of stock, animals and cash; prepares the stock and animal sheets; signs the count |
| Administrator | Runs the imports and the validation queries; takes the pre-opening backup; resets staging for the rehearsal |
| A second approver | At least two people hold approving roles at the branch (A-042), so the maker and the checker are never the same |

## 3. The route of every opening balance

The ledger accounts are those of ADR-0003.

| Balance | Account | Route | What posts it |
| --- | --- | --- | --- |
| Stock: live animals, meat, produce and eggs, feed, supplies, packaging | 1300, 1310, 1320, 1325, 1330, 1340, 1360 by the product's GL group | **The `OPENING_STOCK` import** | Event `inv.OpeningStockLoaded`: Dr the 13xx account, Cr 3900 |
| Cash in the safe | 1010 | Opening journal | The journal |
| Bank balance | 1100 | Opening journal, **less** every amount posted to the bank by the capital and financing records below | The journal, plus those records |
| Mobile money wallet | 1110 | Opening journal | The journal |
| Cheques awaiting clearance | 1130 | Opening journal | The journal |
| Payment provider clearing | 1120 | Not carried. Choose an opening date when the provider's unsettled balance is zero | |
| Fixed assets | 1510 to 1540 | Opening journal **at net book value**, and the same assets in the register at net book value (section 10) | The journal |
| Input and output tax | 1400, 2100 | Opening journal, with the levy as the subledger party | The journal |
| Trade receivables | 1200 | Not carried by default (section 12) | |
| Trade payables | 2000, 2010 | Not carried by default (section 12) | |
| Customer deposits, store credit | 2200, 2210 | Not carried. Settle before cut-over | |
| Investor capital | 3000 with the investor as subledger | **Capital contribution records** (section 11), which post Dr bank, Cr 3000 | Event `cap.CapitalContributed` |
| Loans from investors, grants | 2400, 2450 | **Financing records** (section 11), which post Dr bank, Cr 2400 or 2450 | Events `cap.LoanDrawn`, `cap.GrantReceived` |
| The balancing figure | 3900 Opening balance equity | The journal's balancing line, plus the stock import's credit | |

**The bank line in the opening journal is therefore a derived number:** the bank statement balance at cut-over, minus the contributions, loans and grants that the capital and financing records post to the same bank account at the opening date. The worked example in section 8.4 shows it.

After validation the accountant may reclassify 3900 (for example to retained earnings, 3100, or to the owner's own capital) with a separate approved manual journal. The trial balance is correct before and after.

## 4. Timeline

| When | Step | Owner |
| --- | --- | --- |
| Day -14 | The cut-over date is confirmed. The chart of accounts, tax scheme and rates, fiscal year and periods are confirmed by the accountant (A-020 to A-029). The provider's settlement is up to date | Owner, accountant |
| Day -10 | Templates are issued (section 6). Master data is collected | Administrator |
| Day -7 | **Rehearsal 1** on staging (section 14.1) with the draft files | Administrator, accountant |
| Day -3 | Files corrected. The physical count is scheduled. A freeze on new master data starts | Manager |
| Day -1 | **Cut-over.** After the last sale: count cash, stock and animals; read the bank and mobile money balances; record the counts on the count sheets | Manager, storekeeper, accountant |
| Day 0, before opening | The final files are prepared from the count sheets. **Rehearsal 2** on staging with the final figures. The administrator takes the pre-opening backup on production | Administrator, accountant |
| Day 0, before opening | The process in section 5 runs on production. Validation (section 13). Sign-off (section 15) | Administrator, accountant, owner |
| Day 0 | The first shift opens. The counter trades | Manager |
| Day +1 | The validation checks run again; the first nightly reconciliations are read; the first Z reports are read | Accountant, administrator |

## 5. The process on production, in order

Run exactly this order. A step is not started before the previous one has passed its check.

| # | Step | Check before the next step |
| --- | --- | --- |
| 0 | **Pre-opening backup.** The administrator takes a manual base backup and records its id. If the opening turns out to be wrong before any trading, the database can be restored to this point (section 14.3) | The backup exists and is listed |
| 1 | Prerequisites (section 5.1) | Each item ticked |
| 2 | Master data imports, in this order: `LOCATION`, `PRODUCT`, `SUPPLIER`, `CUSTOMER`, `PRICE_LIST_ENTRY` (section 7) | Each job `VALIDATED` with no errors, then `APPLIED`; counts equal the file |
| 3 | Prices: submit the price list version for approval and activate it | Version `ACTIVE` |
| 4 | Fixed asset register (section 10) | Register total equals the schedule |
| 5 | Opening stock and animals: the `OPENING_STOCK` import (sections 8 and 9) | `VALIDATED` with no errors and totals equal the count sheet; then `APPLIED` |
| 6 | Investors and capital contributions, loans and grants (section 11) | Capital register total equals the schedule |
| 7 | The opening balance journal (section 10): draft, review, submit, approve with step-up | Journal `POSTED` |
| 8 | Treatments under a withdrawal period are recorded (section 9.3) | No animal that is under treatment is sellable |
| 9 | Validation checks (section 13) | All pass |
| 10 | Sign-off (section 15) | Signed |
| 11 | The first shift can open | |

### 5.1 Prerequisites

- The environment is healthy; the smoke suite passed; backups run and one base backup exists (`docs/DEPLOYMENT.md` section 11).
- The branch, its locations (pens, stores, cold room, shop floor, vehicles) and its registers exist. The virtual locations, including `OPENING`, are seeded.
- The fiscal year and its twelve monthly periods exist (A-028). Periods before the opening date are locked; the opening date's period is open. The opening date is the first day of a month by preference, so that the first month's figures are clean.
- The chart of accounts is the confirmed one (A-029), and the posting rules are active.
- The tax scheme is entered and approved, and the registration status is set (A-020 to A-022). Prices depend on it.
- The payment methods and the one bank account and one mobile money account exist (A-004).
- Users are created with their roles: owner, accountant, manager, storekeeper, cashiers. The owner, accountant and managers have TOTP enrolled. At least two people hold approving roles (A-042).
- The approval policies' starting thresholds are set by the owner (A-043).
- The test branch exists for the smoke suite (A-049).

## 6. The import files

Imports are `.xlsx` or UTF-8 `.csv` files uploaded with `POST /files` and turned into a job with `POST /imports`. The job is created `UPLOADED`, validated automatically, and becomes `VALIDATED` (the dry-run preview). Nothing is written until `POST /imports/{id}/apply`. Errors are listed per row with `GET /imports/{id}/errors` (row number, column, message). The same limits apply to every entity.

**File rules**

- One sheet named `data`, with the header row exactly as in the templates. A second sheet `lists` in each template is generated from the database and shows the valid codes (categories, units, species, tax categories, grades, locations, payment methods, GL groups, reason codes).
- Up to 5,000 rows per file.
- **Dates** as `YYYY-MM-DD`. **Money** as whole pesewas in a numeric column (a formula column in the template converts a GHS figure to pesewas with `ROUND(x*100,0)`; the importer reads values only). **Weights and quantities** as text with exactly three decimal places (`38.400`). The importer reads the text of the cell and rejects a value with more places than allowed; it never converts through a floating-point number.
- Booleans `TRUE` or `FALSE`. An empty cell is null. Codes are matched case-insensitively and stored in upper case.
- Phone numbers in E.164 (`+233245550142`). A local number starting with `0` is rejected, not guessed.
- A row with any error is reported and the job cannot be applied. For opening stock this rule is strict: the job is applied only when `rows_valid` equals `rows_total`. Fix the file and upload again; do not apply a partial file.

## 7. Opening master data

Master data is imported only as far as the business will use it on day one. Everything can be added later through the console.

| Entity | Columns (header names) | Notes |
| --- | --- | --- |
| `LOCATION` | `branch_code`, `parent_code`, `code`, `name`, `kind`, `is_sellable`, `allows_negative`, `temp_class`, `temp_min_c`, `temp_max_c`, `capacity_head` | Real locations only (`SITE`, `PEN`, `COLD_ROOM`, `STORE`, `SHOP_FLOOR`, `VEHICLE`, `RETURNS_HOLD`, `QUARANTINE`). Parent must be in the same branch. `allows_negative` stays false except where the owner wants offline sales to be able to overdraw the shop floor |
| `PRODUCT` | `sku`, `name`, `category_code`, `stock_policy`, `tracking`, `species_code`, `base_uom`, `sale_uom`, `nominal_pack_kg`, `weight_tolerance_percent`, `tax_category_code`, `gl_group`, `shelf_life_days`, `storage_temp_class`, `withdrawal_days`, `barcode`, `description`, `online_mode`, `is_purchasable`, `is_sellable`, `status` | `species_code` is required when `stock_policy` is `SERIALISED`. `online_mode` is `REQUEST_TO_BUY` for live animals (A-003). Weight tolerance defaults to 10 percent (A-044). Products start `DRAFT` and are activated after review |
| `SUPPLIER` | `supplier_no`, `name`, `contact_name`, `phone_e164`, `email`, `address`, `tin`, `status` | **Bank and mobile money payout details are not imported.** They are entered through the supplier profile, which needs approval by a different user (abuse case 13) |
| `CUSTOMER` | `customer_no`, `kind`, `name`, `phone_e164`, `email`, `tier_code`, `tin`, `marketing_consent_on`, `status` | Import only customers who will trade on the new system, mainly business accounts. `customer_no` blank means generate. `marketing_consent_on` only where consent was given and can be shown; otherwise blank. Credit limits and business account terms are set afterwards on the business account, with approval |
| `PRICE_LIST_ENTRY` | `price_list_code`, `product_sku`, `grade_code`, `weight_band_code`, `basis`, `list_price_pesewas`, `floor_price_pesewas`, `ceiling_price_pesewas`, `quote_only`, `min_qty` | Creates a `DRAFT` version of the price list. Floor is at most list, and list at most ceiling. Two entries for the same product, grade, band and quantity break are refused. The version becomes `ACTIVE` only through approval by a second person |

Check after each: `rows_applied` equals `rows_total`; spot-check ten rows in the console against the source sheet.

## 8. Opening stock

### 8.1 What the import does

`entity: OPENING_STOCK` loads the physical count at cut-over. On apply, in one transaction:

1. For each location in the file, one goods receipt of kind `OPENING` is created (numbered from its series), registered as a business document.
2. For each row, a stock unit is created where the product is tracked (an animal for a `SERIAL` product, with its tag as the identifier; a lot for a `LOT` product), or the balance is credited directly for an untracked product.
3. For each row, an `OPENING_BALANCE` movement is posted **from the virtual `OPENING` location to the real location**, carrying the quantity, the weight and the value of the row. The movement type allows this movement from the virtual location and is the only way stock enters without a supplier, a birth or a production.
4. The cost pool of each stock unit or product and location is credited with the row's value.
5. The event `inv.OpeningStockLoaded` posts, in the same transaction, Dr the inventory account of the product's GL group, Cr 3900 Opening balance equity, for the total value.

### 8.2 The file

| Column | Meaning | Required |
| --- | --- | --- |
| `location_code` | A real location of the branch, sellable or not | Yes |
| `product_sku` | An existing, active product | Yes |
| `identifier` | The tag number for a serialised animal; the batch number for a lot; empty for an untracked product | For tracked products |
| `quantity` | Decimal string, three places. Exactly `1.000` for a serialised animal. Head for a flock lot; units for countable stock | Yes |
| `weight_kg` | Decimal string, three places. The live weight of an animal, or the net weight of a catch-weight lot | For serialised and catch-weight products |
| `weight_source` | `SCALE`, `MANUAL` or `ESTIMATE` | When `weight_kg` is given |
| `value_pesewas` | The **total** cost carried for this row, as a whole number. For an animal, its accumulated cost. For a lot or untracked stock, the cost of the whole quantity | Yes |
| `grade_code` | Grade of an animal or lot | Optional |
| `expires_on` | For lots with a shelf life | Optional |
| `produced_on` | Production or lay date of a lot | Optional |
| `supplier_no` | The supplier, for trace-back | Optional |
| `sex`, `date_of_birth`, `acquired_on`, `purpose`, `breed`, `dam_tag`, `sire_tag`, `batch_no`, `acquisition_cost_pesewas` | Animal register fields for serialised rows. `sex` is `MALE`, `FEMALE` or `UNKNOWN`; `purpose` is `GROWING` or `BREEDING`; `acquired_on` is required | For serialised rows |

**Validation, row by row:** the location exists, is in the branch and is not virtual; the product exists and is active; the quantity has three places and is greater than zero; a serialised row has quantity exactly `1.000`, a tag and a weight; a tag is unique within the file and among live animals; a serialised or catch-weight row has a weight and a source; `value_pesewas` is a whole number, not negative; a tracked row has an identifier that does not already exist for the product; `expires_on` is after the opening date; the species of an animal matches the product. A value of zero is allowed and warned about (for example an animal born on the farm enters at nil cost, A-025; harvested produce at a standard cost that may be zero, A-026).

The job's summary shows, before apply: rows, total quantity, total weight and **total value by GL group**, which the accountant compares with the count sheet.

### 8.3 Valuation

- **Animals** (`SERIAL`): specific identification. Each animal carries its own accumulated cost (A-024: livestock at accumulated cost). Feed and veterinary cost is capitalised onto growing animals from the opening date; breeding stock's upkeep is expensed (A-025). The cost the farm knows for an animal at cut-over (purchase price, plus feed and treatment already spent, if the farm kept that record) goes in `value_pesewas`. If the farm did not keep it, the manager and the accountant agree a figure by animal group (for example the purchase price of the group) and record how it was decided in the sign-off sheet.
- **Lots and countable stock**: weighted average. The cost pool holds the exact total value of the quantity. The unit cost shown on screens is the pool value divided by the quantity, and it is derived, not stored, so there is no rounding loss in the pool. Rounding happens only when stock is issued, allocated with the largest-remainder rule (ADR-0001, ADR-0018).
- **Standard cost** where the real cost is unknown: the agreed unit cost times the quantity, rounded once per row to whole pesewas. The method and the source of each standard cost are written on the count sheet.
- **Not counted at fair value.** Livestock is not revalued upward at opening. If the owner wants a fair-value view, it is a report, not a ledger entry.

### 8.4 Worked example

Branch `DDW`, opening date 1 December 2026, cut-over close of business 30 November. The count:

| Location | Product | Tracking | Quantity | Total value (pesewas) | Account |
| --- | --- | --- | --- | --- | --- |
| Pen A | Goats, 24 animals, tags G-0301 to G-0324, 90,000 each | `SERIAL` | 24 x 1.000 | 2,160,000 | 1310 |
| Pen B | Sheep, 10 animals, tags S-0101 to S-0110, 110,000 each | `SERIAL` | 10 x 1.000 | 1,100,000 | 1310 |
| Pen C | Broiler flock B-2026-11 | `LOT` | 400.000 head | 720,000 (1,800 per head) | 1310 |
| Feed store | Layer feed, 30 bags at 14,000 | untracked | 30.000 | 420,000 | 1300 |
| Shop floor | Eggs, 60 crates at 4,800 | untracked | 60.000 | 288,000 | 1330 |
| **Total** | | | | **4,688,000** | |

Posted by `inv.OpeningStockLoaded`: Dr 1310 Inventory, live animals 3,980,000 (2,160,000 + 1,100,000 + 720,000); Dr 1300 Inventory, feed and medication 420,000; Dr 1330 Inventory, produce and eggs 288,000; Cr 3900 Opening balance equity 4,688,000. Each goat has its own movement `OPENING_BALANCE` from `OPENING` to Pen A, and its own cost pool of 90,000.

The rest of the example (cash, bank, assets, capital) is in sections 10 and 11, and its totals are checked in section 13.

## 9. Opening animals with tags

Animals are loaded by the same `OPENING_STOCK` import, as serialised rows.

### 9.1 Before the count

- Every animal that will be sold or processed must carry a **tag** (an ear tag or equivalent) before the count. An animal without a tag is tagged during the count, with the number written on the count sheet. The tag number is what people and receipts call the animal; the system's id is never shown.
- Tags are unique among live animals. A tag that was used on an animal that has since gone cannot be reused while that animal's record is live; in practice the farm numbers tags in a new series from the opening date, for example `G-0301` onwards.
- Poultry flocks and other group-managed stock are loaded as lots, counted in head, with a flock batch number.

### 9.2 What is recorded per animal

Tag, species (through the product), sex, breed if known, date of birth if known, date acquired, purpose (`GROWING` or `BREEDING`, which decides how feed and veterinary cost is treated), the current live weight and how it was captured (weigh each animal on the scale where there is one; the source is `SCALE`, `MANUAL` for a read tape or a typed figure, `ESTIMATE` otherwise), the accumulated cost, the pen it stands in, and optionally dam, sire, supplier and batch. These populate the animal register, its timeline and its weight history, and the first weight record starts the growth curve.

### 9.3 Animals under a withdrawal period

A withdrawal period (a veterinary hold after treatment) cannot be loaded as a status; a withdrawal hold arises only from recording a treatment (`recordHealthEvent`), and it cannot be released early by anyone. So, **before the first shift opens**, the manager lists every animal that was treated within its withdrawal period, and a farm hand records each treatment with its real date, product and withdrawal days. The system then places the hold. An animal that has no recorded treatment is sellable on day one, so this step is a safety control and is on the sign-off sheet (section 15).

### 9.4 Checks specific to animals

The count of live tags per pen equals the count on the sheet; no tag appears twice; every animal has a location, a weight and a source; the total of animal values equals the animal rows of the count sheet; `GET /animals?status=ALIVE` agrees with the physical pen counts, which the manager re-checks in the pens.

## 10. The opening balance journal

The accountant enters one manual journal of kind `OPENING`, dated the opening date, with the balances that are not stock and not capital (section 3).

**Entry.** `POST /finance/manual-journals` with `kind: OPENING`, `postingDate`, a description naming the cut-over date and the sign-off sheet, and lines (account, side, amount in pesewas, subledger party where the account has one). Edit the draft with `PATCH` (sending `version`). `POST /finance/manual-journals/{id}/submit` refuses with `JOURNAL_UNBALANCED` unless debits equal credits, and returns 202 with an approval of kind `MANUAL_JOURNAL`. A **different** person, the owner, approves with step-up (`approveRequest`). Only then is the journal posted. A second `OPENING` journal for the same branch and fiscal year is refused (`OPENING_ALREADY_POSTED`).

**Fixed assets.** Each asset is created in the register (`POST /finance/fixed-assets`) at its **net book value at the opening date**, with `acquiredOn` the opening date, the net book value as `costPesewas`, the residual value, and the **remaining** useful life in months. The journal debits the asset account at the same net book value, with no separate accumulated depreciation line. The register and the ledger then agree, and the straight-line depreciation that the first depreciation run calculates is right going forward. The original cost and the accumulated depreciation to date stay on the old asset schedule, which is archived and referenced from the sign-off sheet. (The register has no field for opening accumulated depreciation; see section 16.)

**Worked example, continuing section 8.4.** Cut-over figures: cash in the safe counted GHS 4,500.00; the bank statement balance GHS 384,000.00 (of which GHS 300,000.00 is the investors' contributions, recorded in section 11); the mobile money wallet balance GHS 12,500.00; one delivery vehicle with a net book value of GHS 90,000.00 (original cost GHS 120,000.00 less depreciation to date GHS 30,000.00), remaining life 60 months, no residual value.

| Line | Account | Side | Amount (pesewas) | Note |
| --- | --- | --- | --- | --- |
| 1 | 1010 Cash, safe | D | 450,000 | The counted cash |
| 2 | 1100 Bank accounts (the bank account as subledger) | D | 8,400,000 | Statement balance 38,400,000, less 30,000,000 posted by the capital records |
| 3 | 1110 Mobile money wallets (the wallet as subledger) | D | 1,250,000 | Wallet balance at cut-over |
| 4 | 1510 Fixed assets at cost, vehicles | D | 9,000,000 | Net book value |
| 5 | 3900 Opening balance equity | C | 19,100,000 | The balancing line |
| | **Totals** | | Debits 19,100,000, Credits 19,100,000 | Balanced |

Check of the whole opening position, after sections 8, 10 and 11:

| | Pesewas |
| --- | --- |
| Assets: cash 450,000; bank 38,400,000 (8,400,000 from the journal and 30,000,000 from the capital records); mobile money 1,250,000; stock 4,688,000; vehicle 9,000,000 | 53,788,000 |
| Liabilities | 0 |
| Equity: investor capital (3000) 30,000,000; opening balance equity (3900) 23,788,000 (19,100,000 from the journal and 4,688,000 from the stock import) | 53,788,000 |

Assets equal liabilities plus equity.

## 11. Opening investor capital and units

Investors hold equity in units, with profit retention at 40 percent, owner-configurable (A-002). Units are issued at GHS 1.00 per unit unless the owner sets another price (A-031). The investors' real contribution dates matter: distributions are allocated by unit-days, the contribution day counts and a withdrawal day does not (ADR-0028, A-009).

**Steps**

1. **Create each investor** (`POST /investors`, needs step-up): kind (`INDIVIDUAL` or `ENTITY`), name, contact, identity or registration number (encrypted), payout details (encrypted, entered by the accountant, changes later need a different approver), and the investor's portal login if any (the investor realm has its own login; staff create the account).
2. **Record each contribution** (`POST /capital-transactions`, kind `CONTRIBUTION`, step-up): `investorId`, `amountPesewas`, **`valueDate` the real date the money was contributed** (not the opening date), `unitPricePesewas` (100 for GHS 1.00), `bankAccountId`, and the bank reference. Units issued are the amount divided by the unit price. A contribution issues units at its value date and posts Dr bank, Cr 3000 with the investor as subledger.
3. **Record loans and grants** (`POST /financing`, step-up) the same way where any exist; each posts Dr bank, Cr 2400 or 2450.
4. The ledger entry of each of these records is **dated the opening date**, because the earlier periods are locked. The `valueDate` only governs the units and the investor's statement. (Section 16 states this as a requirement on the build.)

**Worked example**

| Investor | Value date | Amount (pesewas) | Unit price (pesewas) | Units |
| --- | --- | --- | --- | --- |
| Ama Serwaa (individual) | 2025-03-14 | 12,000,000 | 100 | 120,000.0000 |
| Kojo Mensah Holdings (entity) | 2025-09-01 | 15,000,000 | 100 | 150,000.0000 |
| Yaw Boateng (individual) | 2026-04-20 | 3,000,000 | 100 | 30,000.0000 |
| **Total** | | **30,000,000** | | **300,000.0000** |

Posted, each on 2026-12-01: Dr 1100 Bank accounts 12,000,000 and Cr 3000 Investor capital (subledger Ama Serwaa) 12,000,000; likewise 15,000,000 and 3,000,000. The bank balance of record after these three entries and the journal's 8,400,000 is 38,400,000, which is the statement balance.

The capital register (`GET /capital/register`) must show total contributed 30,000,000, total units 300,000.0000, and each investor's percentage of units: Ama Serwaa 40 percent, Kojo Mensah Holdings 50 percent, Yaw Boateng 10 percent.

## 12. Opening receivables and payables

**Default: none.** The owner's decision is a fresh start, and the recommended practice is to collect or write off customer balances, and pay supplier balances, before the cut-over, so that day one has no open items. Customer deposits and store credit are settled the same way.

**If balances must be carried.** Version one has no "opening invoice" document: the receivables ledger works through issued billing documents and the payables ledger through matched supplier invoices, and neither can be entered without a sale, a goods receipt or an order behind it. A balance that must be carried is therefore entered in the opening journal on 1200 (receivables, customer as subledger party) or 2000 (payables, supplier as subledger party), with the amount by party, and then:

- It appears in the ledger and in the party's balance, so the control account equals the subledger total.
- It has no open item in the payments module, so a payment received for it is **not** allocated through the usual flow. The accountant settles it with an approved manual journal (Dr bank or mobile money, Cr 1200 with the customer as subledger party), after matching the bank line by hand. For payables, the same in reverse (Dr 2000 with the supplier as subledger party, Cr bank).
- Dunning and ageing do not include it. The accountant tracks the list outside the system until it is cleared, and the list is attached to the sign-off sheet.
- The owner approves this exception in writing, because it departs from the fresh-start decision. A backlog item to add opening invoices is raised for the owner to decide (section 16).

## 13. Validation checks

Run after step 8 of section 5, on staging in rehearsal and on production at opening and again on day +1. Each check names its source, so that nobody needs to open a table. All must pass; one that does not is a stop.

| # | Check | How | Expected |
| --- | --- | --- | --- |
| V-01 | The ledger balances | `GET /finance/trial-balance` as at the opening date | Total debits equal total credits (example: 53,788,000 each side of assets and equity) |
| V-02 | The opening journal is posted once | `GET /finance/manual-journals?status=POSTED` | One journal of kind `OPENING`, dated the opening date, approved by a user other than the maker |
| V-03 | 3900 is the expected figure | `GET /finance/accounts/{id}/activity` for 3900 | Credit balance equals the sign-off figure (example: 23,788,000) |
| V-04 | Stock on hand equals the count | `GET /stock/on-hand?asOf=` (opening date) | `totalValueAtCostPesewas` equals the count sheet total (example: 4,688,000); quantities per product equal the count sheet |
| V-05 | Inventory accounts equal the stock valuation by group | Trial balance lines 1300, 1310, 1330 against `listStockOnHand` grouped by GL group; then run `subledger-reconcile` once by hand | Equal (example: 3,980,000, 420,000, 288,000); job outcome `SUCCESS` |
| V-06 | Animals | `GET /animals?status=ALIVE` and `GET /stock-units` | Count per pen equals the physical count; no duplicate tag; every animal has a location, a weight, a weight source and a cost; sum of animal costs equals the sheet |
| V-07 | Movements | `GET /stock/movements` filtered by type `OPENING_BALANCE` | One movement per row, all from the virtual `OPENING` location, and no other movement type exists yet |
| V-08 | Cash, bank and mobile money | The ledger balances of 1010, 1100, 1110 against the counted cash, the bank statement and the wallet statement at cut-over | Equal. The accountant signs a reconciliation statement for each |
| V-09 | Capital | `GET /capital/register` | Total contributed and total units equal the schedule (30,000,000; 300,000.0000); each investor's balance on 3000 equals their contributions; units are amount divided by price |
| V-10 | Fixed assets | `GET /finance/fixed-assets` against the journal | Register cost total equals the 15xx opening debits (9,000,000); register accumulated depreciation is zero |
| V-11 | Numbering | Run `numbering-check` by hand | Each series is dense; the opening goods receipts and the journal have their numbers |
| V-12 | Audit | `GET /audit/integrity` | Chain verifies; unsealed count falls to zero; an anchor exists for the day |
| V-13 | Sales are possible and priced | The smoke suite on the test branch; one test sale of each stock type on the test branch, voided | Prices resolve; no product that should sell returns `QUOTE_REQUIRED` unexpectedly |
| V-14 | Holds | The list of animals under treatment against `GET /stock/holds` | Every treated animal has its withdrawal hold |
| V-15 | Users and approvals | A test approval between two named people on staging; the list of approvers | Maker and checker differ; at least two approvers per branch |
| V-16 | Day +1 | Run V-01, V-04, V-05, V-12 again after the first trading day; read the daily exception report | Nothing unexplained |

## 14. Dry run, rehearsal and recovery

### 14.1 The dry run

Every import job has two stages: `VALIDATED` (the dry run, which reads the file, checks every row and writes nothing, and shows totals) and `APPLIED`. The dry run is run as often as needed. The journal's dry run is its draft: the accountant can review it, see its totals and balance flag, and `submit` is the first time anyone else is asked to act.

### 14.2 The rehearsals

Two full rehearsals precede the production run (section 4).

- **Where:** the staging server, with its database reset to the migrated schema and reference seeds only, no demo data, so the opening figures stand alone.
- **Data:** the real figures for stock, animals, cash, bank, assets and capital, because these are the numbers being tested, with **synthetic names, phone numbers and identity numbers** for customers, suppliers and investors. No production personal data enters staging (OPERATIONS section 1).
- **What is run:** the whole of section 5, in order, then all of section 13, then the smoke suite, then three test sales (a goat by tag, eggs by the crate, a split tender), a stock count of the opening stock, and a trial balance. The administrator records the time each step took and every deviation.
- **Output:** a short rehearsal report: the figures, the checks, and the defects found. Rehearsal 2 uses the final count sheets; production proceeds only when Rehearsal 2 passes with no defect open.
- **After:** the staging database is reset again so that no real figures stay in it.

### 14.3 Recovery on opening day

Before any trading, if validation fails in a way that reversing entries would only clutter, the administrator can restore the database to the pre-opening backup (step 0 of section 5; the restore procedure is `docs/runbooks/restore-from-backup.md`), then re-run the process from step 1. The owner approves this in writing, because it discards entries. It is available only until the first shift opens: once anything has traded, the ledger is never restored to an earlier state to remove an opening entry. After the first trade:

- A wrong stock quantity or value is corrected with a stock adjustment or a stock take, with a reason from the fixed list (for example `COUNT_ERROR`), and above the threshold with approval.
- A wrong opening journal line is corrected by a reversing manual journal with approval and step-up.
- A wrong contribution is reversed by a reversing capital transaction (`reverses_transaction_id`) and entered again.
- A wrong animal record is corrected through the animal register; its cost through a value-only cost adjustment.

## 15. Sign-off

The sign-off sheet is a one-page form, printed, filled in and signed by hand on opening day, scanned, uploaded with `POST /files`, and referred to by its file id in the opening journal's description and in the release record.

| Item | Figure | Source |
| --- | --- | --- |
| Opening date and cut-over time | | |
| Cash in the safe counted | | Count sheet signed by manager and accountant |
| Bank statement balance | | Statement, with reconciliation |
| Mobile money wallet balance | | Provider statement |
| Stock by GL group, quantity and value | | Count sheet; import dry-run totals |
| Animals by pen, count and value | | Count sheet; `GET /animals` |
| Fixed assets at net book value | | Asset schedule |
| Investor contributions, units and percentages | | Capital register |
| Opening journal totals and 3900 balance | | Trial balance |
| Receivables and payables carried (normally none) | | Section 12, with the owner's written approval if any |
| Animals under a withdrawal period, treatments recorded | | Section 9.3 |
| Validation checks V-01 to V-15 passed | | Section 13 |
| Rehearsal 2 report attached | | Section 14.2 |

Signatures: owner, accountant, manager, administrator. The system's own record of the decision is the approval of the opening journal (by the owner, with step-up) and the audit trail of every import.

## 16. Requirements this document places on the build

These are not in the committed contract or data model. They are the smallest changes that make this process implementable and safe. Contract changes are a minor version bump recorded in `docs/CONTRACT_CHANGELOG.md`.

| Requirement | Where | Why |
| --- | --- | --- |
| The `OPENING_STOCK` apply creates one goods receipt of kind `OPENING` per location, serialised rows create `liv.animal` rows with source `OPENING`, and a second apply for a branch that already has an applied opening stock job is refused with `OPENING_ALREADY_POSTED` | `mdm` import, `inv`, `liv` | An untracked row applied twice would silently double the stock. The contract's `GoodsReceiptCreate.kind` lists only `PURCHASE` and `HARVEST`, so the opening receipt is created by the import only |
| The import validator rejects partial application for `OPENING_STOCK` (apply only when every row is valid), and reads decimal cells as text | `mdm` import | Section 6 |
| The row-level templates in sections 6 to 8, with a generated `lists` sheet | B13 | Section 6 |
| Ledger entries for capital contributions, loans and grants are dated at the recording date (the opening date), while `valueDate` governs units | `cap`, B12 | Earlier periods are locked, and the data model does not say which date the posting uses |
| The fixed asset register has no opening accumulated depreciation field; opening assets are entered at net book value (section 10) | `fin` | Register and ledger must agree; adding the field is a backlog item |
| There is no opening invoice for receivables or payables (section 12) | `bil`, `pur`, `pay` | Raised to the owner as a backlog item; not needed under the fresh-start decision |
| An example in the contract for an `OPENING` manual journal that matches this document's shape (cash, bank, mobile money, assets against 3900) | `contract/openapi.yaml` | The 1.0.0 example for `listManualJournals` shows an opening journal whose first line is a Wages expense |

## 17. If the owner changes the decision later

The decision in A-005 can be reversed, but the effect depends on when.

**Before go-live (the ledger is still empty of trading).** The cleanest path. Move the opening date back to the earliest date for which history is wanted, take the opening balances as at that date, and enter the history in order with real posting dates, through the normal operations as far as they exist:

- Contributions with their real `valueDate` (already supported).
- Purchases as goods receipts and supplier invoices, sales as orders and receipts, payments and cash movements: **not supported as imports in version one.** Each would have to be keyed through the console, which is slow and, for sales, would consume real document numbers and push stock through the live ledger. This is not recommended; if the owner wants it, it needs a design decision recorded as an ADR and a bulk historical entry tool in the backlog (`docs/BACKLOG.md`), because bulk entry must not bypass the invariants (gap-free numbers, stock sign, serialised animals sold once).

**After go-live.** History cannot be posted before the opening date without reopening locked periods, which needs the owner's approval with step-up for each period (`PERIOD_REOPEN`) and puts figures that were reported back in play. The options, in order of safety:

1. **Keep history outside the ledger (recommended).** Archive the old records as files in the document archive (`POST /files`, then reference them from the opening sign-off) and answer questions from them. Reports on the new system start at the opening date.
2. **Summary history by period.** For each earlier month the accountant enters one manual journal of kind `MANUAL`, dated in that period (which must be reopened for the entry and locked again), with the month's totals and a description naming the source ledger. This gives monthly comparatives in the trial balance and the profit and loss, without individual transactions. It does not create orders, stock movements or customer history.
3. **Transaction history.** Only through a new bulk-entry feature that does not exist. A separate read-only archive database (not in the transactional schemas) is the supported design if the owner wants searchable old sales, and it needs its own ADR so that old data never enters the ledgers or the number series.

Whatever is chosen, the opening stock, the opening journal and the capital records stay as they were. They are never edited. The decision, the owner's name and the date are written in `docs/ASSUMPTIONS.md` as a replacement for A-005.
