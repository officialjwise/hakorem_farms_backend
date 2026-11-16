# ADR-0057: The business's own account numbers are sealed with a data key of their own, wrapped by the key-encryption key

- **Status:** Proposed
- **Date:** 2026-11-16
- **Session:** B08 continued 1b2
- **Deciders:** backend track; the owner approves (A-193)

## Context

The shared brief requires "column-level encryption for bank and mobile money details". `docs/security/DATA_CLASSIFICATION.md` classifies bank and mobile money account numbers as Restricted (DC-40) and names `fin.bank_account.account_no_enc` among them, with the handling rule "AES-256-GCM envelope (`*_enc`), a data key per value wrapped by the key-encryption key (ADR-0022)". ADR-0022 sets the hierarchy (a key-encryption key outside the database, random 256-bit data keys stored wrapped by it, AES-256-GCM with a random nonce per value) and adds a key per data subject (`platform.subject_key`) for personal data, so that a deletion request can destroy it.

Every encrypted column built so far (a supplier's payout details and TIN, a staff member's TOTP secret) belongs to a data subject and is sealed with that subject's key. `fin.bank_account` holds the farm's own accounts: the number belongs to no customer, supplier, investor or staff member. `platform.subject_key.subject_type` admits only those four. If nothing is decided, FIN cannot store the number at all, or would store it under a key whose destruction rule (an erasure request) can never apply to it.

## Options considered

1. **A data key of its own for each number, wrapped by the key-encryption key and stored beside the ciphertext on the row.** Exactly DC-40's rule and ADR-0022's hierarchy; no new subject type, no new key table. Rotating the key-encryption key rewrites the row's wrapped key (not the ciphertext).
2. **A new subject type `BUSINESS` in `platform.subject_key`, one key for the farm.** Reuses the subject key code, but widens ADR-0022's list of data subjects with something that is not one, and puts the farm's numbers under a key whose purpose is to be destroyed on an erasure request.
3. **Encrypt the number directly with the key-encryption key.** Fewest moving parts, but ADR-0022 says the key-encryption key wraps data keys only, and rotating it would mean re-encrypting data. Ruled out by ADR-0022.
4. **Do not store the number, only its last four digits.** Nothing to protect, but bank reconciliation (B9a) and supplier payout files need the account itself, so it would have to be re-entered later.

## Decision

Option 1.

- `fin.bank_account.account_no_enc` (`bytea`) holds the number sealed by `platform/crypto/value-keys.ts` `sealWithOwnKey`: a fresh 256-bit data key from `newDataKey()`, AES-256-GCM with a random nonce, associated data `fin.bank_account.account_no_enc:<id>`, so a ciphertext copied into another row does not open.
- `fin.bank_account.account_no_data_key` (`bytea`) holds that data key wrapped by the active key-encryption key (`KeyRing.wrap`, binding `fin.bank_account.account_no:<id>`), and `account_no_kek_version` the version that wrapped it. A rotation re-wraps `account_no_data_key` and raises `account_no_kek_version`; the database refuses any other change to the sealed number (`ck_bank_account_change`).
- `account_no_last4` is the only form that leaves FIN: in responses, audit before and after values, the idempotency store and logs. The full number is never in a response, a log line, an audit payload, an outbox event, an error message or the idempotency record: the request is hashed for idempotency with the number replaced by an HMAC under a key derived from `LOOKUP_HMAC_KEY` (`hk-bank-account-number-v1`), so the stored request hash cannot be reversed by trying every number. The log scrubber redacts any field named `accountNo`, `account_no` or `accountNumber`.
- Opening a number (`openWithOwnKey`) is for the use case that needs it (bank reconciliation, a payout file), under its own permission, audited as `DECRYPT` (SC-18). No operation built in this session opens one.
- No erasure applies: the number is the business's, not a data subject's. A wrong number is corrected by adding a new account and deactivating the old one, never by editing the sealed value.

## Consequences

- Restricted values that belong to no data subject (the farm's own account numbers today; the provider webhook secrets of ADR-0022's list later) have a defined home: their own data key on their own row, under the same key-encryption key and the same cipher.
- `platform.subject_key` stays a list of data subjects; an erasure request can never touch the farm's bank details.
- KEK rotation now covers two places: `platform.subject_key.wrapped_key` and every `*_data_key` column. No rotation job or runbook exists yet (ADR-0022 names it); when it is written it re-wraps both, and the database already admits a re-wrap of `account_no_data_key` only together with a higher `account_no_kek_version` (BL-066).
- A database dump without the key-encryption key exposes only the last four digits.
- Binds: `docs/data-model/fin.md` (`fin.bank_account`), `docs/security/DATA_CLASSIFICATION.md` DC-40, `docs/security/SECURITY_ARCHITECTURE.md` (keys and secrets), SC-18, the `hakorem-security-review` skill.

## Verification

- `src/platform/crypto/value-keys.spec.ts` (unit): a sealed value opens with its own wrapped key and binding, not with another row's binding, not after a byte is changed.
- `test/integration/fin/bank-accounts.integration.spec.ts` (B08 continued 1b2): the stored `account_no_enc` does not contain the number and opens to it with the test key ring; the number appears in no response, log line, audit row, outbox row, idempotency row or error envelope; the database refuses a changed ciphertext or last four digits (`ck_bank_account_change`).
