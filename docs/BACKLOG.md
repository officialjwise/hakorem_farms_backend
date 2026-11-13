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

## How to add to this list

1. Give the item the next id in its section.
2. Say in one line why it is not being built now and what would change that.
3. Mention it in the session report under "Deferred".
4. Do not build any part of it in the current session.
