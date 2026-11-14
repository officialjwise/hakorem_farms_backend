# B03 — Platform and the first vertical slice

Date: 2026-11-14 · Branch `b03-platform-slice` · Pull request #4, stacked on #3 (B2), #2 (B1) and #1 (B0), none merged (A-080) · Status: gate passed on the backend side; the frontend confirms its half when it switches off its stub (see Gate)

## Contract changes

**Version 1.2.0, additive only** (`docs/CONTRACT_CHANGELOG.md`). A client generated from 1.1.x keeps working. Seventeen operations now answer from the real API and their text is the code's (ADR-0031): `getHealth`, `loginStaff`, `loginCustomer`, `loginInvestor`, `verifyTotp`, `refreshSession`, `logout`, `getCurrentSession`, `changePassword`, `startTotpEnrolment`, `confirmTotpEnrolment`, `stepUp`, `listSessions`, `revokeSession`, `listProducts`, `createProduct`, `getProduct`.

- Optional `challengeToken` on `PasswordChangeRequest` and `TotpCodeRequest`; new optional body `TotpEnrolmentStart` on `startTotpEnrolment`. These three take `CsrfTokenOptional` and list an empty security requirement, because during login they run with a challenge and no session.
- Optional `realm` query parameter on `refreshSession`, `getCurrentSession`, `logout`.
- `x-error-codes` on every implemented operation; new codes `TOTP_ALREADY_ENROLLED`, `APPROVAL_SUBJECT_CHANGED`, `DUPLICATE_VALUE`, `REFERENCE_NOT_FOUND`, `STOCK_POLICY_CONFLICT`.
- 503 on the login operations, `verifyTotp` and `refreshSession`; 403 on `refreshSession`.
- The versioning check passes 1.1.0 to 1.2.0 as minor; the published diff is 196 lines.

## Decisions from the gate, applied

- **A-079 confirmed:** sessions open in `backend/`. This session had all sixteen `hakorem-*` skills (adr, documents, endpoint, frontend, ledger, migration, module, money, offline, pricing, release, runbook, security-review, seed, stock, tests) and loaded module, migration, endpoint, security-review, tests, seed and adr as they fired. Every opener in `docs/prompts/session-openers.md` now says to open in `backend/`.
- **A-071 confirmed:** `pnpm run setup`.
- **A-070:** Versity Gateway v1.10.0 (ADR-0032), chosen for footprint (112 MB), a current image and object lock, which I verified before choosing: a COMPLIANCE-locked version's delete is refused with `AccessDenied`. Production can use any S3 provider (A-067).
- Authorisation is in the handler through the policy engine, not the controller; the slice has tests proving every role without `mdm.product.create` is refused. `platform.audit_event` has UPDATE and DELETE (and TRUNCATE) refused to `hk_app` by privilege and to every role by trigger, with tests.

## Assumptions made or changed this session (all in `docs/ASSUMPTIONS.md`)

| ID | What | Who confirms |
| --- | --- | --- |
| A-065 | Confirmed by B3: the token lifetimes are the design defaults (below) | — |
| A-066 | Open: Argon2id at 64 MiB, 3 iterations takes 88 ms on the development Mac; the server measurement is B13 | B13 |
| A-070, A-072 | Replaced: ADR-0032; health now reports outbox, dead letters and sealing lag | — |
| A-076 | Open: `@nestjs/platform-express` 11.2.10 was published 2026-11-12, still inside the floor; the multer override stays | B4 |
| A-080 | B3 is stacked on B2's branch; its pull request targets `b02-foundation` | Owner, by merging |
| A-081 | Seeded role permissions: all staff read the catalogue and manage their own sessions; Owner and Manager create products and revoke anyone's session | Owner |
| A-082 | A countable with a shelf life is tracked by lot; without one, not tracked | Owner |
| A-083 | New products are `ACTIVE`; nothing sells without a price (B4) | Owner |
| A-084 | API keys answer 401 until integrations (B12) | Owner |
| A-085 | The B3 seed writes SQL; B4 regenerates it through the MDM and IAM services | B4 |
| A-086 | The breached-password range query is off locally and in CI; the bundled list still applies | Owner |
| A-087 | Left to B4: uploads and the scanner, user and grant administration, customer registration, password reset, approval endpoints | Owner |
| A-088 | Rate limits are the design defaults, as settings | Owner |

## Built

| Area | What |
| --- | --- |
| Database | Migrations 0002 to 0009: IAM identity, sessions, tokens, permissions, roles, grants, approval policies and requests; `mdm.branch`, `mdm.location`, units, tax categories, categories, species, products; platform document registry, idempotency keys, outbox, deliveries, inbox, settings, subject keys, audit events with chain and anchors, job runs. The ten roles, the B3 permissions and their grants are seeded by migration. Every rule is tested by violating it |
| Platform | Actor context; AES-256-GCM envelope with the KEK ring and per-subject keys (ADR-0022); the audit writer, redacting secrets and encrypting personal fields, plus detached writes for refusals; domain events with the outbox; the dispatcher with per-subject order, inbox, backoff and DEAD; idempotency; settings; Redis rate limits; signed cursors; zod validation; CORS allow-list; `@Operation` route metadata; health contributors |
| IAM | Login for three realms with Argon2id, the SA-01 backoff for any identifier and a dummy hash; login challenges for TOTP, first-time enrolment and temporary passwords; EdDSA access tokens and rotating refresh tokens with reuse revoking the session; CSRF and origin checks; TOTP with encrypted secrets, recovery codes and step-up; the device list and forced logout; the global guard (deny by default); the policy engine with scope, ownership and step-up; maker-checker requests and decisions; the ScopeNames port (ADR-0033) |
| Product slice | `createProduct`, `getProduct`, `listProducts` through domain, application, infrastructure (Drizzle) and interface, with the policy engine, idempotency, audit and `mdm.ProductCreated` in one transaction |
| Ports | Object storage (S3 adapter), queue (BullMQ), notifications (generic-http SMS), payments (Paystack), metrics (OpenTelemetry with Prometheus), each with one adapter and tests |
| Worker | `src/worker.ts`: outbox dispatch, the audit sealer as `hk_sealer`, the daily signed anchor written under object lock, the nightly verifier, the hourly idempotency purge |
| Contract | Fragments beside controllers checked against routes (ADR-0031); 1.2.0 |
| Stack | Versity and the worker in Compose; `.env` generation for 32-byte keys and Ed25519 keys, appending only missing keys to an existing `.env`; `pnpm run setup` and `pnpm dev` run API and worker; the seeded farm (two branches with every location kind, the catalogue basics, one staff member per role) |

## Decisions

- **A correction to the brief, not a deviation from it (owner, at the B3 review).** The brief said authorisation is checked "in the domain layer". That cannot be built: `domain/` may import only the kernel, so it cannot call IAM's policy engine. The rule now reads, everywhere: **authorisation is checked in the application layer, never only in the controller, with a test proving the wrong role is refused** (ADR-0035, accepted by the owner). B3 already built it that way: every handler calls the policy engine. It is corrected in `docs/SHARED_BRIEF.md` (including the definition of done), `docs/BUILD_PROMPT.md`, `CLAUDE.md`, the SRS, the threat model, `docs/prompts/module-build-prompt.md` (the recipe the openers point to), ADR-0007, ADR-0017 and ADR-0024, `docs/API.md` and the `hakorem-endpoint` skill. The openers themselves never carried the wrong wording. B4 should read "domain layer" in an older record as meaning this. The frontend's copy of the shared brief needs the same edit by the frontend track.
- ADR-0031 (contract fragments, amends ADR-0030), ADR-0032 (Versity), ADR-0033 (ScopeNames port), ADR-0034 (authentication and authorisation as built). All Proposed, accepted by merging.
- No grant or revocation cache: both are read per request (ADR-0034, BL-042 if the load test says otherwise).
- The sealer keeps ADR-0006's cluster-wide horizon; a per-database horizon is BL-043.
- Serialization retries now jitter from 25 ms up to 1 s (five attempts unchanged), after two symmetric commands exhausted their retries under full-suite load.
- A B2 test that was flaky (the write-skew loser may be retried more than once) now asserts the rule rather than an exact count.

## The login flow for the frontend

Base URL `http://localhost:3000/v1` locally. Call with `credentials: "include"` from an origin in `CORS_ALLOWED_ORIGINS` (locally `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:3001`, `http://127.0.0.1:3001`, `http://localhost:4173`). Every state-changing call with a session sends `X-CSRF-Token`; every one that declares it sends `Idempotency-Key` (a UUID, reused on retry).

**Lifetimes** (A-065; the response fields are authoritative, never hard-code them):

| Token | Lifetime |
| --- | --- |
| Access token (EdDSA JWT) | 10 minutes |
| Staff refresh | 12 hours idle, 7 days absolute |
| Customer and investor refresh | 30 days idle, 90 days absolute |
| Step-up | 5 minutes |
| Login challenge | 5 minutes, single use, 5 code attempts |

**Cookies**, set by the API host only: `__Host-hk_s_at` and `__Host-hk_s_rt` (staff), `__Host-hk_c_*` (customer), `__Host-hk_i_*` (investor). Attributes: `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`, `Max-Age` equal to the token's remaining life. JavaScript never sees them. Browsers accept `Secure` cookies from `http://localhost`.

**Steps**

1. `POST /auth/staff/login` `{ identifier, password, deviceLabel? }` (no CSRF, no idempotency key) answers 200 with `{ status, challengeToken, session }`:
   - `AUTHENTICATED`: cookies set, `session` is the `SessionInfo`. Keep `session.csrfToken` in memory.
   - `TOTP_REQUIRED`: `POST /auth/totp/verify` `{ challengeToken, code }` (six digits or a recovery code) answers as `AUTHENTICATED`.
   - `TOTP_ENROLMENT_REQUIRED` (Owner, Manager, Accountant without an authenticator): `POST /auth/totp/enrol` `{ challengeToken }` with no cookie returns `{ otpauthUri, secretBase32 }` (render the URI as a QR code); then `POST /auth/totp/confirm` `{ challengeToken, code }` returns `{ recoveryCodes }` (show once) and **sets the session cookies**; then call `GET /auth/session`.
   - `PASSWORD_CHANGE_REQUIRED`: `POST /auth/password/change` `{ challengeToken, currentPassword, newPassword }` with no cookie (204), then log in again with the new password.
   - Failure: 401 `INVALID_CREDENTIALS`, the same for an unknown account and the same time; 429 `RATE_LIMITED` with `Retry-After` after five consecutive failures (1 minute, doubling to 60) or 20 attempts per address per 15 minutes; 503 if the limiter is unavailable.
2. `GET /auth/session` returns `SessionInfo` with `csrfToken`, `accessExpiresAt`, `refreshExpiresAt`, `steppedUpAt`, `mustChangePassword`, `totpEnrolled`, `grants` (role, branch and location with codes) and `permissions`. The CSRF token is the same for the session's whole life, so a reload gets the same one.
3. Before `accessExpiresAt`, or on a 401 `UNAUTHENTICATED`, `POST /auth/refresh` (no body; the Origin must be allowed). It rotates the refresh cookie and returns a new `SessionInfo`. Serialise refreshes across tabs: presenting an already-rotated refresh token revokes the whole session (401 from then on). A 401 from refresh means log in again.
4. `POST /auth/logout` with `X-CSRF-Token` (204) ends the session and clears the cookies.
5. Customers and investors: `POST /auth/customer/login` and `/auth/investor/login`, same shape, TOTP optional. If one browser holds two realms' sessions, add `?realm=STAFF` (or `CUSTOMER`, `INVESTOR`) to `refreshSession`, `getCurrentSession` and `logout`.
6. Errors you will meet on state changes: 403 `CSRF_TOKEN_INVALID`, 403 `ORIGIN_NOT_ALLOWED`, 403 `PASSWORD_CHANGE_REQUIRED`, 403 `STEP_UP_REQUIRED` (then `POST /auth/step-up` `{ code }` and repeat with the same `Idempotency-Key`), 400 `IDEMPOTENCY_KEY_REQUIRED`, 409 `IDEMPOTENCY_KEY_REUSED`.

**Seeded logins** after `pnpm run setup` (password: `SEED_STAFF_PASSWORD` in `backend/.env`, generated per machine): `adwoa.darko@seed.hakoremfarms.invalid` (Cashier, shop floor, no TOTP: the quickest login), `kofi.mensah@…` (Storekeeper), `esi.appiah@…` (Sales), `abdul.iddrisu@…` (Farm hand), `selorm.agbeko@…` (Driver), `akosua.boateng@…` (Manager), `yaw.agyeman@…` (Accountant), `kwabena.owusu@…` (Owner); the last three enrol TOTP at first login. Six products are seeded.

## Deferred

- To B4 (A-087, in its opener): uploads with the malware scanner (A-057) and `evidence_file_id`; user and grant administration; customer registration and phone verification; password reset; the approval endpoints over the built mechanism; the seed through services (A-085).
- API keys (A-084, B12). The PDF renderer port (B8, with DOC). Anchor publication of the public key and the off-box verification from a clean environment (ADR-0006, B13). Metrics on the API's requests (the worker exports its counters now).
- The e2e Product flow enrols the seeded Manager's authenticator, so it passes once per freshly set-up stack (CI's fresh-clone job). On a stack it has already run against, it stops with a message saying so; `docker compose --profile app down --volumes && pnpm run setup` resets it.
- Smoke steps beyond health (logins, catalogue) are added with B13's smoke suite.

## Tests

| Layer | Result (local, 2026-11-14) |
| --- | --- |
| Unit | 236 passed |
| Integration (Testcontainers PostgreSQL 17.6, Redis 7.4.6, Versity Gateway 1.10.0) | 163 passed (CI); the full suite passed twice in a row locally |
| Contract | 20 passed |
| End to end (stack from the built image, with the worker) | 7 passed |
| Smoke (local stack) | 1 passed |
| Coverage, unit and integration merged | 90.29 percent statements, 80.63 percent branches (gate 80); kernel 100 percent |
| Lint, type check | Clean; 20 of 20 boundary fixtures fire |
| Security | `pnpm audit --audit-level high` passes (5 moderate, unchanged from B2); gitleaks over the 17 B3 commits: no leaks; Trivy and Semgrep run in CI |

Named tests the ADRs require of B3: ADR-0006 (`hk_app` cannot update, delete or truncate the audit event or chain; the superuser tamper reported at its exact seq; business change and audit row commit together; twenty parallel audited writes with no retry); ADR-0010 (outbox commits with the change; redelivery has no second effect; a failing consumer retried with backoff to DEAD, shown by health); ADR-0014 (the four outcomes, including two concurrent requests); ADR-0016 (rotation, reuse revoking the session, forced logout, lockout backoff, identical responses for known and unknown, TOTP enrolment and step-up expiry, CSRF rejection); ADR-0017 (the handler walk, a refusal per seeded role, the requester's approval refused by the database); ADR-0022 (round trip, destroyed subject key leaving the chain verifying and the payload unreadable, no secret field in an audit payload); ADR-0024 (`hk_sealer` cannot read business tables).

## Security review (hakorem-security-review)

Boundaries crossed: TB1 (public login), TB2 (console), TB6 (investor login), TB7 (the worker's keys), TB8 (roles and triggers). `docs/security/SECURE_CODING_STANDARDS.md` run item by item:

- Passed: SC-01 (strict schemas; list queries ignore unknown parameters as API.md says), SC-02 (policy engine in every handler, handler walk), SC-03 and SC-04 (parameters only; interpolated SQL is constant fragments), SC-05 (no float money; approval amounts are bigint), SC-06, SC-07 (no secret in logs, events refuse secret-named fields, audit redacts them), SC-08, SC-09, SC-10, SC-11 (login fails closed with 503), SC-14 (the breached-password query, Redis and storage calls are outside transactions), SC-15, SC-16, SC-17, SC-18 (TOTP secrets encrypted under the user's subject key, decrypted only in IAM), SC-20 and SC-21 (local audit and gitleaks clean; CI runs the rest), SC-22, SC-23 (the slice's write is serializable), SC-24.
- Not applicable, with reason: SC-12 (no upload endpoint in B3, A-087), SC-13 (the Paystack adapter verifies signatures; webhook handling is B9a), SC-19 (no user-supplied outbound URL yet).
- Findings fixed during the session: the deny-by-default guard first refused health and test routes (they now declare operations); refresh now requires an allowed Origin. Two found by CI on this branch: a `pg.Pool` without an error listener would have ended the API or the worker when PostgreSQL dropped an idle connection (a restart), now logged and replaced, with a test; and Semgrep's hard-coded-secret rule flagged a TOTP parameter named `secret`, a false positive cleared by renaming it, not by a suppression.
- Abuse paths: authorisation refusals (an investor's logged as an error) and token reuse are audited with their actor and reason, ready for the daily exception report's `AUTHORISATION_FAILURE` item in B12. No new abuse case.

## Gate

**The slice passes all four test layers.** Unit (`src/modules/mdm/domain/product.spec.ts`, nine tests written first), integration (`test/integration/mdm/products.integration.spec.ts`, twelve, plus the schema rules), contract (`test/contract/b3/slice-and-login.contract.spec.ts`), end to end (`test/e2e/mdm/product-slice.e2e.spec.ts` on the image Compose runs, with the worker sealing the audit trail). All green, as above.

**The frontend can log in against the real API.** Performed with `pnpm run setup` on this machine (exit 0; API and worker healthy; health OK with all five checks). The e2e suite then did exactly what the console will do, from the console's origin `http://localhost:5173`: the seeded Manager's first login through TOTP enrolment, `GET /auth/session` with the CSRF token, a product created with `Idempotency-Key` and `X-CSRF-Token`, read and listed by the cashier, the cashier refused, logout ending the session. The CORS preflight from that origin is answered with credentials (integration test). What this cannot show is the frontend's own code switching off its stub: that is the frontend track's next session, with the flow above.

**CI green: passed.** [Run 43594300920](https://github.com/officialjwise/hakorem_farms_backend/actions/runs/43594300920) on commit `5f5e7a9`, all six jobs successful: lint and type check; unit and integration (399 tests) with the coverage gate; contract (drift check, responses, Redocly, versioning tests); image build and Trivy; the fresh-clone job (`pnpm run setup` on a clean runner, then e2e 7 of 7, which includes the Product flow, smoke, rollback and a second setup); secret scan, dependency audit and Semgrep. The two runs before it failed on the findings described in the security review, both fixed. Pull request events still start no run on this repository (B2's finding), so the push runs are the record.

## Notes for the frontend track

- Regenerate the client from contract 1.2.0. Switch the seventeen operations above off the stub; everything else stays on the mock.
- The flow, lifetimes, cookies, seeded logins and error codes are in "The login flow" above. Run the backend with `pnpm run setup` in `backend/`; the console's dev origin must be one of `CORS_ALLOWED_ORIGINS` in `backend/.env` (add yours there if it differs, then restart the API).
- `createProduct` needs a Manager or Owner (TOTP). Use the seeded Cashier for read-only screens.
- Products have `images: []` until uploads arrive in B4.

## Next session

B04 — Master data and the pricing engine. Open a fresh Claude Code session **in `backend/`**, after pull requests 1 to 4 are merged (or stack on `b03-platform-slice` if they are not), with the opener in `docs/prompts/session-openers.md` section "B4", which is:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B03-platform-slice.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, and ADR-0004, ADR-0020, ADR-0021
and ADR-0001. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate. Confirm that all sixteen hakorem skills are loaded.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day floor
(A-076). Copy the B3 Product slice's shape for every endpoint: domain, application with the policy engine and
idempotency, infrastructure, interface with @Operation, and the operation moved from the planned file into
openapi/<operationId>.yaml (ADR-0031).
Also build what B3 left to B4 (A-087): the file store with uploads, the malware scanner and evidence_file_id on
iam.approval_request; user and grant administration; customer registration and phone verification; password
reset; and the approval endpoints over the existing mechanism. Regenerate the seeded farm through the new MDM and
IAM services (A-085).
Then execute B04 only, on branch b04-master-data-pricing: master data (catalogue, categories, units,
species, grades, weight bands, customers, suppliers, branches, locations, payment methods, delivery
zones, reason codes), price lists in approved effective-dated versions, the pricing engine with the
fixed resolution order and the typed quote-required result, promotions and coupons, and the tax
calculator with named levies per ADR-0020 (exact tests for exclusive and inclusive prices, the
GHS 459.00 beef split into 382.50, 57.38, 9.56 and 9.56, a compounding levy, zero-rated and exempt
categories, and an incomplete scheme version that cannot be activated). Seed the farm.
Stop at the gate and write docs/sessions/B04-master-data-pricing.md.
```

B4 carries more than one module session usually does. If it cannot finish, split it as "If a session cannot finish" in the openers file says: the A-087 items first, then master data and pricing as "B04 continued".
