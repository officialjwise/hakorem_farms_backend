# ADR-0033: IAM asks MDM for branch and location codes through a ScopeNames port

- **Status:** Proposed (awaiting the B3 merge)
- **Date:** 2026-11-14
- **Session:** B3
- **Deciders:** backend track; owner approves by merging B3

## Context

The contract's `SessionInfo.grants` (`GrantSummary`) shows each grant's `branchCode` and `locationCode`, which the console displays and uses to pick a branch. Grants live in IAM (layer 2); branches and locations live in MDM (layer 3). IAM may not read MDM's tables (no cross-schema SQL) and may not import MDM (no upward import). `mdm.branch` and `mdm.location` are universal keys, which permits foreign keys only, "no code import" (docs/MODULE_BOUNDARIES.md section 5). MODULE_BOUNDARIES section 6 says a new port needs an ADR.

## Options considered

1. **Copy the codes into `iam.role_grant`.** No port, but a branch code change leaves stale copies, and IAM would own MDM data.
2. **Return ids only and let the client look the codes up.** A second request on every login and reload, against the contract's shape, on slow connections.
3. **A port defined by IAM and implemented by MDM**, registered at start-up, as the approval handlers already are.

## Decision

Option 3.

- `ScopeNames` is declared in `src/modules/iam/application/ports.ts` and exported from IAM's `index.ts`: `codes(tx, branchIds, locationIds)` returns maps of id to code, in the caller's transaction.
- MDM implements it in `src/modules/mdm/infrastructure/scope-names.ts`, reading only its own tables, and registers it with IAM's `ScopeNamesRegistry` in `MdmModule.onModuleInit`.
- IAM fails loudly if no implementation is registered, rather than returning empty codes.
- The row is added to docs/MODULE_BOUNDARIES.md section 6.

## Consequences

- IAM stays below MDM with no import of it; the codes are always current.
- Every module graph that serves sessions must include MDM; `AppModule` does.
- Binds: docs/MODULE_BOUNDARIES.md section 6, the IAM and MDM cards.

## Verification

`test/integration/iam/authentication.integration.spec.ts` (login returns the grant with `branchCode: 'DDW'` and `locationCode: 'SHOP'`) and `test/integration/platform/seed.integration.spec.ts` (the seeded cashier's grant). `pnpm lint` proves IAM imports nothing from MDM.
