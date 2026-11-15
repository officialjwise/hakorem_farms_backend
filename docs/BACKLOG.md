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
| BL-057 | Server-side `sort` and `direction` on `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements` (the frontend's CR-019) | Raised on 2026-11-15 after every master data and inventory phase had finished, so no phase owns it; B06 continued 3 builds livestock and processing and declined it as out of its scope (session protocol: stay in scope) | The owner places it in a phase, as B06m was placed for CR-009 to CR-011 (A-155); it is additive (two optional query parameters per list, an unknown field a 400 with a code, cursors bound to the sort) | CR-019, ADR-0029 |

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

## How to add to this list

1. Give the item the next id in its section.
2. Say in one line why it is not being built now and what would change that.
3. Mention it in the session report under "Deferred".
4. Do not build any part of it in the current session.
