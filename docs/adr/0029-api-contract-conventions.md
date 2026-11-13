# ADR-0029: API contract conventions: money fields, decimal strings, one error envelope, approvals as 202

- **Status:** Proposed (written in B1 with contract 1.0.0; for the owner and the frontend track to confirm)
- **Date:** 2026-11-13
- **Session:** B1
- **Deciders:** backend track; frontend track consulted through CR-001

## Context

The build prompt requires shared envelopes defined once: an error shape with a correlation id, pagination, an idempotency key header, money as an integer-pesewa field with an explicit currency, and weight in kilograms to three decimal places. The frontend's contract request CR-001 asks that cost and selling price are never the same field, that every stock line carries `unitCostPesewas` and `valueAtCostPesewas`, that totals come from the API (the frontend never sums rows), and that a valuation basis and as-of time are given. The frontend's ADR-0007 formats money from integer pesewas with its own `formatMoney(pesewas)`.

## Options considered

1. **Money as an object** `{ "amount": 127500, "currency": "GHS" }` on every field. Explicit, but every field doubles in size and the frontend unwraps every value; a page of 25 stock lines carries 100 redundant currency codes.
2. **Money as integer fields named for what they are**, `listPricePesewas`, `unitCostPesewas`, with one `currency` field on every object that carries money. Matches CR-001 and the frontend's formatter; the unit is in the name, so a field cannot be misread.

## Decision

Option 2, and these conventions, all written into `contract/openapi.yaml` and explained in `docs/API.md`:

- **Money.** Integer pesewas in fields ending `Pesewas`, JSON integers, never negative, never floats. Every object with a money field has `currency` (`GHS` only in version 1). Direction is a separate field (`side`, `direction`, `isNegative`, `varianceDirection`).
- **Cost and price are always separate fields.** Cost fields say cost (`unitCostPesewas`, `valueAtCostPesewas`, `accumulatedCostPesewas`); price fields say price (`listPricePesewas`, `agreedUnitPricePesewas`, `priceBand`).
- **Totals come from the API.** List responses that a screen totals carry the total as its own field (`totalValueAtCostPesewas`, `totalOutstandingPesewas`, `totalDebitPesewas`), computed over everything matching the filter, not just the page.
- **Decimals are strings.** Weights (`...Kg`, three places), quantities (three places), percentages, units and coordinates are decimal strings with fixed patterns, so no float ever touches them. Every captured weight carries a `weightSource`.
- **Enumerations are upper snake case** (`WEIGHTED_AVERAGE`, `SPECIFIC_IDENTIFICATION`), like every other enum in the contract. CR-001's example used lower case; the meaning is unchanged.
- **One error envelope**, `{ "error": { "code", "message", "correlationId", "details" } }`, on every non-2xx response, with a stable `code` catalogue in `docs/API.md`.
- **A business refusal is 422 with a code**; a version mismatch or a reused idempotency key with a different body is 409.
- **An action that needs a second person returns 202** with `ApprovalPending`; nothing takes effect until a different user approves.
- **Cursor pagination** with `cursor` and `limit`; responses carry `page.nextCursor` and `page.hasMore`.
- **Every state-changing request sends `Idempotency-Key`**, except the operations ADR-0014 lists (login and token endpoints, inbound webhooks, batch syncs whose records carry their own ids, and POSTs that change nothing); cookie-authenticated ones also send `X-CSRF-Token`. Records created offline carry a client-generated UUIDv7 id, which is their idempotency identity.
- **Optimistic locking**: updates send the `version` they read.
- **Customers and investors get their own shapes.** A customer's order (`CustomerOrder`) carries no cost, floor, ceiling or variance; investor endpoints live under `/investor/` and return only the caller's own data.
- **Times** are UTC RFC 3339; business dates are calendar dates in Africa/Accra.

## Consequences

- CR-001 is implemented as requested, except that enum values are upper case.
- A generated client gets plain integers and strings: no money object to unwrap, and nothing a float can round.
- A new money field must follow the naming rule; the `hakorem-endpoint` skill checks it.
- Binds: `contract/openapi.yaml`, `docs/API.md`, every module session from B2 onward, which generates the contract from code and must reproduce these shapes.

## Verification

- B1: the builder validated every example against its schema, the Redocly lint passes with no errors or warnings.
- B2 onward: CI fails if the generated contract differs from the committed one.
