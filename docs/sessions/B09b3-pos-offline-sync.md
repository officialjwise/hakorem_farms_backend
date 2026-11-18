# B09b continued 2: the offline pack, the offline settings, and a crate or a single egg at the counter

Date: 2026-11-18 · Branch `b09b3-pos-offline-sync`, from `main` (`5815c06`) · Lane A · Pull request #108 · Status: **phase split (A-277 (a)); the split gate passed.** Offline sync is **B09b continued 2b**, inserted before B09b continued 3.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-18)

| ID | What | Who confirms |
| --- | --- | --- |
| A-277 (a) | The split: the 5.2 settings, the offline pack and CR-038 at the counter now. Offline sync, the five conflict tests, the 500-sale test, `issueIn` at `occurred_at` with the age bound, the 300-second flag at sync, the shift rules offline and CR-038 at sync go to B09b continued 2b (accepted by the parent session). | Owner |
| A-277 (b) | Each offline setting is bounded at its documented default, so it can only make a till stricter: hours 1 to 8, queue 1 to 500, tolerance 30 to 300 seconds, unverified window 1 to 3 days. The three `pos.offline.*` keys are per branch. All are seeded farm-wide at their defaults. | Owner |
| A-277 (c) | The pack needs `pos.sale.create` at the till's branch and location, plus an enrolled device of the till that is not revoked. No open shift is needed, because the device opens a shift offline from it. | Owner |
| A-277 (d) | The pack prices the POS walk for a buyer with no account, for every product that is ACTIVE, stocked and priced. `validUntil` is `generatedAt` plus `pos.offline.max_hours`; it is not shortened to a price change scheduled inside that window. | Owner |
| A-277 (e) | The units a product is sold by are those a list in force prices it in and that it converts, with the sale unit first when it is priced. A unit that converts but has no price is not sold (a crate of cabbage). Meat is sold by the kilogram. A line that names no unit is in the first unit; a unit not sold is 400 `UNIT_NOT_SOLD`. | Owner |
| A-277 (f) | A unit's band is the engine's price for one of it, with no grade, weight or quantity break. So an animal has no single band (`priceBand` null, `quoteOnly` false), and `quoteOnly` is true only for an entry marked quote only. A product's band and `taxInclusive` are its first unit's. Pricing an animal offline is BL-080. | Owner, Accountant |
| A-277 (g) | The pack carries every `PRICE_OVERRIDE` reason and the `CASH_MOVEMENT` reasons `recordCashMovement` takes. It carries no `VOID` reason, because no sale is voided offline. | Owner |
| A-277 (h) | Offline tenders are the methods allowed offline other than mobile money. Mobile money is added only while the branch setting is on. | Owner |
| A-277 (i) | The policy's override limits are the caller's role limits, not what the shift has left. None is seeded, so both are 0. | Owner, Accountant |
| A-277 (j) | The pack lists every animal and lot with stock at the till's location. Each is `sellable` when it is not reserved beyond its stock, no hold covers it and it is not past its expiry. Each carries its grade and last weight and never a cost. | Owner |
| A-277 (k) | `openShift`, `recordCashMovement` and `completeCounterSale` read `sync.clock_tolerance_seconds`. As with every setting, a change can take up to 30 seconds to apply. | Owner |
| A-277 (l) | **LOUD.** A counter line that names no unit is in the first unit the product is sold by: eggs by the crate, as the operation always documented (the code sold one egg). A held line is priced the same way. A unit on a held line is BL-081. | Owner |
| A-277 (m) | Each issue of the pack is audited (`ISSUE_OFFLINE_PACK`: the device, the versions, the counts). | Owner |

**Contract 2.11.0.** No field was removed or retyped.
- New: `getOfflinePack` moves into code, with the new schema `OfflineSellingUnit`, the optional field `OfflineProduct.sellingUnits` (always sent) and the optional field `CounterSaleLine.uom`.
- **One behaviour of an implemented operation was corrected and declared LOUD.** A `completeCounterSale` line of the seeded eggs that names no unit is a crate (6,000), as the description and example always said. Before, the code sold it as one egg (220).
- `createReturn` gains one description sentence, added with the parent session's leave.

**No ADR conflict.** No ADR was written: every decision here is a reading recorded in A-277. ADR-0027 and ADR-0077 are untouched, because sync is B09b continued 2b. No ORD code changed. Lane B's files were not edited apart from the `createReturn.yaml` sentence the parent session allowed, in its own commit `ef1976e`.

Phase, scope and gate, as confirmed at the start (and split once the size was clear):
1. **Phase:** B09b continued 2 (`b09b3-pos-offline-sync`, from `main` at `5815c06`), lane A.
2. **Scope as built:** the settings of OFFLINE_SYNC 5.2, seeded; `getOfflinePack` with CR-031, CR-032 point 6 and CR-038's `sellingUnits`; CR-038 at the online counter.
3. **Gate of the split:** each of these is proved by SQL over the entries, versions, settings and stock:
   - The pack prices each unit by its own entry: a crate of the seeded eggs at 6,000 and a single egg at 220, never derived.
   - It names the versions, the tax cells, the stock, the methods, the reasons and the policy as the database holds them.
   - A crate and a single egg are sold at the counter at their own prices, with the stock issued in eggs.
   - A unit not sold is refused.
   - Every wrong caller is refused.

## Contract changes

**2.11.0, minor, LOUD for a counter line that names no unit.** The changelog entry and the cold-read line are written, above 2.10.0.
- `getOfflinePack` (`GET /registers/{id}/offline-pack`) moves into code. There are now 454 operations in code and 190 planned (644 in all). Its description says what it carries and its refusals. Its example now has a crate at 6,000 and a single egg at 220, the goat with no single band, and the beef pack sold by the kilogram. It drops the `VOID` reason, and `validUntil` is eight hours after `generatedAt`.
- `OfflineSellingUnit` (new): `uom`, `priceListEntryId`, `priceBand`, `quoteOnly`. `OfflineProduct.sellingUnits` is new; `priceBand` and `taxInclusive` now say they are the first unit's.
- `CounterSaleLine.uom` is new (also on the line of `OfflineSale`). A unit not sold is 400 `VALIDATION_FAILED` `UNIT_NOT_SOLD`.
- `createReturn` description: a line is returned in its sold unit and refunded at the price actually paid on that line, never the current price list. Part of a crate returned as single eggs comes in a later phase.
- Five setting keys are taken by `updateSetting` (not a contract shape; the changelog lists them).
- Checks: `contract:generate --check`, Redocly and the till contract test are clean. `versioning.ts` against `main` runs in the pull request's CI.

## Built

| Area | What |
| --- | --- |
| AUD | Five settings in the catalogue, the first boolean setting (`judgeSetting`), seeded by the seeded Owner through `SettingsAdmin` (`farmSeedOfflineSettings`). |
| MDM | `sellingUnits` and `defaultLineUom` (domain); `PricingService.sellingUnitsIn`; `TaxService.schemeInForceIn`; `MasterDataRefs.reasonCodesOfDomainsIn` and `livePaymentMethodsOfChannelIn`. `ListInForce` gains `versionId` and `taxInclusive`. All additive; nothing existing changed. |
| INV | `StockQueries.unitsStandingAtIn` (additive). |
| POS | `OfflinePacks` (`getOfflinePack`); `packValidUntil`; `withinTolerance` takes the tolerance. `CounterSales` takes and checks `uom` and defaults it. `HeldSales` prices in the default unit. `Shifts` and `CounterSales` read the tolerance setting. POS imports INV, as its card allows. |
| Seed | The five settings. |
| Docs | A-277, BL-080, BL-081, the changelog, API.md, the AUD, MDM, INV and POS cards, `data-model/pos.md`, OFFLINE_SYNC 5.1, abuse case 4, the B09b continued 2b opener and ADR-0026 Amendments, and the B09b continued 3 opener amended with the owner's drop-witness decisions. |

## The gate, proved by running it

**The offline pack (`test/integration/pos/offline-pack.integration.spec.ts`, 9 tests).**
- **Each unit priced by its own entry.** By SQL, the base list holds EGG-0003 at 6,000 for a crate and 220 for one egg. The pack's `sellingUnits` for it are exactly `[CRATE 6,000, EGG 220]`, each naming its own entry id. The product's band and entry are the crate's, and `taxInclusive` is the crate list's. The egg's price is not 6,000 / 30.
- **Every unit of every product,** looked up by the entry id the pack names, matches that entry's product, unit, list, floor, ceiling and basis. The sale unit is first wherever it is priced. The goat has no single band (PER_HEAD). The cabbage has no crate, though it converts from one. No product that is not ACTIVE or not stocked appears.
- **The rest, against the database:**
  - `validUntil` is `generatedAt` plus the seeded 8 hours.
  - The version ids equal the ACTIVE BASE and POS CHANNEL versions in force.
  - The tax scheme id and its cell count match.
  - The stock units equal, by identifier, every unit with on hand above 0 at the shop. Each has exactly 7 keys, and no cost or pool appears anywhere in the pack.
  - The methods equal the enabled POS methods.
  - The `PRICE_OVERRIDE` reasons equal the database's. The `CASH_MOVEMENT` reasons are exactly FLOAT_TOP_UP, FUEL_PAYOUT, OTHER_PAYOUT, SAFE_DROP and SUPPLIER_PAYOUT, and no other domain appears.
  - The policy is `{8, 500, [CASH], 0, 0}`, with `iam.role_limit` empty.
- **Audited once per issue,** with the device id and the versions it gave.
- **The settings drive the policy:**
  - The Owner sets 4 hours, 200 sales and unverified mobile money on for Dodowa. The pack is then valid for 4 hours, the queue is 200, and the offline methods are `[CASH, MOMO]`. Turning the setting off brings back `[CASH]`.
  - A looser value (9 hours) is 422 `SETTING_INVALID`.
  - With the tolerance set to 60 seconds, a shift opened 120 seconds back is `OPENED_AT_OUT_OF_WINDOW`, and one 59 seconds back opens.
- **Refused:**
  - the storekeeper and the accountant (403)
  - no device or an unknown credential (401 `DEVICE_CREDENTIAL_INVALID`)
  - a revoked device (403 `DEVICE_REVOKED`)
  - another till's device (403)
  - an anonymous caller (401)
  - a till that names nothing (404, with the error envelope only)

  Another branch's till is covered by the generated identifier walk, which picks the route up.

**A crate and a single egg at the counter (`test/integration/pos/counter-sale-units.integration.spec.ts`, 2 tests).**
- **The sale:**
  - Kofi sells 1 crate (`uom: CRATE`), 3 single eggs (`uom: EGG`) and 2 crates naming no unit.
  - By SQL, the entries are 6,000 and 220 and the crate converts at 30.
  - The total is **1 x 6,000 + 3 x 220 + 2 x 6,000 = 18,660**; cash 20,000 handed over gives change **1,340**.
  - The answer's lines are `[1.000 CRATE 6,000 6,000], [3.000 EGG 220 660], [2.000 CRATE 6,000 12,000]`.
- **Derived independently:**
  - The eggs issued are `sum(qty_base)` = **30 + 3 + 60 = 93**.
  - The cash payment is **18,660**.
  - Over the receipt's journals, 4020 is **-18,660** and 1200 is **+18,660**.
  - 5020 equals the issues' `sum(value_pesewas)`.
- **Refused, recording nothing** (the counts of orders, payments, movements, documents, journals and number allocations are unchanged), each 400 `VALIDATION_FAILED` `UNIT_NOT_SOLD` on `/lines/1/uom`:
  - a crate of cabbage: it converts at 24, but no list prices it
  - a kilogram of eggs
  - a crate of yams

  A lower-case unit is 400 as well.
- The existing counter sale and held sales specs pass unchanged, including the yams and cabbages, whose first unit is their base unit.

**The seed (`test/integration/platform/seed.integration.spec.ts`):** the five settings, each once, farm-wide, at its default and type, audited five times by the seeded Owner as the seed.

## Mutation checks (each applied alone, both new specs run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | A unit the product converts but no list prices is sold | red: 6 of 11 |
| M2 | A line naming no unit is in the base unit (the old behaviour) | red: 1 of 11 |
| M3 | Every unit priced from the sale unit's entry | red: 2 of 11 |
| M4 | Mobile money offered offline whatever the setting | red: 2 of 11 |
| M5 | The pack ignores `pos.offline.max_hours` | red: 1 of 11 |
| M6 | The pack skips the device check | red: 2 of 11 |
| M7 | Every `CASH_MOVEMENT` reason in the pack | red: 1 of 11 |
| M8 | `openShift` ignores the tolerance setting | red: 1 of 11 |
| M9 | A unit not sold is passed on unchecked | red: 1 of 11 |

## Test first, as it honestly happened

- **The settings catalogue:** the unit tests were written first and seen red (3 of 5) before the keys existed, then green.
- **`sellingUnits`:** its unit test was written with the code and was not seen red on its own. M1 and M3 above show the integration specs catch the rule.
- **The counter sale spec** was written first and seen red, 2 of 2: `uom` was refused as an unknown field (400 `UNKNOWN_FIELD`). It went green once the code took the unit.
- **The pack spec** was written before the route existed, but its first run failed in its own set-up (a revoke posted to the wrong id), so nothing past the set-up ran. The route was built before the set-up was fixed. Its next runs failed on test errors only (the audit table's name and its bytea `after`), and no assertion was weakened. The mutation checks are the proof that it holds the rules.
- **The full integration suite's first run:** 143 files, 1,778 of 1,779 passed. The one failure was the seed spec counting 17 seed units, where the new settings unit makes 18. The count was corrected, because the change is intended, and a test of the seeded settings was added. That spec then passed (23 tests).

## Decisions

- No ADR. Every reading is recorded in A-277.
- The split at the sub-domain boundary, recorded in ADR-0026 Amendments and in the new B09b continued 2b opener.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundaries:** TB3 (the POS device: the pack and the counter line) and TB2 (the settings administration).
- **SC-01:** `uom` must match `^[A-Z]{2,10}$`, and unknown fields are still 400.
- **SC-02:**
  - Authorised in the application layer at the till's branch and location, deny by default.
  - The device credential is checked after authorisation.
  - The wrong roles are refused, as is an anonymous caller.
  - A till that names nothing is 404 with the envelope only.
  - The route joins the handler walk (`getOfflinePack` is added to its list) and the generated identifier walk.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05:** entries are read as bigint and answered through `Money`; nothing is derived or rounded.
- **SC-07, SC-08:** the audit event carries ids and counts only.
- **SC-18:** no cost reaches the device, and a test checks it.
- **SC-24:** every issue and every settings change is audited, settings with step-up.
- **Findings:**
  - [fixed] The counter's egg default: a crate is now sold where one egg was.
  - [accepted, recorded] An animal has no single band in the pack (BL-080).
- **Abuse case 4:** offline tenders stay cash only, with mobile money offered only while the branch setting is on (off by default). The threat model row is updated.
- **Abuse case 3:** the pack's limits are the role limits, and none is seeded.
- **No new abuse path,** so no new exception item.
- **Not applicable, with reason:**
  - SC-09 to SC-11: cookies, CSRF and CORS are unchanged.
  - SC-12: no upload.
  - SC-13: no webhook.
  - SC-14: no external call.
  - SC-17: no maker-checker change.
  - SC-19: no outbound URL.
  - SC-20, SC-21: run by the CI scans.
  - SC-22, SC-23: no new table.

## Deferred

- **B09b continued 2b:** offline sync, ADR-0027's five conflict tests, the 500-sale test with the network disabled, `Billing.issueIn` at `occurred_at` with the age bound, the 300-second flag at sync, ADR-0077 offline, CR-038 at sync, CR-031's `grossPesewas`, and UAT scenario 6 as a dry run.
- **BL-080:** an animal priced offline from its grade and last weight.
- **BL-081:** a unit on a held sale's line.

## Contract requests

The frontend's `main` was first read at `37e5c98` and read again at `81525f1` (after its PR #30). Each request is identified by its content and named by its number at `81525f1`.
- **CR-031:** point 1 (`taxInclusive` from the price list) is built. Point 2 (`SyncResultItem.grossPesewas` and `currency`) is in the contract already and is answered by the sync in B09b continued 2b.
- **CR-032 point 6** (the pack's `CASH_MOVEMENT` reasons) is built. **Points 1 to 5:** B09b continued 3.
- **CR-038:** points 1 (`sellingUnits`) and 2 (`CounterSaleLine.uom` at the counter) are built. Re-pricing by the unit at sync is B09b continued 2b. Point 3 (`createReturn`'s description) is done with the parent session's leave.
- **CR-050** ("Who can witness a cash drop now", CR-045 at `37e5c98`): placed in B09b continued 3 with the owner's 2026-11-18 drop-witness decisions, written into that opener. Not built here.
- **CR-045 to CR-049** (quotes and wholesale, at `81525f1`): lane B's, not touched. **CR-039 to CR-044:** lane B's, as before. **CR-033 points 1 and 2:** B09b continued 4.
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit | 140 files, 1,652 tests passed. |
| Integration | Full suite: 143 files, 1,778 of 1,779 passed on the first run; the 1 failure was the seed-unit count, corrected as above. The seed spec (23 tests), the two new specs (11 tests) and the counter sale and held sales specs then passed. Nothing was re-run to turn red into green. |
| Contract | Full suite: 47 files, 126 tests passed, after the operation count was corrected (see CI). The new till contract test checks `OfflinePack`, `CounterSaleResult` with a crate and single eggs, and the refusals. |
| Coverage | The pricing engine was not changed; `sellingUnitsIn` calls it. The 100 percent gates are CI's. |
| Lint (boundaries, fixtures, placement, schema names), typecheck, Redocly, `contract:generate --check` | Clean. |
| End to end, setup, the image, the scans | Run in CI. |

## Gate

**Passed for the split:**
- The offline pack prices each unit by its own entry (a crate of the seeded eggs at 6,000 and a single egg at 220, by SQL, never derived), takes `taxInclusive` from the list, and carries the `CASH_MOVEMENT` reasons and the 5.2 settings as its policy.
- A crate and a single egg are sold at the counter at their own prices: 18,660 for a crate, three eggs and two crates, with 93 eggs issued, each figure by SQL.
- A unit the product is not sold by is refused.
- Every wrong caller is refused, and the checks are mutation-proved.

**The phase's own gate is not reached here.** "500 queued offline transactions sync exactly once, and ADR-0027's five conflict tests" is now B09b continued 2b's gate.

## Notes for the frontend track

- **2.11.0.** The pack has `sellingUnits` for each product: show each unit at its own `priceBand` and never compute one unit's price from another's. A goat has `priceBand` null: the pack cannot price it offline (BL-080).
- Send `uom` on a counter line for anything other than the first unit. **A line with no `uom` is now in the first unit (eggs: a crate).** A unit not in `sellingUnits` is 400 `UNIT_NOT_SOLD`.
- The pack is valid for `policy.maxOfflineHours` from `generatedAt`. Mobile money appears in `offlineTenderMethodIds` only while the branch allows it.
- The drop witness request (CR-050 on your main) is placed in B09b continued 3.

## CI

- **PR #107's re-run (recorded as the parent session asked):** main is at `5815c06` (PR #107, B09b continued 1c).
  - Push run **44262513227** on `226500d` first failed before any test ran: Docker Hub timed out pulling `testcontainers/ryuk` and the semgrep image. The owner allowed one re-run of the failed jobs for that outage only, and attempt 2 was green.
  - The pull_request run **44262520483** was green.
  - Main's push run **44267544924** on `5815c06` was green.
- **This phase, `8bff69d` (the code head, pull request #108): red.**
  - Push run **44276889823** failed, and so did pull_request run **44277049555**.
  - In both, the one failing job was the contract job (`responses against the contract`). Every other job was green: unit and integration with the coverage gate, lint and type check, the scans, setup, and the image.
  - The cause was mine: `openapi-drift.contract.spec.ts` counts the operations in code and planned (453 and 191). `getOfflinePack` moving into code makes them 454 and 190, and I had run only the till contract spec locally, not the whole contract suite.
  - The count was corrected in its own commit (`test(contract)`), and the full contract suite then passed locally (47 files, 126 tests).
  - Nothing was re-run: the fix is a new commit, and both runs on it are new runs.
- The runs on the head that adds this report are named in the closing message to the parent session, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B09b continued 2b, copied from `docs/prompts/session-openers.md` (added by this phase's split).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b3-pos-offline-sync.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0013, ADR-0015, ADR-0027, ADR-0077, A-273 and A-277 in docs/ASSUMPTIONS.md, and the abuse cases 4, 10 and 11 in
docs/security/THREAT_MODEL.md. Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it. Lane A (docs/prompts/session-openers.md, "Two lanes").

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 2b only, on branch b09b3b-pos-offline-sync, branched from main: offline sync
(syncOfflineSales, pos.sale_sync): exactly-once by client UUIDv7, the gap-free device counter and its gaps, provisional
references, occurred-at and recorded-at, cash-only tenders offline (the pack's offlineTenderMethodIds, A-277 (h)), the
stock exception instead of a refusal, price override bounds re-checked at sync, shift open and cash movements from the
queue, SyncResultItem.grossPesewas (null when nothing was recorded) and its currency (CR-031). Write the five conflict
tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone negative, sale in a locked period,
missing device counter) and the 500-transaction test with the network disabled, each figure derived independently by
SQL over the journal lines and stock movements, never from the function under test. Run scenario 6 of docs/UAT.md as a
dry run and record any difference.
The owner's addition (1) to A-200 (2026-11-16), test-first: an offline sale synced later is issued at its occurred_at,
the time it happened at the till, not the sync time. Extend Billing.issueIn additively to take that time for a synced
sale only, mark the document as synced from offline (a field the receipt and the document read show), and bound how old
an offline sale may be (a setting, conservative default, recorded in ASSUMPTIONS.md): a sale outside the bound is still
recorded, never refused (a synced sale is always recorded), and reaches the exception report; a sale whose period has
since locked posts on the first open date, flagged, keeping its occurred_at (ADR-0027 point 6).
Nothing in sync refuses a sale: a stock conflict, an old sale, a locked period, a till clock outside the tolerance and
(if that path exists yet) a reused receipt token each records the sale and raises an exception. Test each; a mutation
that turns a conflict into a refusal must turn a test red.
ADR-0077 holds offline too: cash from the queue goes only onto the shift it belongs to, on its own till; a queued sale
for a closed or force-closed shift is recorded and flagged per the existing rules (OFFLINE_SYNC 9.4, FR-POS-014,
FR-POS-020), never silently moved to another shift. Where the existing rules do not settle a case, take the
conservative option and record it.
CR-038 at sync (owner, 2026-11-17): an offline sale's line names its unit (`CounterSaleLine.uom`, built in B09b
continued 2: absent means the first unit the product is sold by, A-277 (e)); convert to the base unit for stock
through MasterDataRefs.toBaseIn and re-price by that unit's own entry at sync, test-first with exact pesewas at a crate
and a single egg of the seeded eggs (EGG-0003, base unit EGG, 30 to the crate, A-303). A unit the product is not sold by
is recorded and flagged at sync, never refused (a synced sale is always recorded).
The clock tolerance (owner, 2026-11-17, A-273 (g)): `sync.clock_tolerance_seconds` (seeded at 300 in B09b continued 2,
A-277 (k)). A synced sale whose till time is outside it is recorded and flagged (the sale and the exception report's
source show it), never refused. Test it at 301 seconds either way.
The owner asked for extra care on the till: prove every cash figure, every stock figure and the 500-transaction totals
with exact integers derived independently by SQL over journal lines and stock movements.
Stop at the gate and write docs/sessions/B09b3b-pos-offline-sync.md.
```
