# Runbook: audit chain integrity

Last reviewed: 2026-11-13. Severity: Warning for sealing lag, **Critical for any mismatch**. Related: ADR-0006 (tamper evidence), ADR-0022 (per-subject keys and erasure), ADR-0024 (roles), `docs/security/SECURITY_ARCHITECTURE.md` section 7, `docs/data-model/platform.md`, `docs/runbooks/incident-response.md`.

## How the audit log is protected

1. **Stage one, in the business transaction.** Every audited action writes a row to `platform.audit_event`. A `BEFORE INSERT` trigger sets `txid` and `content_hash` (SHA-256 of the row's canonical bytes); the application cannot supply either. The application role has insert and select only, and triggers reject update, delete and truncate for every role.
2. **Stage two, the sealer.** One process (`hk_sealer`, one worker thread, `AUDIT_SEALER_ENABLED`) turns events into a chain: `platform.audit_chain` has one row per event with `seq` (gap-free), `prev_hash` and `chain_hash = sha256(prev_hash || content_hash || seq)`. It seals events whose `txid` is below the oldest transaction still in progress, in `txid` then `id` order, so the order is final.
3. **Stage three, the anchor.** Daily at 23:55 and at every shift close, the sealer signs the chain head (`seq`, `chain_hash`) with a key held outside the database and stores the signed anchor in the **anchor bucket with object lock**, and in `platform.audit_anchor`.
4. **The nightly verifier** (`audit-verify`, 03:10) recomputes every content hash and chain hash, compares the head with the latest anchor, and finds any gap in `seq` and any event older than 5 minutes without a chain row.

Personal data inside `before` and `after` is encrypted per data subject before it is hashed. **Destroying a subject's key on an approved deletion request does not break the chain**, because the hash covers the stored ciphertext. So a deletion request is never the explanation for a mismatch.

## Symptoms

| Alert | Meaning |
| --- | --- |
| Audit sealing lag more than 60 s (warning), more than 300 s (critical), or an event unsealed for more than 5 minutes | The sealer is behind or stopped. The events are still protected by privileges and triggers, but not yet chained |
| Longest open transaction more than 30 s (warning) or 120 s (critical) | A long transaction holds back the sealing horizon for everything behind it |
| Chain verification mismatch, gap in `seq`, or head differing from the latest anchor | **Possible tampering or corruption.** Critical |
| Anchor missing or failing to write; verification not run in 26 hours | The off-box evidence is not being produced, or the verifier is not running |
| Clock offset more than 1 s (warning) or 5 s (critical) | Anchor and audit times may be unreliable |
| `GET /audit/integrity` shows `outcome` `DRIFT` or `FAILED` | The latest verification found a problem or could not run |

## A. Sealing lag, no mismatch

This is the common case and it is not an incident.

1. **Is the sealer running?** `dc ps worker`, `dc logs --since 15m worker | grep -i seal`. One process seals (`AUDIT_SEALER_ENABLED=true` on exactly one worker). If two run, the second fails on the unique `seq` and it should be stopped.
2. **How far behind?**
   ```sql
   SELECT count(*) AS unsealed, min(e.recorded_at) AS oldest
   FROM platform.audit_event e
   LEFT JOIN platform.audit_chain c ON c.audit_event_id = e.id
   WHERE c.seq IS NULL;
   ```
3. **Is a long transaction holding the horizon?**
   ```sql
   SELECT pid, usename, state, now() - xact_start AS age, left(query, 120) AS query
   FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 10;
   ```
   A transaction older than 30 s is the cause: find the handler (correlation id in the log), and let it finish or end it (`pg_terminate_backend(pid)` for an `idle in transaction` session only, and log it). The `idle_in_transaction_session_timeout` of 10 s should have ended it; check the setting if it did not. The sealer then catches up on its own.
4. **Restart the sealer** if it is stuck: `dc up -d --force-recreate worker`. It resumes from the last sealed event; nothing is lost. If it fails on start, read the error: a missing `DATABASE_URL_SEALER`, a wrong password, or a conflicting `seq` (see B).
5. **Verify** the lag falls to seconds and `unsealed` reaches zero.

## B. The sealer fails with a sequence or hash error

The sealer refuses to write if the `seq` it would write already exists or its `prev_hash` does not match the head. Do not "fix" this by editing the chain. Treat the first sentence of Section C as applying.

## C. Verification mismatch, gap, or head differs from the anchor

> **Stop. Do not repair, re-seal, delete or rerun anything that writes. Capture evidence first** (`docs/runbooks/incident-response.md`, step 2).

1. **Open an incident (SEV2, SEV1 if there are signs of intrusion)** and tell the owner. A mismatch is the detection of abuse case 15, "audit log or ledger altered directly in the database".
2. **Capture the evidence** as in incident-response step 2: a labelled physical backup, an export of `platform.audit_chain`, `audit_event` hashes and `audit_anchor`, the anchor objects downloaded from the anchor bucket, logs, and the database server log. Include the verifier's output (`platform.job_run.summary` for `audit-verify`).
3. **Narrow the damage.** The job summary gives the first mismatching `seq`. Determine what kind of mismatch it is:

| Finding | Meaning | Next |
| --- | --- | --- |
| A `content_hash` recomputed from the row differs from the stored one | An `audit_event` row's contents changed after insertion | Section D |
| A `chain_hash` recomputed from the previous row, content hash and `seq` differs | A chain row was changed, or a row was removed or inserted before it | Section D |
| A gap in `seq`, or an event with no chain row where one is due | A row was deleted, or the sealer failed mid-write | Section D |
| The current head differs from the latest anchor for a `seq` that exists in both | The chain was rewritten after the anchor | Section D (the most serious: needs the signing key to have been used or the verifier to be wrong) |
| The anchor signature does not verify against the published public key | The anchor object or the key is wrong | Check that you have the right public key and key id (`signing_key_id` on the anchor); keys rotate yearly, old public keys stay in `docs/` |
| The chain verifies but is **behind** the anchor (the head `seq` is lower than the anchor's) | Sealed events that were anchored are missing from the database | A restore lost data (check the restore history), or events were removed |

4. **Rule out the innocent causes**, in this order, using the evidence copies:
   - **A restore** to an earlier time, or a point-in-time recovery, which the incident log would show.
   - **A verifier bug**: recompute the hashes for the same range on a restored copy of the database (use the `evidence` backup) with an independent script; if the copy verifies, the live database was changed after the backup, or the live verifier is wrong.
   - **Hardware corruption**: disk or filesystem errors in `dmesg`, PostgreSQL checksum failures in the log, a bad backup.
   - **A migration or superuser change** noted in the pipeline's migration approvals or the incident log. Migrations are outside the audit log by design (recorded in the migration history and the pipeline's approval record). A migration is allowed to add columns; it must never change the content of existing audit rows. A migration that did is a defect.
   - **Clock offset**: does not change hashes, but affects `occurred_at` and anchor times; check `chronyc tracking`.
5. **Everything else is tampering until shown otherwise.** Continue under `incident-response.md`: containment (revoke database credentials that may have leaked, rotate `DATABASE_URL_*` passwords, check who used the superuser), investigation, notification.

## D. What may and may not be done

- **Never** update, delete or re-insert into `platform.audit_event`, `platform.audit_chain` or `platform.audit_anchor` to make a check pass. The triggers reject it for every role; defeating them (disabling a trigger as the superuser) is itself an event for the incident log and is not done to "fix" a chain.
- **Do not re-seal.** The honest record is: the chain verified until `seq` N, and failed at N+1; the anchors prove the state at the anchor times. That fact is the product.
- **Moving on.** After the evidence is captured and the owner has decided, new events continue to be sealed. If the damaged range cannot be repaired, the sealer may be told to start a **new segment** after the last good `seq` by a controlled administrative procedure that writes a signed marker event (specified by the B3 session in its report) naming the incident, the last good `seq` and its anchor; the old segment is kept untouched as evidence. This is the owner's decision, recorded in the incident log, and done by the administrator with a witness. Until that procedure exists in code, the verifier keeps reporting the break and the health check stays `DEGRADED` with the known reason, which is acceptable.
- **Restore** from backup is never the way to "undo" a mismatch: it throws away the evidence and the events after the backup. It is used only if the database is unusable (`restore-from-backup.md`), after the evidence copy exists.

## E. Anchor problems

- **The anchor job fails** (object storage down, credentials wrong, the signing key missing): `dc logs worker | grep anchor`. Check `S3_ANCHOR_*`, `AUDIT_ANCHOR_KEY_ID` and `AUDIT_ANCHOR_SIGNING_KEY` in the worker's environment only. Fix, then run the anchor job by hand; it anchors the current head. A missed anchor is not data loss, but each day without one lengthens the window an attacker with database access could rewrite unnoticed.
- **Key rotation** (yearly): generate the pair, publish the public key in `docs/` with its id and start date before the key is used; set `AUDIT_ANCHOR_KEY_ID`; deploy the worker. Keep every old public key.
- **Missed shift-close anchors:** shift-close anchors are triggered by `approveShiftClose`; if they are absent the daily one still covers.
- **Clock offset** above 1 s: fix NTP (`systemctl restart chrony`, `chronyc makestep` once), and note the interval in the log if anchor times were affected.

## F. Evidence of a clean state (periodic)

Each month, with the monthly restore verification, the administrator confirms: the verifier ran every night; the latest anchor is less than 24 hours old; the anchor bucket's object lock is on and the anchor writer's key cannot delete; `GET /audit/integrity` shows `SUCCESS`; and the head `seq` equals the count of events. The result is one line in the monthly checklist.

## Verification

- `GET /audit/integrity` returns outcome `SUCCESS`, `unsealedCount` zero, and a latest anchor less than 24 hours old.
- `SELECT outcome, finished_at FROM platform.job_run WHERE job_name = 'audit-verify' ORDER BY finished_at DESC LIMIT 3;` shows `SUCCESS`.
- The health check `audit_sealing_lag` is `OK`.
- For a lag incident: the oldest unsealed event is a few seconds old, and no transaction older than 30 s exists.
- For a mismatch incident: the incident log records the last good `seq`, the evidence checksums and the owner's decision.

## Escalation

| When | Who |
| --- | --- |
| Any hash mismatch, gap, or head disagreeing with an anchor | Owner immediately; `incident-response.md` |
| Sealing lag above 300 s that a restart does not fix | Administrator; owner informed after 30 minutes |
| The anchor cannot be produced for 24 hours | Owner (the evidence window is open) |
| The signing key may be exposed | `incident-response.md`: rotate, publish, and treat anchors since the exposure as untrusted until re-anchored |
