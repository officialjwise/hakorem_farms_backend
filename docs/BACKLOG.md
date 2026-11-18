# HaKorem Farms Platform: Backlog

Everything deliberately out of scope for version one. A good idea found during a session is written here, not built. An item leaves this list only by an owner's decision and, if it changes structure, an ADR.

Each item says why it is parked and what would bring it back.

## Parked by decisions in B0

| ID | Item | Why it is not in version one | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-001 | Cash rounding to the nearest coin at the counter | Tenders are pesewa-exact. Rounding adds a posting and a rule per tender for little gain | The owner reports that small coins are not practical at the till | ADR-0001 |
| BL-002 | More than one currency | The business trades in cedis only. The currency column exists so this is an expand step later | A supplier or customer invoiced in another currency | ADR-0001 |
| BL-003 | A levy charged as a fixed amount per unit rather than a percentage | The levy matrix expresses percentage levies with a base. No such levy applies to the catalogue | The accountant identifies one | ADR-0020 |
| BL-004 | Direct integration with an electronic invoice certification service | Whether it applies is not yet verified. Billing documents already carry certified-total fields and the document pipeline is built so certification can be added | The compliance check in B1 finds it applies | ADR-0020, A-062 |
| BL-005 | Allocation of distributions by the average of daily percentages | The owner chose unit-days. The run records its method, so another could be added | The owner or investors ask for it; needs a new ADR | ADR-0028 |
| BL-006 | Fair-value accounting for livestock | The cost model is assumed, pending the accountant | The accountant requires fair value | ADR-0003, A-024 |
| BL-007 | Posting yield variance as its own figure in the ledger | Yield is recorded and flagged; the cost is absorbed by the outputs | The accountant wants variance reported separately | ADR-0018 |
| BL-008 | Table partitioning for the ledger, stock movements and audit log | Year-one volumes do not need it, and it would weaken global unique keys | Any of these tables passes about 50 million rows or 50 GB, or vacuum and index maintenance become a problem | ADR-0003, A-068 |
| BL-009 | A read replica for reporting | A second database server is outside the year-one budget. The reporting role and schema make the move a connection change | Reports affect counter latency in the load test, or the budget allows | ADR-0023 |
| BL-010 | Row-level security in PostgreSQL for branch scoping | Scoping is enforced and tested in the domain layer | A second branch with separate staff opens, or an audit asks for defence in depth | ADR-0024 |
| BL-011 | A second payment aggregator adapter | The port exists and one adapter is built | The first provider's outages or fees justify it | A-047 |
| BL-012 | A second production server or failover database | One server meets the availability and recovery targets with offline mode and a drilled restore | The business cannot tolerate a four-hour recovery | ADR-0025 |
| BL-013 | Separate legal entities with separate books | One entity, branch as a dimension | A second company is formed | ADR-0007, A-032 |
| BL-014 | Unverified mobile money tenders offline as normal practice | Off by default because a forged confirmation is a named abuse case; a setting exists | The owner accepts the risk for a specific branch | ADR-0027 |
| BL-015 | Listing individual live animals for direct purchase online | Request to buy is the owner's default. The reservation mechanism already supports it; it is a product setting | The owner wants it for a species or a season | ADR-0019 |
| BL-016 | Central log aggregation and dashboards beyond Prometheus and Sentry | Logs are JSON with correlation ids on the server with rotation, which is enough to start | Diagnosing an incident from server logs proves too slow | ADR-0025 |

## Parked in B3

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-042 | A short-lived cache of grants and revoked sessions (ADR-0016's design) | B3 reads both from PostgreSQL on every request, by primary key or index, so a change takes effect at once with no invalidation to get wrong | The B13 load test shows the reads as a bottleneck against the NFR targets | ADR-0034 |
| BL-043 | Sealing the audit chain with a horizon of the current database only | The sealer's horizon is the oldest transaction on the whole server (ADR-0006); with one database per server that is exact, and it is always safe | Production shares its PostgreSQL server with another busy database, and sealing lag shows on the health report | ADR-0006 |

## Parked in B04d

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-044 | Promotions targeted at a customer tier | The SRS names tiers among a promotion's targets, but the contract and `mdm.promotion` carry none; a tier already has its own price list, and channel and coupon restrict a promotion | The owner wants a discount for one tier that a tier price list cannot express | ADR-0040, A-101 |

## Parked in B05x

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-047 | A closed branch refuses new stock documents and movements at its locations | Closing a branch is refused while stock or open documents remain (ADR-0051), but nothing yet stops a new receipt or movement there afterwards; that is a rule on every INV document and on the movement trigger, outside B05x's three items | The owner closes a selling point, or the next session that opens INV's documents | A-150 |
| BL-048 | A `branchId` filter on `listStockTransfers`, `listStockAdjustments`, `listGoodsReceipts` and `listStockTakes` (CR-015) | INV list filters, not branch management; the lists are already narrowed to the reader's grants | The next session that opens INV's lists; payments, billing and audit lists take it when they are built | A-152 |
| BL-049 | Server-rendered label PDFs for products and lots (`POST /labels`, CR-016) | B05x returns label data only; rendering, archiving and auditing printed documents is DOC's, with document generation | B8's document generation, or B6 with `printPackLabels` | A-151 |
| BL-050 | The owner dashboard's further figures from CR-013 (change arrows, stock health counts, stock by category, alert lists, near-expiry by month, invoices, recent payments, payment method split) | Most need sources not built (BIL, PAY, ORD); the rest need definitions the owner has not given (what "available" and "out of stock" count, which change compares with what) | B8, B9a and B9b add their figures; B12 composes the rest with the read model | A-149, A-152 |
| BL-051 | A carcass lot as a processing input | B6 processes live animals only (A-153): a carcass lot needs a quantity consumed by weight from the lot at the location, which no requirement exercises yet | A carcass bought in, or a two-stage process (slaughter, then cutting) | FR-PRC-001, A-153 |
| BL-052 | Reserve a processing order's inputs while it is in progress | An animal can still be sold after its order starts; completion then refuses it, so nothing is corrupted, but the order fails late | The owner reports orders failing at completion because an animal was sold | FR-PRC-001, ADR-0019 |

## Parked in B06m

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-053 | `resolvePrices` priced from a named draft version (`priceListVersionId`), so a sample basket shows what the draft would charge | CR-009's optional part. `previewPriceListVersion` already shows every changed price; pricing from a version not in force needs the engine to take a version in place of its walk, a second path through code under a 100 percent gate, for a screen that does not yet exist | The price list screen asks for basket pricing in a new contract request | CR-009, FR-MDM-016, A-156 |
| BL-054 | A `kind` filter on `previewPriceListVersion` (only the changes) | Not asked for; `counts` tells a screen whether anything changed and the lines are in identity order | A list of several hundred lines where the manager reviews only changes | CR-009, A-156 |

## Parked in B06 continued 2

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-055 | Batches that group individual animals (a litter of kids, a group of goats) with members joined to them | `createBatch` hatches lot-tracked flocks only (A-159); no operation in the contract adds an animal to a batch, and a group's head and cost would be the sum of its members' rather than one lot's. `liv.animal.batch_id` exists, empty | The owner asks to manage a litter or a goat group as one, or a contract request adds a member operation | FR-LIV-006, A-159 |
| BL-056 | Correcting a misread tag (`updateAnimal.tagNo`) | The tag is the stock unit's identifier, which INV's guard holds fixed so labels and traces never change under a sold lot; allowing it needs an INV migration and a rule for printed labels | A tag misread at receipt that cannot be fixed by reversing the receipt | FR-LIV-002, A-159 |
| BL-057 | Server-side `sort` and `direction` on `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` (the frontend's CR-019) | Raised on 2026-11-15 after every master data and inventory phase had finished, so no phase owns it; B06 continued 3 builds livestock and processing and declined it as out of its scope (session protocol: stay in scope) | The owner places it in a phase, as B06m was placed for CR-009 to CR-011 (A-155); it is additive (two optional query parameters per list, an unknown field a 400 with a code, cursors bound to the sort). **Built in B07 continued 3** (contract 1.33.0), except the fields BL-062 and BL-063 park | CR-019, ADR-0029 |
| BL-058 | MDM's `Supplier.hasProfile` answering true for a supplier with a procurement profile | MDM (layer 3) cannot ask PUR (layer 7) without a new port and its ADR; every supplier registered from 1.29.0 on has a profile opened in its registration's transaction, so `getSupplierProfile` is the answer meanwhile | A screen that needs the flag on the supplier list, with an ADR for the port | A-166, FR-MDM-007, FR-PUR-001 |
| BL-059 | A supplier credit against an invoice already paid in full, the supplier then owing the farm a refund | Without the ledger (B8) there is no supplier balance to carry a debit, so B07 continued 1b refuses a credit against a PAID invoice (`ORIGINAL_SETTLED`) and caps every credit at what is unpaid | B8's payables subledger, with an ADR on how a supplier refund is received and allocated | FR-PUR-011, A-172 |
| BL-060 | Storing supplier scores per month (`pur.supplier_score`, PROJECTION) | Scores are computed when asked from PUR's own facts, exact and always current; a month's score changes if a late invoice is approved for it | A report that must show a score as it stood at month end, or the cost of computing becomes noticeable | FR-PUR-014, A-173 |
| BL-061 | Perceptual matching of death photographs (a perceptual hash or image similarity), to catch a reused photograph that was re-saved, resized, cropped or photographed from a screen | B06r matches a reused photograph by its exact bytes (SHA-256), which catches the same file twice and nothing else; the camera-only rule on the client is a deterrent, and the server cannot tell a camera photograph from a gallery one | Reused photographs found by hand that the byte hash missed, or the mortality rate by handler pointing at one person | Abuse case 2, A-175, ADR-0053 |

## Parked in B07 continued 3

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-062 | Sorting INV's stock lists by product name and stock on hand by location name | The names are MDM's: INV cannot index them in its own schema or join MDM's tables (ADR-0008, ADR-0011). It needs an INV projection of product and location names kept by MDM's change events, with its own ADR (a new table class use and a subscription), and its indexes | The console's users ask for an alphabetical stock list across more than one page | CR-019, A-181, ADR-0054 |
| BL-063 | Sorting stock on hand and stock units by value at cost | A line's value is its share of its pool by `allocate`, and a unit's the sum of its pools, both computed when read; an index needs the value stored on the listed row, maintained by the movement trigger, a change to the valuation projection (ADR-0018) | The owner wants the most valuable stock first across pages; until then the page on screen sorts | CR-019, A-181, ADR-0054 |
| BL-064 | Posting an inter-branch transfer of untracked stock | INV publishes `inv.StockTransferredBetweenBranches` from the transfer receipt when the pool moves between branches, FIN posts 13xx at the receiving branch against 13xx at the sending branch (ADR-0003's row), and the stock reconciliation compares per branch | A second branch starts trading and moves untracked stock between branches | A-184, ADR-0056 |
| BL-065 | Registering a subledger party before anything has posted to it | A manual journal names a `fin.subledger_party` id, and a party exists only once a posting created it, so an opening receivable for a customer, or a payable for a supplier, nobody has yet posted to cannot be entered. An operation that registers a customer, supplier, investor, levy, register, driver, bank account or provider as a party from its owning module's published key (a list and a create in the contract, `fin.subledger_party` unchanged) | The accountant enters the opening balance journal with open customer or supplier balances | A-190 |
| BL-066 | A key-encryption key rotation job | ADR-0022 says rotation re-wraps data keys and touches no ciphertext, but no job or runbook does it yet. It re-wraps `platform.subject_key.wrapped_key` and every `*_data_key` column (today `fin.bank_account.account_no_data_key`, which the database lets change only with a higher `account_no_kek_version`, ADR-0057) under `KEK_ACTIVE_VERSION`, audited, and the restore drill proves an old version can be retired | Before the first yearly rotation, or on staff departure (`docs/security/SECURITY_ARCHITECTURE.md`, keys and secrets) | A-193 |
| BL-067 | Finding a bank account by its number, and refusing the same number twice | `fin.bank_account` stores the number only sealed (ADR-0057), so two accounts with the same number are not detected and the bank reconciliation (B9a) cannot match a statement line by number. An operation adds `account_no_hash`, an HMAC of the normalised number under a key derived from `LOOKUP_HMAC_KEY` (ADR-0022's `*_hash`), unique among live accounts, backfilled by a job that opens each number once, audited | Bank reconciliation in B9a, or the owner asks for duplicate refusal | A-194 |
| BL-071 | A returns figure on the owner dashboard: completed returns' credit notes on the day each was approved, beside the sales | The dashboard's sales are completed orders' gross (FR-RPT-001, A-234 (c)); netting a credit on its approval day could make a day negative, which `Pesewas` cannot carry. It needs a new additive figure (`returnsTodayPesewas` and a point field), which no screen has asked for yet | The owner or the frontend asks for returns on the dashboard (a contract request) | FR-RPT-001, FR-RPT-003, A-234 |
| BL-068 | A fixed asset's full depreciation schedule on the register, and depreciation up to a disposal date | FR-FIN-014's acceptance says "the register lists its schedule", but the contract's `FixedAsset` has no schedule field, and a disposal does not charge the months since the last run (A-199). An additive `schedule` on `getFixedAsset` (each future month's exact `allocate` part from `depreciationCharge`) and an optional "charge to the disposal date" step need a contract change the frontend asks for | A frontend contract request, or the accountant asks | A-199 |

## Parked by the owner, 2026-11-17

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-072 | Registered checkout: a signed-in customer placing an online order (`customerSession` on `placeOrder`) | The owner, 2026-11-17: the launch path is guest checkout with a phone number and an SMS tracking link (A-232) | After launch, by the owner's decision | A-232, ADR-0070 |
| BL-073 | Order promotions and coupons on an order (`ord.sales_order_adjustment`) | The owner, 2026-11-17: after launch | After launch, by the owner's decision | A-232, FR-MDM-018 |
| BL-074 | Returnable egg trays and crates owed to or by the supplier (a packaging item, a container balance per supplier, deposits, return movements) | The owner, 2026-11-17: not scheduled until the owner confirms whether the supplier takes trays and crates back | The owner confirms the supplier takes them back | The egg coverage check of 2026-11-17 |

## Parked in B09q

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-075 | Dropping the unused column `mdm.product.barcode` (the contract step of its removal) | Contract 2.0.0 neither reads nor writes it and migration 0211 dropped its unique index (the expand step), but the previous API version still selects it, so the column may only go once 2.0.0 is the version running everywhere (docs/DATA_MODEL.md, Migrations: expand then contract) | The first migration after 2.0.0 is deployed: `ALTER TABLE mdm.product DROP COLUMN barcode`, the Drizzle table already free of it | ADR-0072, A-249 |

## Parked in B09e continued 3

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-076 | A receipt claim settled by a replacement delivery named on the claim, written off with approval, or cancelled as raised in error | The owner's decision 5 settles a claim by the supplier's credit note or by the invoice that left the rejected goods out (ADR-0076); a replacement delivery is already covered by its receipt raising the received quantity, after which the invoice that charged the whole delivery settles the claim | The owner asks for a write-off of an unrecoverable claim, or a claim raised in error is found open | ADR-0076, CR-036 point 3, A-272 |

## Parked in B09b continued

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-077 | Approving the void of a sale whose payment already has a reversal waiting answers 500 instead of a refusal | Found by `test/integration/pos/till-cash-paths.integration.spec.ts` while building B09b continued: `Receipts.reverseApprovedIn` writes a second open reversal for the payment. ORD's void and PAY's reversal are lane B's and shared, and the till's own paths are not affected | Lane B (ORD) or the PAY owner refuses the void's approval with a stated code while a reversal is pending **Scheduled into B09u (parent session, 2026-11-18): a 500 is a defect, not parked work.** **Done in B09u (A-307):** the void's approval is refused with `REVERSAL_PENDING` and a reversal asked for beside a waiting void with `VOID_PENDING`, tested by `test/integration/ord/void-pending-reversal.integration.spec.ts`. | ADR-0077, A-226 |
| BL-078 | `openShift` and `recordCashMovement` check the device credential the contract names | B9b built them on the staff session alone, and a manager recording a drop at the back-office console has no till device; the counter sale and the sync are where a revoked device must be stopped (A-274 (c)) | The offline sync (B09b continued 2) sends shift opens and cash movements from the queue under the device credential | ADR-0016, OFFLINE_SYNC 6.5 |
| BL-079 | A refused provider tender at the counter (another customer's, another shift's, a second use of the same payment) reaches the daily exception report's source | B09b continued 1c refuses each attempt in the handler and the database (ADR-0079) and leaves nothing behind but the 422 and the authorisation log; the cleared payment itself stays on the unmatched and unallocated queue (abuse case 4) until a sale or a refund takes it. A refusal is rolled back with the sale, so an event for it needs its own transaction | B12's daily exception report, which defines the item kinds and their sources | ADR-0079, A-276, abuse case 4 |

## Parked in B09u

| ID | Item | Why it is not in version one yet | What would bring it back | Related |
| --- | --- | --- | --- | --- |
| BL-090 | The product sheet's import takes createProduct's `SKU_SERIES_LOCK`, as the customer and supplier sheets now take their create locks | The owner's B09u item 8 names customers and suppliers; products allocate their SKU from one counter row, so an import beside single creates retries rather than fails | A product import beside a create retried or failed in a test or in use | A-308, PR #102 |

## Explicitly outside the brief

These are not mentioned in the shared brief, or are mentioned only conditionally. They are listed so that nobody builds them by accident.

| ID | Item | Note |
| --- | --- | --- |
| BL-030 | Payroll | The brief says "payroll if present". Wages reach the ledger by manual journal or expense invoice. No payroll module |
| BL-031 | Native mobile applications | The console and driver view are a PWA |
| BL-032 | Loyalty points and referral schemes | Promotions and coupons are in scope; a points ledger is not |
| BL-033 | Route optimisation | Routes are ordered by a person. Stops are a list |
| BL-034 | Sensor integration for scales and cold rooms | Weight and temperature are captured manually or from a scale at the device. `source` columns already distinguish `SENSOR` and `SCALE` |
| BL-035 | Supplier self-service portal | Suppliers are managed by staff |
| BL-036 | Ordering by WhatsApp chatbot | WhatsApp is an outbound channel and a source of quote requests entered by staff |
| BL-037 | Demand forecasting and automatic reordering | Reorder points and alerts are in scope; forecasting is not |
| BL-038 | Single sign-on with an external identity provider | Authentication is self-hosted by decision |
| BL-039 | Specific accounting package integrations | The accounting export port is in scope; an adapter for a named package is built when one is chosen |
| BL-040 | Customer-facing live delivery map | Delivery notifications at dispatch, on the way and delivered are in scope |
| BL-041 | Multi-language interface beyond English | All strings go through the translation layer from day one; other languages are data |
| BL-042 | An unassign operation for a customer's price list (`DELETE /customers/{id}/price-list`) | FR-MDM-021's "unassigning returns to tier" is met by an assignment with a `validTo` (A-113); a separate operation needs a contract addition, worth it when the wholesale screens (F10) ask for it |
| BL-045 | Re-resolve saved addresses when a delivery zone's areas change | A saved address keeps the zone it was in when saved (A-112, A-116); the checkout quote always matches live, so a stale saved zone only affects what a screen shows |
| BL-046 | A sweep of unreferenced objects in the private bucket | An upload writes its object before the transaction that registers it (ADR-0044), so a replayed or rolled-back upload leaves an object nothing references; it is never served and costs only storage, worth sweeping when storage cost shows on the bill |
| BL-069 | The nightly `settlement-match` job: a break for a cleared provider payment no settlement has carried after the provider's settlement period, and a mobile money wallet's statement import (B09a continued 1c, A-214 (g)) | Settlement and statement matching are built on demand (`matchSettlementReport`, `matchBankStatement`); the nightly sweep needs the provider's real settlement period from the A-064 sandbox run, and a wallet statement's format from the owner's mobile money account |
| BL-070 | Reclassify an unidentified receipt from 2290 to a customer's deposit as a PAY operation (B09a continued 1c, A-214 (e)) | Today the accountant moves it by an approved manual journal; build it when suspense receipts are frequent enough to need their own screen |

## How to add to this list

1. Give the item the next id in its section.
2. Say in one line why it is not being built now and what would change that.
3. Mention it in the session report under "Deferred".
4. Do not build any part of it in the current session.
