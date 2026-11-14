---
name: hakorem-runbook
description: "Use when a new failure mode is identified or an incident, outage, near miss, reconciliation break, failed deploy, failed restore drill, dead-lettered outbox message, alert or health-endpoint item is investigated or resolved; when a new alert rule, reconciliation job, external dependency, circuit breaker or scheduled job is added; when a threat model entry or a residual risk needs an operational response; or when creating or editing any file under `docs/runbooks/`. Not for the decision to change a design (hakorem-adr) and not for preparing a release (hakorem-release)."
---

# Runbooks: one per failure mode, usable at 2 a.m. by someone who did not write the code

Rule from the brief: every failure mode named in the threat model and the architecture has a runbook in `docs/runbooks/` with symptoms, diagnosis and the fix. Existing documents to read first: `docs/ARCHITECTURE.md` sections 8 (external calls, health endpoint, nightly reconciliation) and 9 (deployment), `docs/security/THREAT_MODEL.md` (STRIDE tables and the residual risk register), `docs/OPERATIONS.md` (monitoring and alert thresholds), `docs/DEPLOYMENT.md`. Brief-mandated runbooks include payment provider down, database failover, restore from backup, incident response (`docs/runbooks/incident-response.md`, with an evidence capture step that does not destroy what it captures) and reconciliation break; KEK rotation (ADR-0022) and projection rebuild (ADR-0023) are also runbooks.

## When to write or update one

- A failure mode is named in a design, threat model row, ADR or alert and has no runbook.
- An incident or near miss was resolved: write what actually worked, while it is fresh, in the same pull request as the fix.
- A new health item, reconciliation job, scheduled job, external dependency or alert rule lands: it ships with its runbook, and the alert links to it.
- A restore drill, deploy rollback or game day showed a step was missing or wrong.

## Checklist

1. **File.** `docs/runbooks/<kebab-case-failure-mode>.md`, one failure mode per file, linked from `docs/README.md` and from the alert, health item or threat-model row that triggers it.
2. **Fixed sections, in this order:** Summary (what it is, who is affected, severity, owner), Detection (which alert, health item, exception report kind or user report shows it, with the threshold), Symptoms (what an operator or user sees), Diagnosis (numbered steps with the exact command or query and what each result means; read-only first), Containment (stop the damage without destroying evidence), Fix (numbered, exact, with the expected output of each step), Verification (how you know it is fixed: a query result, a health item turning green, the smoke suite), Escalation (who, when, how to reach them, and the point at which to stop and call), Evidence and follow-up (what to preserve, the audit and incident log entry, the post-incident review, which document or test to update).
3. **Commands are copy-paste exact** and say where they run (VPS over SSH, inside the `api` container, psql as which role). Use the least-privileged role that works; superuser access is used only by the administrator over SSH and is itself an entry in the incident log (ADR-0024).
4. **Never auto-correct drift.** A reconciliation difference is a finding for a person. The runbook says how to compare the rows named in the alert, how to decide which side is right, and how to correct with a reversing entry or a stock adjustment through the application with maker-checker, never an `UPDATE` on a ledger table.
5. **No destructive default.** Steps that delete, truncate, rotate keys, fail over or restore say what will be lost, are marked as such, and are preceded by a verified backup point. Do not instruct anyone to disable a trigger or a constraint.
6. **Evidence first.** For anything involving fraud, tampering or a breach, capture evidence (log extracts, audit chain head and the latest signed anchor, database state of the affected rows) before containment changes it, using the method in `docs/runbooks/incident-response.md`.
7. **No secrets in a runbook.** Name where a secret lives (the deploy user's secrets file, the separate KEK backup); never paste one. No production data in examples.
8. **Time and impact.** State the recovery targets that apply (RPO 15 minutes, RTO 4 hours, availability 99.5 percent monthly, maintenance outside 06:00 to 20:00 Accra time) and the expected duration of the fix.
9. **Test it.** A runbook that has never been followed is a hypothesis. Record in the file the date it was last exercised and by whom (a drill, a staging rehearsal or the real incident). The quarterly restore drill exercises the restore runbook and its timing is recorded.
10. **Link the system to the runbook.** The alert rule, health endpoint item and exception report kind carry the runbook path. A new abuse path from a security review (hakorem-security-review) gets a response runbook if an operator must act.

## Correct and incorrect

The correct example is illustrative: its dates, names and thresholds are examples, and a real runbook records its own.

```markdown
# Runbook: outbox backlog growing (dead-lettered deliveries)

Owner: backend on-call. Severity: high if oldest undelivered message is older than 15 minutes.
Last exercised: 2026-11-20 on staging by Yaw Boateng.

## Detection
Health item `outbox.oldest_undelivered_seconds` above 900, or alert `OutboxBacklog` (docs/OPERATIONS.md).

## Diagnosis (read-only first)
1. On the VPS: `docker compose -p hakorem-prod logs --since 30m worker | grep -i dead`.
2. `psql -U hk_app -c "SELECT consumer, status, count(*), min(next_attempt_at) FROM platform.outbox_delivery GROUP BY 1,2;"`
   A growing `DEAD` count for one consumer means that consumer fails; a growing `PENDING` count for all means the dispatcher is stopped.
...
## Verification
`GET /health` shows outbox backlog 0 and the oldest message under 60 seconds; the smoke suite passes.

## Escalation
If the cause is the payment provider, follow payment-provider-down.md. If unsure after 30 minutes, call the owner.
```

```markdown
<!-- WRONG -->
# Outbox problems
If the outbox is stuck, restart things and clear the table.   <- no detection, no exact steps, destroys evidence
Run: TRUNCATE platform.outbox_message;                         <- forbidden: a ledger, and it loses events and receipts
```

## After an incident

In the same pull request as the fix: update or add the runbook; update the threat model residual risk register and the relevant abuse case if the incident showed a gap; add a regression test; if the incident changed a decision, write an ADR (hakorem-adr). Record the incident in the incident log per `docs/runbooks/incident-response.md` and name it in the next session report.
