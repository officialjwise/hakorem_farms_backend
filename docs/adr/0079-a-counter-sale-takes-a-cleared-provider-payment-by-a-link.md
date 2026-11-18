# ADR-0079: A counter sale takes a mobile money or card payment the provider cleared by linking it, insert-only, never by changing the payment

- **Status:** Proposed (2026-11-17)
- **Date:** 2026-11-17
- **Session:** B09b continued 1c
- **Deciders:** backend track; owner approves

## Context

FR-POS-006: no screen accepts "paid" on the cashier's word (abuse case 4). At the counter a mobile money tender is a charge the customer approves on the phone: the cashier starts it with `initiateMobileMoneyCharge` naming the till's open shift (ADR-0077), and it clears only from the provider's verified callback or a status lookup, as an unallocated deposit with no order (the sale is not yet rung up, so there is no order to name). B09b continued refused such a tender at the counter (A-274 (f), `PROVIDER_PAYMENT_NOT_AVAILABLE`) because two things were undecided:

- **The payment is frozen once cleared.** `trg_payment_guard` lets only `allocated_pesewas`, `refunded_pesewas` and the move to REVERSED change on a cleared payment. Its `order_document_id` cannot be set afterwards.
- **ORD reads an order's payments by the order they name** (`Payments.ofOrderIn`, by `order_document_id`). An order's figures (`paidPesewas`, `paymentStatus`), its returns' refund plan and its void's judgement all come from that read. A sale paid partly by a provider payment that ORD cannot see would read part-paid, and its void would reverse the cash and credit the whole receipt while the mobile money stayed allocated to it.

The opener asks for the link to be decided here, the payment allocated once by its id through `SalePosting.postIn`, never another customer's or another shift's, never one not yet cleared, and for the parent session to be asked before an existing PAY or ORD shape changes.

## Options considered

1. **Let a cleared payment's `order_document_id` be set once, from null.** One column, every existing read works. It loosens the freeze on a posted money record (ADR-0003's "nothing financial is updated in place") and changes an existing PAY trigger: a change of an existing shape, which the opener reserves for the parent session.
2. **Allocate the payment to the receipt and let ORD find it through the allocation.** No new table; but ORD would have to read payments by billing document, a new read across BIL and PAY for every order view, and a payment unallocated later (an accountant's `unallocatePayment`) would silently leave the sale.
3. **A link row in PAY, insert-only, one per payment, written in the sale's transaction before the allocation; PAY's read of an order's payments takes the payments that name the order and the payments linked to it.** One new LEDGER table and one new PAY port (`Payments.takeClearedIn`); the existing read keeps its shape and, for every payment written before this phase, its answer (no link exists).

## Decision

Option 3.

- **`pay.payment_order_link`** (LEDGER, migration 0251): `payment_id` (PK: one sale per payment, ever), `order_document_id`, `shift_document_id`, `customer_id`, `branch_id`, `recorded_at`, `actor_id`. Insert-only (`platform.reject_change`). `pay.payment_order_link_guard`, under the payment's row lock, refuses (HK010 `ck_payment_order_link`, the rule in the error's detail) a payment that is not mobile money or card (`NOT_A_PROVIDER_PAYMENT`), not CLEARED from the provider's callback or lookup (`PAYMENT_NOT_CLEARED`), already taken for an order, allocated or refunded by a pesewa (`PAYMENT_ALREADY_USED`), of another branch, customer or till shift (`OTHER_BRANCH`, `OTHER_CUSTOMER`, `OTHER_SHIFT`), or whose shift no longer takes entries from the person linking it (the till rule of migration 0239, read through `pay.till_shift_refusal`, never from `pos`).
- **`Payments.takeClearedIn`** (PAY's port, in the caller's serializable transaction): judges the payment with the pure `judgeClearedTender` (`src/modules/pay/domain/cleared-tender.ts`), asks POS's `TillShiftCheck` for the shift (ADR-0077), writes the link, allocates the whole payment to the sale's receipt (◆ `pay.DepositAllocated`: Dr 2200 Cr 1200), and audits `TAKE_AS_TENDER`. The tender's amount must be the payment's amount exactly (`AMOUNT_DIFFERS`), so the payment is applied whole and **no change is ever given from it**; a walk-in sale takes only a payment for nobody, and a named customer's sale only that customer's (`OTHER_CUSTOMER`); a payment of another branch is answered `PAYMENT_UNKNOWN`, exactly as an id that names no payment, so its identifier tells a cashier nothing.
- **ORD, additively** (`src/modules/ord/application/sale-posting.ts`, by the parent session's leave): `SaleTenderRequest.paymentId` (optional). A tender naming it is taken through `takeClearedIn` instead of `recordIn`. Nothing else in ORD changes.
- **PAY's reads:** `PaymentStore.paymentsOfOrder` reads `order_document_id = $1` or a link to `$1`; `PaymentView.orderDocumentId` and the contract's `Payment.order` name the linked sale for a linked payment. So the order's figures, its return's refund plan and its void see the payment: a void of a sale paid by mobile money or card is refused `TENDER_NOT_VOIDABLE` (ORD's existing rule), and the money goes back through a return's refund to the original method.
- **POS:** `completeCounterSale` accepts a mobile money or card tender only with `paymentId`; without it, 422 `PAYMENT_METHOD_REQUIRES_VERIFICATION` as before. `PAYMENT_ID_NOT_FOR_METHOD` (a `paymentId` on a cash tender) and `PAYMENT_NAMED_TWICE` are new details of `COUNTER_SALE_INVALID`; `PROVIDER_PAYMENT_NOT_AVAILABLE` is no longer answered.

## Consequences

- No existing PAY or ORD shape changed: one new table, one new PAY method, one new optional field on ORD's sale request, one read widened that answers the same for every payment that existed before.
- A mobile money payment taken at the till for no sale stays an unallocated deposit counted in the shift's tenders until a sale takes it or it is refunded, exactly as before.
- The ledger needs no new posting rule: the payment's clearing credited 2200 (deposit); the allocation moves it to the receipt's 1200.
- A payment linked to a sale and later unallocated by the accountant (`unallocatePayment`, with a reason) keeps its link: it cannot be taken by another sale (`PAYMENT_ALREADY_USED`, the PK). The card provider (B09c) uses the same path.
- Binds `docs/data-model/pay.md`, the PAY and POS cards in `docs/MODULE_BOUNDARIES.md`, `docs/API.md` (`completeCounterSale`), THREAT_MODEL abuse case 4, A-276.

## Verification

- `src/modules/pay/domain/cleared-tender.spec.ts` (12 tests): every refusal, written before the code and seen red.
- `test/integration/pos/provider-tender.integration.spec.ts` (11 tests): a 4,000 mobile money payment and 2,000 in cash pay a 6,000 receipt (3 yams at the 2,000 the base list holds); by SQL the link, one allocation of 4,000, the receipt's allocations summing to 6,000, 2200 and 1200 back to 0 and the allocation's journal exactly Dr 2200 4,000 Cr 1200 4,000; ORD reads it PAID, the payment names its sale, a void is refused `TENDER_NOT_VOIDABLE`; refused, recording nothing: a second allocation (also by the database), another customer's and a named customer's on a walk-in sale, one not yet cleared (also by the database), another cashier's shift and no shift (also by the database), another branch's (as an unknown id), a part or more of the payment, change from it, no payment, a payment id on cash, the wrong role.
- Mutations, each turning that spec red, are in the B09b continued 1c report.
