---
name: hakorem-endpoint
description: "Use when adding, changing, renaming, deprecating or removing an HTTP endpoint, route, controller, request or response schema, DTO, `operationId`, `x-permission`, error code, query filter, sort, pagination or list total, response example, or when regenerating, diffing or linting `contract/openapi.yaml` (`pnpm contract:generate`, `npx @redocly/cli lint contract/openapi.yaml`), bumping the contract version, writing `docs/CONTRACT_CHANGELOG.md`, or answering a request in `../frontend/docs/CONTRACT_REQUESTS.md`. Covers validation, domain-level authorisation, idempotency key, CSRF, error envelope, rate limit and OpenAPI annotation. When the endpoint touches login, payments, webhooks, exports, uploads or permissions, also run hakorem-security-review; when it must work offline, also hakorem-offline."
---

# Endpoints: the contract is the product

Conventions: `docs/adr/0029-api-contract-conventions.md` and `docs/API.md`. Idempotency: `docs/adr/0014-idempotency-and-external-references.md`. Authentication and CSRF: `docs/adr/0016-authentication.md`. Authorisation and approvals: `docs/adr/0017-authorisation-and-maker-checker.md`. Secure defaults for a new endpoint: `docs/security/SECURITY_ARCHITECTURE.md` section 13. The contract is `contract/openapi.yaml` (3 MB; never read it whole, grep for the `operationId` or path). Never break it silently.

## Checklist for a new or changed endpoint

1. **Contract first, or generated and diffed.** From B2 the spec is generated from code and CI fails if it differs from the committed file. From B3 (ADR-0031) the route declares `@Operation({ operationId, access, realms, permission, idempotent, csrf, rateLimit })`, and the operation's text is cut from `contract/planned/openapi.planned.yaml` into `interface/openapi/<operationId>.yaml` beside the controller, leaving an empty path item behind if the path has no planned operation left; the generator refuses a fragment that contradicts the route. Regenerate with `pnpm contract:generate`, lint with `npx @redocly/cli lint contract/openapi.yaml` (no errors, no warnings), commit the file in the same change.
2. **Naming.** `operationId` reads as a client method (`createStockAdjustment`, `listPriceListVersions`); tagged by module code; `x-permission: <module>.<resource>.<action>` on the operation and in its description.
3. **Validate at the boundary.** A schema for every inbound payload; the parsed typed command is what travels inward; unknown fields are rejected. No `any`, no unvalidated `req.body`.
4. **Authorise in the handler, not only the controller.** The command or query handler calls the IAM policy engine with permission, branch, location and ownership. The permission is a seeded row (hakorem-migration), granted to no role until someone adds it. A handler or route with no declared permission fails the B3 handler-walk test.
5. **Object-level ownership.** A customer reads only their own orders; an investor only under `/investor/...` and only their own data; a driver only assigned deliveries; a cashier only their own shift. A record that exists but is not yours answers `404 NOT_FOUND` or `403 FORBIDDEN` without leaking existence detail.
6. **State-changing means idempotent.** Reference `#/components/parameters/IdempotencyKey` (a UUID header). Cookie-authenticated operations also reference `CsrfToken` (`X-CSRF-Token`). The key row is the first write of the business transaction; same key with the same body returns the stored response, a different body is `409`. Records created offline use their client UUIDv7 id as the key, so the offline sync operations (`syncOfflineSales`, `syncDriverEvents`) take no `Idempotency-Key` header.
7. **One error envelope.** `{ "error": { "code", "message", "correlationId", "details" } }` on every non-2xx, with a stable `code` from the catalogue in `docs/API.md`. `400` malformed, `401`, `403`, `404`, `409` version mismatch or key reuse, `422` business refusal with a code, `429`, `500` with a correlation id and no internal detail. An action needing a second person returns `202` with `ApprovalPending`.
8. **Optimistic locking.** Updates send the `version` they read; a mismatch is `409`.
9. **Lists.** Cursor pagination (`cursor`, `limit`; response `page.nextCursor`, `page.hasMore`). Never offset. A total a screen displays is its own field (`totalValueAtCostPesewas`, `totalOutstandingPesewas`) computed over everything matching the filter. At least five realistic rows in the example (Ghanaian names, catalogue products, plausible prices).
10. **Money and decimals.** Fields ending `Pesewas` are JSON integers, never negative, with `currency` on the object. Direction is a separate field. Cost fields say cost, price fields say price; they are never one field. Weights (`...Kg`), quantities, percentages are decimal strings with fixed patterns, and captured weights carry `weightSource`. Enumerations are upper snake case. Times are RFC 3339 UTC; business dates are calendar dates in Africa/Accra.
11. **Customers and investors get their own shapes.** `CustomerOrder` carries no cost, floor, ceiling or variance. Staff-only fields never appear in a customer or public schema.
12. **Rate limit.** Name the endpoint group (login/TOTP/reset, public quote form, checkout and payment initiation, webhook, console, public catalogue, integrations) and add the `429` response. Authentication, quote form, checkout and integration limits fail closed.
13. **Side effects through the outbox.** No provider, SMS or email call in the request; publish an event. Audit the action with actor and before and after values.
14. **Business rules are not in the controller.** If a test must call HTTP to exercise a calculation, it is in the wrong layer.
15. **Document it.** The module's section of `docs/API.md`; the SRS requirement id (`FR-<MOD>-nnn`) in the commit or pull request.

## Versioning and the changelog

- Additive change (new optional field, new endpoint): minor bump, entry in `docs/CONTRACT_CHANGELOG.md`.
- Breaking change (removed or renamed field, changed type, new required input, tightened enum): major bump, entry in the changelog, and the first lines of the session report, so the frontend track picks it up. Never silent.
- Frontend requests are read from `../frontend/docs/CONTRACT_REQUESTS.md` from B4 onward. Implement what is reasonable, record in the session report what you declined and why. Never edit that file and never open frontend source.
- A decision that changes a convention (envelope, pagination, money shape) is an ADR (hakorem-adr).

## Correct and incorrect

```yaml
# RIGHT
/stock-adjustments:
  post:
    operationId: createStockAdjustment
    tags: [inv]
    x-permission: inv.adjustment.create
    parameters:
      - $ref: "#/components/parameters/IdempotencyKey"
      - $ref: "#/components/parameters/CsrfToken"
    security: [{ staffSession: [] }, { apiKey: [] }]
    responses:
      "201": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/StockAdjustment" } } } }
      "202": { $ref: "#/components/responses/ApprovalPending" }
      "422": { $ref: "#/components/responses/BusinessRuleViolation" }
      "429": { $ref: "#/components/responses/RateLimited" }
```

```ts
// RIGHT: controller parses and delegates; the handler authorises and does the work
@Post()
create(@Body(zodPipe(CreateStockAdjustment)) cmd: CreateStockAdjustmentCmd, @Actor() actor: Principal) {
  return this.handler.execute(actor, cmd);   // handler calls policy.authorise(actor, "inv.adjustment.create", {...})
}
```

```ts
// WRONG: float money, offset paging, role check only in the controller, a total the client must add up
@Post() @Roles("storekeeper")
create(@Body() body: any) { return { total: body.lines.reduce((a, l) => a + l.price * l.qty, 0), page: 3 }; }
```

## Test expectations

Unit for any rule; integration for the handler through its public interface including the wrong role refused, the wrong branch refused, a replay returning the stored result, and two concurrent identical requests producing one effect; contract tests assert every response shape against `contract/openapi.yaml`; end to end for a critical flow. See `docs/TEST_STRATEGY.md` and use hakorem-tests.
