# Runbook: payment provider (and messaging providers) down

Last reviewed: 2026-11-13. Severity: Warning, rising to Critical when online checkout or counter mobile money has been unavailable for more than 30 minutes. Related: `docs/ARCHITECTURE.md` section 7.2 and "External calls", `docs/API.md` section 13, `docs/security/SECURITY_ARCHITECTURE.md` section 8, `docs/runbooks/reconciliation-break.md`.

## What this covers

- **A.** The payment provider (Paystack, the first adapter) is down, slow or erroring.
- **B.** Our credentials with the provider are rejected (a key rotated, revoked or wrong).
- **C.** Our server cannot reach the provider (DNS or network).
- **D.** Charges work but webhooks do not arrive, or arrive and are rejected.
- **E.** SMS, WhatsApp or email providers are down (section at the end).

## Symptoms

- Alert: payment provider failure rate above 20 percent (warning) or 50 percent, or the circuit breaker open (critical); PENDING payments older than 15 minutes with no webhook; inbound webhook rejections.
- Customers see "payment is unavailable"; checkout returns 503 `PAYMENT_PROVIDER_UNAVAILABLE`. Mobile money at the counter does not clear.
- Payments sit in `PENDING`; orders stay unconfirmed after the customer says they paid.
- Sentry shows errors in module `pay` with provider timeouts or 401 from the provider.

## What keeps working, and what does not

| Works | Does not work |
| --- | --- |
| Cash at the counter; cash on delivery; bank transfer recorded by the accountant against the statement | Mobile money and card, online and at the counter, whatever the provider's state: only a verified provider callback or lookup can clear them |
| Offline counter, cash only (and the manager-approved unverified mobile money tender if the setting allows it) | Refunds to mobile money (they queue and appear as `FAILED` or pending in the break queue) |
| Everything that does not need the provider | Automatic confirmation of online orders |

A payment that the customer made but we could not confirm is **never** marked paid by hand. `recordPayment` refuses mobile money and card (`PAYMENT_METHOD_REQUIRES_VERIFICATION`). The payment stays `PENDING` and the status poll or the webhook clears it when the provider is back.

## Diagnosis

1. **Is it them?** Open the provider's status page and your merchant dashboard. Note whether it reports an incident.
2. **Our view of the calls.** Look at the metrics and logs.
   - Grafana-free check on the box: `curl -s localhost:9464/metrics | grep -E 'hk_payment_(provider_calls|breaker)'` from inside the API container (`dc exec $ACTIVE wget -qO- localhost:9464/metrics | grep hk_payment`).
   - Logs: `dc logs --since 30m $ACTIVE worker | grep '"module":"pay"' | tail -50`. Look for the HTTP status of the provider: 401 or 403 means credentials (B); `ETIMEDOUT`, `ECONNRESET`, 5xx mean them (A); `ENOTFOUND` means DNS (C).
3. **Can the server reach the provider at all?** `dc exec $ACTIVE sh -c 'getent hosts api.paystack.co && wget -S -O /dev/null https://api.paystack.co 2>&1 | head -5'`. If DNS fails, check the host's resolver (`resolvectl status`) and try `dig api.paystack.co @1.1.1.1` from the host. If other outbound traffic also fails, check the hosting provider's status and the server's network.
4. **Credentials (B).** Did anyone rotate the key in the dashboard? Compare the key's prefix in the dashboard (`sk_live_...`) with the beginning of `PAYSTACK_SECRET_KEY` in `/etc/hakorem/production/secrets.env` (read only the first 8 characters, never print the key). A mismatch is the cause. A staging key (`sk_test_`) in production, or the reverse, is also the cause.
5. **Webhooks (D).**
   - `SELECT outcome, count(*), max(received_at) FROM pay.webhook_event WHERE received_at > now() - interval '2 hours' GROUP BY outcome;` (as `hk_report` is not allowed; use the administrator role and log the use). No rows at all: the provider is not calling, or Caddy is not passing the request. Many `REJECTED_SIGNATURE`: the signing secret is wrong or someone is forging (go to `incident-response.md` if the pattern is not explained by a key change). Many `REJECTED_STALE`: the server clock is wrong (`chronyc tracking`).
   - In the provider dashboard, check the webhook URL (`https://api.hakoremfarms.com/v1/webhooks/payments/paystack`) and its delivery log.
   - From outside, `curl -i -X POST https://api.hakoremfarms.com/v1/webhooks/payments/paystack -d '{}'` should return 401 (a bad signature), which proves the route is alive.
6. **How big is it?** `SELECT count(*), min(created_at) FROM pay.provider_transaction WHERE status IN ('INITIATED','PENDING');` and the list `GET /payments?status=PENDING`.

## Fix

**A. The provider is down.** There is nothing to repair. The circuit breaker stops the API from hammering it and retries on its own schedule.
1. Tell the shop supervisor: take cash only until further notice, and tell customers who ask. For delivery, drivers collect cash on delivery.
2. If the outage lasts more than 30 minutes, put a notice on the storefront checkout (a setting banner, B7) and tell the owner.
3. Do not restart the API to "reset" the breaker; it closes by itself when a trial call succeeds.
4. When the provider recovers, the status poll (`payment-status-poll`, every 5 minutes) looks up every `PENDING` payment and clears the real ones. Wait one full poll cycle before intervening.

**B. Credentials.** Get the correct key from the provider's dashboard (it is the administrator's job, with the owner), put it in `/etc/hakorem/production/secrets.env` as `PAYSTACK_SECRET_KEY`, then restart only what reads it: `dc up -d --force-recreate $ACTIVE worker`. This restarts the active API instance briefly; do it when the counter is quiet, or follow the zero-downtime procedure in `docs/DEPLOYMENT.md` section 5 with the changed secret (a deploy of the same image). Revoke any key that has leaked.

**C. Network or DNS.** Fix the resolver or network; if the provider's address changed, nothing in the code pins it. Escalate to the hosting provider if the server itself has lost outbound connectivity.

**D. Webhooks.** Correct the URL or the signing secret as above. After fixing, **ask the provider to resend** failed webhooks from its dashboard where it offers it, or let the status poll catch up. A resent webhook that was already processed collides on the unique event id and is acknowledged with no effect, so resending is safe.

## Catching up when the provider returns

1. List what is still `PENDING`: `GET /payments?status=PENDING`. For each one that is older than the poll interval, call `POST /payments/{id}/check-status`. It performs a server-to-server lookup and clears, fails or leaves the payment, with its ledger posting, in one transaction.
2. Payments the provider says succeeded but that we have no matching order or payment for appear as unmatched payments and in the break queue (`GET /payments/unmatched`, `GET /reconciliation/breaks`). Follow `reconciliation-break.md`: allocate them to the order, or refund the customer.
3. A customer who paid while the provider was degraded and whose order was cancelled in the meantime has a cleared deposit; refund it (`POST /refunds`, approval above the automatic limit) or use it for a reorder.
4. Refunds that failed are retried by `refund-retry` every 15 minutes; check `GET /refunds?status=FAILED` after an hour, and use `POST /refunds/{id}/retry` or settle another way (`mark-paid` with the bank or mobile money reference).
5. At the next settlement report, `settlement-match` compares the provider's lines with our payments. Expect differences from the outage window and clear them as in `reconciliation-break.md`.

## Verification

- The breaker metric `hk_payment_breaker_state` is closed, and the failure rate is below 5 percent for 15 minutes.
- A test mobile money payment of the smallest amount at the counter on the test branch (or a sandbox charge on staging) clears through the webhook and the lookup.
- `SELECT count(*) FROM pay.provider_transaction WHERE status IN ('INITIATED','PENDING') AND created_at < now() - interval '30 minutes';` returns 0 (or each remaining one is explained in the incident log).
- The health endpoint is `OK`.

## Escalation

| When | Who |
| --- | --- |
| Online payments unavailable for more than 30 minutes | Owner |
| More than 1 hour, or any money the customer says was taken and we cannot find | Owner; the provider's merchant support with the transaction references |
| Credentials suspected leaked | `incident-response.md` immediately; revoke the key first only after evidence is captured, unless money is at risk |
| Unexplained `REJECTED_SIGNATURE` volume | `incident-response.md` |
| Settlement differences that remain after two reports | Accountant with the provider |

## E. Messaging providers (SMS, WhatsApp, email) down

**Symptoms.** Alert: notification send failure rate above 20 percent. Receipts and updates not arriving; messages in `FAILED` or `PENDING` in `GET /notifications/messages`.

**Impact.** Messages queue and the notification module tries the next channel in the customer's preference order. Counters still print receipts. One-time codes by SMS stop, so customer registration and phone verification stop; staff login is unaffected unless a staff member relies on SMS for a reset.

**Diagnosis.** Provider status page; `dc logs --since 30m worker | grep '"module":"ntf"'`; check the provider balance (an SMS account out of credit looks exactly like an outage); check the API key.

**Fix.** Top up the balance; correct the key; wait for the provider. Messages retry with backoff and then fail; `POST /notifications/messages/{id}/retry` re-sends one (it refuses a message suppressed by an opt-out, and that refusal is never overridden). For a long outage, send the important ones (delivery windows, quotes) by another channel by hand.

**Verification.** A test message to the administrator's own number is delivered; the failure rate falls below 5 percent for 15 minutes.
