# ADR-0040: Promotions and coupons as built: where ADR-0004 left a choice

- **Status:** Proposed (owner approves by merging the B04d pull request)
- **Date:** 2026-11-15
- **Session:** B04d
- **Deciders:** backend track; owner

## Context

ADR-0004 point 5 fixes the rules: promotions and coupons are applied after the base price, as separately recorded adjustments, only to prices from the tier, channel or base lists; at most one promotion per `stack_group`; an exclusive promotion excludes all others. FR-MDM-018 adds that a coupon cannot be redeemed beyond its total or per-customer limit, "checked under a row lock". `docs/data-model/mdm.md` gives the tables. Building it met eight questions these leave open. If nothing is decided, two selling modules (cart in B7, order in B9a) would each compute discounts their own way, and a coupon limit would hold only as long as callers behaved.

## Options considered

1. **Discount on the unit price.** `resolvePrices` already returns unit prices, so a per-unit discount fits its shape. Cost: the selling module would multiply a rounded unit discount by the quantity, a second rounding of the same amount (ADR-0001).
2. **Discount on the line extended at list price.** One half-up rounding of the line amount; the selling module records the integer. Cost: a per-kilogram line without a weight has no line amount and so no discount until it is weighed.
3. **Coupon limit held only by the application** (read, check, write under serializable isolation). Cost: 20 concurrent checkouts of a hot code fail serialization and retry until some exhaust their five attempts.
4. **Coupon limit held by a trigger under row locks, with an optional advisory lock taken by the caller before its transaction.** Cost: one more trigger and one lock key the selling modules must name.

## Decision

Options 2 and 4, with these rules:

1. **The anchor is the line extended at list** (`extendPrice`: list times quantity, or per kilogram times the weight, rounded half-up once). `PERCENT_OFF` is `half_up(line x percent)`, once. `AMOUNT_OFF` comes off the line once, never more than the line. A per-kilogram line without a weight takes no promotion. `resolvePrices` returns each discount as `AppliedPromotion.discountPesewas`, largest first. Pure rules: `src/modules/mdm/domain/pricing/promotions.ts`, under the existing 100 percent gate on `domain/pricing/**`.
2. **Stacking.** Candidates are the `ACTIVE` line promotions whose window `[valid_from, valid_to)` holds the pricing time, whose channel is null or the request's, whose targets name the product or its category or any category above it, whose coupon (if required) is the request's, and whose minimum order is met by the sum of the request's lines extended at list. A discount that rounds to zero is dropped. If any exclusive candidate remains, the largest exclusive one alone applies. Otherwise the largest of each stack group applies, groups taken largest first, each capped so the line never goes below zero. Ties break by promotion code. Nothing applies to a `CUSTOMER` list price.
3. **Bundle, free-delivery and order-level promotions** are defined, approved and stored here, and evaluated on the whole basket by the cart and order (B7, B9a); the line engine gives them nothing.
4. **Lifecycle as for price lists (ADR-0036).** `DRAFT` to `PENDING_APPROVAL` (`PROMOTION_ACTIVATION`, approver holds `mdm.promotion.approve`, step-up) to `ACTIVE` or `REJECTED`; `ACTIVE` to `ENDED`. Activation moves `valid_from` to the moment of approval if that is later, never earlier; a window that passed before approval is refused (`WINDOW_PASSED`). `endPromotion` sets `valid_to` to now (or keeps an earlier end). Trigger `mdm.promotion_guard` freezes everything else; targets are frozen with the promotion and replaced in a draft only through `mdm.clear_draft_promotion_targets` (`SECURITY DEFINER`).
5. **The limit is the database's.** Trigger `mdm.coupon_redemption_count` on `mdm.coupon_redemption` (a `LEDGER` table) locks the promotion, then the coupon (always in that order), checks the coupon's `max_uses`, the promotion's `max_redemptions` across its coupons, the per-customer limit and one use per document, and moves `used_count`; a refusal is SQLSTATE `HK006` with the reason in `DETAIL`. `mdm.coupon_guard` refuses any change to `used_count` that does not come from that trigger (`pg_trigger_depth()`), and `ck_coupon_within_limit` is the backstop. A release must undo a use the same document holds.
6. **Callers queue on one lock.** A selling module redeems with `Promotions.redeemIn(tx, …)` inside its own serializable transaction and names `couponLockKey(code)` in `seriesLocks`, so concurrent redemptions of one code wait for each other before their snapshots instead of failing serialization. The trigger holds the limit whether or not the caller does this.
7. **`validateCoupon` is public and says nothing about any customer.** It takes no session (the guard gives a public route no actor), ignores `customerId`, and answers `NOT_FOUND`, `EXPIRED`, `LIMIT_REACHED` or `NOT_APPLICABLE`; the per-customer limit is checked when the coupon is redeemed. It is rate-limited by address (`public`). A `cartId` names nothing until carts exist (B7).
8. **Targets are products and categories only.** The SRS lists tiers among a promotion's targets, but neither the contract nor `mdm.promotion` has a tier; a promotion is restricted by channel and coupon. Tier targeting is parked (BL-044 in `docs/BACKLOG.md`, A-101).

Every discount posts to account 4220 when the selling module posts its line (B8, B9a); MDM records nothing in the ledger.

## Consequences

- A selling module never computes a discount; it records the integers `resolveIn` returns and redeems the coupon in the same transaction as the order.
- A hot coupon serialises its redemptions on one lock: throughput for that one code is one transaction at a time, which is the point.
- A late approval never discounts a sale already priced; a promotion ended early stops at once.
- Forbidden: updating `used_count` directly, deleting a redemption, discounting a contract price.
- Binds `docs/data-model/mdm.md`, `docs/API.md` (Pricing), `docs/MODULE_BOUNDARIES.md` (MDM card), the `hakorem-pricing` skill, and the cart and order sessions (B7, B9a).
- Reversal: rules 1 to 3 are one pure file; 4 and 5 are migration 0017, changed by a new migration; 6 and 7 are one function each.

## Verification

- `src/modules/mdm/domain/pricing/promotions.spec.ts`: exact pesewas, the half-pesewa cases, each stacking rule, the cap, the contract price refused; 100 percent on all four measures.
- `test/integration/mdm/promotion-schema.integration.spec.ts`: every rule of migration 0017 violated once, and 101 redemptions over 20 connections at read committed with no caller lock against a limit of 100: exactly 100 committed.
- `test/integration/mdm/promotions.integration.spec.ts`: the B04d gate through the API (one per stack group, the exclusive 10 percent alone, no discount on a contract price) and 101 serializable redemptions by 20 concurrent callers through `redeemIn`: exactly 100, the 101st `COUPON_UNAVAILABLE` `LIMIT_REACHED`; maker refused as checker; the wrong roles refused.
