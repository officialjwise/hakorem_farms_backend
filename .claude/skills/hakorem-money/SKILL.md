---
name: hakorem-money
description: "Use when any code or test touches price, amount, total, subtotal, tax, levy, VAT, discount, fee, change, tender, refund amount, cost value, profit, share or split of an amount, currency, pesewas, GHS, `Money`, `*Pesewas` fields, `_pesewas` columns, `platform.pesewas`, `allocate`, rounding, or does arithmetic on money, quantity times price, or percentage of an amount. Applies to TypeScript, SQL and tests. For journal entries and account selection use hakorem-ledger; for resolving which price applies use hakorem-pricing; for quantities and weights as stock use hakorem-stock. This skill still applies underneath all three whenever a number of pesewas is computed."
---

# Money: integer pesewas, one rounding, exact splits

Decision: `docs/adr/0001-money-representation-and-rounding.md`. Tax: `docs/adr/0020-tax-engine-named-levies.md`. API shape: `docs/adr/0029-api-contract-conventions.md`. Allocation worked example: `docs/adr/0028-investor-distribution-allocation.md` (Test 1).

## Checklist

1. **Never a float.** Money, quantity and weight are never a JavaScript `number` in arithmetic. Use the kernel types (`packages/kernel`: `Money`, `Quantity`, `Weight`, `allocate`). The lint rule from B2 fails the build on `number` arithmetic in a file that imports `Money`.
2. **Integer pesewas everywhere.** Database columns are named `*_pesewas` and use the domain `platform.pesewas` (`BIGINT`, 0 to 9,007,199,254,740,991). Amounts are never negative: direction is a `side` (`D`/`C`), a `direction`, or the document type.
3. **No stored rates.** Average cost per kilogram, a share percentage and similar are derived from two stored integers when needed, never stored as an authority (ADR-0001, ADR-0018).
4. **One rounding per line, half-up, at the anchor.** The anchor is the line net for a tax-exclusive price, the line gross for a tax-inclusive price, `value_out` for a stock issue from a cost pool, and the amount being split for a split. Everything else on the line derives from the anchor. For non-negative integers `half_up(n / d) = (2n + d) div 2d`.
5. **A total is a sum of line integers.** Never recompute a total from another total, and never round a sum.
6. **Splits only through `allocate(total, weights[])`.** Integer weights, floor of each exact share, leftover pesewas to the largest remainders, ties broken by the stable key you pass in (line number, investor number), all-zero weights is an error. Never divide and round each part, never "put the difference on the last line". A header-level discount is allocated across lines before tax.
7. **Percentages and rates are exact decimals** parsed from strings by the decimal library, never from `number`. Tax rates are `NUMERIC(7,4)` in `mdm.tax_category_levy`; the calculator in MDM is the only place levy arithmetic lives (ADR-0020).
8. **Currency is GHS.** Document and journal headers carry `currency CHAR(3) NOT NULL DEFAULT 'GHS' CHECK (currency = 'GHS')`. No multi-currency logic, no cash rounding to the coin (parked in `docs/BACKLOG.md`).
9. **API shape.** Money is an integer field whose name ends `Pesewas`, plus one `currency` on the object. Cost and price are always separate fields (`unitCostPesewas` vs `listPricePesewas`). A total the screen shows comes from the API as its own field and covers everything matching the filter, not just the page. Weights and quantities are decimal strings with three places.
10. **Nothing client-side computes money.** Do not return fields the frontend would have to add up; add the total on the server.

## Required test shape

Written test-first, one named test per rule, each asserting an exact integer. Each rounding site needs these cases as separate tests: exactly half, one pesewa below half, one above, zero, and the maximum (9,007,199,254,740,991). Test names are sentences, as in ADR-0028.

```ts
describe("line total", () => {
  it("rounds an exact half pesewa up, once, at the line total", () => {
    // 2.500 kg at 3 pesewas per kg is 7.5 pesewas
    const net = lineNet(Money.pesewas(3n), Quantity.thousandths(2500n));
    expect(net.toPesewas()).toBe(8n); // never 7, never a float
  });
  it("allocates GHS 10,000.01 across three investors without creating or losing a pesewa", () => {
    const parts = allocate(1_000_001n, [90_000n * 10_000n, 22_500n * 10_000n, 30_250n * 10_000n], ["001", "002", "003"]);
    expect(parts).toEqual([630_474n, 157_618n, 211_909n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000_001n);
  });
});
```

Coverage: kernel `Money`, `Weight`, `Quantity`, `allocate` and the tax calculator need 100 percent branch coverage (`docs/TEST_STRATEGY.md`).

## Correct and incorrect

Incorrect: float arithmetic, per-part rounding, a second rounding of the same quantity.

```ts
// WRONG: number arithmetic, Math.round, and the parts do not sum to the total
const net = Math.round(unitPrice * weightKg);          // float, and rounds before discount
const vat = Math.round(net * 0.15);                    // rate as a float
const nhil = Math.round(net * 0.025);
const total = Math.round(net + vat + nhil);            // second rounding of a sum
const shares = investors.map(i => Math.round(profit * i.pct)); // loses or invents pesewas
```

Correct: kernel types, one rounding at the anchor, levy amounts on an integer base, exact split.

```ts
// RIGHT: names are those exported by packages/kernel (B2); shape is what matters
const net = lineNet(unitPrice, quantity).minus(lineDiscount);      // the only half-up for this line
const levies = taxCalculator.exclusive(net, category, scheme);     // half_up(base * rate) per levy, integer base
const gross = net.plus(sum(levies.map(l => l.amount)));            // a sum of integers
const shares = allocate(distributable, unitDays, investorNos);     // sums to distributable exactly
```

SQL: money columns use the domain, never `numeric`, `float` or `money`.

```sql
-- RIGHT
line_net_pesewas   platform.pesewas NOT NULL,
-- WRONG
line_net           numeric(14,2),    -- second money scale
unit_cost_per_kg   double precision  -- stored rate, float
```

## Common traps

- Per-kilogram price times a weighed quantity is the anchor for catch-weight lines: `half_up(price_per_kg x weighed_kg)` once (ADR-0021).
- Issue from a cost pool: `half_up(V x q / Q)`, and the issue that empties the pool takes all remaining value (ADR-0018).
- Tax-inclusive prices: net and levies come from `allocate` over the gross with weights `1 : e_1 : ... : e_n`, so net plus levies equals gross exactly.
- Retention and tax withheld: `half_up(amount x rate)` once per investor or per run as ADR-0028 states.
- JSON carries integers up to 2^53-1 exactly; parse client ids and amounts as `bigint` on the server, not `Number`.
