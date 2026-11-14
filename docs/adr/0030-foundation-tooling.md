# ADR-0030: Foundation tooling: the migration runner, the contract generator and the kernel's decimals

- **Status:** Proposed (awaiting the B2 merge)
- **Date:** 2026-11-14
- **Session:** B2
- **Deciders:** backend track; owner approves by merging B2

## Context

B2 builds the foundation every module session stands on. Four choices were left open by the earlier ADRs: how plain SQL migrations are run and rolled back, how a contract that B1 wrote by hand becomes "generated from code" (FR-API-002) when B2 has no module code, how the kernel handles exact decimal rates when ADR-0001 says "a decimal library" and `docs/MODULE_BOUNDARIES.md` says the kernel imports nothing, and how the integration suite isolates tests when `LEDGER` tables reject `TRUNCATE`.

## Options considered

1. **Migrations:** drizzle-kit's migrator (journal format, no down migrations), a third-party SQL runner, or a small runner of our own.
2. **Contract:** generate only what the code documents (the published file would shrink from 600 operations to none and break the frontend), keep the hand-written file as both input and output (circular: the drift check could never fail for planned operations), or merge a planned contract with the code's document.
3. **Kernel decimals:** depend on a decimal library, or represent a rate exactly as two bigints.

## Decision

**Migration runner** (`src/platform/database/migration-runner.ts`, ours, about 200 lines).

- Files are `migrations/NNNN_<schema>_<verb>_<subject>.sql` with `-- migrate:up` and `-- migrate:down` sections, or a `-- forward-fix:` header instead of a down section. A file with neither is refused. `-- migrate:no-transaction` marks a file that cannot run in a transaction.
- It logs in as `hk_migrator` and does everything as `hk_owner` through `SET ROLE` (the migrator is a member without inheritance), so every object is owned by the role nobody logs in as (ADR-0024).
- Applied migrations are recorded in `migration.applied_migration` with a SHA-256 checksum. An applied file that has changed is refused. The `migration` schema is tooling, not application data: no runtime role can use it, and it is outside the table-class check.
- Each migration runs in its own transaction; a failure leaves nothing behind. A session-level advisory lock stops two runners overlapping.
- `db:rollback` runs the last migration's down section, or prints its forward fix, changes nothing and exits 2.
- Roles are created by `db:bootstrap` in development and test only, from the role URLs in `.env`; staging and production are provisioned by hand in B13.

**Contract generation** (`scripts/contract/`).

- The operations B1 wrote by hand now live in `contract/planned/openapi.planned.yaml`. `contract/openapi.yaml` is generated: every operation the code documents with `@nestjs/swagger`, plus every planned operation. An operation is in exactly one place: an operation in both, or a schema defined differently in both, fails generation. A session that implements an operation deletes it from the planned file in the same change.
- The code's document is read from the NestJS module graph in preview mode, so generation needs no database. Paths are relative to the server URL, which already ends in `/v1`.
- A deterministic emitter reproduces the B1 file's YAML style byte for byte (checked: the 3,066,649-byte contract round-trips identically), so "CI fails on any diff" (`pnpm contract:generate --check`) means a real change, never a reformat.
- In B2 the code documents no operation (health is excluded until B3 adds the checks its contract description lists), so the generated contract equals 1.1.0 exactly. B2 makes no contract change.
- The error codes `docs/API.md` marks "Added" are adopted operation by operation as each operation moves into code, where the code knows which codes it raises. Adding them by hand to 600 planned operations would be guesswork that no code checks.
- `scripts/contract/versioning.ts` compares a pull request's contract with its base: a breaking change (removed operation, schema or property, a newly required property, a removed enumeration value, a changed type) needs a new major version, and any change needs a new version (FR-API-001).

**Kernel decimals.** The kernel imports nothing, as `docs/MODULE_BOUNDARIES.md` requires. A rate is `Rate`: an exact percentage parsed from a string into a bigint numerator over a power-of-ten denominator. That is exactly the precision a decimal library would give for ADR-0001's uses (a percentage of an amount, rounded half-up once), and it adds no dependency to the money path.

**Test isolation.** One PostgreSQL 17 and one Redis 7 container per run; migrations applied once into a template database; each test file clones its own database from the template. Tests connect as `hk_app`; tamper tests connect as the superuser.

**Versions.** The brief fixes TypeScript 5.x and NestJS 11, which are pinned (5.9.3, 11.2.8) although newer majors exist. Every dependency is pinned exactly, and pnpm refuses any version published less than 14 days ago (`minimumReleaseAge`). Vitest is 4.x and zod 4.x because the 3.x lines carry high-severity advisories.

## Consequences

- From B3, a session that implements an operation writes it in code and deletes it from the planned file; CI fails until both are done.
- The planned file is hand-edited until it is empty, under the same version and changelog rules as before.
- The runner is ours to maintain, but it is small, tested against real PostgreSQL (apply, rollback, edited-file refusal, forward fix, failure rollback), and has no hidden behaviour.
- Binds: the `hakorem-migration` and `hakorem-endpoint` skills, `docs/API.md` section 10.3, `docs/ONBOARDING.md` section 4.

## Verification

- `test/integration/platform/migration-runner.integration.spec.ts`: apply, rollback, the edited-file refusal, the forward fix, and a failed migration recording nothing.
- `test/contract/api/openapi-drift.contract.spec.ts › fails when the generated contract differs from the committed one`, and the duplicate-operation refusal.
- `test/contract/api/versioning.contract.spec.ts › fails on an unversioned breaking change`.
- The kernel's `Rate` tests, at 100 percent branch coverage.
