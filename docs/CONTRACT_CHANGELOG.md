# Contract changelog

Every change to `contract/openapi.yaml`, newest first. A breaking change needs a major version bump, an entry here, and a line at the top of the session report so the frontend track picks it up.

Version numbers follow semantic versioning: a major bump breaks an existing client, a minor bump adds operations or optional fields, a patch fixes descriptions or examples.

## 1.0.1 (2026-11-13, B1)

Examples and one description only. No operation, field or schema changed; a client generated from 1.0.0 needs no change.

- Catalogue and product page: catch-weight prices are per kilogram, as `priceBasis` says (goat meat GHS 26.00 per kg, not a pack price).
- Quotes: the standard-rated delivery fee carries its levies (GHS 12.00 on GHS 60.00); the quote list no longer repeats one total.
- Animals and stock on hand: an animal's `priceBand` is the band for its weight band; processed animals in processing and trace examples are no longer animals shown alive elsewhere.
- Receivables: Royal Palm Hotel's overdue invoice is 24 days late (1 to 30 bucket), consistent with its account not being on hold.
- Exceptions: the stock exception item carries abuse case 11 only; case 10 is a device counter gap.
- `CapitalTransactionCreate.unitPricePesewas`: the default is GHS 100.00 per unit, matching every example and ASSUMPTIONS A-031.

## 1.0.0 (2026-11-13, B1)

First version, written by hand before any endpoint exists so the frontend can build against a mock server.

- **Scope:** 600 operations on 476 paths, covering every module in the shared brief, including those not built until B12. 807 schemas. Tagged by module, grouped for Redoc with `x-tagGroups`.
- **Conventions:** money as integer `...Pesewas` fields with `currency` on the object; weights, quantities and percentages as decimal strings; one error envelope with `correlationId`; cursor pagination; `Idempotency-Key` on every state-changing request and `X-CSRF-Token` on cookie-authenticated ones; 202 `ApprovalPending` for maker-checker actions (ADR-0029).
- **Security schemes:** staff, customer and investor session cookies (`__Host-hk_s_at`, `__Host-hk_c_at`, `__Host-hk_i_at`), integration API keys, and a POS device credential.
- **Extensions:** `x-permission` on every staff operation names the permission the domain layer checks; `x-owner-module` where the owning module differs from the tag.
- **Examples:** every list operation has at least five realistic rows from one consistent seeded farm in Dodowa. Counter sale, tax, processing cost and distribution figures are computed with the same largest-remainder rule the backend will use, so they are exact.
- **Frontend requests:** CR-001 implemented (`unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, `totalValueAtCostPesewas`, `asOf` on `GET /stock/on-hand`; cost and price never share a field). Enum values are upper case: `WEIGHTED_AVERAGE`, `SPECIFIC_IDENTIFICATION`.
- **Lint:** `npx @redocly/cli lint contract/openapi.yaml` passes with no errors and no warnings under `redocly.yaml` (recommended rules; the localhost server warning is turned off because the local and mock servers are listed on purpose).
