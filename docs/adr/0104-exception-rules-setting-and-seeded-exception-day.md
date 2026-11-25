# ADR-0104: The exception report's rule as an Owner's setting, and the seeded farm's exception day kept in RPT

- **Status:** Proposed (the owner reviews A-392 to A-394; the setting is the owner's own decision of 2026-11-24)
- **Date:** 2026-11-24
- **Session:** B12 continued 4
- **Deciders:** backend track; the owner

## Context

ADR-0103 built the daily exception report with R18's threshold (three storefront checkouts one address lets end unpaid
in a day) as a constant (A-390 (f)). On 2026-11-24 the owner approved A-390 and decided: "Make the 3 a setting the
Owner can change, audited, not a constant", changed only by the Owner, validated as a whole number of at least 1, and
read as in force for the report's day so a later change never rewrites an earlier day's items. AUD already keeps an
audited, effective-dated settings catalogue (FR-AUD-007), changed by `aud.setting.manage`.

Four phases in a row deferred the seed for reporting. The parent session asked for at least one exception item of
every kind on a seeded day; most kinds come from events that only a fault, a forgery or an attack produces (a
rejected webhook signature, a failed audit verification, a till's refused sync, a projection drift).

## Options considered

1. **A new RPT settings table and endpoint for the threshold.** A second settings mechanism, a new operation, and its
   own audit, for one integer.
2. **AUD's catalogue, changed through `aud.setting.manage`.** Today only the Owner holds it, but any later grant of it
   would let that role change the report's rule too.
3. **AUD's catalogue, with an entry naming a permission of its own, checked besides `aud.setting.manage`.** One
   mechanism, its audit and its effective dating unchanged; the rule stays the Owner's whoever later holds the
   general permission.

For the seeded day:

A. **Make every kind through its module's service.** Impossible honestly for the kinds that need a forged or broken
   record; a seed must not fabricate records presented as real.
B. **Write invented events into the outbox for the projector alone,** as the integration spec does. They would sit in
   the platform's event history, where a rebuild, and any consumer added later, would read them as real.
C. **Classify invented events in RPT and keep the items in RPT's projection only, marked SEED,** beside the kinds the
   seed makes for real (a split order, an export) and every item the seeded farm's own events raise.

## Decision

Option 3: `rpt.checkout_holding.unpaid_checkouts` (INTEGER, default 3, from 1, farm-wide) names
`rpt.exception_rules.manage`, granted to the Owner only (migrations 0374, 0375). The projector reads the value in force
when each checkout ended (`Settings.integerAt` at the event's time), so a redelivery or a rebuild judges it the same
way; the item carries the threshold it was judged by.

Option C: `ExceptionProjector.seedDay`, called only by `pnpm db:seed` (`src/seed/farm-rpt.ts`).

## Consequences

- No operation is added; `updateSetting` takes one more key, and a 403 for a holder of `aud.setting.manage` without the
  rule's permission (contract 2.49.0).
- A setting's change takes effect from the moment it is made, never earlier (a past `validFrom` is refused), so an
  earlier day's items cannot be rewritten through the setting.
- The seeded exception day disappears on a rebuild of the projection, by design; the next `pnpm db:seed` on a fresh
  database makes it again. Its items point at one invented subject document.
