# B04d — Promotions and coupons

Date: 2026-11-15 · Branch `b04d-master-data-promotions`, from `b04c-master-data-continued` at `d735dd9` · Pull request: see "Gate" · Status: **phase split (A-103)**. B04d built promotions and coupons end to end and passed that part of its gate; the rest of master data and the MDM seed move to **B04d continued**, which carries the rest of the gate.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-099 | Seeded promotion permissions (migration 0018): Owner and Manager read, create, update and approve (approve needs step-up; the checker is never the maker); Accountant and Sales read; Cashier, Storekeeper, Farm Hand and Driver hold none | Owner |
| A-100 | A line discount is taken from the line extended at list price, rounded half-up once; `AMOUNT_OFF` comes off the line once, not per unit; a per-kilogram line with no weight takes no promotion until it is weighed | Owner, Accountant |
| A-101 | Promotions target products and categories (a category covers the ones below it) and are restricted by channel and coupon. Tier targeting is parked (BL-044): the SRS lists tiers, but the contract and the table carry none | Owner |
| A-102 | `validateCoupon` is public and ignores `customerId`, so it never reveals who used a coupon; the per-customer limit is checked at redemption. A `cartId` is refused until carts exist (B7) | Owner |
| A-103 | B04d split at a sub-domain boundary inside MDM: promotions here, the rest of master data and the MDM seed in B04d continued; B04e follows that | Owner |

A-076 checked again: `@nestjs/platform-express` 11.2.10 is three days old, inside the 14-day floor, so the multer override stays.

## Why the phase split

B04d's opener carries three sub-domains: promotions, about fifteen more master data entities with about forty operations, and the seed through services. Promotions alone took a domain module, three migrations and nine operations to reach their gate. Building the rest in the same context would have meant starting work this context could not carry to its gate. So the session stopped at a green commit and split at the promotions boundary, as "If a session cannot finish" allows. The split is recorded in ADR-0026 Amendments, A-103, and a new opener section, "B04d continued", in `docs/prompts/session-openers.md`. B04e now branches from B04d continued and reads its report.

## Built

| Area | What |
| --- | --- |
| Domain (`9da5d2d`) | `domain/pricing/promotions.ts`, under the existing 100 percent gate. It holds the line discount, the stacking rules, the cap that keeps a line at zero or above, promotion and coupon definitions, and the coupon verdict |
| Database (`5ef677b`) | `0016` adds the `PROMOTION` document type. `0017` adds four things: `mdm.promotion` with its lifecycle guard; targets frozen with their promotion (a definer function empties a draft); `mdm.coupon`, whose use count only a redemption moves; and the append-only `mdm.coupon_redemption`. The redemption's trigger locks the promotion, then the coupon. It refuses a use beyond the coupon, promotion or per-customer limit, or a second use by one document (SQLSTATE HK006) |
| Application and interface (`e344964`) | `Promotions` covers create, update with optimistic locking, submit (always 202, `PROMOTION_ACTIVATION`) and end. It is also the approval handler: it activates no earlier than approval and publishes `mdm.PromotionActivated` and `mdm.PromotionEnded` to the outbox. It also covers coupons, the public `validateCoupon`, and `redeemIn` and `releaseIn` for the selling modules. `resolvePrices` now records each line's discounts. `0018` adds the permissions and the approval policy. Audit runs on every write |
| Docs (`cbee3d7`, `bc2e824`) | ADR-0040, `docs/data-model/mdm.md`, the MDM card, `docs/DOMAIN_MODEL.md` events, `docs/API.md` (Pricing, error codes), the contract changelog, the split |

## Decisions

- **ADR-0040** (proposed): promotions and coupons as built, where ADR-0004 left a choice. The discount comes from the line extended at list. Stacking is one promotion per group, the larger; an exclusive one applies alone, with a cap and ties broken by code. Basket promotions (bundle, free delivery, order) are evaluated by the cart and order. A promotion activates no earlier than its approval. A trigger holds the coupon limit under row locks; callers take `couponLockKey(code)` so redemptions queue instead of retrying. The public coupon check reveals no customer.

## Contract changes

**1.6.0. Additive, with one relaxation on a public operation** (`docs/CONTRACT_CHANGELOG.md`). Nine operations now answer from the real API: `listPromotions`, `createPromotion`, `getPromotion`, `updatePromotion`, `submitPromotion`, `endPromotion`, `listCoupons`, `createCoupon` and `validateCoupon`. That makes 43 from code and 557 planned. `resolvePrices` fills `promotions`. Three new error codes: `PROMOTION_INVALID`, `COUPON_INVALID` and `COUPON_UNAVAILABLE`. `validateCoupon` drops the optional customer session and optional CSRF header that the planned contract offered: it is public. Clients sending either are not refused. No existing field, schema or response changed shape, and nothing a client sends became required.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 stock valuation at cost | Not this phase: stock is B5 |
| CR-003 unit display precision | **Moved to B04d continued**, with units of measure |
| CR-004 sign-in gaps | Not this phase: point 3 is scheduled for B04e, as B04 continued left it |
| CR-005 named empty examples | **Declined again**, as in B4. The frontend is paused, and the conversion is best done in one scripted pass when it resumes. The nine new list and get fragments keep the planned single example |
| CR-006 TOTP enrolment | Not this phase; point 2 shipped in 1.4.0 |
| CR-007 machine-readable step-up | Already in the contract (`x-requires-step-up`). No new step-up operation this phase: `mdm.promotion.approve` is checked at approval (B04e's `approveRequest`) |
| CR-008 repeated example ids | Answered in an earlier version |

## Deferred

- To **B04d continued**: the rest of master data, each write with a wrong-role refusal (categories, units with CR-003, species, grades, weight bands, customers and addresses, tiers, suppliers, branches, locations, payment methods, delivery zones, reason codes, `assignCustomerPriceList`, `updateProduct`, price list listings). Also the MDM seed through services, including tax scheme version 1 drafted by the seeded Accountant and approved by the seeded Owner, and seeded promotions.
- To **B04e**: imports and exports (FR-MDM-019, FR-MDM-020), which need the file store; `approveRequest` and `rejectRequest`, which a screen needs to approve a promotion. Until then approvals are decided through `Approvals.decide`, as the tests do.
- To **B7 and B9a**: evaluating bundle, free-delivery and order-level promotions on a basket, and redeeming the coupon with the order (`Promotions.redeemIn`). Also posting each discount to account 4220 (B8 and B9a).
- To the backlog: tier-targeted promotions (BL-044).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 412 passed. `src/modules/mdm/domain/pricing/**` stays at 100 percent on all four measures, promotions included |
| Integration | 298 passed. New: `promotion-schema` (26, every rule of 0017, and the 101-over-20-connections race) and `promotions` (13, the gate through the API and `redeemIn`). The handler walk covers all 43 routes |
| Contract | 31 passed. `pnpm contract:generate` unchanged after regeneration (43 from code, 557 planned). Redocly lint clean |
| Coverage, merged | 710 passed; 92.17 percent statements, 83.68 percent branches (gate 80); every `fullCoverage` gate held |
| Lint, type check | Clean |
| End to end | Not run locally; CI's fresh-clone job runs it |

## Gate

**Promotions apply only to tier, channel and base prices and stack by their rules, and a coupon limited to 100 refuses the 101st under 20 concurrent redemptions without exceeding 100: passed.** Proven by running these tests, exact pesewas each time:

- **Two in one stack group:** 5 and 8 percent on ten broilers at GHS 180.00 (180,000 pesewas at list). Only the 8 percent applies: 14,400 (`promotions.integration.spec.ts`; also in `promotions.spec.ts`).
- **An exclusive 10 percent and a 5 percent in another group:** only the exclusive one applies, 18,000. Once it ends, the 5 percent applies alone, 9,000.
- **A contract price:** the caterer's `CUSTOMER` list price of 17,000 a head takes no promotion. Tier, channel and base prices do.
- **The coupon limit:** 101 redemptions by 20 concurrent serializable callers through `Promotions.redeemIn`, against a coupon limited to 100. Exactly 100 succeed and the 101st is `COUPON_UNAVAILABLE` `LIMIT_REACHED`; `used_count` is 100 and the ledger holds 100 rows. The same race at the database alone (20 connections, read committed, no caller lock) also commits exactly 100.
- **Also covered:** a maker refused as checker (`MAKER_CANNOT_CHECK`). Wrong roles refused: Sales and the Cashier cannot create, the Cashier cannot read, and Sales cannot submit or add coupons. Also tested: the per-customer limit at redemption, and a release that frees a use.

**Not this session's gate (moved to B04d continued):** "every master data write refuses the wrong role" and "the MDM seed, tax scheme included, written through services, with `calculateTax` answering on a fresh setup".

**CI:** the runs on the final head commit are listed in the pull request and in the session's closing message, with their ids and events, as CLAUDE.md step 6 requires. The push run on `e344964` (the API slice) was `43661558276`, success.

## Security review (the parts this change touches)

- Authorisation is checked in every handler: `mdm.promotion.read`, `.create` and `.update`; the checker holds `mdm.promotion.approve` (step-up). Wrong-role refusals are tested, and so is the handler walk.
- Maker-checker: the maker is refused as checker of their own promotion.
- Abuse case "coupon reuse beyond its limit by concurrent requests" (threat model, T): the control is the trigger under row locks, tested with 20 concurrent connections. The redemption ledger is append-only for every role, so a daily report can reconcile `used_count` against it.
- `validateCoupon` is public: it is rate-limited by address, says nothing about any customer, and writes nothing.
- SQL is parameterised. The one new definer function has a fixed `search_path` and empties only a draft's targets.

## Notes for the frontend track

- A discount is its own line under the price (`promotions[]` on each resolved line). Never compute it.
- `submitPromotion` always answers 202; nothing is active until a second user approves.
- `validateCoupon` needs no session. Show `reason` as the answer (`NOT_FOUND`, `EXPIRED`, `LIMIT_REACHED`, `NOT_APPLICABLE`); the per-customer limit shows only at checkout.

## Next session

B04d continued. The opener is in `docs/prompts/session-openers.md`, section "B04d continued":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04d-master-data-promotions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the MDM requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/mdm.md, the MDM card in docs/MODULE_BOUNDARIES.md, ADR-0036, ADR-0039 and ADR-0040.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day
floor (A-076). Copy the B3 Product slice's shape for every endpoint, with the fragment moved from the
planned file (scripts/contract/move-to-code.ts), and the promotion slice's shape (B04d) for lists,
updates with a version and maker-checker documents.
Then execute B04d continued only, on branch b04d-continued-master-data, branched from
b04d-master-data-promotions: the rest of master data (categories, units of measure with CR-003's
displayDecimals, species, grades, weight bands, customers and addresses, tiers, suppliers, branches,
locations, payment methods, delivery zones, reason codes, assignCustomerPriceList, updateProduct, the
price list listings), each write with a wrong-role refusal; and the MDM seed through the services (A-085),
including tax scheme version 1 with the ADR-0020 seed matrix drafted by the seeded Accountant and approved
by the seeded Owner, keeping src/seed/reference-pricing.ts as the price definition, and seeded promotions
through Promotions. Imports and exports (FR-MDM-019, FR-MDM-020) need the file store, which is B04e's:
build them there or record them as deferred. Write the failing tests first for every money and permission
rule. Stop at the gate, write docs/sessions/B04d-continued-master-data.md, push, and open a stacked pull
request against b04d-master-data-promotions.
```
