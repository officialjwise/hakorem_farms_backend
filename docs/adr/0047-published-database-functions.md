# ADR-0047: A lower layer may publish read-only database functions that a higher layer's trigger calls

- **Status:** Proposed (B5; awaiting the owner's review of the stacked pull request)
- **Date:** 2026-11-15
- **Session:** B5
- **Deciders:** backend track

## Context

ADR-0002 puts the stock invariants in the movement trigger. Two of its steps need facts that master data owns: step 5 refuses negative stock "unless both the movement type and the location allow negative stock", and the trigger must know whether a location is virtual (the outside world) or physical, and which branch it is in. Tracking a product by unit or not is also MDM's (`mdm.product.tracking`): a movement of a serialised goat with no stock unit must be refused.

ADR-0011 and `docs/MODULE_BOUNDARIES.md` section 7 allow a cross-schema reference only as a foreign key to a published key; the schema-name check fails a migration that names another schema's table. A trigger in `inv` that selects from `mdm.location` would break that rule. The platform already solved the same problem once: an import's trigger asks `platform.require_clean_file` instead of reading `platform.stored_file` (ADR-0046).

## Options considered

1. **Read `mdm.location` and `mdm.product` in the trigger.** Simple, and the boundary check would need an exception for every such read. Any column of the table becomes something inventory can depend on.
2. **Copy the flags onto inventory rows.** A movement or a balance would carry `allows_negative` and `is_virtual`. The copy goes stale when the owner changes a location, and the trigger would trust whatever the caller wrote.
3. **MDM publishes two read-only functions, called by primary key.** `mdm.location_stock_facts(id)` returns branch, kind, code, virtual and allows-negative; `mdm.product_tracking(id)` returns the tracking. They are `STABLE`, `SECURITY DEFINER`, owned by `hk_owner` with a fixed `search_path`, and executable by the application roles. The schema-name check allows a function that a schema lists in `tooling/architecture.json` under `publishedFunctions`, called from a higher layer only.

## Decision

Option 3. The published functions are the database's equivalent of a module's `index.ts`: a narrow, named answer, not access to the table. Adding a function to `publishedFunctions` is a change to this ADR's list:

| Function | Schema | Returns | Called by |
| --- | --- | --- | --- |
| `location_stock_facts(uuid)` | `mdm` | `branch_id`, `kind`, `code`, `is_virtual`, `allows_negative` | `inv` movement and reservation triggers, `inv.pub_stock_on_hand` |
| `product_tracking(uuid)` | `mdm` | `SERIAL`, `LOT` or `NONE` | `inv` movement trigger and stock unit guard |
| `archived_rendering(uuid, bytea)` | `doc` | the archived rendering's id for a document and SHA-256, or null | `bil` migration 0155, relinking documents to their archive when applied again after a rollback (B08 continued 2b, ADR-0061) |

`scripts/check/schema-names.ts` passes a call to a listed function from a schema in a higher layer, and fails any other name of a lower schema's object; its unit test proves both.

## Consequences

- The movement trigger reads the location's current flags at the moment of posting, so the owner's change to a location takes effect at once, and nothing is copied.
- MDM may change its tables freely as long as the two functions keep their signature.
- A reviewer sees every cross-schema dependency in one list in `tooling/architecture.json`.
- Binds: `docs/MODULE_BOUNDARIES.md` section 7, `migrations/0043_mdm_publish_stock_facts.sql`, `migrations/0044_inv_create_stock_ledger.sql`.

## Verification

- `scripts/check/schema-names.spec.ts`: a call to `mdm.location_stock_facts` from `inv` passes; an unlisted `mdm` function, and a listed one called from a lower layer, fail.
- `test/integration/inv/*.integration.spec.ts`: negative stock is refused at a location that does not allow it and posted with an exception at one that does.
