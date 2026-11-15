# ADR-0051: Master data asks inventory whether a branch or location is in use through a port

- **Status:** Proposed (B05x; the owner approves by merging the B05x pull request)
- **Date:** 2026-11-15
- **Session:** B05x
- **Deciders:** backend track; owner

## Context

FR-MDM-006 says "a location with stock cannot be archived", and the B05x opener says a branch cannot be closed while it holds stock or open documents. Branches and locations are MDM's (layer 3); stock and the stock documents are INV's (layer 5). MDM may not import INV, and ADR-0011 lets only RPT and CST select from another schema's published views, so MDM cannot read `inv.pub_stock_on_hand` either. A-111 recorded in B04d continued 2 that the location check "comes through a port (an ADR then)", and `docs/MODULE_BOUNDARIES.md` section 6 says a new port needs an ADR. Without a decision, `archiveLocation` archives a cold room with meat in it and `updateBranch` closes a branch with goats in its pens, which is what B04d continued 2 left.

## Options considered

1. **MDM reads inventory's published views.** One query, no port. It breaks ADR-0011 (only RPT and CST read `pub_*` views) and the schema-name check, and makes a lower layer depend on a higher one's data.
2. **A database trigger on `mdm.location` and `mdm.branch` that asks an INV function.** The rule would hold for direct SQL, but it is a lower schema calling a higher one's function, the reverse of ADR-0047, and every later module with open documents (PUR, ORD, DEL) would have to add to one trigger.
3. **A port defined by MDM and implemented by INV (and later modules).** MDM defines `LocationUsageCheck` in its `index.ts`: given a branch or a location, in the caller's transaction, a check answers whether stock stands there and how many open documents name it. INV registers its implementation when it starts, as it registers its `OPENING_STOCK` sheet (ADR-0050). MDM adds up every registered check.

## Decision

Option 3.

- `LocationUsageCheck` (MDM, `src/modules/mdm/application/location-usage.ts`): `branchUsage(tx, branchId)` and `locationUsage(tx, locationId)` return `{ holdsStock, openDocuments }`. `LocationsAdmin.registerUsageCheck(check)` adds one; the combined answer holds stock if any check says so and sums the open documents.
- INV's implementation (`InventoryLocationUsage`) reads only its own schema: stock from its published view `inv.pub_stock_on_hand` (any non-zero on hand at a physical location, in transit included, negative included); open documents from its own document tables: goods receipts in `DRAFT`, transfers in `DRAFT` or `DISPATCHED` from or to the branch or location, adjustments in `DRAFT` or `PENDING_APPROVAL`, reversals waiting for approval (branch only), stock takes not yet `POSTED` or `CANCELLED`, and open stock exceptions.
- `updateBranch` closing a branch (`status: CLOSED`) and `archiveLocation` call the combined check in their serializable transaction, after the version check. A later module with documents that name a branch or location (PUR's orders, ORD's orders, DEL's deliveries) registers its own check in its session.
- The port is read-only: it authorises nothing and writes nothing.

## Consequences

- The layer rule holds: MDM imports nothing above it; INV imports MDM's `index.ts`, as it already does.
- A branch or location in use is refused by the application, not by the database. A script that updates `mdm.branch.status` directly bypasses the check; the nightly reconciliation does not look for it. This is accepted as the cost of keeping MDM's tables below INV's.
- `docs/MODULE_BOUNDARIES.md` section 6 lists the port; the MDM and INV cards name it.
- Reversal: remove the registration and the two calls; nothing is stored.

## Verification

- `test/integration/mdm/branch-management.integration.spec.ts`: a branch holding stock, one with a draft goods receipt and a location holding stock are refused with the rule named; once the stock and the document are gone, the branch closes and reopens.
- `scripts/check` and `eslint-plugin-boundaries`: MDM imports nothing from INV.
