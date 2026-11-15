# B4 continued (e): The B3 carry-overs in IAM

Date: 2026-11-15 · Branch `b04e-iam-carry-overs`, from `b04d3-reference-data` · Pull request: see the session's closing message (stacked, not merged) · Status: **phase split (A-121)**. The part built here passed its gate; the rest of B04e is two new sessions, B04e continued and B04e continued 2.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-120 | User and grant administration rules. Owner and Manager hold the nine new permissions; the Accountant reads users, roles and grants; nobody else holds any. `iam.user.create`, `iam.user.reset_password` and `iam.grant.manage` need step-up. The permission is checked at every branch the target holds a grant at. Nobody administers their own access (403; the database refuses a self-grant and a self-revocation). Nobody grants or revokes a role holding a permission they lack at that scope. The last active Owner and the last Owner grant in force stay. `realm: INVESTOR` waits for B12. A temporary password is sealed with the user's key in the idempotency store. New codes `GRANT_INVALID`, `USER_INVALID` | Owner |
| A-121 | The phase split at sub-domain boundaries inside IAM (below) | Owner |

Also updated: A-085 (no seed unit writes SQL any more) and A-087 (what is built and where the rest went).

Phase, scope and gate, as confirmed at the start:

1. Phase: B4 continued (e), B04e.
2. Scope: the A-087 IAM items (file store and scanner, user and grant administration, customer registration and phone verification, password reset with CR-004 point 3, the approval endpoints), MDM imports and exports, and the IAM seed through the IAM services.
3. Gate: those operations are live, each with a wrong-role refusal, and the IAM seed is written through the IAM services.

## The split (A-121, ADR-0026 Amendments)

The whole scope (about thirty operations, a new scanner container, the file store and MDM imports) would not reach its gate in one context. I stopped at a sub-domain boundary, as "If a session cannot finish" says:

- **Built here:** user, role-reading and grant administration (fourteen operations), and the IAM seed through the services. This part's gate: every one of those operations refuses the wrong role, and the IAM seed is written through the IAM services. **Passed.**
- **B04e continued** (`b04e2-auth-approvals`): `createRole`, `updateRole`, the approval endpoints (`listApprovals`, `getApproval`, `approveRequest`, `rejectRequest`, `cancelApprovalRequest`), `registerCustomer`, `verifyCustomerPhone`, and password reset with CR-004 point 3's error codes.
- **B04e continued 2** (`b04e3-file-store-imports`): the file store with uploads, the malware scanner (A-057), `evidence_file_id`, product images, and MDM's imports and exports.

`docs/prompts/session-openers.md` has both new sections in order before B5, and B5's opener now reads `B04e3-file-store-imports.md`.

## Contract changes

**1.10.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Fourteen more operations are served by the real API (115 from code, 485 planned): `listUsers`, `createUser`, `getUser`, `updateUser`, `disableUser`, `enableUser`, `unlockUser`, `resetUserPassword`, `listRoles`, `getRole`, `listPermissions`, `listGrants`, `createGrant`, `revokeGrant`.

- Two new error codes, `GRANT_INVALID` and `USER_INVALID` (422), in `docs/API.md` section 10.3.
- `x-error-codes` and descriptions on the fourteen operations state their rules.

No schema, field, parameter or response changed shape. Redocly lint is clean; `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Domain | `src/modules/iam/domain/access-admin.ts`, under a new 100 percent gate: grant judgement (self-grant, role beyond the granter, location in branch, window, realm), account status, the last Owner, temporary passwords |
| Application | `AccessAdmin` (with `bootstrapFirstOwner`, ADR-0043), `AccessStore` port, `role-view.ts`. `ScopeNames` gains `refs`, which MDM implements |
| Infrastructure and API | `PgAccessStore`, `AccessController`, fourteen fragments moved from the planned file |
| Migrations | `0027` (no self-revocation, a CHECK), `0028` (nine permissions), `0029` (grants to roles). All three rolled back and applied again |
| Events | `iam.RoleGranted` and `iam.RoleRevoked`, as `docs/DOMAIN_MODEL.md` names them; every grant change is also audited as `PERMISSION_CHANGE` |
| Seed | `src/seed/farm-iam.ts` replaces `farm-b3.ts`. The System bootstraps the seeded Owner, who creates the other seven accounts and every grant through the services. Each person changes the temporary password through the real first sign-in (`loginStaff`, then `changePassword` on the challenge). All four seed units are service units now. A fresh seed writes 236 records; a second run writes 0. The `seed.loaded` setting row B3 wrote is gone; nothing read it |
| Docs | ADR-0043 and the index, A-120, A-121, ADR-0026 Amendments, the openers, `docs/API.md`, the changelog, `docs/data-model/iam.md`, the IAM card, `DOMAIN_MODEL` events |

## Decisions

**ADR-0043**: the first Owner is created by IAM's bootstrap as the SYSTEM principal, only while no staff account exists. It follows ADR-0042, which names this bootstrap, and contradicts no accepted ADR. Everything else is an assumption (A-120, A-121).

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 2 is B5 |
| CR-004 | Point 3 (reset token error codes) moved with password reset to B04e continued |
| CR-005 | **Declined again**, for the reason given before: one scripted pass when the frontend resumes. The new fragments keep one example each, and `listUsers` and `listRoles` are among them |
| CR-006 | Answered earlier |
| CR-007 | Already done: the five step-up operations here carry `x-requires-step-up: true`, and `step-up-contract.integration.spec.ts` still matches them to the seeded permissions |
| CR-008 | Answered earlier |

## Deferred

- **To B04e continued:** role writes, the approval endpoints, customer registration and phone verification, password reset and CR-004 point 3.
- **To B04e continued 2:**
  - the file store, uploads and the scanner;
  - `evidence_file_id`;
  - product images;
  - MDM imports and exports.
- **To B12:** investor accounts (`realm: INVESTOR`, linked to an investor record), and the `PERMISSION_CHANGE` item on the daily exception report, which reads `iam.RoleGranted` and `iam.RoleRevoked`.
- **To B13:** production provisioning calls `bootstrapFirstBranch` and then `bootstrapFirstOwner`.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 502 passed. New: `access-admin.spec.ts` (11 tests), at 100 percent on all four measures. Every earlier `fullCoverage` gate holds |
| Integration | 436 passed. New: `access-admin.integration.spec.ts` (25 tests). `seed.integration.spec.ts` gained four tests. The handler walk now covers 115 routes |
| Contract | 37 passed. New: `b4/access-admin.contract.spec.ts` checks every new response shape |
| Coverage, merged | 938 passed. Statements 92.61 percent, branches 83.76 percent (gate 80) |
| Lint, type check | Clean |
| End to end | 13 passed. They ran against a database built from empty (bootstrap, migrate, seed twice: 236 records, then 0), with the API and worker on the host. That database was `hakorem_e2e` in the dev Postgres, with its own Redis key prefix. The dev database volume was not deleted |
| Smoke | Passed against the same stack |
| Rollback | `0029`, `0028` and `0027` rolled back and applied again |

## Gate (this part)

**Passed.** I proved it by running these tests:

- **Wrong roles:**
  - Each of the eight writes is refused with 403 `FORBIDDEN`, and the refusal audited, for the Accountant, Sales, the Cashier, the Storekeeper and the Driver.
  - The six reads are refused for all four non-admin roles, and answer the Owner, Manager and Accountant.
  - A Manager granted at TST cannot touch a Dodowa user or grant at Dodowa.
  - A user with no grant gets 403 on all 115 routes.
- **Rules:**
  - A Manager granting themselves Owner, or anything, gets 403 (audited `SELF_GRANT`), and the database refuses a self-grant row and a self-revocation (23514).
  - A Manager cannot create an Owner or revoke an Owner grant.
  - An Owner's grant of a Manager is a `PERMISSION_CHANGE` naming granter, grantee and role, and an `iam.RoleGranted` outbox message.
  - A revoked grant is refused on the next request.
  - A duplicate live phone or email is 422 `DUPLICATE_VALUE`.
  - Disabling revokes every session at once and login fails; enabling restores it.
  - Unlock clears a lockout at once.
  - A reset revokes the sessions and forces a change.
  - `createUser`, `resetUserPassword` and `createGrant` without a step-up in five minutes are 403 `STEP_UP_REQUIRED`.
  - The temporary password is in no audit row and no idempotency row, yet a retry with the same key shows the same one.
- **Seed through services:**
  - The Owner's account and grant were written by the System, and the seven others with their grants by the seeded Owner, all under `hakorem-seed`.
  - All eight changed their password on a login challenge.
  - No seed source inserts into or updates an `iam` or `mdm` table, and every seed unit is a service unit.

**CI:** the runs on the final head commit are listed in the pull request and in the session's closing message, with their ids and events, as CLAUDE.md step 6 requires.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the back office (system administration).
- **Authorisation:**
  - The check is in the handler, at every branch involved, and denies by default.
  - Self-administration and role escalation are refused in code, and self-grant and self-revocation in the database too.
  - Refusals are audited detached, with the missing permissions named.
- **Identity:**
  - Temporary passwords are 80 bits, hashed with Argon2id and changed at first login.
  - They are kept nowhere in the clear (sealed in the idempotency store with the user's subject key) and are never logged or audited.
  - A reset and a disable revoke all sessions.
  - Unlock clears both the Redis lock and the row.
- **Data:** email and phone in the user audit events are encrypted with the staff subject key (`personalFields`). Queries are parameterised and `ILIKE` input is escaped.
- **Abuse:** insider privilege escalation is blocked by the grant rules. Every accepted change is published for B12's `PERMISSION_CHANGE` item.
- **Not applicable:**
  - uploads: B04e continued 2;
  - payments and webhooks: none here.

## Notes for the frontend track

- **Temporary passwords:** show `temporaryPassword` once, and do not store it. A retry with the same key shows it again.
- **Status:** `status` can be `LOCKED`; offer unlock then.
- **Grant forms:** a 403 on a grant means the role holds more than you hold there. Offer only roles your own permissions cover.

## Next session

B04e continued. The opener is in `docs/prompts/session-openers.md`, section "B04e continued — Roles, approvals and the customer realm":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e-iam-carry-overs.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the IAM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/iam.md, the IAM card in docs/MODULE_BOUNDARIES.md, ADR-0017, ADR-0034, ADR-0035 and
ADR-0043. Use docs/prompts/module-build-prompt.md as the recipe, and run hakorem-security-review on every
operation: they are authentication, approvals and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Copy the user and grant slice's shape (B04e: AccessAdmin, PgAccessStore, AccessController) for every
endpoint, with the fragment moved from the planned file (scripts/contract/move-to-code.ts).
Then execute B04e continued only, on branch b04e2-auth-approvals, branched from b04e-iam-carry-overs:
role writes (createRole, updateRole), the approval endpoints over the existing Approvals mechanism
(listApprovals, getApproval, approveRequest, rejectRequest, cancelApprovalRequest), customer registration
and phone verification (FR-IAM-019), and password reset (FR-IAM-020) with CR-004 point 3's error codes.
Notification delivery is B11's: send the codes through the existing notification port and record what
waits. Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e2-auth-approvals.md, push, and open a stacked pull request against b04e-iam-carry-overs.
```
