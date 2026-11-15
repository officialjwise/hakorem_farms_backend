# ADR-0042: The first branch is bootstrapped by MDM before any grant exists

- **Status:** Proposed (owner approves by merging the B04d continued 2 pull request)
- **Date:** 2026-11-15
- **Session:** B04d continued 2
- **Deciders:** backend track; owner

## Context

A-085 and ADR-0041 require the seeded farm to be written through the services, and the gate of B04d continued 2 requires that no part of the MDM seed is written as SQL. `createBranch` is authorised like every other write (ADR-0017): its caller needs a grant of `mdm.branch.create`. But `iam.role_grant.branch_id` is `NOT NULL` (migration 0004): every grant names a branch. So on an empty database nobody can hold a grant, and nobody can be authorised to create the first branch. The same is true in production on the first day, whatever B04e and B13 decide about the first Owner account. If nothing is decided, the first branch stays a SQL row written outside every MDM rule, without its virtual locations being created the way every later branch's are, and without an audit event.

## Options considered

1. **Keep the first branch as SQL in the IAM seed unit.** Nothing new, but the gate's "no MDM row written as SQL" fails, and the first branch's virtual locations are hand-written rows that can drift from what `createBranch` writes.
2. **Make `role_grant.branch_id` nullable, a grant with no branch meaning "everywhere".** The Owner could create the first branch through `createBranch`. Cost: it changes ADR-0034's scope model and every scope check, for one row on day one. Out of this phase.
3. **Widen the seed's waiver (ADR-0041) to skip authorisation.** Forbidden by ADR-0041: the waiver covers the step-up only.
4. **A bootstrap operation in MDM that creates the first branch as the SYSTEM principal, and only while no branch exists.** It writes the branch, its eight virtual locations and the audit event through the same code as `createBranch`. It cannot be reached over HTTP and refuses once any branch exists.

## Decision

Option 4. `LocationsAdmin.bootstrapFirstBranch(system, body)`:

- accepts only an actor whose kind is `SYSTEM`, and runs in a serializable transaction that first counts `mdm.branch`; any row at all, live or archived, refuses it;
- writes through the same steps as `createBranch` (phone normalisation, code check, the eight virtual locations, the `CREATE` audit event with the SYSTEM principal as actor);
- has no route, no permission and no idempotency key: it either runs on an empty table or refuses.

The seed runs it as its first unit (`mdm-bootstrap`, `src/seed/farm-mdm.ts`) in a request context whose user agent is `hakorem-seed`. Every later branch, the smoke-suite branch included, is created by a granted person through `createBranch`. B04e's first-run bootstrap and B13's production provisioning call the same operation for the farm's first branch.

## Consequences

- No MDM row of the seeded farm is written as SQL; the first branch is audited as written by the System.
- An unauthorised path to a branch exists only on an empty `mdm.branch`. On a running farm it refuses before writing anything.
- Grants scoped to a location wait for the location: the seed writes them in a last SQL unit (`iam-location-grants`, IAM's until B04e).
- Reversal: delete the method and write the first branch another way; nothing else depends on it.

## Verification

- `test/integration/platform/seed.integration.spec.ts`: Dodowa's `CREATE` event is the System's, the test branch's the seeded Owner's, the six locations and the customers the seeded Manager's, all under `hakorem-seed`; no seed source inserts into or updates an `mdm` table.
- `test/integration/mdm/parties-locations.integration.spec.ts`: a branch created through the API gets exactly the eight virtual locations, which the API and the database refuse to change.
