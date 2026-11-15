# ADR-0043: The farm's first Owner is bootstrapped by IAM before any staff account exists

- **Status:** Proposed (owner approves by merging the B04e pull request)
- **Date:** 2026-11-15
- **Session:** B04e
- **Deciders:** backend track; owner

## Context

A-085 and ADR-0041 require the seeded farm to be written through the services, and B04e's gate requires the IAM seed to be written through the IAM services. `createUser` and `createGrant` are authorised like every other write (ADR-0017): the caller needs a current grant of `iam.user.create` and `iam.grant.manage`, and may grant only a role whose every permission they hold (FR-IAM-022). On an empty database nobody holds a grant, so nobody can create the first account. The same is true in production on day one. ADR-0042 met the same problem for the first branch and said B04e's first-run bootstrap would call it for the farm's first branch.

## Options considered

1. **Keep the first Owner as SQL in the seed.** Nothing new, but the gate's "IAM seed through the IAM services" fails, and production would need a hand-written row outside every IAM rule (no audit event, no temporary password, no forced change).
2. **Widen the seed's waiver (ADR-0041) to skip authorisation.** Forbidden by ADR-0041: the waiver covers the step-up only, and it would not help production.
3. **A bootstrap operation in IAM that creates the first Owner as the SYSTEM principal, and only while no staff account exists.** It writes through the same steps as `createUser` and `createGrant`, cannot be reached over HTTP, and refuses once any staff account exists.

## Decision

Option 3. `AccessAdmin.bootstrapFirstOwner(system, { displayName, email, phone, branchId })`:

- accepts only an actor whose kind is `SYSTEM`, and runs in a serializable transaction that first looks for any `STAFF` row in `iam.user_account`, live or archived; one refuses it;
- writes the account with a temporary password and `must_change_password`, then the Owner grant at the branch, through the same code as `createUser` and `createGrant` (identifier checks, the grant rules, the `CREATE` and `PERMISSION_CHANGE` audit events and `iam.RoleGranted`, the System as actor). The System holds no grant, so the "no role beyond what the granter holds" comparison is skipped for it alone;
- has no route, no permission and no idempotency key, and returns the temporary password once.

The seed runs it in `iam-services` (`src/seed/farm-iam.ts`), after `mdm-bootstrap`, in a request context whose user agent is `hakorem-seed`. The seeded Owner then signs in with the temporary password and sets the seeded password through the real first-login flow, and creates every other account and grant through `createUser` and `createGrant`. B13's production provisioning calls the same operation, after `bootstrapFirstBranch`, and hands the temporary password to the owner.

## Consequences

- No IAM row of the seeded farm is written as SQL; the first Owner and their grant are audited as written by the System, every other account and grant by the seeded Owner.
- An unauthorised path to an account exists only while `iam.user_account` holds no staff row. On a running farm it refuses before writing anything.
- Reversal: delete the method and provision the first Owner another way; nothing else depends on it.

## Verification

- `test/integration/platform/seed.integration.spec.ts`: the Owner's `CREATE` event and Owner grant are the System's, the seven other accounts and their grants the seeded Owner's, all under `hakorem-seed`; every seeded account changed its temporary password on a login challenge; no seed source inserts into or updates an `iam` or `mdm` table, and every seed unit is a service unit.
