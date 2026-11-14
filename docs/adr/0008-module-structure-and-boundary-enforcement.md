# ADR-0008: Module structure, a schema per module, and the boundary lint rule

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

Hard constraint 1 requires a modular monolith with boundaries enforced in code: modules talk through published interfaces and domain events, never by reaching into each other's tables, and a future extraction should cost a refactor, not a rewrite. The non-functional rules require an import-boundary lint rule that fails the build. The build prompt requires every module session to build domain, then application, then infrastructure, then interface.

## Options considered

1. **Convention and code review.** Fails within weeks on a build this size.
2. **Separate packages per module in the workspace.** Strong isolation, heavy tooling, slow builds, and awkward for a single deployable.
3. **Folders inside one application, with a lint rule over import paths and a schema per module in the database.** Light tooling, enforced in both the code and the data.

## Decision

Option 3.

**Code layout**

```text
packages/kernel/                Money, Weight, Quantity, allocate, ids, Clock, Result
src/platform/                   technical mechanisms, no business rules (ADR-0009)
src/modules/<code>/
  index.ts                      the public interface: the only file other modules may import at runtime
  events.ts                     published event contracts: types only
  domain/                       aggregates, value objects, domain services; pure
  application/                  commands, queries, ports
  infrastructure/               Drizzle tables, repositories, adapters
  interface/                    HTTP controllers, request schemas, event subscribers
  <code>.module.ts              NestJS module
```

`<code>` is the lower-case module code from the shared brief: `iam`, `mdm`, `liv`, `inv`, `prc`, `pur`, `pos`, `whl`, `quo`, `shp`, `ord`, `del`, `bil`, `pay`, `fin`, `cap`, `cst`, `rpt`, `ntf`, `doc`, `aud`, `api`.

**Import rules**

1. A module imports another module only through that module's `index.ts`, and only if the other module is in a lower layer (the layer table is in `docs/MODULE_BOUNDARIES.md`).
2. Any module may import any module's `events.ts`, as a type-only import, in order to subscribe.
3. Inside a module, `domain/` imports only `packages/kernel` and its own files. It never imports NestJS, Drizzle, `application/`, `infrastructure/` or `interface/`. `application/` imports `domain/`. `infrastructure/` and `interface/` import `application/` and `domain/`.
4. `packages/kernel` imports nothing. `src/platform` imports only the kernel.
5. Nothing imports from the frontend repository, and no path leaves `backend/`.
6. Import cycles are an error.

**Enforcement in code**

The rule is implemented with `eslint-plugin-boundaries`. Each folder above is an element type, the layer table is the allow-list, and anything not allowed is an error. ESLint runs in the `lint` script, which CI runs on every pull request, so a violation fails the build. The full rule specification is in `docs/MODULE_BOUNDARIES.md`.

**Data layout**

- One PostgreSQL schema per module, named by the module code, plus `platform`.
- A module's code reads and writes only its own schema. Cross-module foreign keys are allowed only as described in ADR-0011.
- Migrations are plain SQL. Each migration file touches one schema.

**Enforcement in data**

Two CI checks, delivered in B2:

- A query over `pg_constraint` lists every foreign key that crosses schemas and fails if one is not on the allow-list in `docs/MODULE_BOUNDARIES.md`.
- A scan of each module's `infrastructure/` folder fails if it names a schema other than its own.

## Consequences

- A boundary violation is caught by the editor and the pipeline, not in review.
- Extracting a module later means replacing in-process calls to its `index.ts` with a client and dropping its cross-schema foreign keys.
- Every module pays for a public interface file and event contracts even when it has one consumer.
- Binds: `docs/MODULE_BOUNDARIES.md`, the `hakorem-module` skill, B2's lint configuration.

## Verification

- B2: the lint rule is wired in, and a deliberately illegal import in a fixture fails the `lint` script.
- B2: both data checks run in CI.
- B3: the Product vertical slice passes all rules and becomes the reference shape.
