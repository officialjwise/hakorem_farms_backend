# Runbook: document rendering, the archive and the numbering audit

Last reviewed: 2026-11-16. Severity: High for a hash mismatch or an orphan allocation (tamper evidence); Medium for a document left unarchived. Related: ADR-0010 (outbox), ADR-0015 (numbering), ADR-0044 (file store), ADR-0061 (rendering and the archive), `docs/data-model/doc.md`, `docs/data-model/bil.md`, `docs/runbooks/queue-backlog.md`.

## How it works

An issued billing document asks DOC for its rendering in the transaction that issues it: a `doc.render_job` row (QUEUED, with the template versions active then) and a `doc.RenderRequested` outbox message. The worker's consumer `doc.render` renders the PDF (and, for a receipt, the ESC/POS), writes the files to the private bucket as use `ARCHIVE`, and inserts one `doc.archived_document` row with the SHA-256 of each. `bil.archive-link` then sets the billing document's `archived_document_id` and `content_hash`. The malware scan passes the files before they are served. A sale never waits on any of this.

## Symptoms

- A document shows no archive (`archivedDocumentId` null) for more than a few minutes; reprint answers 422 `DOCUMENT_NOT_ARCHIVED` `RENDERING`, or `NOT_SCANNED` after the render.
- Log: `outbox delivery failed; will retry` or `outbox delivery is dead` with consumer `doc.render`, `bil.archive-link` or `pur.remittance-link`.
- A paid supplier payment shows `remittanceDocumentId` null for more than a few minutes (B08 continued 2c, ADR-0062): its advice is rendered by `doc.render` like any document (the render job's `business_document_id` is the `pur.supplier_remittance` row's id) and linked by `pur.remittance-link`. Diagnose and fix it as below; the link is set once and is never repaired by hand.
- Log error: `archived document does not match its SHA-256`, and reprint answers 422 `ARCHIVE_HASH_MISMATCH`.
- Log error: `billing numbering audit found a gap, an orphan or an unarchived document`; the job run `billing-numbering-audit` is not `clean`.

## Diagnosis

1. **Unarchived.** `SELECT status, attempts, last_error FROM doc.render_job WHERE business_document_id = '<id>'`. FAILED with an error: read it (object storage down, a template that cannot render). Check the delivery: `SELECT status, attempts, last_error, next_attempt_at FROM platform.outbox_delivery WHERE consumer = 'doc.render' AND subject_id = '<id>'`. A storage outage clears itself: the outbox retries with backoff. `NOT_SCANNED` means the scanner is behind or down: see the file store's scan backlog.
2. **Dead delivery.** After eight attempts the delivery is `DEAD`. Fix the cause first (storage, a template), then requeue the delivery as in `queue-backlog.md`. The render job is rendered once per message, so a requeue cannot archive twice.
3. **Hash mismatch.** The stored bytes, or the archive row, have changed outside the application. Treat it as an incident (`incident-response.md`): preserve the object and its versions, compare with the latest backup, and find who had write access to the bucket. Never re-render to "fix" it: the archive is the evidence.
4. **Orphan allocation or gap.** A number was allocated to a document that no longer exists or does not carry it, or a series skipped. The database refuses this through the application, so it means a direct change to the database. Incident, as above; restore the row from backup into a separate database to compare. The audit changes nothing.

## Fix

- Rendering and scan backlogs recover on their own once storage or the scanner returns. Never write `doc.archived_document`, `bil.billing_document.content_hash` or `archived_document_id` by hand; the archive refuses change for every role.
- A template that fails to render (should not happen: bodies are checked at save) is replaced by drafting and activating a new version; documents already queued keep the version recorded with their job, so fix the cause in the renderer, not the job.

## Afterwards

Record the incident, the documents affected and the time to recover in the incident log. A tamper finding is reported to the Owner the same day.
