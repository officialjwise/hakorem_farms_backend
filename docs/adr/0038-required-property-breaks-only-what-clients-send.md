# ADR-0038: A newly required property is breaking only on a schema a client sends

- **Status:** Accepted (owner, 2026-11-14, choosing this option when the check blocked PR #6)
- **Date:** 2026-11-14
- **Session:** B4
- **Deciders:** owner; backend track built it

## Context

FR-API-001 and `docs/API.md` section 1: a change that can break an existing client needs a new major version, and CI fails a pull request that breaks the contract without one. `scripts/contract/versioning.ts` runs on every pull request against the base branch's contract and counts as breaking, among other things, any schema that newly lists a property in `required`.

That is right for a schema a client sends: an old client does not send the new property and is refused. It is wrong for a schema only the server sends. Contract 1.4.0 added `qrCodeDataUri` to `TotpEnrolment`, the response of `startTotpEnrolment`, as a required field. The server always sends it, and an old client ignores a field it does not know (`docs/API.md` section 1, rules a client must follow). `docs/API.md` already lists "a new response field" as a minor change. The check called it breaking anyway, and PR #6 could not merge.

The check runs only on the `pull_request` event, because only then is there a base contract to compare with. The session watched the `push` runs, which were green, and missed the failure from the QR commit onward. It was found when the merge was attempted.

If nothing is decided, every new response field must be either optional (so generated client types mark a field the server always sends as possibly missing) or a major version (which tells the paused frontend track that something broke when nothing did).

## Options considered

1. **Refine the check.** A newly required property is breaking only on a schema a client sends. Costs a reachability walk in the script and a decision that changes a CI safeguard.
2. **Make `qrCodeDataUri` optional.** The check stays as it is. Costs a weaker contract: the till's generated type says the field can be missing, so every screen handles a case that never happens, and every later response field meets the same choice.
3. **Bump to 2.0.0.** Treats the addition as breaking. Costs a false signal to the frontend track and a `/v2` with no breaking change in it.

## Decision

Option 1, in `scripts/contract/versioning.ts`:

- `schemasSentByClients(document)` collects every schema reachable from an operation's `requestBody`, an operation's `parameters` or a path item's `parameters`. It follows `#/components/schemas/…`, `#/components/parameters/…` and `#/components/requestBodies/…` references transitively, and discriminator mappings as well as `$ref`s.
- `breakingChanges` reports `schema X now requires P` only when `X` is in that set for the previous or the next contract. A schema used in both a request and a response is a sent schema and stays strict.
- Every other rule is unchanged for every schema: a removed operation or schema, a lost property, a removed enumeration value, a changed type.
- `docs/API.md` section 1 says the same: making an optional field required is major on what a client sends; a new response field is minor, required or not.
- The contract stays at 1.4.0 with `qrCodeDataUri` required.

## Consequences

- A new field the server always returns can be published as required in a minor version, so generated client types are as strong as the server's behaviour.
- A schema the server returns can never be loosened silently: losing a property or an enumeration value is still breaking.
- One cost to the frontend: a test fixture built by hand from a generated response type fails to compile after a new required field until the fixture adds it. That is a build-time prompt, not a runtime break, and it is how a screen learns of the field.
- Callbacks and top-level `webhooks` are not walked. The contract has neither; if one is added, its request body is sent by the server, so the walk already treats it correctly by leaving it out.
- Binds `docs/API.md` section 1 and `scripts/contract/versioning.ts`. A session that adds a check on the contract watches the `pull_request` run as well as the `push` run.

## Verification

`test/contract/api/versioning.contract.spec.ts`, written first:

- A newly required property is still breaking on a request body schema (`LoginRequest`), on a schema reached only through a reference (`RoleLimit`, through `RoleCreate`) and on a parameter schema.
- It passes under a minor version on response-only schemas (`HealthCheck`, `TotpEnrolment`).

On the real contract the walk finds 295 of 810 schemas sent by clients; `TotpEnrolment`, `HealthCheck` and `Error` are not among them; `LoginRequest`, `RoleLimit`, `PhoneNumber` and `Pesewas` are. CI's command, `tsx scripts/contract/versioning.ts <main's contract> contract/openapi.yaml`, prints `contract versioning: ok` on PR #6.
