# ADR-0041: The seeded farm is written through the services, as the seeded staff

- **Status:** Proposed (owner approves by merging the B04d continued pull request)
- **Date:** 2026-11-15
- **Session:** B04d continued
- **Deciders:** backend track; owner

## Context

hakorem-seed and A-085 require the seeded farm to be written through the modules' public services, so seed data passes every rule production applies, and the gate of B04d continued requires tax scheme version 1 "drafted by the seeded Accountant and approved by the seeded Owner". Until now every seed unit wrote SQL in one transaction the runner opened (`SeedUnit.run(client)`). The services open their own transactions through `UnitOfWork`, need the application's module graph, and check grants, step-up and maker-checker. Two facts make that hard: the seeded Owner, Manager and Accountant enrol their authenticator at first login (B3's first-run flow), so they hold no TOTP credential while the seed runs; and the tax, price list and promotion approvals and every `mdm.tax.manage` call demand a fresh step-up. If nothing is decided, the seed keeps writing SQL that can drift from what the services would accept, and `calculateTax` has no scheme on a fresh setup.

## Options considered

1. **Keep SQL, mirroring each rule by hand.** No new mechanism; every rule the services enforce is repeated in the seed and drifts the first time a rule changes (the B4 seed already re-implemented the approval payload hash).
2. **Seed a TOTP secret for the seeded staff.** The real step-up runs, but the first-login enrolment the console's first-run flow is built on disappears, and a secret has to be generated and printed per machine.
3. **Run the services in the application context and accept the seed's own step-up.** `pnpm db:seed` starts the module graph without HTTP and calls the services as the seeded staff; the one check a seed cannot satisfy, a person typing a code, is waived for the seed's own calls only.

## Decision

Option 3.

- `SeedUnit` is `SQL` (writes in a transaction the runner opens, for slices whose services do not exist yet) or `SERVICE` (`run(app: INestApplicationContext)`). `runSeedUnits(pool, app, units)` in `src/seed/run-seed.ts` runs both, in order, for `pnpm db:seed` and for the tests that load the seeded farm.
- `pnpm db:seed` refuses production three ways first (unchanged), then starts `AppModule` as an application context on the real clock. A version asked to start at the seed instant starts at its approval instead (ADR-0036, ADR-0039), as a late approval would in production; a fixed clock was rejected because grants written by the SQL units start at the database's `now()`.
- Service units act as seeded people through `SeedStaff` (`src/seed/seed-staff.ts`): each call runs in a request context of its own whose user agent is `hakorem-seed`, so the audit trail says the seed wrote it. Inside `SeedStaff.as` only, and only for a seeded principal, a `STEP_UP_REQUIRED` or `TOTP_ENROLMENT_REQUIRED` refusal is treated as passed. The Authoriser raises those only after it has found a grant that allows the permission, so grants, scope, maker-checker, idempotency, audit and outbox all run as in production. The waiver is removed when the call returns.
- A service unit finds a record by its natural code before writing it and passes a fixed idempotency key, so a second run writes nothing.
- The MDM services the seed calls are exported from `src/modules/mdm/index.ts`; no other module calls them.

## Consequences

- The seeded farm's catalogue, price lists, tax scheme and promotions now pass every MDM rule. A rule change that the seed data breaks fails `pnpm db:seed` and the seed test, not a later session.
- `pnpm db:seed` needs Redis and the full application configuration (`pnpm run setup` provides both).
- The SQL units that remain (branches and locations, customers, staff) move to service units when their services exist (B04d continued 2 and B04e). A SQL unit whose rows move keeps drawing their ids, so the rows it still writes keep the ids an earlier run gave them.
- Forbidden: a step-up waiver anywhere outside `src/seed`, or one that applies to a principal the seed did not create.

## Verification

- `test/integration/platform/seed.integration.spec.ts`: the farm loads once and a second run writes nothing; tax scheme version 1 is active with 21 cells, requested by the seeded Accountant and decided by the seeded Owner; every price list is active, drafted by the seeded Manager and approved by the seeded Owner; the catalogue's audit events carry the seeded Manager and `hakorem-seed`; `calculateTax` answers for the seeded cashier.
- `test/e2e/mdm/pricing.e2e.spec.ts`: on a fresh `pnpm run setup`, the seeded cashier's `calculateTax` splits a GHS 459.00 beef pack into 382.50, 57.38, 9.56 and 9.56.
