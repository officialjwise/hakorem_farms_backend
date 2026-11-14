# ADR-0021: Catch-weight orders are invoiced on weighed quantity, with a tolerance and a payment adjustment

- **Status:** Proposed (awaiting B0 gate; provider capability to be confirmed in B9a)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief states that the final price of meat ordered online is only known at the scale. Every such order carries an acceptable tolerance, a re-pricing rule, and either a payment pre-authorisation with later capture or a documented adjustment with customer notification. The invoice is raised against weighed quantity, never ordered quantity. The storefront must show the estimated total, the tolerance and the final-charge rule at checkout.

Mobile money, the dominant payment method, generally has no pre-authorisation: money is either collected or not.

## Options considered

1. **Pre-authorise and capture later, for every method.** Clean where supported. Not available for mobile money.
2. **Charge the maximum (estimate plus tolerance) and refund the difference.** Works for every method but overcharges every customer first.
3. **Charge the estimate, then settle the difference after weighing.** Works for every method; most orders need a small refund or a small collection.

## Decision

Option 3 as the rule for every method, with option 1 used where the provider and method support it.

**At order time**

- A catch-weight order line stores the ordered packs, the estimated weight (packs multiplied by the product's nominal pack weight), the price per kilogram, the estimated line total and `tolerance_percent` (default from the product, initially 10).
- Checkout shows the estimated total, the highest possible total (estimate plus tolerance) and the rule below.
- Online payment collects the estimated total. Where pre-authorisation is available, the highest possible total is authorised and the final total captured. Either way the payment is recorded as a customer deposit until the invoice exists (ADR-0003).

**At picking**

- Each pack is weighed. The fulfilment line stores the weight and its source.
- The final line total is `half_up(price per kg × weighed kg)` (ADR-0001).
- If the weighed total is within the tolerance of the estimate, the order proceeds.
- If it is above the tolerance, the picker must choose different packs. If none fit, the order waits for the customer's consent to the higher total or to a substitution, recorded on the order.
- If it is below the tolerance, the picker adds or swaps packs where possible. Otherwise the order proceeds at the lower total.

**At dispatch**

- The invoice is issued against weighed quantity.
- The deposit is allocated to the invoice. The difference is settled:

| Case | Settlement |
| --- | --- |
| Final below the amount paid | The difference is refunded to the original method, or held as store credit if the customer chose that at checkout |
| Final above the amount paid, within tolerance | The balance is collected on delivery, or captured from the pre-authorisation |
| Cash on delivery | The final total is collected on delivery |

- The customer is notified of the final total and the adjustment, with the weights, through the outbox.

## Consequences

- No customer is charged more than the highest total they were shown without giving consent.
- Small automatic refunds will be common. They are a defined refund reason that does not need individual approval below a configured amount, and they appear on the daily refund report.
- A balance collected on delivery makes the driver's expected cash depend on fulfilment. The delivery record carries the amount due, computed at dispatch.
- Whether the first payment adapter supports pre-authorisation for cards is verified in B9a and recorded there.
- Binds: `docs/data-model/ord.md`, `docs/data-model/shp.md`, `docs/data-model/pay.md`, the order state machine in `docs/DOMAIN_MODEL.md`.

## Verification

- B9a: tests with exact values for a final total below, equal to, above-within-tolerance and above-beyond-tolerance of the estimate.
- B11 gate: a catch-weight order re-prices at pick, the invoice shows weighed quantity, and the outbox carries the customer notification.
