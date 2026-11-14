---
name: hakorem-frontend
description: "Use when a backend task decides something a screen depends on: the shape of a response a screen renders, a list total a screen must not compute, how many requests a screen needs to become useful, the weight of a catalogue or listing response on a slow mobile connection, which fields a customer or investor may see versus staff only, error messages and labels the API returns for display, the screen-facing side of an answer to `../frontend/docs/CONTRACT_REQUESTS.md` (hakorem-endpoint leads on the contract change itself), or a contract change the frontend track must pick up. Also when someone asks to build or restyle a storefront, back office, point-of-sale or driver screen, component, design token or Storybook story in this repository: this repository has no screens, so send that work to the frontend repository, which keeps its own skills. Never edit anything under `../frontend`. Load it first for a question, plan or estimate on these too, even before the code exists."
---

# Frontend: what the backend owes a screen, and where screen work goes

This repository is the backend. It has no screens, no components and no design tokens. Screen work belongs in `../frontend/` (`apps/storefront`, `apps/console`, `packages/ui`, `packages/api-client`), which has its own `CLAUDE.md` and skills (`hakorem-screen`, `hakorem-ui-component`, `hakorem-api-call`, `hakorem-contract-sync`, `hakorem-pos-offline`, `hakorem-money-ui`, `hakorem-storefront-perf`, `hakorem-a11y`, `hakorem-frontend-adr`). The two repositories are joined only by `contract/openapi.yaml`; neither imports code from the other, and neither session writes in the other's folder (`docs/SHARED_BRIEF.md`, hard constraints 2 and 3).

## If asked to build or change a screen here

Stop and say so. Do not scaffold a React or Next.js file in this repository and do not edit `../frontend`. Tell the person that the work belongs in a frontend session, which starts by running `./scripts/sync-contract.sh` there. If the screen needs something the contract does not offer, that is a contract request: the frontend writes it to `frontend/docs/CONTRACT_REQUESTS.md`; the backend reads it at the start of the next session. A backend session may read that file (from B4 onward) and never edits it.

## What a backend decision owes the screen (checklist)

1. **The contract covers the screen.** Every screen's data is reachable through documented operations with realistic examples (at least five rows on a list). A screen must not need an undocumented field.
2. **One round trip to be useful.** A screen becomes useful in a single request. Embed the small related objects it displays (`product { id, sku, name }`, `createdBy { id, displayName }`) and put settlement or status projections on the list, as `bil.document_settlement` does for invoices. A dashboard tile or a list never needs a per-row follow-up call.
3. **The frontend never computes business numbers.** Totals, balances, outstanding amounts, stock value at cost, tax, change due, variance and ageing buckets come from the API as named fields (`totalValueAtCostPesewas`), computed over everything matching the filter and not only the visible page. If a screen would have to add two fields, add the sum to the response.
4. **Cost and price never share a field.** Staff screens get `unitCostPesewas` and `valueAtCostPesewas` with `valuationMethod` and `asOf`; price fields are named for price (`listPricePesewas`, `priceBand`). See ADR-0029 and CR-001.
5. **Customer-facing versus staff-only is a schema boundary.** A customer's order (`CustomerOrder`) and public catalogue carry no cost, floor, ceiling, variance, margin or approval data. Investor endpoints live under `/investor/` and return only the caller's own capital, share and distributions. Never reuse a staff schema for a customer response and "hide" fields in the UI.
6. **Low-bandwidth budget.** A catalogue listing page is under 300 KB compressed, largest contentful paint under 2.5 s on simulated 3G. Therefore: cursor-paginated lists with a sensible default `limit`; image URLs for responsive variants (`platform.stored_file_variant`) and no inline image data; no unbounded embedded arrays; sparse fields on list rows, full detail on the detail operation; anonymous catalogue reads are cacheable and carry no per-user data.
7. **Money, weight and time formats.** Integer pesewas, decimal strings in kilograms with three places, RFC 3339 UTC times, calendar business dates in Africa/Accra. The frontend formats at the edge with `formatMoney` and `formatWeight`; do not send preformatted currency strings.
8. **Errors a screen can show.** The error envelope carries a stable `code`, a plain `message` fit for display through the translation layer, `details` with field paths for form errors, and the `correlationId` the user quotes to support. A business refusal is `422` with a code; an action needing a second person is `202 ApprovalPending`; a quote-required price is a normal result, not an error.
9. **Pages that need the customer's identity** are fetched in the browser; server-rendered catalogue pages are anonymous (ADR-0016). Do not design a response that forces the storefront server to carry a customer cookie.
10. **Offline surfaces.** Anything the POS or driver screen needs while offline (prices with an age, the open shift, the product list) is a documented, cacheable operation. Sync responses give per-record outcomes (hakorem-offline).
11. **Checkout states for catch-weight.** Return the estimated total, the highest possible total and the final-charge rule so the screen can display them (ADR-0021). `REQUEST_TO_BUY` products return a request-for-quote action instead of an add-to-cart (ADR-0019).
12. **Localisation readiness.** Strings the API returns for display (error messages, status labels, notification and document labels) go through the translation layer; English ships first. No string is hard-coded in a handler.

## Making a contract change the frontend can absorb

Follow hakorem-endpoint for the mechanics. In addition: additive changes bump the minor version; breaking changes bump the major version, get an entry in `docs/CONTRACT_CHANGELOG.md` and are named at the top of the session report. Record any frontend request you decline, with the reason, in the session report. The frontend regenerates its client from the new contract; do not describe types for it in prose.

## Correct and incorrect

```yaml
# RIGHT: totals from the API, cost and price separate, valuation stated, one request renders the screen
StockOnHandList:
  properties:
    items: { type: array, items: { $ref: "#/components/schemas/StockOnHandLine" } }   # unitCostPesewas, valueAtCostPesewas, valuationMethod, listPricePesewas
    totalValueAtCostPesewas: { type: integer, minimum: 0 }
    currency: { type: string, enum: [GHS] }
    asOf: { type: string, format: date-time }
    page: { $ref: "#/components/schemas/Page" }
```

```yaml
# WRONG: one field whose meaning depends on context, no total, a staff schema reused for customers
StockLine: { properties: { value: { type: number }, price: { type: number } } }     # float; cost or price?
CustomerOrderLine: { allOf: [ { $ref: "#/components/schemas/SalesOrderLine" } ] }   # leaks floorPricePesewas, varianceReason
```

```ts
// WRONG (in the frontend, which the backend must make unnecessary): summing rows to show a total
const total = items.reduce((a, i) => a + i.valueAtCostPesewas, 0);   // only the visible page; wrong
```
