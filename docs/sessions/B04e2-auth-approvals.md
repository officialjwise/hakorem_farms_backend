# B04e continued: Roles, approvals and the customer realm

Date: 2026-11-15 · Branch `b04e2-auth-approvals`, from `b04e-iam-carry-overs` · Pull request #14 (stacked on `b04e-iam-carry-overs`, not merged) · Status: **gate passed**, no split.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-122 | **Roles:** only the Owner holds `iam.role.manage`, which needs step-up. Nobody changes a role they hold (so the Owner role changes only by migration). Nobody adds or removes a permission they do not hold through some current grant. The Owner, Manager and Accountant roles keep `requiresTotp`. In `updateRole`, `permissions` and `limits` replace the whole set. **Soft deletion:** a permission leaves a role by soft deletion of its `iam.role_permission` link, not by the hard delete that `docs/data-model/iam.md` described. ADR-0024 gives the application role no DELETE on a MASTER table, so the soft deletion is the only reading consistent with an accepted ADR. **Approvals:** the Owner, Manager and Accountant hold `iam.approval.read` and `iam.approval.cancel.own`. Deciding also needs the policy's approver permission at the branch, and a step-up when the policy's `requires_step_up` is set, which is now enforced. Only the maker withdraws a request. A lapsed request shows as `EXPIRED`, but nothing writes that status yet. `subject.number` and `evidenceFileId` are null for now. New code `ROLE_INVALID` | Owner |
| A-123 | **Registration:** only a Ghana number registers. The answer is identical for a known phone, which gets a notice SMS and a challenge with no code. An email another customer already uses is left off the new account. **Verification:** a customer signs in only once the phone is verified, and an unverified login gets a new code. Codes are six digits, valid ten minutes, five attempts, stored as an HMAC. **Reset:** the token goes by SMS to an account with a phone; an email-only account waits for B11. A reset revokes sessions, clears the lockout, and for a customer also verifies the phone. **Limits:** five per identifier per fifteen minutes, failing closed. **Sending:** after commit, without waiting. `MESSAGING_MODE` defaults to `capture` and must be `live` in production. **Events:** `iam.UserCreated` and `iam.PhoneVerified`. Linking an `mdm.customer` record waits for B7. **Audit:** a reset request for an unknown account is audited with no actor. **Seed:** no seeded customer account. New codes `VERIFICATION_CODE_INVALID` and `RESET_TOKEN_INVALID`, `RESET_TOKEN_USED`, `RESET_TOKEN_EXPIRED` | Owner |

Phase, scope and gate, as confirmed at the start:

1. Phase: B04e continued.
2. Scope: role writes (`createRole`, `updateRole`), the five approval endpoints over the existing Approvals mechanism, customer registration and phone verification (FR-IAM-019), and password reset (FR-IAM-020) with CR-004 point 3's error codes.
3. Gate: all of these are live, each write with a wrong-role refusal.

## Contract changes

**1.11.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Eleven more operations are served by the real API (126 from code, 474 planned):

- `createRole`, `updateRole`
- `listApprovals`, `getApproval`, `approveRequest`, `rejectRequest`, `cancelApprovalRequest`
- `registerCustomer`, `verifyCustomerPhone`
- `requestPasswordReset`, `resetPassword`

What else changed:

- **New error codes (all 422):** `ROLE_INVALID`, `VERIFICATION_CODE_INVALID`, `RESET_TOKEN_INVALID`, `RESET_TOKEN_USED` and `RESET_TOKEN_EXPIRED`. They are also in `docs/API.md` section 10.3.
- **Descriptions:** `x-error-codes` and descriptions state each operation's rules.
- **Customer login:** `loginCustomer` can now answer `VERIFICATION_REQUIRED`, a value `LoginResult` already had.

No schema, field, parameter or response changed shape. Redocly lint is clean; `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Domain | Three files, each under a new 100 percent gate. `role-admin.ts`: change beyond the actor, own role, TOTP roles, duplicate limits. `approval.ts`: adds withdrawal and the shown status. `self-service.ts`: Ghana phone, codes and their attempts, reset token refusals |
| Application | `RoleAdmin`. `ApprovalInbox`, plus `Approvals.cancel` and the policy step-up. `SelfService` for registration, verification and reset. `PhoneCodes`, which holds the HMAC codes and sends after commit. `AuthenticationService.continueLogin` and the unverified-customer step. `Authoriser` scope `stepUp` |
| Infrastructure and API | `PgAccessStore` role writes. `PgApprovalStore` inbox queries, with visibility and `decidableByMe` in SQL. `PgSelfServiceStore`. `ApprovalsController`. The role routes on `AccessController` and four public routes on `AuthController`. Eleven fragments moved from the planned file |
| Platform | `SMS_CHANNEL` is bound from configuration (`MESSAGING_MODE`, `SMS_*`). `DocumentRegistry.refs`. `OperationSpec.permissionByPolicy`, checked by the contract generator against the contract's policy text. The audit trail accepts no actor for `PASSWORD_RESET_REQUESTED` |
| Migrations | `0030`: role permission soft deletion and three permissions. `0031`: their grants. `0032`: `phone_verified_at` and `code_hash`. All three rolled back and applied again on the dev database |
| Events | `iam.RoleChanged`, `iam.UserCreated` (self-registered customer; no personal data) and `iam.PhoneVerified` |
| Docs | `docs/API.md`, the changelog, A-122, A-123, `docs/data-model/iam.md`, the IAM card, `DOMAIN_MODEL` events, OPERATIONS messaging, the openers |
| Test support | A client the pool is already closing now carries the pool's error handler. It caught a 57P01 teardown error that made one coverage run fail as unhandled, in `promotion-schema`, a file this session did not touch |

## Decisions

No new ADR: nothing here changes a structure, port, dependency or convention an ADR fixes.

- **IAM sends codes directly to the SMS port.** This was already the platform's rule for one-time codes (ADR-0009 and the port's comment).
- **`permissionByPolicy`** makes the generator check the contract's existing `x-permission` text. It changes nothing in the contract.
- **Soft-deleted role permission links:** ADR-0024's rule, applied (A-122).

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 2 is B5 |
| CR-004 | **Point 3 done:** `RESET_TOKEN_INVALID`, `RESET_TOKEN_USED`, `RESET_TOKEN_EXPIRED` (422), on `resetPassword` and in `docs/API.md`. Points 1 and 2 were answered in B3 (ADR-0034) |
| CR-005 | **Declined again:** one scripted pass when the frontend resumes. `listApprovals` keeps one example |
| CR-006 | Answered earlier |
| CR-007 | Already done: `createRole` and `updateRole` carry `x-requires-step-up: true`, and `step-up-contract.integration.spec.ts` still matches them to `iam.role.manage` |
| CR-008 | Answered earlier |

## Deferred

- **To B04e continued 2:** `evidence_file_id`, after which `ApprovalRequest.evidenceFileId` reads the column instead of null in `approval-inbox.ts`. Also the file store, the scanner, product images, and MDM imports and exports.
- **To B7:** link a verified customer account to an `mdm.customer` record from `iam.UserCreated` and `iam.PhoneVerified`, carrying the marketing consent. Seed storefront customers.
- **To B8:** document numbers in `ApprovalRequest.subject.number`.
- **To B11:** reset by email for email-only accounts, plus NTF templates and delivery receipts for the one-time messages.
- **To B12:** the `PERMISSION_CHANGE` report items from `iam.RoleChanged`.
- **To B13:**
  - a sweep that writes `EXPIRED` on lapsed requests;
  - `MESSAGING_MODE=live` with the provider in production.
- **Noticed, not this phase:** FR-IAM-005's acceptance says the bundled list refuses `Password1234!`, but with the range service off it accepts it (`password1234` is refused). It needs a look in a hardening pass; it is not in `docs/BACKLOG.md` yet.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 521 passed. New: `role-admin.spec.ts` and `self-service.spec.ts`, and `approval.spec.ts` extended; all three are at 100 percent on all four measures. Every earlier `fullCoverage` gate holds |
| Integration | New: `roles-approvals.integration.spec.ts` (19 tests) and `customer-realm-reset.integration.spec.ts` (12, against a stub SMS provider). The handler walk now covers 126 routes |
| Coverage, merged | 988 passed. Statements 92.97 percent, branches 84.08 percent (gate 80). One unhandled teardown error, fixed above; the rerun of that file was clean three times |
| Contract | 40 passed. New: `b4/roles-approvals-self-service.contract.spec.ts` covers every new response shape and the error envelope |
| Lint, type check | Clean |
| End to end | New `test/e2e/iam/customer-realm.e2e.spec.ts`: registration and reset answer alike on the built stack, and an unverified login gets no session. It runs in CI on the production image; I did not run it on this machine |
| Rollback | `0032`, `0031` and `0030` rolled back and applied again |

## Gate

**Passed.** I proved it by running these tests:

- **Wrong roles:**
  - On `createRole` and `updateRole`, the Manager, Accountant, Sales, Cashier, Storekeeper and Driver are each refused with 403 `FORBIDDEN`, and each refusal is audited (12).
  - On `listApprovals`, `getApproval` and `cancelApprovalRequest`, Sales, the Cashier, the Storekeeper and the Driver are refused with 403.
  - On `approveRequest` and `rejectRequest`, those four and the Accountant (who lacks the policy permission) are refused with 403, as is a Manager at another branch, and the request stays `PENDING`.
  - A user with no grant gets 403 on every permissioned route, approve and reject included.
- **Roles:**
  - The Owner needs a step-up.
  - A permission the Owner lacks gets 403.
  - The Owner role cannot be changed by its holder (403, audited).
  - Turning TOTP off on the Manager role is 422 `ROLE_INVALID`.
  - A removed permission is soft-deleted with the actor, and the holder loses it on the next request; adding it back restores it.
  - A stale version is 409.
  - The database refuses deleting a system role (23514).
  - There are still exactly ten system roles.
- **Approvals:**
  - An approval runs the handler in the same transaction, is published as `iam.ApprovalDecided`, and a replay returns the same response.
  - The maker is refused with 422 `MAKER_CANNOT_CHECK`.
  - A changed subject is refused with 422 `APPROVAL_SUBJECT_CHANGED`.
  - A policy step-up is enforced.
  - A lapsed request shows as `EXPIRED` and is refused.
  - Only the maker can withdraw a request (anyone else gets 403, audited), and a second withdrawal is 422.
  - The inbox visibility, `canDecide`, `decidableByMe`, `requestedByMe` and the cursor all hold.
- **Customer realm (FR-IAM-019):**
  - A known phone gets the same answer with no second account, and no code passes its challenge.
  - The sixth code is refused even when right (401 `CHALLENGE_EXPIRED`).
  - A code expires at ten minutes.
  - An unverified login gets a new code and no cookies.
  - A non-Ghana phone is 400.
  - The sixth registration of one phone is 429.
  - A customer cookie on `GET /iam/users` is refused.
- **Reset (FR-IAM-020, CR-004 point 3):**
  - Known, unknown and malformed identifiers get identical bodies.
  - A reset revokes the earlier session and clears the lockout.
  - A used code is `RESET_TOKEN_USED`, an unknown one `RESET_TOKEN_INVALID`, and one past thirty minutes `RESET_TOKEN_EXPIRED`.
  - Only the newest code works.
  - A breached password does not spend the code.
  - The sixth request for one identifier is 429.

**CI:** green on commit `c6b8721` (see the end of this report).

## Security review (hakorem-security-review)

- **Boundaries:**
  - TB1, the public storefront: registration, verification and reset.
  - TB2, the back office: system administration and the approval inbox.
- **Authorisation:**
  - The check is in each handler and denies by default.
  - Approve and reject check `iam.approval.read` first, then the policy permission at the branch, with a step-up where the policy asks.
  - Maker and checker are kept apart by the domain and by the database CHECK.
  - Self-administration of roles is refused, and so is any change beyond what the actor holds.
  - Every refusal is audited detached.
- **Identity:**
  - Nothing reveals whether an account exists: registration and reset answer alike, and both do the same work (Argon2 hash, token row, SMS).
  - A known phone's challenge holds no code, so it cannot be guessed into a takeover.
  - Codes are kept as an HMAC with a server key, and tokens as SHA-256.
  - Messages are sent after commit, never through the outbox.
  - A reset revokes every session.
  - Per-identifier limits fail closed.
- **Data:**
  - Phone and email in the customer's `CREATE` audit event are encrypted with the customer's subject key.
  - Event payloads carry no name, phone or email.
  - Logs mask the phone (`scrubString`).
- **Abuse:**
  - An insider escalating through a role edit is blocked: no permission beyond the actor's, no editing a role they hold.
  - Every role change is published for B12's `PERMISSION_CHANGE` item.
- **Not applicable:** uploads (B04e continued 2), and payments and webhooks (none here).

## Notes for the frontend track

- **Registration** always answers `VERIFICATION_REQUIRED`: show the code screen. A wrong code is 422 `VERIFICATION_CODE_INVALID`; a 401 `CHALLENGE_EXPIRED` means start again. Signing in before verifying also leads to the code screen.
- **Reset:** the reset screen can name `RESET_TOKEN_INVALID`, `RESET_TOKEN_USED` and `RESET_TOKEN_EXPIRED` (CR-004 point 3).
- **Approval inbox:** offer approve and reject only where `canDecide` is true; a 403 `STEP_UP_REQUIRED` means ask for a code and retry with the same key.
- **Role forms:** offer only the permissions the user holds.

## Next session

B04e continued 2. The opener is in `docs/prompts/session-openers.md`, section "B04e continued 2 — The file store, uploads and MDM imports":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e2-auth-approvals.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM and DOC requirement blocks' file and import requirements in docs/SRS.md
(FR-MDM-019, FR-MDM-020 and the DOC upload requirements, nothing else), docs/data-model/iam.md,
docs/data-model/mdm.md, the platform and MDM cards in docs/MODULE_BOUNDARIES.md, ADR-0025, ADR-0032 and
A-057 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 2 only, on branch b04e3-file-store-imports, branched from b04e2-auth-approvals:
the file store with uploadFile, getFile and createFileSignedUrl, the malware scanner (A-057),
evidence_file_id on iam.approval_request, product images, and MDM's imports and exports with a dry run.
Write the failing tests first for every permission rule. Stop at the gate, write
docs/sessions/B04e3-file-store-imports.md, push, and open a stacked pull request against b04e2-auth-approvals.
```

## CI

Every run that exists for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`6c24de9`** (the feature head): push run `43675261670` and pull_request run `43675289570` both **failed**. In each, the static analysis step (semgrep `node_api_key`) read `require('SMS_API_KEY', '<message>')` in `app-config.ts` as a hard-coded key. Every other job passed, end to end included.
- **`c6b8721`** (`fix(platform): name the SMS settings a sandbox needs in a list`): push run `43675574190` and pull_request run `43675578684` are both **success**. All six jobs passed in each: lint and type check, the scans, unit and integration with the coverage gate, contract, build and scan the image, and the setup script with end to end against the stack from the built image.
- **This report's commit:** its runs are named in the session's closing message, since a commit cannot name its own runs.
