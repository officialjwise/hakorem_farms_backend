# ADR-0063: The payment provider port, webhooks, the provider sweep and refunds as built

- **Status:** Accepted (owner, 2026-11-16)
- **Date:** 2026-11-16
- **Session:** B09a continued
- **Deciders:** backend track; the owner gave the webhook order, the sweep and the refund rule on 2026-11-16; the accountant reviews the two posting rows (A-210)

## Context

ADR-0003 names the tender, deposit and refund rows of PAY's events; ADR-0014 makes webhook event ids and provider references unique keys; ADR-0010 keeps external calls out of business transactions; the security architecture (section 8) orders a webhook's checks. Building them raised what those leave open: what a Paystack "event id" is when Paystack sends none; which time the window is applied to when the provider signs no timestamp; how a payment whose webhook never comes is found; how an allocation is taken off in the ledger when ADR-0003 names only `pay.DepositAllocated` in one direction; and where a refund's approval sits when the owner asks that till fraud be impossible for one person.

## Options considered

1. **Trust the webhook, verify later.** Clear on the signed webhook and reconcile the amount at settlement. Rejected: the brief and SA-08 say the payload's amount is never trusted.
2. **A status poll per pending payment only.** Finds a lost webhook for payments we know, but never a success under a reference we did not create, and costs one call per payment.
3. **One clearing path fed by three sources, the provider's own record the only truth.** The webhook (after signature, window and once-only checks), an on-demand lookup and a scheduled sweep of the provider's transaction list all call one function that applies the provider's answer under the payment's lock; the database refuses a provider payment cleared without its charge confirmed for exactly its amount.

## Decision

Option 3.

- **The webhook's order** (the owner): signature over the raw body in constant time; the event's own signed time within 300 seconds either side; once by the provider's reference, the event id `<event>:<reference>`, unique among events that reached processing, so neither a forged nor a stale delivery can block the genuine one; only then the server-to-server lookup. A difference between the payload and the lookup is rejected with no effect; a difference between the lookup and what was asked holds the payment PENDING with a break. Every request is a row of `pay.webhook_event`, with only the provider's fields PAY reads.
- **The sweep** (the owner): `provider-sweep`, every minute, reads the provider's transaction list from where the last run ended (`pay.provider_sweep`, one row per run, none for a run that failed), applies each of ours through the clearing path, raises a success under an unknown reference as a break without posting, and looks up every charge still open; a charge the provider has no record of after 30 minutes fails with a break.
- **Clearing** is an unallocated deposit (Dr 1120 against the provider, Cr 2200 against the customer). Money arriving after its order stopped waiting clears the same way with an `UNMATCHED_PAYMENT` break.
- **Allocation from deposit** extends ADR-0003's `pay.DepositAllocated` row with its mirror: amount key `applied` (Dr 2200 Cr 1200) and `unapplied` (Dr 1200 Cr 2200, an allocation taken off with a reason, once), one per event. **`pay.RefundPaid`** posts Dr 2200 Cr the original payment's tender account by its method's kind, against its till or provider, as ADR-0003's row reads for a refund out of a deposit; a refund against a credit note (Dr 1200) and to store credit (Cr 2210) follow with B09a continued 1b.
- **Refunds:** every refund a person asks for waits for a different approver with a fresh step-up (`REFUND`, threshold 0, as data); a refund draws only on the payment's unallocated money, held by `trg_refund_cap`; a provider refund is sent by `refund-dispatch` outside any transaction with the refund's id as its idempotency key, retried after 5 and 10 minutes, then left for a person with a break; a payout by hand needs its reference and is never recorded by the refund's maker (`ck_refund_paid_by`).
- **The port's resilience** (`ResilientPaymentProvider`): timeout, three attempts with full jitter, a circuit breaker; a retried charge reuses our reference.

## Consequences

- No payment depends on a webhook arriving: the sweep finds it within a minute or two. The provider is asked once per open charge per minute at most.
- A single Owner cannot refund; the smallest team (Owner and Manager) can, one asking and the other approving.
- `pay.DepositAllocated` now has four rules; the boot assertion and the matrix tests cover both keys.
- Binds: `docs/data-model/pay.md`, `docs/API.md` (PAY), `docs/runbooks/payment-provider-down.md`, `docs/runbooks/reconciliation-break.md`, the PAY card in `docs/MODULE_BOUNDARIES.md`, A-210.

## Verification

- `test/integration/pay/payment-edge-cases.integration.spec.ts`: bad signature, stale, replay, forged amount, amount differing at the provider, timeout after charge, webhook before the API answer, an order that no longer exists, a late webhook, an unknown reference, the sweep twice, the circuit breaker and a charge missing at the provider, over-, under- and partial payment, unallocation, the database's rules by direct SQL, the wrong roles, and the trial balance.
- `test/integration/pay/refunds.integration.spec.ts`: the cap, the smallest team and a single Owner, step-up, rejection, provider dispatch, failure and retry, the payout by hand, the wrong roles, and the trial balance.
- `test/sandbox/paystack.sandbox.spec.ts` (on demand, `pnpm test:sandbox`; B09a continued 2, A-217): the adapter against Paystack's test mode. It found that Paystack ignores `Idempotency-Key` on a refund, so the refund's idempotency key named above is honoured by the adapter itself: it travels as the refund's `merchant_note` and is looked up on the transaction's refunds before any refund is sent. The decision stands; the mechanism is the adapter's.
