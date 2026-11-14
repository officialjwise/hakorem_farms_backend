# Table dictionary: `iam`

Owner: IAM module. Identity, sessions, roles, grants and maker-checker approvals (ADR-0016, ADR-0017). Conventions are in `docs/DATA_MODEL.md`.

---

### `iam.principal` · MASTER

The single identity every actor has. Universally referenceable (ADR-0011).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL, CHECK in (`USER`, `API_KEY`, `SYSTEM`) | What sort of actor |
| `display_name` | `text` | NOT NULL | Shown on documents and in the audit log |
| `status` | `text` | NOT NULL, CHECK in (`ACTIVE`, `DISABLED`) | A disabled principal cannot authenticate |

Standard columns: `MASTER`.

- A `SYSTEM` principal exists for each worker (sealer, dispatcher, scheduler) so that automated actions have an actor.

### `iam.user_account` · MASTER

Login details for a person.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `principal_id` | `uuid` | PK, FK `iam.principal` | One account per principal |
| `realm` | `text` | NOT NULL, CHECK in (`STAFF`, `CUSTOMER`, `INVESTOR`) | Realms have separate logins and cookies |
| `email` | `text` | NULL | Login by email; stored lower-case |
| `phone_e164` | `text` | NULL, CHECK matches `^\+[1-9][0-9]{7,14}$` | Login by phone |
| `password_hash` | `text` | NULL | Argon2id encoded hash; null for an account that has not set one |
| `password_changed_at` | `timestamptz` | NULL | |
| `must_change_password` | `boolean` | NOT NULL DEFAULT `false` | Forced change on first login |
| `totp_required` | `boolean` | NOT NULL DEFAULT `false` | Set for privileged roles |
| `failed_attempts` | `integer` | NOT NULL DEFAULT 0 | Lockout backoff |
| `locked_until` | `timestamptz` | NULL | Lockout |
| `last_login_at` | `timestamptz` | NULL | |

Standard columns: `MASTER`.

- CHECK: at least one of `email`, `phone_e164` is present.
- Partial UNIQUE (`realm`, `email`) and (`realm`, `phone_e164`) where `deleted_at IS NULL`.

### `iam.totp_credential` · MASTER

A user’s TOTP secret.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `principal_id` | `uuid` | PK, FK `iam.principal` | |
| `secret_enc` | `bytea` | NOT NULL | TOTP secret, column-encrypted (ADR-0022) |
| `confirmed_at` | `timestamptz` | NULL | Enrolment is complete only after a first valid code |
| `last_used_step` | `bigint` | NULL | Rejects replay of a code within its time step |

Standard columns: `MASTER`.

### `iam.recovery_code` · WORK

Single-use codes for a user who has lost their TOTP device.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `code_hash` | `bytea` | NOT NULL | Codes are shown once and stored hashed |
| `used_at` | `timestamptz` | NULL | Single use |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |

### `iam.session` · DOCUMENT

One row per login: the device list.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Carried in the access token |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `realm` | `text` | NOT NULL | |
| `device_label` | `text` | NULL | Shown in the device list |
| `user_agent` | `text` | NULL | |
| `ip_created` | `inet` | NULL | |
| `csrf_token_hash` | `bytea` | NOT NULL | SHA-256 of the CSRF token, which is derived from the session id with a server key so a reload gets the same one (ADR-0034) |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `last_seen_at` | `timestamptz` | NOT NULL | Idle timeout |
| `idle_expires_at` | `timestamptz` | NOT NULL | |
| `absolute_expires_at` | `timestamptz` | NOT NULL | |
| `stepped_up_at` | `timestamptz` | NULL | Last TOTP entry, for step-up |
| `revoked_at` | `timestamptz` | NULL | Forced logout |
| `revoked_by` | `uuid` | NULL, FK `iam.principal` | |
| `revoke_reason` | `text` | NULL | |

- Never deleted. Index (`principal_id`) where `revoked_at IS NULL`.
- Carries only the columns listed: a session has no branch, status or version. Trigger: a revoked session cannot change (SQLSTATE HK003).

### `iam.refresh_token` · WORK

Rotating refresh tokens. Kept after use so that reuse is detectable.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `session_id` | `uuid` | NOT NULL, FK `iam.session` | |
| `token_hash` | `bytea` | NOT NULL, UNIQUE | SHA-256 of the token |
| `issued_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `expires_at` | `timestamptz` | NOT NULL | |
| `used_at` | `timestamptz` | NULL | Set once, on rotation |
| `replaced_by_id` | `uuid` | NULL, FK `iam.refresh_token` | The successor |

- Presenting a row whose `used_at` is set revokes the session.

### `iam.verification_token` · WORK

One-time tokens for password reset, phone and email verification and login codes, and the challenge between login steps (ADR-0034).

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `purpose` | `text` | NOT NULL, CHECK in (`PASSWORD_RESET`, `PHONE_VERIFY`, `EMAIL_VERIFY`, `LOGIN_CODE`, `LOGIN_TOTP`, `LOGIN_TOTP_ENROLMENT`, `LOGIN_PASSWORD_CHANGE`) | The `LOGIN_*` purposes are the steps between password and session (B3) |
| `token_hash` | `bytea` | NOT NULL, UNIQUE | |
| `device_label` | `text` | NULL | The login's device label, carried to the session the challenge ends in (B3) |
| `expires_at` | `timestamptz` | NOT NULL | |
| `attempts` | `integer` | NOT NULL DEFAULT 0 | Caps guessing |
| `consumed_at` | `timestamptz` | NULL | Single use |

### `iam.api_credential` · MASTER

Keys for integrations.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | The integration's identity |
| `key_prefix` | `text` | NOT NULL, UNIQUE | Shown in listings to identify a key |
| `key_hash` | `bytea` | NOT NULL | The key is shown once and stored hashed |
| `expires_at` | `timestamptz` | NULL | |
| `last_used_at` | `timestamptz` | NULL | |
| `rate_limit_per_minute` | `integer` | NOT NULL, CHECK `> 0` | Per-key rate limit |
| `revoked_at` | `timestamptz` | NULL | Rotation |

Standard columns: `MASTER`.

### `iam.permission` · LOOKUP

The fixed list of permission codes.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `code` | `text` | PK | `<module>.<resource>.<action>` |
| `module` | `text` | NOT NULL | |
| `description` | `text` | NOT NULL | Shown when editing roles |
| `requires_step_up` | `boolean` | NOT NULL DEFAULT `false` | Fresh TOTP needed to use it |

### `iam.role` · MASTER

A named set of permissions.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `code` | `text` | NOT NULL, UNIQUE among live rows | `OWNER`, `MANAGER`, `ACCOUNTANT`, `STOREKEEPER`, `CASHIER`, `SALES`, `FARM_HAND`, `DRIVER`, `INVESTOR`, `CUSTOMER` seeded |
| `name` | `text` | NOT NULL | |
| `is_system` | `boolean` | NOT NULL DEFAULT `false` | Seeded roles cannot be deleted |
| `requires_totp` | `boolean` | NOT NULL DEFAULT `false` | Owner, Accountant, Manager |

Standard columns: `MASTER`.

### `iam.role_permission` · MASTER

Which permissions a role contains.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `role_id` | `uuid` | NOT NULL, FK `iam.role` | |
| `permission_code` | `text` | NOT NULL, FK `iam.permission` | |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `created_by` | `uuid` | NOT NULL, FK `iam.principal` | |

- PK (`role_id`, `permission_code`). Removal is a hard delete of the link, with the before state in the audit log.

### `iam.role_limit` · MASTER

Amount limits attached to a role, read by the owning module.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `role_id` | `uuid` | NOT NULL, FK `iam.role` | |
| `limit_kind` | `text` | NOT NULL, CHECK in (`PRICE_OVERRIDE_PER_LINE`, `PRICE_OVERRIDE_PER_SHIFT`, `REFUND_WITHOUT_APPROVAL`, `PURCHASE_ORDER_APPROVAL`, `STOCK_ADJUSTMENT_WITHOUT_APPROVAL`) | |
| `amount_pesewas` | `pesewas` | NOT NULL | The limit |

Standard columns: `MASTER`.

- PK (`role_id`, `limit_kind`).

### `iam.role_grant` · MASTER

A role given to a principal at a branch, optionally one location.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `principal_id` | `uuid` | NOT NULL, FK `iam.principal` | |
| `role_id` | `uuid` | NOT NULL, FK `iam.role` | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | Scope |
| `location_id` | `uuid` | NULL, FK `mdm.location` | Null covers the whole branch |
| `valid_from` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `valid_to` | `timestamptz` | NULL | Temporary cover |

Standard columns: `MASTER`.

- UNIQUE NULLS NOT DISTINCT (`principal_id`, `role_id`, `branch_id`, `location_id`) among live rows.

### `iam.approval_policy` · MASTER

When an approval is needed and who may give it.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL | Approval kind (ADR-0017) |
| `branch_id` | `uuid` | NULL, FK `mdm.branch` | Null for all branches |
| `threshold_pesewas` | `pesewas` | NULL | Approval needed at or above this; null means always |
| `approver_permission` | `text` | NOT NULL, FK `iam.permission` | What the checker must hold |
| `requires_evidence` | `boolean` | NOT NULL DEFAULT `false` | For example a photograph for mortality |
| `requires_step_up` | `boolean` | NOT NULL DEFAULT `false` | |

Standard columns: `MASTER`.

- UNIQUE NULLS NOT DISTINCT (`kind`, `branch_id`) among live rows.

### `iam.approval_request` · DOCUMENT

One maker-checker request. Posted statuses: `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`.

| Column | Type | Constraints | Why |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | |
| `kind` | `text` | NOT NULL | |
| `branch_id` | `uuid` | NOT NULL, FK `mdm.branch` | |
| `subject_document_id` | `uuid` | NOT NULL, FK `platform.business_document` | What is being approved |
| `payload_hash` | `bytea` | NOT NULL | Binds the approval to the exact content |
| `amount_pesewas` | `pesewas` | NULL | For threshold and reporting |
| `summary` | `text` | NOT NULL | What the checker is shown |
| `evidence_file_id` | `uuid` | NULL, FK `platform.stored_file` | Photograph or document |
| `requested_by` | `uuid` | NOT NULL, FK `iam.principal` | The maker |
| `requested_at` | `timestamptz` | NOT NULL DEFAULT `now()` | |
| `status` | `text` | NOT NULL, CHECK in (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`) | |
| `decided_by` | `uuid` | NULL, FK `iam.principal` | The checker |
| `decided_at` | `timestamptz` | NULL | |
| `decision_reason` | `text` | NULL; required for `REJECTED` | |
| `expires_at` | `timestamptz` | NULL | Stale requests lapse |
| `version` | `integer` | NOT NULL DEFAULT 1 | Optimistic lock |
| `updated_at` | `timestamptz` | NOT NULL DEFAULT `now()` | Set by `platform.touch_version()` |

- **CHECK (`decided_by IS NULL OR decided_by <> requested_by`)**: the maker cannot be the checker.
- CHECK: `decided_by` and `decided_at` are set exactly when status is `APPROVED` or `REJECTED`.
- Partial UNIQUE (`subject_document_id`, `kind`) where status is `PENDING`: one open request per subject and kind.
- Frozen once decided (`platform.freeze_posted`).
- `evidence_file_id` is added, with its foreign key to `platform.stored_file`, by the B4 migration that creates the file store (docs/DATA_MODEL.md, Migrations).
