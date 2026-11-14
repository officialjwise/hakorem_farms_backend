# Runbook: queue, outbox and projection backlog

Last reviewed: 2026-11-13. Severity: Warning, Critical at the thresholds in `docs/OPERATIONS.md` section 7. Related: ADR-0010, `docs/ARCHITECTURE.md` section 6 (event flow), `docs/data-model/platform.md` (`outbox_message`, `outbox_delivery`, `inbox_message`), `docs/runbooks/database-failover.md`.

## How the plumbing works, in short

- A business change writes its outbox message **in the same transaction**. So the business data is already correct; a backlog means side effects are late, not that data is wrong.
- The **dispatcher** (in the worker) reads `platform.outbox_message`, creates a `platform.outbox_delivery` row per consumer, and delivers at least once, ordered per subject. A failing consumer retries with exponential backoff and jitter. After `OUTBOX_MAX_ATTEMPTS` (default 10) the delivery becomes `DEAD`: the dead letter queue.
- **BullMQ on Redis** carries work signals and jobs (documents, notifications, reports). **The outbox table is the durable record.** If Redis is lost, the dispatcher polls the table and rebuilds its queues.
- Each consumer records `(consumer, message_id)` in `platform.inbox_message` in the same transaction as its effect, so a redelivery does nothing twice. **Replaying is safe.**
- The consumers: notifications, outbound webhooks, reporting and costing projections, document rendering, shop listings.

## Symptoms

- Alerts: outbox backlog (more than 500 warning, 5,000 critical), oldest pending age (60 s, 300 s), dead letters (1, 10), BullMQ waiting jobs, projection lag, CPU, latency, serialization retries, Redis memory.
- Customers say receipts, order updates or documents are late. The dashboard is stale. Webhooks to integrators arrive late. `GET /health` shows `outbox_backlog`, `queue_depth`, `dead_letters` or `projection_lag` as `DEGRADED` or `DOWN`.

## What keeps working

Sales, stock, payments and the ledger do not wait for the outbox. The counter, the console and the checkout keep working. What is late: messages, documents, webhooks, projections, reports. Staff may need to read a receipt from the order screen instead of waiting for the message.

## Diagnosis

Work down this list; stop at the first thing that explains it.

1. **Is the worker running?**
   ```bash
   dc ps worker
   dc logs --since 15m worker | tail -100
   ```
   Not running or restarting: read why (`OOMKilled`, a crash loop on a bad deploy, no database). If it started failing right after a deploy, roll back (`docs/DEPLOYMENT.md` section 7).
2. **How big and how old?**
   ```sql
   SELECT consumer, status, count(*), min(next_attempt_at) AS oldest_due, max(attempts) AS max_attempts
   FROM platform.outbox_delivery
   WHERE status IN ('PENDING','FAILED','DEAD')
   GROUP BY consumer, status ORDER BY count(*) DESC;
   ```
   One consumer with everything: that consumer or its dependency is the problem. All consumers: the dispatcher, Redis or the database is.
3. **Why do they fail?**
   ```sql
   SELECT consumer, last_error, count(*) FROM platform.outbox_delivery
   WHERE status IN ('FAILED','DEAD') GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;
   ```
   Errors are scrubbed summaries. Pair them with the worker log lines for the same correlation id (search `message_id`).
4. **Redis.** `dc exec redis redis-cli -a "$REDIS_PASSWORD" info memory | head`, `ping`, and `info stats | grep evicted`. Memory near `maxmemory`, evictions above zero, or no answer is the cause. Queue keys must never be evicted (`noeviction`); if Redis is full, find the largest keys (`--bigkeys`).
5. **The database.** `SELECT pid, now() - xact_start AS age, state, left(query, 100) FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY age DESC LIMIT 10;` A long transaction (over 30 s) blocks audit sealing and can slow everything. Serialization retries above 5 percent (`hk_serialization_retries_total`) means hot rows contending.
6. **An external dependency.** SMS, WhatsApp or email down makes `ntf` fail; the payment provider down makes status polls fail (`payment-provider-down.md`); object storage down makes document rendering and file scans fail; the customer's webhook URL down makes `api` deliveries fail (that is the integrator's, see below).
7. **A poison message.** The same message failing every time with the same error while others pass: a data shape the consumer cannot handle. It will go `DEAD` after the retries; it does not block others on a different subject.
8. **Capacity.** CPU above 95 percent (`node-exporter`), a report run or PDF render flooding the worker (`hk_queue_waiting` by queue), a batch of 500 offline sales arriving.

## Fix

**Worker down or crash-looping.** Fix the cause and restart: `dc up -d worker`. After a bad deploy, roll back (`docs/DEPLOYMENT.md` section 7). The backlog then drains on its own.

**Redis lost or full.** Restart Redis (`dc up -d redis`). It starts empty (append-only file permitting). The dispatcher detects the missing queue state and rebuilds it from the undelivered outbox rows; allow a few minutes. Do not flush Redis by hand unless it is corrupt, and note it in the log. If memory is the issue, find the key group growing and fix the producer; raise `maxmemory` only with the box's RAM budget in view (`docs/OPERATIONS.md` section 2).

**One slow or blocked consumer.** Reduce what it competes with: lower `REPORT_CONCURRENCY` and `PDF_RENDER_CONCURRENCY` temporarily, or pause the schedule of a heavy report. If an external provider is down, wait; the backoff retries and the notification module falls back to the next channel.

**Dead letters.** A `DEAD` delivery has exhausted its retries. **Fix the cause first; replaying before that only creates new dead letters.**
1. Group them by `last_error` (query above) and fix the cause: the provider, the bug, the data.
2. For **outbound webhooks**, redeliver through the API: `GET /webhook-deliveries?status=DEAD`, then `POST /webhook-deliveries/{id}/redeliver` for each. The same delivery id is sent, so a receiver that deduplicates sees it once. An endpoint set to `DISABLED_FAILING` must be re-enabled by the integrator's owner after they fix their side (`PATCH /webhook-endpoints/{id}`).
3. For **internal consumers**, requeue the rows. `outbox_delivery` is operational state (class `WORK`), so this is an ordinary update, done by an administrator and logged:
   ```sql
   -- only after the cause is fixed; replace the consumer and window
   UPDATE platform.outbox_delivery
   SET status = 'PENDING', attempts = 0, next_attempt_at = now(), last_error = NULL
   WHERE status = 'DEAD' AND consumer = '<consumer>' AND message_id IN (
     SELECT id FROM platform.outbox_message WHERE recorded_at > now() - interval '7 days');
   ```
   The inbox table makes this safe: a message the consumer already handled is skipped.
4. **Never delete** an outbox message or a delivery row. If a message can never be delivered (a destination that no longer exists), leave it `DEAD` with a note in the incident log; the weekly digest lists it until it ages out under retention.

**A poison message.** Identify it by `last_error` and the subject. Fix the consumer (a code change, shipped normally) so that it handles or skips that shape, then requeue as above. Do not hand-edit the message payload: outbox messages are insert-only (`LEDGER`).

**Projection lag.** `hk_projection_lag_seconds` by projection tells you which. The projector is a consumer; fix it as above. If a projection is wrong rather than late, rebuild it from events with its rebuild command (B11, B12) and run `projection-compare`.

**Database contention (long transactions, retries).** Find the handler holding the transaction (`pg_stat_activity.query` and the correlation id in `application_name` if set), fix it. `idle_in_transaction_session_timeout` (10 s) kills the forgotten ones. A migration holding locks is a sign the release should have waited for the window (`docs/DEPLOYMENT.md` section 4.3).

**Capacity.** Wait out a burst (an offline sync, a month-end report run) if it is draining; move heavy scheduled reports to the night (`rpt.report_schedule`); lower concurrency; if it is sustained, record it for the capacity review (OPERATIONS section 12) and plan a bigger plan or a worker limit change.

**Webhook receiver slow or down (not our fault).** The delivery retries over about 45 hours (1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 24 hours). Tell the integration's contact (`api.integration.owner_contact`). Pause the endpoint if it is hurting the queue (`PATCH /webhook-endpoints/{id}` to `PAUSED`).

## Verification

- `hk_outbox_oldest_pending_seconds` is under 60 and `hk_outbox_pending` is falling; `hk_queue_waiting` is normal; `hk_outbox_dead` is zero or each dead row is explained.
- `GET /health` shows `outbox_backlog`, `queue_depth`, `dead_letters` and `projection_lag` as `OK`.
- A real message goes through: a test notification to the administrator, a test webhook (`POST /webhook-endpoints/{id}/test`), a PDF render of a test document.
- `projection-compare` succeeds on its next run, or by hand.
- The p95 latency and error-rate alerts have cleared.

## Escalation

| When | Who |
| --- | --- |
| Critical backlog for more than 30 minutes | Owner informed; administrator keeps working it |
| Any dead letter on a consumer that posts or reconciles money (payments, `pay`) | Accountant: a missed `pay` event is a possible reconciliation break (`reconciliation-break.md`) |
| A message that cannot be delivered because of a code defect | A bug with the message id, the consumer and the error; the hotfix goes through the pipeline |
| Redis lost with queue rebuild failing | `database-failover.md` for the platform view; then an incident if messages were lost |
