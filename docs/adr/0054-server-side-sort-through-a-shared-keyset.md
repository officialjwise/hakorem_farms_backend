# ADR-0054: Server-side sort through a shared keyset, an allow-list per list and the id as tie-breaker

- **Status:** Proposed (B07 continued 2 builds the owner's CR-019 instruction of 2026-11-15; the field lists per console list are the frontend's request, reviewed when B07 continued 3 applies them)
- **Date:** 2026-11-15
- **Session:** B07 continued 2
- **Deciders:** owner (CR-019: build the sort once, here, and prove it pages without skipping or repeating); backend track

## Context

CR-019 asks for `sort` and `direction` on `listProducts`, `listStockOnHand`, `listStockUnits` and `listStockMovements`, applied before paging. The storefront catalogue's planned `listCatalogue` already takes `sort` (`RELEVANCE`, `PRICE_ASC`, `PRICE_DESC`, `NAME`). Until now every list paged by id alone (`docs/API.md` section 5), and a sort applied by each list in its own way would page differently on each: an offset skips or repeats a row when rows arrive between pages, and a cursor that carries only the sort value skips rows whose values tie.

## Options considered

1. **Offset pagination for sorted lists.** Simple, but a row inserted before the offset shifts every later page: rows repeat or are skipped. Refused.
2. **Each list writes its own ordered query and cursor.** Works when done carefully, but the tie and null rules would be written many times, and one list getting them wrong is a silent data loss on screen.
3. **One mechanism in platform: an allow-list of sort fields per list, each an expression written in code and backed by an index; the order is the asked field then the row id in the same direction; the cursor carries every key; a keyset condition pages strictly after it.**

## Decision

Option 3 (`src/platform/http/keyset-sort.ts`).

- **The allow-list.** A list declares `SortSpec`: its fields (a SQL expression over its own row and a type), its tie-breaker (the row id) and its default order. The request names a field; nothing from the request reaches the SQL text. Any other field, or a direction other than `asc` or `desc`, is 400 `VALIDATION_FAILED` with detail code `SORT_NOT_ALLOWED`.
- **Ties and nulls.** The id is always the last key, in the same direction, so no two rows share a position. A nullable field leads with `expression IS NULL` ascending and is coalesced, so its nulls come last in both directions and every key is comparable.
- **The cursor.** It carries the text of every key (`k0`, `k1`, ...) inside the existing signed, expiring `Cursors` body, and the sort is part of the cursor's binding: a cursor from one sort is refused by another (400 `INVALID_CURSOR`).
- **Paging.** `k1 > v1 OR (k1 = v1 AND k2 > v2) OR ...`, each comparison in its key's direction. A row that arrives before the cursor is not on a later page; a row that arrives after it is seen once.
- **Indexes.** Each allowed field has an index on (branch or scope, expression, id) in the list's migration; the catalogue's are in migration 0119, the delivery slots' in 0118.
- **The catalogue keeps its planned enumeration.** `listCatalogue`'s `sort` values map to the shared fields (`RELEVANCE` the shop's category order then name, `PRICE_ASC` and `PRICE_DESC`, `NAME`); a value outside the list reaches the shared sort as a field name and is refused the same way. The console lists take CR-019's `sort` and `direction` when B07 continued 3 applies the mechanism to them.

## Consequences

- Every sorted list pages the same way, proved once against real PostgreSQL with ties, nulls and concurrent inserts (`test/integration/platform/keyset-sort.integration.spec.ts`); without the tie-breaker the test goes red.
- A list that adds a sort field adds its index in the same migration.
- Cursors grow by the size of the keys (a name, a price), still well inside the 512-character limit lists accept.
- Binds: `docs/API.md` section 5, `src/platform/http/keyset-sort.ts`, the catalogue and slot lists, and B07 continued 3's console lists.

## Verification

- Unit: `src/platform/http/keyset-sort.spec.ts` (the allow-list, directions, nulls last, the keyset condition).
- Integration: the probe table walk with ties and concurrent inserts; the catalogue walked two at a time by price (`test/integration/shp/storefront-checkout.integration.spec.ts`).
