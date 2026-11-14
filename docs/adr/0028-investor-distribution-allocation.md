# ADR-0028: Investor distributions are allocated by unit-days with largest-remainder rounding

- **Status:** Accepted (owner, 2026-11-13)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** owner approved the method and set the conditions; backend track specified them

## Context

The shared brief requires that shareholding is held as units with effective dates, that profit share is computed at a period close from the ledger, and that a distribution run allocates by weighted average shareholding. Acceptance scenario 4 requires that two investors who contributed on different dates receive an allocation that matches a hand calculation and ties exactly to the ledger.

"Weighted average shareholding" has two readings that pay investors differently. If A holds 100 units all quarter and B holds 100 units from mid-quarter, weighting units by days held gives A 66.7 percent and B 33.3 percent, while averaging each day's percentage gives A 75 percent and B 25 percent.

The owner chose unit-days, and set three conditions: largest-remainder allocation on integer pesewas so that the allocations sum to the distributable amount exactly; a test asserting that no pesewa is created or lost on an awkward split with three investors; and the day-count convention, including whether the contribution day counts, recorded here.

## Options considered

1. **Average of daily percentages.** Each day's profit is shared by that day's holdings. Needs exact rational arithmetic, and is not the reading the owner chose.
2. **Unit-days.** Each investor's weight is the sum over the days of the period of the units they held that day. This is the weighted-average-units convention, and the weights are integers.

## Decision

Option 2.

**Amounts**

1. The periods covered by the run must be locked or closed in the ledger.
2. `net_profit` is income minus cost of sales minus expenses for the period, read from the ledger. If it is zero or negative, the run records that and allocates nothing.
3. `retained = half_up(net_profit × retention_rate)`. The retention rate is an owner setting, default 40 percent, snapshotted on the run.
4. `distributable = net_profit − retained`.

**Day-count convention**

- Days are calendar dates in Africa/Accra.
- The period is inclusive at both ends: `days_in_period = period_end − period_start + 1`. Actual days are counted; no 30-day months and no 360-day year.
- **The contribution day counts.** Units issued with effective date `E` are held on `E` and every later day.
- **The withdrawal day does not count.** Units redeemed with effective date `R` are held up to and including the day before `R`.
- A holding is therefore the half-open interval from `E` up to but not including `R`.
- The effective date of a unit issue is the value date of the capital contribution.

**Weights**

- `unit_days(investor) = sum, over each day d in the period, of the units the investor held on d`.
- Units are stored as `NUMERIC(18,4)`. The weight passed to the allocation is `unit_days × 10,000`, an integer.
- If total unit-days is zero, the run cannot be approved.

**Allocation**

- `allocate(distributable, weights)` from ADR-0001: floor of each exact share, then the leftover pesewas go one at a time to the largest remainders.
- Ties are broken by investor number, lowest first.
- The run stores, per investor, the unit-days and the allocated amount. A deferred constraint trigger asserts that the allocated amounts sum to `distributable` before the run can leave draft.
- Tax withheld, if a rate is configured, is `half_up(allocated × rate)` per investor, and net payable is allocated minus withheld. The rate defaults to zero until the accountant confirms it.

**Run lifecycle**

Draft, then pending approval, then approved by a different user with step-up authentication, then posted to the ledger, then paid. The run records `allocation_method = 'UNIT_DAYS'` and the day-count convention as text, so a historical run states the rule it used.

## Test specification

B0 writes no code. These tests are specified here with exact values and are implemented in B2 (the kernel's `allocate`) and B12 (the distribution run). Both sessions must include them under these names.

**Test 1: `allocates an awkward amount across three investors without creating or losing a pesewa`**

Period: 1 January 2027 to 31 March 2027, 90 days. Net profit GHS 16,666.68 (1,666,668 pesewas), retention 40 percent.

- `retained = half_up(666,667.2) = 666,667`
- `distributable = 1,666,668 − 666,667 = 1,000,001` pesewas (GHS 10,000.01)

| Investor | Holdings | Unit-days |
| --- | --- | --- |
| 001 Ama | 1,000 units from before the period | 1,000 × 90 = 90,000 |
| 002 Kofi | 500 units, effective 15 February 2027 (15 February to 31 March is 45 days, the contribution day counted) | 500 × 45 = 22,500 |
| 003 Esi | 250 units from before the period, plus 250 units effective 1 March 2027 (31 days) | 250 × 90 + 250 × 31 = 30,250 |
| Total | | 142,750 |

| Investor | Exact share (pesewas) | Floor | Remainder (of 142,750) | Allocated |
| --- | --- | --- | --- | --- |
| 001 Ama | 630,473.485… | 630,473 | 69,250 | **630,474** |
| 002 Kofi | 157,618.371… | 157,618 | 53,000 | **157,618** |
| 003 Esi | 211,909.143… | 211,909 | 20,500 | **211,909** |
| Sum | 1,000,001 | 1,000,000 | 142,750 | **1,000,001** |

The floors sum to 1,000,000, leaving one pesewa, which goes to the largest remainder, investor 001.

Assertions:

- the three allocated amounts are exactly 630,474, 157,618 and 211,909;
- their sum equals 1,000,001;
- rounding each share half-up independently gives 630,473 + 157,618 + 211,909 = 1,000,000, which loses a pesewa, and the test asserts the implementation does not produce that result.

**Test 2: `breaks a tie between equal remainders by investor number`**

Three investors with equal unit-days, distributable 100 pesewas. Expected: 34, 33, 33 in investor-number order. Sum 100.

**Test 3: `counts the contribution day and not the withdrawal day`**

Period 1 to 30 April 2027 (30 days). One investor is issued 100 units effective 10 April and redeems them effective 20 April. Expected unit-days: 100 × 10 = 1,000 (10 April to 19 April inclusive).

**Test 4: `refuses to allocate when all weights are zero`**

Expected: a typed error, no allocation rows.

**Test 5: `the posted distribution ties to the ledger`**

After posting the run from Test 1: account 3300 is debited 1,000,001 in total, account 2300 is credited 630,474, 157,618 and 211,909 against the three investor subledgers, and the trial balance sums to zero.

## Consequences

- An investor's share is explainable with a calendar and a calculator, which is what acceptance scenario 4 demands.
- A new contribution earns from its value date, including that day.
- The alternative reading (average of daily percentages) is not built. If it is ever wanted, it is a new allocation method and a new ADR.
- Binds: `docs/data-model/cap.md`, the kernel `allocate` function, the B12 session, `docs/UAT.md` scenario 4 (B1).

## Verification

- B2: Tests 1, 2 and 4 against `allocate`.
- B12: Tests 1 to 5 against the distribution run. The B12 gate is that a distribution matches a hand calculation and ties exactly to the ledger.
