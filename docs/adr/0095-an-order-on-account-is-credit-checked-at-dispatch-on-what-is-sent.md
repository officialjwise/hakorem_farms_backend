# ADR-0095: An order on account is credit-checked at dispatch on what is sent, through the credit policy port

- **Status:** Proposed (the owner reviews A-368)
- **Date:** 2026-11-24
- **Session:** B11 continued 8 (lane B)
- **Deciders:** backend track; the owner reviews A-368

## Context

The owner, 2026-11-23 (A-338, A-341): dispatch on credit terms is not deferred past launch; the credit check runs at
dispatch through WHL's credit control, ORD sitting below WHL, and the invoice is issued from the quantities actually
dispatched. A-331 (a), approved: the whole unpaid order counts against the limit, ignoring deposits not yet paid.
Until now an order on account was credit-checked once, at confirmation, on its estimate (CR-046, ADR-0088), and
dispatch and collection refused it (`CREDIT_DISPATCH_NOT_AVAILABLE`). WHL's exposure counts every confirmed credit order
not yet invoiced at its estimate, so at dispatch the order being judged is still in that sum; and the dispatch issues
its document in the same transaction before the gross is known, so the new invoice is already among the open items.
Judged naively, the order would be counted two or three times.

## Options considered

1. **Trust the check at confirmation.** Nothing at dispatch. A catch-weight order weighed heavier, a customer who bought
   more since, or a backorder sent weeks later would leave the yard over the limit with no one asked.
2. **Judge at dispatch through ORD's existing `OrderConfirmationPolicy` port, on the gross of the document.** The port
   gains `creditAtDispatchFor` (the gross, the order's own estimate and its just-issued document left out of exposure)
   and `dueDateFor` (the customer's terms). A refusal rolls the whole dispatch back; a written reason asks for the
   override on that gross in a transaction of its own (202), as confirmation does.
3. **WHL subscribes to a dispatch event and refuses afterwards.** The goods would already be on the van.

## Decision

Option 2. At dispatch and at the hand-over, an order on account is judged by the registered policies (WHL's credit
control) on the gross of the document issued on what is sent, against the customer's open items (its own document left
out) and the other confirmed credit orders not yet invoiced (its own estimate left out): never counted twice. Exactly at
the limit goes. An approved override covers it when the gross is no more than the amount it was approved for, no more
over the limit, and for no new reason (`overrideCoversDispatch`); a heavier gross needs a new approval. Refused, the
dispatch writes nothing (the document's number returns to its series) and answers 422 with the figures in words; with
`creditOverrideReason` the override is asked for that gross and answered 202 under the request's key, approved by a
holder of `whl.credit.override` who did not ask (ADR-0017). A backorder of an order on account is judged again at its
own dispatch, on its own quantities, so splitting an order never avoids the check. The invoice is due on the business
date plus the customer's payment terms, and nothing is due to the driver (the cash due on delivery is nil). With no open
account the dispatch is refused `CREDIT_CHECK_UNAVAILABLE`, never waved through. The order on account completes when its
invoice is settled (BL-097), as every delivered or collected order does.

## Consequences

- ORD still imports nothing of WHL; WHL implements two more methods of ORD's port. `judgeIn` always leaves the order
  being judged out of the uninvoiced sum, so `getOrderCreditCheck` on a confirmed order no longer counts it twice.
- An override approved at dispatch is bound to the gross (its payload hash reads the request's amount for an order no
  longer `PLACED`), so a repacked heavier order cannot ride on it.
- The daily exception report (B12) reads `whl.CreditOverrideApproved` as before (abuse case 14) and abuse case 54 for a
  check bypassed at dispatch.
