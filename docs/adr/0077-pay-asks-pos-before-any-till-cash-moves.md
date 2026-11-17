# ADR-0077: PAY asks POS, through the TillShiftCheck port, before any cash moves into or out of a till

- **Status:** Proposed (2026-11-17)
- **Date:** 2026-11-17
- **Session:** B09b continued
- **Deciders:** backend track; owner approves

## Context

The owner's decision on A-212 (a) (2026-11-16) is that cash enters only through a till shift and is counted at its close; A-273 (i) adds that a cash refund is paid only out of an open shift of the till that took the payment. B9b left one gap open, recorded as A-273 (k): PAY refuses cash into a till with no shift named (`SHIFT_REQUIRED`, `ck_payment_cash_shift`), but whether the named document is a till shift, OPEN and the seller's own was POS's to check, and only POS's own commands checked it. Any caller of PAY's ports (`Payments.recordIn`, `Payments.writeIn`, `ProviderPayments.chargeIn`), and PAY's own commands that move a till's cash out (`markRefundPaid`, an approved `reversePayment`, the void ORD approves through `Receipts.reverseApprovedIn`), could name another cashier's shift, another till's shift, or a shift that was closed or force-closed. Cash recorded so is either counted at nobody's close or makes a closed shift's frozen figure wrong: the gap a cashier would use to take cash off the books (abuse case 17).

PAY is layer 7 and POS layer 10 (MODULE_BOUNDARIES section 2): PAY may not import POS nor read `pos.shift`, and the schema-names check refuses a PAY migration that reads another schema or the platform's registry.

## Options considered

1. **Leave the check to each selling command.** POS's counter sale and cash movements check under the shift's lock; every other path is trusted. Costs nothing, and leaves every PAY port and PAY's refunds and reversals open: the gap stays.
2. **A PAY trigger that reads `pos.shift`.** Enforced in the database, but a lower schema reading a higher one's table breaks ADR-0008's boundary and the schema-names check refuses it.
3. **A port: PAY defines `TillShiftCheck` and a `TillShiftRegistry`; POS registers its implementation.** PAY asks, in the caller's transaction, before any cash moves through a till; POS answers under the shift's row lock. One more port to keep, and the rule is held in the application, with the database holding that a till's cash names a shift (`ck_payment_cash_shift`) and that a cash refund paid from a till names the shift it was paid out of (`ck_refund_till_shift`).

## Decision

Option 3.

- `src/modules/pay/application/till-shifts.ts` defines `TillCashRequest` (`shiftDocumentId`, `registerId` or null, `branchId`, `actorId`, `direction` IN or OUT), `TillCashAnswer` (the shift's till with its location, or a refusal `SHIFT_UNKNOWN`, `SHIFT_NOT_OPEN`, `SHIFT_NOT_OWN`, `SHIFT_OTHER_REGISTER`, `SHIFT_OTHER_BRANCH`), the port `TillShiftCheck` and `TillShiftRegistry`, exported from PAY's `index.ts`. **Deny by default:** with no check registered, or none that knows the document, the answer is `SHIFT_UNKNOWN`.
- POS's `TillCash` (`src/modules/pos/application/till-cash.ts`) implements it and `PosModule.onModuleInit` registers it. It locks the shift (`SELECT ... FOR UPDATE`) and judges with the pure `judgeTillCash` (`src/modules/pos/domain/till.ts`): the shift is OPEN (a CLOSING, CLOSED or force-closed shift takes and pays out nothing); of the payment's branch; of the till named, when one is; and the actor is its cashier, or holds `pos.shift.force_close` at its branch (the manager recovering a till, OFFLINE_SYNC 6.5, A-273 (f); migrations 0233 and 0234 seed it to the Owner and the Manager).
- PAY asks through `Payments.tillCashIn` (throws 422 `PAYMENT_INVALID`) or `Payments.tillCashAnswerIn` (for a command that words its own refusal):
  - `Payments.writeIn`, the one door every PAY payment is written through (so `recordIn`, and any module's sale tender, cannot go round it), for every cash payment into a till;
  - `ProviderPayments.initiate` and `writeChargeIn` (and so `chargeIn`) for a mobile money charge that names a shift: such a charge is counted in the shift's tenders, and is authorised at the till's location;
  - `Refunds.markPaid` for a refund of a cash payment held by a till, other than to store credit: the body's new optional `shiftId` is required (422 `REFUND_INVALID` `SHIFT_REQUIRED`) and must be an open shift of the till that took the payment (`SHIFT_OTHER_REGISTER` otherwise); `pay.refund.paid_from_shift_id` (migration 0232) records it, and `ck_refund_till_shift` refuses a till cash refund PAID without one, or a shift on any other refund;
  - `Receipts.reverseIn`, for an approved `reversePayment` and the void ORD approves: cash goes back out only through the shift it was taken in, which must still be open, and the decider must reach it.
- A shift's expected cash counts cash refunds against the shift they were paid out of (`PgPaymentStore.shiftTotals`), not the shift that took the payment, and only once paid.

## Consequences

- No path in PAY takes or pays out a till's cash that POS has not seen under the shift's lock: the gap A-273 (k) recorded is closed for every caller. A direct PAY call cannot bypass it, and each path's refusal is tested.
- A cash refund needs an open shift on the till that took the payment; a payment taken in a shift that has closed is refunded or reversed only by a manual journal under approval (the accountant), or after a new shift opens on that till (a refund). A void of a cash sale after its shift closed is refused at the approval, as FR-POS-009 ("only within the same shift") intends.
- Only the Owner and the Manager may record cash, pay a refund out of, or reverse a payment on another cashier's shift. The Accountant may request a reversal and pay a non-till refund, but not take cash out of a cashier's drawer.
- The driver's cash on delivery (B11) is cash held by a driver, not a till (`ck_payment_cash_holder`), and is outside this port; B11 must hold its own rule for the driver's reconciliation.
- Binds `docs/MODULE_BOUNDARIES.md` section 6 and the PAY and POS cards, `docs/data-model/pay.md`, `docs/API.md` (`markRefundPaid`, `initiateMobileMoneyCharge`), THREAT_MODEL abuse case 17, A-273 (i) and (k) and A-274.

## Verification

- `src/modules/pos/domain/till.spec.ts` (`judgeTillCash`): each refusal and the order in which they apply, written before the code and seen red.
- `test/integration/pos/till-cash-paths.integration.spec.ts` (B09b continued): for a sale's tender through ORD, `recordIn` and `writeIn` called directly, a mobile money charge by HTTP and through `chargeIn`, a cash refund paid by hand, an approved reversal and a void, and a cash movement, cash naming another cashier's shift, another till, a closed shift and a force-closed shift is refused and nothing is recorded (counts and ledger by SQL); the database refuses a till cash refund paid with no shift. A cashier who counts the figure derived by SQL signs off EXACT and the till's 1000 returns to 0. Six mutations, each removing one check, turn the spec red (the report lists them).
