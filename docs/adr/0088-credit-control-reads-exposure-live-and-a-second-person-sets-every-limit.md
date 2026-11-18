# ADR-0088: Credit control reads exposure live under the account's lock, and a second person sets every limit and every release

- **Status:** Proposed
- **Date:** 2026-11-18
- **Session:** B10 continued (lane B)
- **Deciders:** backend track; the owner to accept (CR-046 and CR-048 are the owner's words of 2026-11-17 and 2026-11-18)

## Context

FR-WHL-006 defines exposure as the outstanding invoiced balance plus confirmed orders not yet invoiced (SA-21) and asks
that an order taking it over the limit is not confirmed without an approved override. CR-046 (the owner) adds that an
order past its terms does not go through either, that the answer carries the amount over and the reason, that the override
needs a written reason and that the approver is never the person who asked. CR-048 (the owner, 2026-11-18) adds that
every change to a credit limit, up or down, and every release of a hold waits for an Owner or Manager who did not ask.
`docs/data-model/whl.md` planned `business_account.exposure_pesewas` "maintained by subscribers" to BIL's and PAY's
events, and the WHL card lists those subscriptions. ORD's `OrderConfirmationPolicy` port (MODULE_BOUNDARIES section 6)
answered only PASSED or REFUSED, and `confirmOrder` takes no body.

## Options considered

1. **A stored exposure kept by asynchronous subscribers.** A few seconds behind the payments ledger, so two orders
   confirmed in that window both pass on the old figure; a projection to reconcile; the bounced cheque of A-212 (d)
   would count only once its event is consumed.
2. **Exposure read live in the confirming transaction (chosen).** BIL's open items of the customer at every branch
   (`Billing.customerOpenItemsIn`, new and additive: a reversed or bounced payment has already reopened its item in its
   own transaction, A-212) plus ORD's confirmed credit orders not invoiced (`Orders.uninvoicedCreditIn`, new), read under
   `whl.business_account`'s row lock in the serializable confirmation, so two confirmations for one customer queue and
   the second sees the first.
3. **The limit and the release changed in place with an audit row only.** One person could raise a limit and confirm a
   favoured buyer's order (abuse case 14); refused by CR-048.

## Decision

Option 2, and:

- **The port answers a judgement.** `OrderConfirmationPolicy.creditFor` answers PASSED, OVERRIDDEN or REFUSED with every
  reason (`ON_HOLD`, `OVER_LIMIT`, `PAST_TERMS`) and the figures; `requestOverrideIn` asks for a `CREDIT_OVERRIDE`
  approval with the asker's written reason in ORD's transaction. ORD refuses a REFUSED order with 422
  `CREDIT_LIMIT_EXCEEDED`, `CREDIT_TERMS_EXCEEDED` or `ACCOUNT_ON_HOLD` naming the amounts, or, given
  `creditOverrideReason` (an optional, additive body), asks for the approval in place of the refusal (202, as the
  contract already planned). WHL also serves `getOrderCreditCheck` and `requestCreditOverride` on the order's path.
- **An override covers what was approved.** The same order at the same amount, no more over the limit, for no new
  reason; the approval binds the order, its amount and its reasons (`payload_hash`). Approved, the order is confirmed by
  calling `confirmOrder` again, so the reservation runs under its own locks.
- **A second person on every limit and release, in the database.** A change is a `whl.account_change` document (a
  business document of type `ACCOUNT_CHANGE`) under IAM's `CREDIT_LIMIT_CHANGE` or `ACCOUNT_RELEASE` approval;
  `ck_account_change_checker` refuses one applied by its asker, and `whl.business_account_guard` refuses a limit other
  than nil, or a release from hold, written without an applied change of that account for exactly that. An override is
  `whl.credit_override` with `ck_credit_override_checker`. IAM's `ck_approval_request_*` holds the same rule beneath.
- **Releasing takes its own permission** (`whl.account.release`), so the Accountant who may put a hold on cannot take it
  off; the overdue hold is a daily job; paying does not release a hold on its own (A-314 (c)).

## Consequences

- `exposure_pesewas` is not stored and the WHL card subscribes to nothing for it; every figure a screen shows is read
  as at the moment of reading.
- A confirmation for a business account reads the customer's open items and orders: indexed point reads
  (`ix_billing_document_customer`, `ix_sales_order_customer`) under serializable isolation.
- Binds: `docs/data-model/whl.md`, the WHL and ORD cards and section 6 of `docs/MODULE_BOUNDARIES.md`, `docs/API.md`,
  CR-046 and CR-048, abuse case 14 in `docs/security/THREAT_MODEL.md`.

## Verification

`src/modules/whl/domain/credit.spec.ts` (exactly at the limit, one pesewa over, past the terms by one day, the hold's
day 30 and 31, the override's cover), written before the code and seen red; `test/integration/whl/credit-control.integration.spec.ts`
(exposure against SQL sums from `bil.billing_document`, `pay.payment_allocation` and `ord.sales_order`; the override,
release and limit change refused to the wrong role and to their asker, and by the database; the bounced cheque; the
seeded people), mutation-checked.
