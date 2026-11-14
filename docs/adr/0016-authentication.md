# ADR-0016: Authentication design

- **Status:** Proposed (awaiting B0 gate; token lifetimes are finalised in B3)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief fixes self-hosted authentication with Argon2id, a short-lived access token plus a rotating refresh token in httpOnly cookies, TOTP for privileged roles, device and session lists, forced logout, lockout with exponential backoff, a breached-password check, and no account enumeration. Cookies are `SameSite=Strict`, httpOnly and secure, with CSRF tokens on cookie-authenticated state changes. The storefront sits on the apex domain, the console on `app.` and the API on `api.`.

## Options considered

1. **Opaque server-side session only.** Simple revocation, but a database read on every request.
2. **Long-lived JWT.** No lookup, but cannot be revoked, which fails forced logout.
3. **Short-lived signed access token plus a rotating, server-stored refresh token.** As the brief specifies.

## Decision

Option 3.

**Principals.** `iam.principal` is the single identity every actor has. Kinds: `USER`, `API_KEY`, `SYSTEM`. A user account belongs to one realm: `STAFF`, `CUSTOMER` or `INVESTOR`. Realms have separate login endpoints and separate cookie names, so a customer session can never be presented as a staff session.

**Passwords.** Argon2id with a per-password salt. Parameters are configuration, tuned in B3 to about 250 ms on the production server, starting from 64 MiB memory, 3 iterations, parallelism 1. Staff accounts are created with a temporary password and `must_change_password`. At set time the password is checked against a breached-password list by k-anonymity range query, with a bundled list of common passwords as the fallback when the service is unreachable.

**Tokens**

| Token | Form | Lifetime (design default) | Stored |
| --- | --- | --- | --- |
| Access | Signed JWT (EdDSA) with principal, session id, realm and step-up time | 10 minutes | Cookie `__Host-hk_s_at` (staff), `__Host-hk_c_at` (customer) or `__Host-hk_i_at` (investor); httpOnly, secure, `SameSite=Strict`, path `/` |
| Refresh | 256-bit random, opaque | Staff: 12 hours idle, 7 days absolute. Customer: 30 days idle, 90 days absolute | Cookie `__Host-hk_s_rt`, `__Host-hk_c_rt` or `__Host-hk_i_rt`, httpOnly, secure, `SameSite=Strict`; SHA-256 hash in `iam.refresh_token` |

- The API host sets both cookies with the `__Host-` prefix, so they are bound to `api.hakoremfarms.com` and never sent to another subdomain. The console and storefront call the API from the browser with credentials. All three hosts share one registrable domain, so `SameSite=Strict` cookies are sent.
- Storefront pages that need the customer's identity fetch that data in the browser. Server-rendered catalogue pages are anonymous.
- Each refresh rotates the token. Presenting a token that has already been rotated revokes the whole session and raises an alert, since it means the token was copied.
- Roles and grants are not in the access token. They are read per request from a short-lived cache keyed by principal and invalidated on any grant change, so a permission change takes effect at once.

**Sessions.** `iam.session` holds one row per login with device label, IP address and last-seen time. Users see and revoke their own sessions; a manager can revoke anyone's. Revocation deletes nothing: it sets `revoked_at`, and the session id in the access token is checked against a revocation cache.

**TOTP and step-up.** TOTP (RFC 6238) is mandatory for Owner, Accountant and Manager and available to others. The secret is encrypted at column level (ADR-0022). Recovery codes are stored hashed. Distribution posting, bulk export, role and grant changes, and posting rule changes require a TOTP entered within the last five minutes on that session.

**Lockout and enumeration.** Failed logins back off exponentially per account and are rate-limited per IP address. Every failure returns the same message and takes the same time, including for unknown accounts (a dummy hash is verified). Password reset always answers "if the account exists, a message was sent".

**CSRF.** Every cookie-authenticated state-changing request must carry an `X-CSRF-Token` header matching a token bound to the session, and an `Origin` on the CORS allow-list.

**API keys.** Integrations authenticate with a key shown once and stored as a SHA-256 hash in `iam.api_credential`, with expiry, rotation and per-key rate limits. A key is a principal with role grants like any other.

**Offline counter.** A register device is enrolled by a manager and holds a device credential. Offline, the cashier unlocks the device with a PIN against a locally cached shift. At sync, the server authenticates the device credential and the batch names the cashier and shift. The server is authoritative and re-checks every permission. The detail is specified in `docs/OFFLINE_SYNC.md` in B1.

Amended in B1 (2026-11-13), before acceptance: cookie names carry the realm, so that one browser can hold a staff and a customer session without either being presented as the other. The names are fixed in `contract/openapi.yaml` under `securitySchemes`.

## Consequences

- Forced logout and permission changes take effect within one request, not at token expiry.
- The staff refresh lifetime is long enough to cover an eight-hour offline shift.
- Storefront account pages cannot be server-rendered with the customer's data. This is accepted: those pages have no search value.
- Authentication events are recorded in the audit log (ADR-0006), which is the authentication audit the brief asks for.
- Binds: `docs/security/SECURITY_ARCHITECTURE.md`, `docs/data-model/iam.md`, the B3 session, which writes the exact login flow into its report for the frontend track.

## Verification

- B3: tests for refresh rotation, reuse detection revoking the session, forced logout, lockout backoff, identical responses for known and unknown accounts, TOTP enrolment and step-up expiry, CSRF rejection.
- B3 gate: the frontend logs in against the real API.
