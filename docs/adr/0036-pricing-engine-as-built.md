# ADR-0036: The pricing engine as built: where ADR-0004 left a choice

- **Status:** Proposed (accepted by merging the B4 pull request)
- **Date:** 2026-11-14
- **Session:** B4
- **Deciders:** backend track; owner approves by merging

## Context

ADR-0004 fixes the resolution order, the typed `QuoteRequired` result, maker-checker activation and "overlap made impossible by a constraint". Building it in B4 met six questions the ADR does not answer. Each needed an answer in code, and each is cheap to reverse because it lives in one function or one trigger.

## Decisions

1. **Branch lists inside a slot.** `mdm.price_list` is unique per (kind, channel, tier, branch), so one slot can hold a list for a branch and a list for every branch. Inside a slot the branch's list comes first and the walk falls through to the all-branch list like any other slot: customer, tier at this branch, tier everywhere, channel at this branch, channel everywhere, base at this branch, base everywhere. Rejected: the branch list replacing the all-branch list outright, which would leave a branch that prices only its eggs with no price for its goats.
2. **When the reason is `MISSING_GRADE_OR_WEIGHT`.** Only when some entry would have matched once given the grade or weight the request lacks. A 65 kg goat with no grade, against a list whose grade A entries are for smaller bands, is `NO_RULE`: no grade would price it. A weight outside every band is `NO_RULE`. The first build answered `MISSING_GRADE_OR_WEIGHT` there; the B4 gate test found it.
3. **Activation starts no earlier than the approval.** A version approved after its `validFrom` becomes `ACTIVE` from the moment of approval; the trigger on `mdm.price_list_version` lets activation move `valid_from` later, never earlier. A version whose whole window passed before approval cannot be activated (`INVALID_STATE_TRANSITION`, detail `WINDOW_PASSED`). Otherwise a late approval would rewrite which price was in force for sales already made.
4. **What activation does to the versions it overlaps.** An active version that started earlier is ended where the new one starts (`valid_to`, the only column of an active version that may change, and only to an earlier value); one that starts at or after the new one is `SUPERSEDED`. A new version with an end date does not revive anything after it: the list has no price after that end until another version is activated, and the walk goes on to the next list. The exclusion constraint on `ACTIVE` windows is the backstop.
5. **Replacing draft entries.** `docs/data-model/mdm.md` says a draft entry is removed outright, but `hk_app` holds no `DELETE` on a `MASTER` table (ADR-0024). The one removal is `mdm.clear_draft_price_list_entries(uuid)`, `SECURITY DEFINER`, owned by `hk_owner` with a fixed `search_path`; the entry guard trigger refuses any insert, update or delete of an entry whose version is not `DRAFT`, so the function can empty only a draft. One open version per list at a time (`uq_price_list_version_draft`), matching the contract's single `draftVersionId`.
6. **`resolvePrices` checks the permission without a branch or location scope.** A cashier's grant is scoped to the shop floor location, and a location-scoped grant does not satisfy a branch-scoped check (ADR-0034). Prices are INTERNAL, not confidential, and every operation that sells at a price (counter sale, order, quote) checks its own location scope when it records the sale. A list that applies everywhere registers its versions as business documents under the farm's first active, non-test branch (A-090); the approval is decided there.

Also recorded:

- **Line extension** (`extendPrice`) multiplies the unit price by the weight for `PER_KG` and by the quantity otherwise, rounded half-up once (ADR-0001). A `PER_KG` line without a weight is refused, never estimated.
- **Agreed price** (`judgeAgreedPrice`): a discount within the band needs no approval while it is within the role's remaining allowance for the shift; a price above list needs none up to the ceiling; outside the band, either way, it needs approval. The selling module works out the allowance from `iam.role_limit` (B9a, B9b).
- **Response money** is a JSON integer from `Money.toJsonInteger`, which refuses anything outside the exact range; the request side parses pesewas into `bigint` at the boundary.

## Consequences

- Anyone can still predict a price by reading the lists in order; the branch rule adds one step per slot and is documented in `docs/API.md` (Pricing).
- A late approval never changes the price an earlier sale was made at, and `getPriceListVersion` can show a later `validFrom` than was drafted.
- A finite version over an open-ended one leaves a gap after its end. A manager who wants the old prices back drafts a version for them.
- Reversal: decisions 1, 2 and 6 are one function each; 3 to 5 are a trigger and a function in migration 0011, changed by a new migration.

## Verification

- `src/modules/mdm/domain/pricing-engine.spec.ts` and `price-list.spec.ts`: 100 percent branch coverage, exact pesewas, the half-pesewa rounding case and a weight outside every band.
- `test/integration/mdm/pricing-schema.integration.spec.ts`: every database rule violated once.
- `test/integration/mdm/price-lists.integration.spec.ts`: the lifecycle through the API, maker refused as checker, a backdated version starting at approval, the branch list falling through, wrong roles refused.
- `test/integration/mdm/pricing-gate.integration.spec.ts`: the B4 gate over the seeded catalogue.
