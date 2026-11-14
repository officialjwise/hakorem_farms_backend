# ADR-0007: Multi-location from day one

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief makes locations first class: the farm, the pens, the cold room, the shop floor, the delivery vehicle and a customer-return holding area are all stock locations, and every movement names a source and a destination. It requires branch and location scoping so that a cashier at the shop cannot post movements at the farm. The owner's default is to build multi-location and run a single location, because retrofitting it is painful.

Two different things are called "location" in conversation: the place a business trades from, and the place a goat stands. They need different treatment, because payments, journals, shifts and number series belong to a trading place but have no stock location.

## Options considered

1. **Single location now, add a column later.** Cheapest today. Later it means a backfill of every transactional table, new unique keys on numbering, and a rewrite of authorisation.
2. **One tree, with the trading place as the root node of the stock location tree.** One concept, but money and documents then need a stock location they do not have.
3. **Two concepts: branch for trading and control, location for stock.** Slightly more to explain, and each table references the one that fits.

## Decision

Option 3.

- **`mdm.branch`** is the unit of trading, authorisation, numbering and reporting. One legal entity, one chart of accounts; branch is a dimension on journal lines, not a separate set of books.
- **`mdm.location`** is the stock tree. Every location has a `branch_id`, an optional `parent_id`, and a `kind`: `SITE`, `PEN`, `COLD_ROOM`, `STORE`, `SHOP_FLOOR`, `VEHICLE`, `RETURNS_HOLD`, `QUARANTINE`, `IN_TRANSIT`, or one of the virtual kinds used as the outside world in stock movements (ADR-0002). Flags: `is_virtual`, `is_sellable`, `allows_negative`, and a `temperature_class` for cold chain.
- **`branch_id NOT NULL`** is carried on every transactional header: orders, billing documents, payments, shifts, registers, goods receipts, transfers, processing orders, journal lines and number series. It is denormalised deliberately so that scoping and reporting never need a join through the location tree.
- **Authorisation.** A role is granted to a user for a branch, and optionally for one location within it. The check runs in the application layer, in every command and query handler (ADR-0017, ADR-0035). A grant with no location covers the whole branch.
- **Numbering.** Series are keyed by document type, fiscal year and branch (and register for receipts), so a second branch gets its own series without a schema change (ADR-0015).
- **Transfers.** A transfer between locations in one branch changes stock only. A transfer between branches also posts a journal that moves the inventory value between branch dimensions (ADR-0003).
- **Launch configuration.** One branch is seeded for the farm and shop, with its location tree. A second branch flagged `is_test` exists in every environment for the deployment smoke suite. It has its own number series and is excluded from statutory reports, so the production smoke sale never consumes a real receipt number.

## Consequences

- Opening a second branch is data entry: a branch row, its locations, its registers and its role grants.
- Every query that lists transactional data must filter by the caller's branches. The authorisation layer supplies the filter; repositories require it as a parameter, so forgetting it is a compile error rather than a leak.
- Consolidated reports sum across branches; branch reports filter by the dimension.
- Separate legal entities with separate books are out of scope and parked in `docs/BACKLOG.md`.
- Binds: `docs/data-model/mdm.md`, every transactional table in `docs/data-model/`, ADR-0015, ADR-0017.

## Verification

- B3: a test proving a user granted a role at branch A is refused the same action at branch B.
- B5: a test proving a storekeeper scoped to one location cannot post a movement from another.
- B13: the smoke suite creates and voids a sale in the test branch and the statutory sales report excludes it.
