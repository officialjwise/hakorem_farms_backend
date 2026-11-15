# B06u: units of measure and their conversions

Date: 2026-11-15 · Branch `b06u-uom-conversions`, from `main` (`b08a3b0`) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-163 | **How FR-MDM-003 is built, taking the most conservative reading.** (a) One alternative unit is `numerator / denominator` base units, two `bigint`s, no stored decimal. "Exact to three places" means the lowest-terms denominator divides 1,000. A 50 kg bag is 50/1 and a 500 g pack is 1/2. A third (1/3, or 0.3333333 sent as 3333333/10000000) is refused. The server reduces a fraction it is sent (250/2000 becomes 1/8). A converted quantity that would need a fourth decimal place is refused, never rounded. (b) Only a `COUNTABLE` product converts, from a `COUNT` unit other than its base unit, to its base unit. Catch-weight meat never converts (A-157), nor does a serialised animal or a service. FR-MDM-003's "15 kg pack at 15.000" is proved as arithmetic in the unit test, not as a conversion a meat product may hold. (c) A conversion is never edited: to change a factor, archive the conversion and make a new one. So the table has an `id` key and a partial unique index among live rows, not the data model's (product, from, to) primary key. (d) The operations are `listUomConversions`, `createUomConversion` and `archiveUomConversion`, as a separate list rather than a field on `Uom` or `Product`. The writes use two new permissions held by the Owner and the Manager. Each write publishes `mdm.ProductChanged` (`uomConversions`). (e) Other modules convert only through `MasterDataRefs.toBaseIn`. (f) The seed gives the two feeds a 50 kg and a 25 kg bag, and cabbages a crate of 24. | Owner |

**Needs the owner's approval:**
- Conversions for countable products only. This means no "pack" unit on catch-weight meat, and FR-MDM-003's 15 kg pack example is read as arithmetic.
- No in-place edit: a new factor means archive the old conversion, then make a new one.
- Owner and Manager only, with no second approver. A wrong factor is not yet used by any stock flow (see the security review).

**I found no ADR conflict.** Every decision here is reversible and is recorded as an assumption. There is no new ADR and no new dependency. ADR-0047, ADR-0051 and ADR-0052 are untouched. The one change to a dictionary shape (an `id` key instead of the planned composite key) is recorded in `docs/data-model/mdm.md` and A-163 (c).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B06u (`b06u-uom-conversions`, from `main`).
2. **Scope:**
   - `mdm.product_uom_conversion`, with numerator and denominator and the exact-factor rule in the database.
   - FR-MDM-003's unit test.
   - List and manage operations, with wrong-role refusals.
   - Reads by other modules through `MasterDataRefs`.
3. **Gate:**
   - Alternative units convert exactly.
   - FR-MDM-003's unit test passes.
   - The database refuses an inexact factor.
   - The conversions list answers in the contract.
   - Every write refuses the wrong role.

## Contract changes

**Version 1.27.0, minor and additive. No existing schema, field, parameter or enumeration value changed; only `Uom`'s description was reworded.** The contract now has 261 operations from code, 369 planned and 630 published.
- **New operations:**
  - `listUomConversions` (`GET /uom-conversions`, `mdm.product.read`; filters `productId` and `includeArchived`).
  - `createUomConversion` (`POST /uom-conversions`, `mdm.uom_conversion.create`).
  - `archiveUomConversion` (`POST /uom-conversions/{id}/archive`, `mdm.uom_conversion.archive`).
- **New schemas:** `UomConversion`, `UomConversionPage`, `UomConversionCreate`.
- **New error code:** 422 `UOM_CONVERSION_INVALID`, with the reasons `INEXACT_FACTOR`, `TOO_LARGE`, `NOT_COUNTABLE`, `BASE_UNIT` and `NOT_COUNTED`.
- The changelog entry and the cold-read summary are written. Redocly lint is clean, and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0090:** `mdm.product_uom_conversion` (MASTER), with these rules: `ck_uom_conversion_exact` (`1000 % denominator = 0 AND gcd(numerator, denominator) = 1`); `ck_uom_conversion_numerator` (at most 10^9); `mdm.uom_conversion_guard` (countable product and its base unit only: HK010 `ck_uom_conversion_product`; a counted unit only: `ck_uom_conversion_unit`; never changes except to be archived: HK004); and `uq_uom_conversion_live`. No DELETE for `hk_app`.<br>**0091, 0092:** the permissions `mdm.uom_conversion.create` and `mdm.uom_conversion.archive`, granted to the Owner and the Manager. |
| MDM domain (100 percent gate) | `unit-conversion.ts`: `exactFactor`, `factorText`, `toBase`, `fromBase`, `judgeConversion`. The spec was written first and seen red (missing module). |
| MDM application | `UomConversions` (list, create, archive): authorise first, idempotency key as the first write, serializable writes, an audit with before and after, and `mdm.ProductChanged`. Also `MasterDataRefs.toBaseIn` (refusals `NO_PRODUCT`, `NO_CONVERSION`, `INEXACT_QUANTITY`). |
| MDM infrastructure and interface | `PgUomConversionStore`; `MasterDataRefsStore.uomFactor`; `UomConversionsController` with three fragments; the strict zod schemas (whole numbers only). |
| Seed | `farm-mdm-units.ts`, run after the LIV seed: FEED-BRL-GROWER at 50 kg a BAG, FEED-GOAT-CONC at 25 kg a BAG, PRD-CABBAGE-HEAD at 24 to a CRATE. |
| Docs | <ul><li>A-163; A-157 marked built.</li><li>`docs/data-model/mdm.md` and the `DATA_MODEL.md` rules table.</li><li>FR-MDM-003's trigger line and its traceability row.</li><li>`docs/API.md` (the B06u section and the error code).</li><li>The MDM card in `MODULE_BOUNDARIES.md`.</li><li>ADR-0026 Amendments.</li><li>The changelog.</li><li>The openers: the B7 and B9a lines that name `toBaseIn`, and the table row.</li></ul> |

## Contract requests

The frontend's `main` lists CR-001 to CR-019 (fetched 2026-11-15).
- **CR-011** (unit conversions, and a way to add one): **implemented.**
  - Units stay seeded and read only.
  - A conversion is represented as a `UomConversion`, an exact numerator and denominator with its `factor`. It is listed by the new `listUomConversions` and managed by `createUomConversion` and `archiveUomConversion`.
  - CR-011's two examples: a crate of 30 eggs is a conversion only on a product counted per egg (base `UNIT`). Today's seeded egg products are counted in `CRATE`. A meat pack's nominal kilograms are **never** a conversion: `nominalPackKg` stays an estimate, and the weighed kilograms are charged.
- **CR-003**: answered earlier (1.7.0, 1.16.0). `displayDecimals` is unchanged.
- **CR-019** (server-side sort): **declined here** because it is outside this phase's scope. It stays parked as BL-057 for the owner to place.
- **CR-005**: standing decline.
- The rest were answered in earlier phases. Nothing else in the file concerns units.

## Security review (hakorem-security-review)

- **Boundary:** TB2, the authenticated back office.
- **Authorisation:**
  - Every handler authorises first in the application layer, deny by default.
  - The two new permissions are seeded by 0091 and granted only by 0092.
  - The handler walk now covers the three routes. A staff user with no grant gets 403 on each.
  - The integration test refuses the Accountant, Storekeeper, Cashier, Sales, Farm hand, Driver and Investor on both writes, and the Investor on the list.
- **Input:**
  - The bodies are strict zod schemas: whole numbers between 1 and 10^12, a unit pattern and a uuid.
  - A float or a string is 400.
  - All queries are parameterised.
- **Database:** MASTER grants (no DELETE), and immutability by trigger.
- **Audit:** create and archive carry before and after.
- **Not applicable:** identity, sessions and browser (no change to the existing console session handling), money paths, webhooks, uploads, exports and personal data. Conversions hold no personal or restricted data and no money.
- **Abuse path considered:** a Manager enters a wrong factor (a 500 kg bag) so that a later purchase overstates kilograms received. No flow converts a quantity yet, so nothing can be misstated today. The factor is immutable and audited, and a stale factor stays readable. **For B7:** when a purchase line first converts, that phase should judge whether this needs a threat model row and an exception report item. The three-way match compares quantities in the base unit.

## Deferred

- **B7:** the first purchase or cart line in an alternative unit, converted through `MasterDataRefs.toBaseIn` (the opener says so), and the abuse-path judgement above.
- **B9a:** order lines in an alternative unit, through the same door (its opener already says so).
- **Owner:** CR-019 (BL-057).

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **891 passed** (13 new in `mdm/domain/unit-conversion.spec.ts`, which includes FR-MDM-003's named test `converts packs and crates exactly and refuses inexact factors`). |
| Integration | **839 passed**. New: `mdm/uom-conversions` (17). Updated: the handler walk and the seed unit kinds. |
| Coverage, merged | 1,730 passed. Statements 93.74, branches 83.83 percent (gate 80). Every 100 percent gate holds, the new `src/modules/mdm/domain/unit-conversion.ts` among them. |
| Contract | **67 passed**. New: `b6u/uom-conversions.contract.spec.ts` (2). The drift counts are now 630 and 261; the request-schema map gains the two writes. |
| Lint, type check, Redocly, `contract:generate --check` | Clean |
| End to end | CI (not run locally). |

**Test first, honestly:**
- `unit-conversion.spec.ts` was red first (missing module).
- `uom-conversions.integration.spec.ts` was written before the application layer. It was seen red: 15 of 17 failed, and the 2 that passed are the database tests of migration 0090, which already existed. It then passed first time.
- The first full run failed in three places, each a list that a new route or seed unit has to join: the handler walk's route list and its request bodies, and the seed's unit kinds. I joined them and nothing was skipped.
- I saw no flaky test.

## Gate

**Passed.** Each point was proved by a test on this machine:
- **Exact conversion:**
  - 2 packs at 15/1 convert to 30.000, and 3 crates of 30 convert to 90.000 (unit).
  - Through `MasterDataRefs.toBaseIn`: 3 crates convert to 90.000 eggs, 4 bags of 25 kg to 100.000 kg, and the base unit passes through.
  - 0.001 of a 1/8 pack is refused (`INEXACT_QUANTITY`), not rounded.
- **FR-MDM-003's unit test** passes under its own name.
- **The database refuses an inexact factor:** a direct insert of 1/3, of 3333333/10000000, of the unreduced 60/2, or of 0 fails with 23514. A catch-weight pack, a goat, a target other than the base unit and a weighed alternative unit fail with HK010. Changing a factor or an archived row fails with HK004, and DELETE fails with 42501.
- **The list answers in the contract:** `listUomConversions` on the seeded farm matches `UomConversionPage` and lists exactly the three seeded conversions, counted by hand. Create, archive and the 422 envelope match their schemas.
- **Every write refuses the wrong role:** seven roles get 403 on both writes and no row is written. The Owner and the Manager succeed. The handler walk refuses a user with no grant.

## Notes for the frontend track

- The units screen can now show a product's conversions (`listUomConversions?productId=`) and, for the Owner and Manager, add or archive them.
- Show `factor`, and send whole numbers.
- `UOM_CONVERSION_INVALID` names its reason in `details[].code`.
- Never offer a conversion on catch-weight meat.
- Units themselves stay read only.

## CI

The code commits were pushed together, so CI ran only on their head, `e6849bc` (pull request #41). Both runs on it are green:
- run 43758157256, `push`, success;
- run 43758186997, `pull_request`, success.

This report's own commit is the final head. A commit cannot name its own runs, so they are listed in the session's closing message, together with `main`'s `push` run on the merge commit.

## Next session

B7, copied from `docs/prompts/session-openers.md` (updated by this phase: a line in another unit converts through `MasterDataRefs.toBaseIn`):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B06u-uom-conversions.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PUR and SHP requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/pur.md, shp.md and del.md, the PUR, SHP and DEL cards in docs/MODULE_BOUNDARIES.md,
FR-DEL-001, and ADR-0011, ADR-0019, ADR-0020, ADR-0026 (the online-store assignment and the delivery
split) and A-034 and SA-13 in docs/ASSUMPTIONS.md.
Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 only, on branch b07-procurement-suppliers: suppliers' terms and payout details with
the different-approver rule, requisitions, purchase orders with approval limits, supplier invoices with
the three-way match that blocks payment on disagreement, supplier payments, supplier scores, and, as
ADR-0026 proposes, the public catalogue, cart and checkout reservation with the 15-minute release
(order placement and online payment are B09a), and, as the ADR-0026 delivery split decides, the
del.delivery_slot table and slot generation, with checkout storing a chosen slot through its foreign key
but not enforcing capacity (capacity and cut-offs are B11). Use input levies from ADR-0020 and a reclaimable flag
on the supplier invoice lines. A purchase or cart line in a unit other than the product's base unit (feed
bought by the 50 kg bag) converts through MasterDataRefs.toBaseIn (B06u, A-163), never with a factor of its own.
Extend the seed.
Stop at the gate and write docs/sessions/B07-procurement-suppliers.md.
```
