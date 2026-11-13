# ADR-0022: Column encryption, key management, and erasing personal data from immutable records

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires column-level encryption for bank and mobile money details, identity numbers and investor payout details, encryption at rest and in transit, and logs scrubbed of secrets. It requires an immutable, hash-chained audit log with before and after values, and it also requires handling of customer data deletion requests under Ghana's Data Protection Act. An audit log that can never change and a right to have personal data deleted contradict each other unless the design resolves it at the start. It cannot be retrofitted: once plaintext personal data is in a hash-chained row, removing it breaks the chain.

## Options considered

1. **Leave personal data out of the audit log.** Resolves the conflict, but the brief requires before and after values, and a disputed change to a customer's phone number is exactly what the log is for.
2. **Database-side encryption (`pgcrypto`).** Keys pass through SQL and can appear in logs and statement statistics.
3. **Application-side envelope encryption, with a key per data subject for anything written to immutable storage.** Destroying a subject's key makes their data unreadable without altering a single stored byte.

## Decision

Option 3.

**Key hierarchy**

- A key-encryption key (KEK) is held outside the database: in the secrets file on the server, readable only by the deploy user, injected as an environment variable. It has a version, and old versions are kept to decrypt old data.
- Data-encryption keys (DEKs) are random 256-bit keys, stored wrapped by the KEK.
- Cipher: AES-256-GCM with a random nonce per value. Stored form: key id, nonce, ciphertext, tag.

**Encrypted columns**

- Restricted fields are stored in `BYTEA` columns named `*_enc`: supplier and investor bank and mobile money details, identity numbers, tax identification numbers of individuals, TOTP secrets, webhook secrets.
- Where equality lookup is needed (finding a customer by phone number), a keyed hash is stored beside it in a `*_hash` column (HMAC-SHA-256 with a separate key). Phone numbers used for login and messaging are stored in clear in the master record and are classified confidential.
- Decryption happens only in the owning module, only for a permission that allows it, and every decryption of payout details is audited.

**Per-subject keys and erasure**

- `aud.subject_key` holds one wrapped DEK per data subject (customer, supplier contact, investor, staff member).
- Anything written to an immutable store that contains a subject's personal data is encrypted with that subject's key before it is written. This applies to the `before` and `after` values of audit events.
- The audit content hash is computed over the stored bytes, which are ciphertext for those fields. The chain therefore verifies whether or not the key still exists.
- An approved deletion request destroys the subject's wrapped key (the row keeps `destroyed_at`, who and why). The personal data in every audit event becomes permanently unreadable. Nothing in the audit log is updated or deleted.
- Master records are anonymised in place by the same request: personal fields are overwritten with a marker and the record is soft-deleted. This is an audited update of a `MASTER` table.
- Financial documents that the law requires the business to keep (invoices, receipts) are retained for the statutory period with the details they were issued with. The retention periods, and what a deletion request therefore cannot remove, are set out in `docs/security/COMPLIANCE.md` in B1.

**Never stored, never logged**

- Card numbers never reach the server (hosted or tokenised provider flow).
- Passwords, tokens, one-time codes and key material are never written to the audit log, the outbox or application logs. The audit writer replaces them with `[redacted]` by field classification.
- Logs and traces mask phone numbers to the last three digits and drop payment identifiers.

**At rest and in transit**

- TLS 1.3 from the browser to Caddy. Database, Redis and application traffic stays on a private Docker network on one host.
- The server's disk is encrypted where the hosting plan allows; backups and WAL archives are encrypted client-side before leaving the server, with a key separate from the KEK.

**Rotation**

- KEK rotation re-wraps DEKs and touches no data rows. It is a runbook in B1.
- A DEK is rotated by writing new values with a new key id; old values remain readable until re-encrypted by a background job.

## Consequences

- A database dump or a stolen backup does not expose restricted fields or the personal data in the audit log.
- A deletion request can be honoured without breaking audit integrity.
- Losing the KEK loses every encrypted value. The KEK is backed up separately from the database, and the restore drill proves that both can be brought back.
- Reports cannot filter or sort on encrypted fields. This is intended.
- Binds: `docs/security/SECURITY_ARCHITECTURE.md`, `docs/data-model/aud.md`, B1's data classification and compliance documents, the `hakorem-security-review` skill.

## Verification

- B3: round-trip tests; a test that destroying a subject key leaves the audit chain verifying and the payload unreadable; a test that secret fields never appear in an audit payload.
- B3: a log-scrubbing test that feeds a phone number, a token and a payment reference through the logger and asserts none appears in output.
- B13: the restore drill restores the KEK from its separate backup and decrypts a sample value.
