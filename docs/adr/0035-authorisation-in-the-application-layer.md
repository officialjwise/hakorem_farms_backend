# ADR-0035: Authorisation is checked in the application layer, never only in the controller

- **Status:** Accepted (owner, 2026-11-14, at the B3 review: a correction to the shared brief's wording)
- **Date:** 2026-11-14
- **Session:** B3
- **Deciders:** owner; backend track

## Context

The shared brief, its definition of done, `docs/BUILD_PROMPT.md`, `CLAUDE.md`, the SRS (FR-IAM-009), the threat model and ADR-0017 said authorisation is checked "in the domain layer" (or "at the domain layer", "at domain level"). The layering forbids exactly that. `docs/MODULE_BOUNDARIES.md` and the lint rule (ADR-0008) let `domain/` import only the kernel and itself, so a domain entity cannot call IAM's `Authoriser` without breaking the dependency rule. What the brief protects against is a permission checked only at the edge, in a controller, which a queue worker, another module's call or an offline sync would bypass. That protection lives in the command and query handlers, which every caller reaches. B3 built it there: every handler in `src/modules/*/application/` calls `Authoriser.authorise(tx, actor, permission, scope)` before doing work.

If the wording stayed, a later session could try to put permission checks into `domain/`, fail the lint rule, and then either move policy code into the kernel or widen the boundary. Both are wrong.

## Options considered

1. **Keep the wording and read "domain layer" loosely, as "the business logic, not the controller".** No edit, but every later session would meet a rule that its own lint configuration forbids, and might "fix" the code instead of the text.
2. **Correct the wording everywhere to the application layer**, which is what the brief means and what B3 built.

## Decision

Option 2. The rule, wherever it is stated:

> Authorisation is checked in the application layer, never only in the controller, with a test proving the wrong role is refused.

- Every command and query handler (`src/modules/<code>/application/`) calls the IAM policy engine before it does work: the permission, the branch, the location where the resource has one, and the owner for resources with an ownership rule. Deny by default.
- The route's `@Operation` metadata declares the same permission, for the contract and the handler-walk test. It never replaces the handler's check.
- The domain layer stays pure. It enforces business rules that are not about who the actor is, such as amount limits passed in as data (a role's override limit, read by the application layer and handed to the domain rule), and it never imports IAM.
- Every module session proves the wrong role is refused with a test.

This is a **correction to the brief's wording, not a deviation from it**: the intent (no check only at the controller, deny by default, object-level ownership) is unchanged, and B3 already built it this way.

Corrected in the same change: `docs/SHARED_BRIEF.md` (hard rules, the abuse case table, the skill table, the definition of done), `docs/BUILD_PROMPT.md` (B3), `CLAUDE.md`, `docs/SRS.md` (FR-IAM-009 and the two abuse case controls), `docs/security/THREAT_MODEL.md` (abuse case 8), `docs/prompts/module-build-prompt.md` (the recipe the session openers point to), `docs/ARCHITECTURE.md` (the controls table and the index), `docs/API.md` (`x-permission`), ADR-0007, ADR-0017 (amended in place, before acceptance) and ADR-0024, and the `hakorem-endpoint` skill. The session openers themselves never carried the wrong wording. The frontend repository keeps its own copy of the shared brief; the frontend track applies the same correction to it (this session writes nothing under `../frontend`).

## Consequences

- A rule and its enforcement agree: the lint rule keeps `domain/` pure, and the handler-walk test (`test/integration/iam/authorisation.integration.spec.ts`) proves every permissioned route refuses a user with no grant.
- Historical records (`docs/sessions/`, the 1.0.0 entry of `docs/CONTRACT_CHANGELOG.md`) keep their original words; this ADR is the reference for what they meant.
- Binds: every module session's definition of done, the `hakorem-module`, `hakorem-endpoint` and `hakorem-security-review` skills.

## Verification

- `pnpm lint`: `domain/` imports only the kernel (the boundary fixtures fail if a domain file imports a framework or another module).
- The handler-walk test and the per-role refusal tests of B3; each later module adds its own wrong-role test.
- A search of `docs/`, `CLAUDE.md` and `.claude/skills/` for "domain layer" in an authorisation sense finds only this ADR and historical records.
