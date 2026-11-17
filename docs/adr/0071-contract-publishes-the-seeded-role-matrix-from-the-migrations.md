# ADR-0071: The contract publishes the seeded role matrix, read from the migrations at generation time

- **Status:** Proposed
- **Date:** 2026-11-17
- **Session:** B09x
- **Deciders:** backend track; the owner approves (A-236)

## Context

CR-023 (frontend F6b) asks for the seeded role matrix in the contract, "either a `listRoles` example listing every seeded role with its full permissions, or an `x-seeded-roles` extension on `components`", so the frontend's test fake and route gates can be checked against it in CI. The B09x opener requires it "generated from the IAM seed by `pnpm contract:generate` and failing CI on drift", and never hand-written. The seeded roles and grants live only in the IAM seed migrations (0004, 0008 and some sixty `iam_grant_*` and `iam_regrant_*` files since), written as SQL of several shapes: `VALUES` joins, `CROSS JOIN` with `IN` lists, deletions that move a grant (0103), single-row grants (0174). ADR-0030 and ADR-0031 make the contract a pure function of the planned file and the fragments beside the controllers; nothing in it so far came from the database.

If nothing is decided the matrix is either missing (CR-023 unanswered) or typed into an example by hand, which drifts the first time a session adds a grant.

## Options considered

1. **Parse the migrations' SQL in the generator.** No database needed. Costs a parser for every shape a grant has been written in, and a silent wrong answer the first time a session writes a new shape (a `DELETE ... USING`, a `WHERE r.code <> 'CASHIER'`).
2. **Apply the migrations to a throwaway PostgreSQL 17 and read the result.** Exact by construction: the matrix is what `pnpm db:migrate` produces. Costs Docker for `pnpm contract:generate` (already needed for the tests and `pnpm dev`) and about ten seconds per run.
3. **A complete `listRoles` example kept by an integration test.** The example is typed in and a test compares it with the migrated database. Costs a hand-written list of some 660 grants and a failure in the integration job rather than in the contract's own drift gate.

## Decision

Option 2.

- `scripts/contract/seeded-roles.ts`: `seededRolesFromMigrations()` starts `postgres:17.6-alpine` through Testcontainers, runs `bootstrapDatabase` and `migrate` over `migrations/` exactly as setup does, and `readSeededRoles` reads `iam.role` (not deleted, ordered by id: the order 0004 seeds them in) with each role's `iam.role_permission` codes and `iam.role_limit` rows, sorted by code.
- `generateContractText` writes the result to `components.x-seeded-roles`: one entry per role with `id`, `code`, `name`, `isSystem`, `requiresTotp`, `permissions` and `limits`, the fields of `Role` the seed decides (never `userCount`, `version` or a time). It is an extension, so documentation, never a schema; no shape changes.
- `pnpm contract:generate --check` (the contract job) therefore fails when any migration changes a seeded grant without the contract being regenerated. A caller that already holds a migrated database (the contract tests) passes its roles to `generateContractText` instead of starting a container.
- The matrix shows the seed only. A role created or edited at runtime through `createRole` or `updateRole` is not in it; `listRoles` answers those.

## Consequences

- The frontend can assert its fake and route gates against `components.x-seeded-roles` (CR-023), and every grant migration shows up in the contract diff of its own pull request.
- `pnpm contract:generate` needs Docker, as `pnpm test:contract` and `pnpm dev` already do. Binds `docs/API.md` section 15, `docs/ONBOARDING.md` (the command) and ADR-0030's generation, which it extends without changing.
- A migration that seeds a grant must be followed by `pnpm contract:generate` in the same change; CI says so if it is forgotten.

## Verification

`test/contract/api/seeded-roles.contract.spec.ts` (B09x): the published matrix equals the migrated template database's roles exactly; the credit-note grants are as the owner set them in 0174 (create: Owner, Manager, Accountant; approve: Owner, Manager); a scratch migration revoking a grant makes the generated text differ from the committed file. `test/contract/api/openapi-drift.contract.spec.ts` generates with the test database's roles and matches the committed file. Mutation run by hand in B09x: a scratch `0207_iam_revoke_scratch_grant.sql` turned `pnpm contract:generate --check` red (exit 1), and removing it turned it green.
