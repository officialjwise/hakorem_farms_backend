# ADR-0034: How B3 built authentication and authorisation, where ADR-0016 and ADR-0017 left a choice

- **Status:** Proposed (awaiting the B3 merge; amends the design defaults of ADR-0016 and ADR-0017 where noted)
- **Date:** 2026-11-14
- **Session:** B3
- **Deciders:** backend track; owner approves by merging B3

## Context

ADR-0016 and ADR-0017 fixed the design: realms, Argon2id, EdDSA access tokens, rotating refresh tokens in `__Host-` cookies, TOTP, CSRF, lockout, deny by default, one maker-checker mechanism. Building it in B3 met questions they did not answer: how the steps between password and session are carried when the contract's enrolment and password-change operations require a session; how a CSRF token can be returned again on reload when only its hash is stored; which session a request means when one browser holds two realms (all three share the API host, so a browser sends every realm's cookies); whether grants and revocations go through a cache; and how a refusal is recorded when the refused command rolls back.

## Options considered

1. **Follow the design text literally**: caches for grants and revoked sessions, a random CSRF token stored hashed, session-only enrolment. A random token cannot be shown again after a reload; session-only enrolment makes first login impossible for Owner, Manager and Accountant; a cache adds invalidation to get wrong.
2. **Resolve each question with the simplest rule that keeps the design's guarantees**, recorded here.

## Decision

Option 2.

- **Login challenges.** Each step between password and session is a single-use challenge in `iam.verification_token`, purposes `LOGIN_TOTP`, `LOGIN_TOTP_ENROLMENT` and `LOGIN_PASSWORD_CHANGE` (added to the check), with the `device_label` of the login, five minutes, five attempts. `changePassword`, `startTotpEnrolment` and `confirmTotpEnrolment` accept the challenge in the body instead of a session (contract 1.2.0, `CsrfTokenOptional`). Confirming enrolment through a challenge completes the login and sets the cookies. A temporary password is changed through its challenge and the user logs in again.
- **CSRF token.** Derived, not random: `HMAC-SHA256(k, "csrf|" + session_id)` with `k` derived from `LOOKUP_HMAC_KEY`; `iam.session.csrf_token_hash` holds its SHA-256 and the check is in constant time. It is the same for the session's life, so a reload gets the same token. An allowed `Origin` is required on every cookie-authenticated state change, and on refresh.
- **Realm selection.** A route lists the realms it accepts. With one realm's cookie present, that realm; with several, the optional `realm` query parameter decides, otherwise 400 naming `/realm` (refresh: 401). A token carries its realm and is refused under another realm's cookie name.
- **No caches in B3.** Grants are read from `iam.role_grant` in the handler's transaction on every check, and the session row is read on every authenticated request (a primary-key lookup; `last_seen_at` is written at most once a minute). A revoked grant or session therefore takes effect on the next request, as ADR-0016 requires, with no invalidation. A cache is added only if B13's load test shows the need (BACKLOG).
- **Refusals survive.** A refused authorisation is written to the audit trail on its own connection (`AuditTrail.recordDetached`), since the refused command's transaction rolls back; so are failed logins and a locked identifier.
- **Lockout.** The SA-01 schedule is kept in Redis per hash of realm and identifier, the same for identifiers without an account; `iam.user_account.failed_attempts` and `locked_until` mirror it for real accounts. If Redis is down, login is refused with 503 (fails closed). The per-address limit and the console limit are fixed windows in Redis, read from settings with code defaults.
- **The policy engine** checks a current grant holding the permission, branch and location scope, an ownership rule (`owner` with the permission for anyone's record), then step-up for permissions marked `requires_step_up`. A route without `@Operation` metadata is refused by the guard before any handler runs.
- **API keys** are not accepted in B3 (A-084): a bearer token is 401 until integrations arrive.
- **The audit chain and anchors** are written only by `hk_sealer`: their class comment is `class=LEDGER;writer=hk_sealer`, `hk_app` and `hk_worker` hold SELECT only, and the table-class check accepts exactly this form.

## Consequences

- First-time Owner, Manager and Accountant logins work end to end without a session, which the gate needs.
- One authenticated request costs one session read and, per permission check, one grant read; both indexed.
- The frontend must send `realm` only when it holds two sessions in one browser.
- Binds: docs/API.md section 3, docs/data-model/iam.md (`verification_token`), docs/security/SECURITY_ARCHITECTURE.md section 3, the `hakorem-endpoint` and `hakorem-security-review` skills.

## Verification

`test/integration/iam/authentication.integration.spec.ts` (cookies, identical failures and timing, lockout for unknown identifiers too, rotation and reuse, logout, expiry, CSRF and origin, preflight, realms), `second-factor.integration.spec.ts` (enrolment through the challenge, replay, five wrong codes, recovery codes, step-up expiry, temporary password, breached password), `authorisation.integration.spec.ts` (the handler walk, each seeded role refused, audited refusals, forced logout taking effect at once), `approvals.integration.spec.ts`, and `test/e2e/mdm/product-slice.e2e.spec.ts` on the built image.
