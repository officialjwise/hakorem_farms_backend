# Runbook: incident response

Last reviewed: 2026-11-13. Severity: Critical. Related: `docs/security/THREAT_MODEL.md` (abuse cases 1 to 18), `docs/security/SECURITY_ARCHITECTURE.md` (sections 7 and 11), ADR-0006, ADR-0022, `docs/security/COMPLIANCE.md` (obligations and their sources), `docs/runbooks/audit-chain-integrity.md`, `docs/runbooks/restore-from-backup.md`.

The realistic threat to this business is a person with a valid login: voiding a cash sale, writing off a living goat, adjusting stock to cover a theft, diverting a payment. Outside attackers are the second case. This runbook covers both. Its central rule:

> **Capture evidence first, in a way that does not destroy it. Contain second. Correct last.**

Corrective action (fixing data, restarting services, rotating keys, deleting accounts) overwrites the very things that show what happened.

## What counts as an incident

Declare one when any of these is true, or you are not sure:

- Evidence that someone accessed or changed data they should not have (an investor account reading finance data, a bulk export nobody can explain, a refresh token used twice).
- A forged or suspicious webhook, a payment marked paid that the provider did not confirm, a payment provider key that has leaked.
- Money or stock that is wrong in a way a person could have caused: repeated voids by one cashier, adjustments with no reason, a shift short again and again, an offline sale that was removed (`DEVICE_COUNTER_GAP`) or refused as tampered (`REJECTED_INTEGRITY`).
- The audit chain, a ledger or a stock balance does not verify (`audit-chain-integrity.md`) and the cause is not a known fault.
- A stolen or lost device, laptop, phone or key that held access.
- Unexplained access to the server, unknown processes, changed files, an unexpected deployment.
- Personal data exposed by a bug, a misconfiguration or a message sent to the wrong people.
- Ransomware, defacement, or a hosting-provider breach notice.

If it is only an outage with a known technical cause, use the matching runbook instead.

## Roles

| Role | Does |
| --- | --- |
| Incident lead | The administrator on call. Decides what is done and in what order, and keeps the log |
| Owner | Decides about notification, about the people involved, about money, and about bringing the system back |
| Scribe | A second person who writes the log as it happens, so the lead can work. In a small team this may be the accountant |
| Witness | For any action that touches the database as superuser or touches evidence, a second person watches and initials the log entry |

Never investigate a suspected insider alone, never confront them before evidence is captured, and keep the circle small: the owner, the lead, the scribe.

## Severity

| Level | Meaning | Examples | First response |
| --- | --- | --- | --- |
| SEV1 | Active compromise, data exposure, or money being lost now | Leaked provider key, intruder on the server, a forged payment accepted | Start immediately; evidence capture runs in parallel with containment of the active harm |
| SEV2 | Suspected fraud or tampering, no active loss | Refresh token reuse, repeated voids by one cashier, chain mismatch | Evidence capture, then containment within the hour |
| SEV3 | Anomaly under review | A single unexplained export, one rejected sync | Evidence capture, review within the day |

## Step 1: open the log (within 10 minutes)

Create the entry `INC-YYYYMMDD-n` in the incident log (see `docs/runbooks/README.md`). Write down: time detected (UTC), by whom or what alert, what was seen, the correlation ids and entities named, severity, the lead and the scribe. Everything from here is timestamped in UTC and signed by who did it.

## Step 2: capture the evidence

Do all of this **before** any corrective action. Active containment of ongoing harm (section 3) may run alongside it, but never replaces it. Do not reboot servers, restart containers, redeploy, rotate keys, prune Docker, delete accounts or sessions, or "tidy" anything until the relevant item below is done.

Create a folder for the evidence: `/root/evidence/INC-YYYYMMDD-n/` on the server (root-only, mode 0700) and an evidence prefix in the backups bucket: `evidence/INC-YYYYMMDD-n/` (the evidence copy is made with credentials that can write there and the bucket's lifecycle rule does not expire the `evidence/` prefix). After each item, compute `sha256sum` of what you captured and record it in the log with the time and your initials. This is the chain of custody.

### 2.1 Snapshot the database

A snapshot without stopping the system, so evidence is not lost to ongoing changes.

```bash
# a labelled physical backup, immediately, tagged with the incident id; it also preserves the WAL up to now
dc exec postgres pgbackrest --stanza=hakorem --type=full \
  --annotation=incident=INC-YYYYMMDD-n backup
dc exec postgres pgbackrest --stanza=hakorem info          # note the backup label in the log
```

Then copy that backup set and the WAL archive range to the evidence prefix so the 30-day retention cannot expire it (`aws s3 cp` or the provider's equivalent with the backup credentials, from the backups bucket to `evidence/INC-.../pgbackrest/`). A logical copy for reading is also useful: `pg_dump -Fc` of the whole database with `hk_backup`, encrypted with the backup key, uploaded the same way. The physical backup is the evidence; the logical dump is the working copy to look at.

### 2.2 Export the audit chain and the anchors

```bash
# verify, and record the result without changing anything
# (run as hk_sealer or the administrator; the verifier only reads)
GET /v1/audit/integrity          # as the owner or accountant: head, latest anchor, unsealed count, last verification

# export the events and the chain for the period of interest, and the whole chain head record
dc exec postgres psql -U hk_sealer -d hakorem -c "\copy (select * from platform.audit_chain order by seq) to stdout csv header" > /root/evidence/INC-.../audit_chain.csv
dc exec postgres psql -U hk_sealer -d hakorem -c "\copy (select id, occurred_at, recorded_at, actor_id, session_id, ip, correlation_id, module, action, entity_type, entity_id, encode(content_hash,'hex') from platform.audit_event where recorded_at >= now() - interval '30 days' order by txid, id) to stdout csv header" > /root/evidence/INC-.../audit_events.csv
dc exec postgres psql -U hk_sealer -d hakorem -c "\copy (select * from platform.audit_anchor order by seq) to stdout csv header" > /root/evidence/INC-.../audit_anchor.csv
```

The export of the `before` and `after` bytes of specific events is done on request of the lead for named entities only, because they contain personal data encrypted per subject; the evidence folder is treated as Confidential. Download the **anchor objects** themselves from the anchor bucket (object lock keeps them), with their signatures, and verify each against the published public key in `docs/`. Record: latest anchor sequence and time, whether the current chain verifies up to it, and any gap or mismatch. If the chain does not verify, stop and read `audit-chain-integrity.md` before anything else; the mismatch itself is evidence.

### 2.3 Preserve logs

The on-box container logs roll over (250 MB per container) and the nightly archive only covers up to the last run.

```bash
# archive now, for every container, with the full output
/opt/hakorem/bin/log-archive --now            # the same job as the nightly one, run immediately
for c in $(docker ps -q); do docker logs --timestamps $c > /root/evidence/INC-.../$(docker inspect --format '{{.Name}}' $c | tr -d /).log 2>&1; done
cp -a /var/log/caddy /root/evidence/INC-.../caddy
journalctl -u ssh -u docker --since "7 days ago" > /root/evidence/INC-.../journal.txt
last -aiF > /root/evidence/INC-.../last.txt; lastb -aiF > /root/evidence/INC-.../lastb.txt 2>/dev/null
cp -a /var/log/auth.log* /root/evidence/INC-.../ 2>/dev/null
```

Also record the **volatile state** that disappears on reboot, in the order of likely loss: `date -u`, `uptime`, `ps auxf`, `ss -tnp`, `docker ps -a`, `docker stats --no-stream`, `who`, `w`, `ufw status verbose`, `crontab -l` for each user, the output of `dc config` with secrets removed, and `ls -laR /opt/hakorem /etc/hakorem` (names and times only, no contents). Sentry: note the relevant issue ids and the time range; the uptime monitor's history.

### 2.4 Preserve the application context

- The daily exception report for the period (`GET /exceptions/daily-report`), the exception list (`GET /exceptions`), and the specific records named by the alert (orders, payments, shifts, deliveries, adjustments, approvals, users and grants). Export each as JSON with the correlation id.
- The list of sessions and devices for the accounts involved (`GET /iam/sessions`, `GET /registers/{id}/devices`), API credentials and their last use.
- The webhook ledger for the period (`pay.webhook_event`), outbound webhook deliveries, the offline sync log (`pos.sale_sync`) for the devices involved, file access log (`platform.file_access_log`).
- Do **not** run bulk exports that touch customer data (the export itself would be a new event on the report); read the specific records.

### 2.5 Record who has access

Who has the secrets file, the CI key, the provider dashboards and the sealed envelopes; who was on shift; what changed in the last 7 days (releases, grants, settings changes: `GET /audit/events?action=SETTING_CHANGE` and `PERMISSION_CHANGE`).

When evidence capture is complete, write "evidence captured" in the log with the time and the SHA-256 list.

## Step 3: contain

Contain the harm with the smallest action that stops it and keeps the state. Each action is logged, and each is **audited by the system**, which is also evidence.

| Situation | Containment | Notes |
| --- | --- | --- |
| A staff account is suspected | `POST /iam/users/{id}/disable` and `POST /iam/sessions/{id}/revoke` for every session | Disabling does not delete anything. Do it quietly: the person must not be able to clear their device first. Capture the evidence first |
| A session or refresh token was copied (reuse alert) | The session is already revoked. Force a password reset for the account (`resetUserPassword`), revoke other sessions, review that account's recent actions | Find how the token leaked (shared device, malware) |
| A grant was changed improperly | Revoke the grant (`revokeGrant`, step-up); review everything done with it | Permission changes are on the report |
| An API key leaked | Revoke it (`revokeApiCredential`), issue a new one, review its recent requests | Revoke only after the evidence is captured, unless money is moving |
| A webhook endpoint is misused | Pause it (`updateWebhookEndpoint`), suspend the integration | |
| A POS device is lost, stolen or suspected | `POST /devices/{id}/revoke`; force-close the shift (`POST /shifts/{id}/force-close`) | The device's queue syncs later under a manager (`OFFLINE_SYNC.md`) |
| A payment provider key leaked | Create a new key in the provider's dashboard, replace it in the secrets file, redeploy, then revoke the old key | Check the provider's transaction list for transactions you did not make |
| Forged webhooks arriving | Nothing to stop: they are rejected and logged. Keep the rejection log. If the volume is a flood, rate-limit the source at Caddy or `ufw` | A forged webhook never clears a payment |
| An address is attacking | `ufw deny from <ip>` and, for repeated offenders, a Caddy deny rule | A block is logged; it is not a fix |
| Intrusion on the server | Isolate: block inbound from the hosting panel's firewall except your own address; **do not power off** if memory evidence matters and there is time to capture it; take the provider's disk snapshot | The disk snapshot is also evidence |
| Ransomware or destructive tampering | Cut the server from the network (hosting panel), snapshot, then rebuild per `restore-from-backup.md` on a new server | Do not restore on top of the compromised server |
| Data exposed through a bug | Disable the affected endpoint or feature (a deploy of a fix, or a Caddy route block for that path) | Keep a copy of the affected responses' logs |
| The system must stop trading temporarily | Prefer read-only: revoke the sessions you must, and tell the shop to use offline mode. Stopping the API is a last resort | The counter keeps working offline for up to 8 hours |

## Step 4: investigate

Work from the copies in the evidence folder and from read-only queries, not from the live data where possible.

1. **Timeline.** Combine the audit events (who, what, from which address and session), the correlation ids, the logs and the exception report into one timeline in the incident log.
2. **Scope.** What was touched: which records, which customers or investors, which amounts, which period. What could have been touched and was not.
3. **Cause.** How did the actor get the ability: a shared password, a stolen device, a role granted too widely, a missing check in the code, a leaked key.
4. **Money and stock effect.** Quantify in pesewas. Use the ledger and the stock ledger, never a spreadsheet.
5. **Insider cases.** The controls that should have stopped it (maker-checker, approval limits, blind close) and why they did not. Do not accuse; present the timeline to the owner.
6. **Playbooks by type**

| Type (abuse case) | Look at |
| --- | --- |
| Voids, discounts, refunds by one person (1, 3, 12) | Void and override reports by user and shift (`GET /exceptions`), approvals and their approvers, over or short by cashier |
| Write-off, mortality or adjustment to hide a shortage (2, 7) | Stock adjustments and mortality records with reasons, photographs, approvers; recount the stock |
| Forged payment confirmation (4, 5) | `pay.webhook_event` outcomes, `pay.payment.verification`, unmatched payments and breaks, the provider's list |
| Driver under-declaring cash (6) | Driver variance report, proofs of delivery, reconciliation by someone else |
| Investor account probing (8) | Authorisation failure events for the principal, its sessions |
| Data export (9) | Export audit events with row counts, who and when |
| Offline sale removed or tampered (10, 11) | `DEVICE_COUNTER_GAP`, `SYNC_REJECTED`, `OFFLINE_SYNC.md` section 9 |
| Supplier details changed (13) | Payout detail change history and its approver, supplier payments |
| Credit overrides (14) | Credit override report, ageing |
| Ledger or audit altered in the database (15) | `audit-chain-integrity.md`, the anchors, the database log for superuser use |
| Role grants (16) | Permission change report, step-up events |
| Short shift (17) | Z reports, over or short postings, supervisor sign-offs |

## Step 5: notify

### 5.1 Inside the business

The owner is told within the hour of a SEV1 or SEV2 being declared. The owner decides about the people involved and about continuing to trade.

### 5.2 The Data Protection Commission and the people affected

Where **personal data** was or may have been accessed, disclosed, lost or altered by someone who should not have had it, the business is the data controller and has notification duties under Ghana's Data Protection Act, 2012 (Act 843): to the Data Protection Commission and to the people affected. The exact obligation, any time limit and the format are recorded with their source and date in `docs/security/COMPLIANCE.md` (assumptions A-061 to A-063 track the checks still open); the owner reads that entry before notifying. The working targets of this runbook, which are targets and not a statement of the law:

| When | What |
| --- | --- |
| Within 1 hour of declaring | The owner is told whether personal data is involved |
| Within 24 hours | The owner decides, with the lead, whether the threshold for notification is met, and records the decision and its reasons in the log, **whether the answer is yes or no** |
| As soon as reasonably practicable after discovery, and aiming for no later than 72 hours | If yes, notify the Data Protection Commission and the affected people |

The notification states, plainly: what happened and when; when it was discovered; what personal data and about whom (categories and approximate numbers: customers, suppliers, investors, staff); the likely consequences for them; what has been done and what they should do (for example, change a password); and a contact. It is written by the owner, reviewed by the lead for accuracy, and sent by the owner. Keep a copy and the acknowledgement. Do not include anything that is not known: say what is not known yet and when an update will follow.

Which data is personal here: customer names, phone numbers, addresses and order history; supplier contacts; investor identity, payout details and capital; staff accounts; delivery locations. Restricted fields (bank and mobile money details, identity numbers) are column-encrypted; if they were exposed only as ciphertext, say so, with the facts about whether the keys were also exposed. An erased subject's data in the audit log is unreadable by design (ADR-0022).

### 5.3 Others

- **Payment provider:** if a key leaked, if forged transactions occurred, or if customer payments were affected.
- **Hosting provider:** for an intrusion or a platform fault; ask them to preserve their logs.
- **Police:** for theft or fraud, at the owner's decision, with the evidence list and its SHA-256 sums. Hand over copies, never the originals.
- **Customers:** a plain-language message through the usual channels where they need to act. No speculation.
- **Insurer or auditor:** if the business has one, as its policy requires.

## Step 6: eradicate and recover

Only now correct things, and only through approved, audited, reversing records.

1. **Close the hole.** Remove the access the actor had, fix the code, change the setting. A code fix goes through the normal pipeline (`docs/DEPLOYMENT.md`), with the test that would have caught it added in the same pull request, and the threat model and this runbook updated.
2. **Rotate secrets** that may have been exposed, in the order in `docs/OPERATIONS.md` section 4, and revoke every session of the affected population.
3. **Correct the data** by reversing entries, adjustments and refunds with their normal approvals. The incident log records which correcting record belongs to which finding. Never update a ledger, stock, audit or allocation row (they are insert-only, and a superuser edit would break the chain: see `audit-chain-integrity.md`).
4. **Rebuild** a compromised server from a clean image and the backups (`restore-from-backup.md`), never by cleaning it in place. The old server stays isolated until the incident is closed.
5. **Verify.** Audit chain verifies and a fresh anchor exists; trial balance, stock recompute and numbering checks pass; the smoke suite passes; the exception report is quiet for 48 hours; the alert that raised the incident is clear.
6. **Resume** normal operation when the owner agrees. Tell the shop what changed (new passwords, new devices, new limits).

## Step 7: close

- **Post-incident review** within five working days with the owner, the lead and the scribe: what happened, the timeline, what worked, what did not, the cost in pesewas and hours, what changes. Blameless in tone, specific in actions.
- **Actions** each with an owner and a date, tracked until done (a new alert, a new approval threshold, a new test, a new control, a training point). Update `docs/security/THREAT_MODEL.md` (an abuse case or a residual risk), this runbook and the one that fits the cause.
- **Close the log entry** with the evidence list and its checksums, and the location of the evidence copies. Evidence is kept for at least 12 months, or longer if a legal process requires, in the `evidence/` prefix. Do not delete it before the owner confirms.

## Escalation

| When | Who |
| --- | --- |
| Any SEV1 | Owner immediately, by telephone |
| Evidence or chain tampering suspected | Owner; do not tell the person suspected |
| Personal data involved | Owner, for the notification decision |
| Money lost or at risk | Owner and accountant |
| The administrator is the person suspected | Owner takes the lead; a second administrator or an outside security contact is brought in; the hosting panel's owner account is used to snapshot and isolate |
