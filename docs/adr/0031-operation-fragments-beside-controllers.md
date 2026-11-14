# ADR-0031: An implemented operation's contract text lives beside its controller and is checked against the route

- **Status:** Proposed (awaiting the B3 merge)
- **Date:** 2026-11-14
- **Session:** B3
- **Deciders:** backend track; owner approves by merging B3

## Context

ADR-0030 made `contract/openapi.yaml` the merge of the operations the code documents with `@nestjs/swagger` and the operations still planned. B3 implements the first seventeen. Two requirements meet here: FR-API-002 (the contract is generated from code and CI fails on any diff) and "never break the contract silently" (hard constraint 3). An operation's published text in B1 is rich: examples with Ghanaian rows, shared `$ref` responses, `x-permission`, descriptions the frontend reads. Swagger decorators produce a different document: other key order, inline schemas, no examples unless repeated in decorators, and nothing that ties the text to what the guard enforces. Rebuilding each B1 operation from decorators would change the published file for no reason and still leave the text free to disagree with the route.

## Options considered

1. **Swagger decorators per operation.** As ADR-0030 wrote. Every moved operation's text would be re-expressed in decorators and come out different; examples and `$ref`s would be duplicated in TypeScript; nothing would check that the permission in the text is the one the handler checks.
2. **The B1 text, moved verbatim into a YAML fragment beside the controller, checked against the route's own metadata.** The published text does not change when an operation moves into code; the generator refuses a fragment that contradicts its route.

## Decision

Option 2.

- Each implemented operation has `openapi/<operationId>.yaml` in its module's `interface/` folder (platform's in `src/platform/<area>/openapi/`). The file is the operation object, moved verbatim from `contract/planned/openapi.planned.yaml` in the change that implements it, then edited as the code requires.
- `scripts/contract/code-document.ts` builds the application's module graph in preview mode, walks every controller route, and for each takes the method and path from the route, the `operationId` from its `@Operation` metadata (`src/platform/http/operation.ts`), and the text from the fragment. It refuses: a route without `@Operation`; a route without a fragment; a fragment no route implements; a fragment whose `x-permission`, Idempotency-Key parameter, CSRF parameter (`CsrfTokenOptional` exactly when the route accepts a login challenge) or security schemes disagree with the route's metadata; a GET with a request body.
- A planned path whose operations have all moved stays in the planned file as an empty path item, so it keeps its place in the published order. A path whose operations are split between code and the planned file emits its methods in the usual HTTP order. Moving an operation therefore changes the published file only where the operation itself changed.
- Shared components (schemas, parameters, responses) stay in the planned file until the code owns them.
- `x-error-codes` on each implemented operation lists the codes it can raise (A-074).
- A test parses every implemented operation's request example with the zod schema its route validates with, so code and contract accept the same requests.

## Consequences

- From B3, moving an operation into code is: write the route with `@Operation`, cut the operation from the planned file into the fragment, regenerate. The 1.2.0 diff is 196 lines, all intended.
- The `@nestjs/swagger` decorators are no longer the source of operation text; `@Operation` applies `ApiOperation` only for the operation id. ADR-0030's "documents with `@nestjs/swagger`" is amended by this ADR; the rest of ADR-0030 stands.
- A reviewer reads the contract change as a YAML diff beside the code that implements it.
- Binds: `scripts/contract/`, the `hakorem-endpoint` skill (the fragment is the contract step), every module session.

## Verification

- `test/contract/api/openapi-drift.contract.spec.ts`: the committed file equals the generated one; a route without a fragment, a fragment without a route, and a fragment that contradicts its route each fail; an operation in both places fails; 600 operations published, 583 planned.
- `test/contract/b3/slice-and-login.contract.spec.ts`: every request example parses with its route's schema; every implemented response matches its schema.
- `scripts/contract/versioning.ts` passes 1.1.0 to 1.2.0 as a minor change.
