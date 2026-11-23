# B09b continued 4c: the animal's price in the pack

Date: 2026-11-23 · Branch `b09b5c-pos-animal-price`, from `main` (`f413ecc`) · Lane A · Status: **gate passed locally; the pull request merges only when every run on its head is green (below).** This closes B9b's splits; the next phase is B09c.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made or decided this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-286 (a) | **What the pack prices:** every animal (SERIAL unit) standing at the till that may be sold now, through MDM's `PricingService.resolveIn` exactly as the counter prices it for a buyer with no account (POS, the till's branch, the pack's time), one head in the first unit its product is sold by, from the animal's own `gradeId` and `lastWeightKg` as INV holds them (what the server prices a synced line from). Never derived. A lot carries no price of its own. | Owner |
| A-286 (b) | **Priceless, and why:** `priceBand` and `priceListEntryId` null, `unpricedReason` the engine's own (`MISSING_GRADE_OR_WEIGHT`, `NO_RULE`, `QUOTE_ONLY`) or `NOT_SELLABLE`. With the seeded lists a goat with no grade is priced by its weight band alone (the lists have such entries); a grade is needed only where a list prices by grade alone. | Owner |
| A-286 (c) | **The weight's date and source:** `lastWeighedAt` is INV's; `lastWeightSource` is LIV's latest weighing's when that weighing is the weight priced (same kilograms), else null. POS now imports LIV (layer 6) for the new read-only `Weighing.latestIn`. | Owner |
| A-286 (d) | **The difference at sync:** the price charged posts; the server prices from the weight and grade the line carries (re-weighed on the till's scale), else the animal's latest it holds at sync, in whatever band that falls (CR-052's question); the difference is the variance on 4210, raised as `PRICE_OVERRIDE` by A-278 (h) as amended. **LOUD:** a line whose price differs and names no reason (the till charged what its pack said) is recorded under the server's new reason `OFFLINE_PACK_PRICE` (migration 0306), never offered to a cashier; before, such a sale was refused `REJECTED_INTEGRITY`, against ADR-0027 point 2. | Owner, accountant |
| A-286 (e) | **The flag's facts** add `pricedFrom` (weight, grade, weight source). A weight recorded after the sale but before its sync is the server's latest and is used. | Owner |
| A-286 (f) | **Online,** `OFFLINE_PACK_PRICE` is an ordinary `PRICE_OVERRIDE` reason under every online rule; BL-107 asks whether ORD should refuse it online (lane B's module). | Owner |
| A-285 (f) | **Decided by the owner on 2026-11-23, amended and built here:** "Mask the TIN in the counter sale's stored response to its last four characters. It appears in full only on the invoice document." The counter sale's answer, its stored idempotency copy and every replay show `receipt.customerTin` masked; the document and its archived render keep it in full. LOUD in 2.28.0. | Owner (decided) |

**For the parent session to schedule:** nothing new. B09c is next (its opener, unchanged, below). CR-059 to CR-062 stay B12's; CR-057 point 1 still needs both lanes; BL-107 needs lane B's leave in ORD.

**ADR conflicts: none.** ADR-0004's walk is used unchanged through MDM's public `resolveIn`; ADR-0027 point 2 is now honoured for a difference without a reason. **No new ADR** (ADR-0084 unused). No phase split.

**Contract 2.28.0 (above main's 2.27.0, lane B's B11 continued), additive, LOUD on two behaviours:** `OfflineStockUnit` gains `priceBand`, `priceListEntryId`, `unpricedReason`, `lastWeighedAt` and `lastWeightSource` (optional, always sent). **LOUD:** `syncOfflineSales` records a price difference the till gave no reason for under `OFFLINE_PACK_PRICE` where it refused the sale; `completeCounterSale`'s `receipt.customerTin` is masked to its last four characters where it was in full. No existing field removed, retyped or made required on a request.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 4c (`b09b5c-pos-animal-price`, from `main` `f413ecc`), lane A.
2. **Scope:** CR-052 with the owner's clarification on prices; then, at the coordinator's instruction mid-phase, the owner's decision on A-285 (f).
3. **Gate:** each sellable animal priced in the pack from its own latest weight and grade by the engine, with the weight's date and source; an animal with no weight or no grade priceless and answered as such; a weight changed since the pack posting the price charged, the server's price from the latest weight worked out only to compare, and the difference flagged REVIEW within the cashier's limit and URGENT beyond it, in exact pesewas by SQL over the order line and the journal lines.

## Built

| Area | What |
| --- | --- |
| Data | `0306_mdm_offline_pack_price_reason`: the `PRICE_OVERRIDE` reason `OFFLINE_PACK_PRICE` (lookup row, no note). No table or column changes. |
| LIV (shared, additive) | `Weighing.latestIn`: each unit's latest weighing (weight, source, time), read only. |
| POS | `domain/animal-price.ts` (100 percent gate): `animalPrice`, `reasonAtSync`, `OFFLINE_PACK_PRICE`.<br>`OfflinePacks` resolves every sellable animal's own band in one `resolveIn` call and gives its weight's date and source; the server's reason is filtered out of the pack's reasons; the issue's audit counts `pricedAnimals`.<br>`OfflineSync` defaults a line's reason to `OFFLINE_PACK_PRICE` (ORD keeps it only on a line with a variance) and adds `pricedFrom` to the override flag (INV's `StockUnits.factsIn`, LIV's `Weighing.latestIn`).<br>`CounterSales` answers the receipt with its TIN masked (A-285 (f)). |
| Contract | 2.28.0 (above); `getOfflinePack`'s example prices the goats and shows a priceless and an unsellable one; `syncOfflineSales` answers CR-052's question; `completeCounterSale` and `CounterSaleBuyer` say where the TIN is in full. |
| Docs | A-286, A-285 (f) decided; BL-080 marked built, BL-107; abuse case 39; the POS and LIV cards; OFFLINE_SYNC 5.1; API.md; `data-model/mdm.md` (the reason); DATA_CLASSIFICATION E-1; the changelog. |

## The gate, proved by running it

**Unit:** `src/modules/pos/domain/animal-price.spec.ts` (5 tests), written first and seen red (no module), then green at 100 percent statements, branches, functions and lines.

**Integration:** `test/integration/pos/offline-animal-price.integration.spec.ts` (8 tests), written first and seen red (7 of 8 failing: the pack had no price; the sale with no reason was refused). The cashier's limits are 30,000 a line and 10,000,000 a shift; the seeded base list prices goats and sheep by weight band.
- **The pack**, each figure compared with the entry the database holds:
  - G-0142 (29.000 kg) GOAT-L 120,000 in 90,000 to 150,000; G-0143, G-0145 GOAT-M 65,000; G-0144 graded A at 26.100 kg GOAT-M A 72,000 in 45,000 to 90,000; S-0032 SHEEP-S 40,000. Each with its entry id, `lastWeighedAt` equal to INV's and `lastWeightSource` `SCALE`, the source of its latest weighing.
  - A goat received with no weight: priceless, `MISSING_GRADE_OR_WEIGHT`. A ram re-weighed at 70.000 kg: priceless, `QUOTE_ONLY`. The broiler lot: no price of its own.
- **Weights changed after the pack**, each sale synced, every figure by SQL over `ord.sales_order_line`, `bil.billing_document` and the receipt's journal lines:
  - **G-0144 re-weighed 30.500 kg (GOAT-L A), sold at the pack's 72,000 with no reason:** `APPLIED_WITH_EXCEPTION`. Line: resolved 130,000, floor stretched to 72,000, ceiling 150,000, agreed 72,000, variance 58,000 BELOW, reason `OFFLINE_PACK_PRICE`, total 72,000, the GOAT-L A entry. Receipt 72,000; 1200 +72,000; 4210 +58,000; credits 130,000; balanced. Flag URGENT, 58,000, `OUTSIDE_BAND`, `pricedFrom` 30.500 kg, grade A, `SCALE`.
  - **G-0142 down to 27.500 kg (GOAT-M), sold at 90,000 agreed inside the pack's band (`REGULAR_CUSTOMER`):** `APPLIED`. Resolved 65,000, band 40,000 to 90,000, variance 25,000 ABOVE; receipt 90,000; 1200 +90,000; 4210 −25,000; credits 90,000. Flag **REVIEW**, `WITHIN_CASHIER_LIMIT`.
  - **S-0032 up to 31.000 kg (SHEEP-M), sold at 70,000:** resolved 110,000, variance 40,000 BELOW, inside the band; 4210 +40,000; credits 110,000. Flag **URGENT**, `BEYOND_ROLE_LIMIT` (30,000), `NO_SUPERVISOR_PIN`.
  - **G-0143 re-weighed on the till's scale at the sale, 28.400 kg (`weightKg`, `SCALE` on the line), sold at the pack's 65,000:** priced by the server from that weight, GOAT-L 120,000; variance 55,000 BELOW, reason `OFFLINE_PACK_PRICE`; the line keeps 28.400 `SCALE`; 4210 +55,000; credits 120,000. URGENT, `OUTSIDE_BAND`.
  - **G-0145, weight unchanged:** 65,000, `APPLIED`, no exception, no variance.

**A-285 (f):** `test/integration/pos/buyer-tin.integration.spec.ts` (8 tests, one new), changed first and seen red (5 failing: the answer and the stored copy carried the TIN in full). Now, by SQL: the answer's `receipt.customerTin` is `*******0042`; `platform.idempotency_key.response_body` holds only the masked form; a replay answers byte for byte the first answer; `bil.billing_document.customer_tin` and the archived PDF keep it in full; the Ghana Card PIN is masked the same way; the TIN is in no audit row unmasked, no outbox message, no order, no sync row, no idempotency answer, and not in the sync result.

## Mutations

Each applied alone, its spec run, and the source restored byte for byte (`cmp`).

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `OfflineSync` passes the till's reason as it came (no `OFFLINE_PACK_PRICE`) | red: 2 of 8 (the two sales with no reason are refused) |
| M2 | the pack prices an animal without its weight | red: 5 of 8 |
| M3 | the pack offers `OFFLINE_PACK_PRICE` to the cashier | red: 1 of 10 (`offline-pack`) |

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since the last report)

- **CR-052: implemented** (2.28.0, A-286). Its question is answered in `syncOfflineSales`: an animal re-weighed at the sale is priced by the server from that weight, in whatever band it falls; the price charged stands and the difference is raised.
- **CR-033 point 3** (the SMS and `receiptMessage`): B11's, as before.
- **CR-059 to CR-062:** RPT's, B12.
- **CR-057 point 1:** both lanes, still to schedule.
- Everything else was answered in earlier phases.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB3 (the till: the pack and the sync), TB2 (the counter sale's answer), the database.
- **Authorisation:** unchanged and re-run. The pack is read by `pos.sale.create` at the till's branch and location from an enrolled device; the sync by the shift's cashier or a recovering manager. No new operation or permission. The pack's new prices are INTERNAL, as every price in it is.
- **Prices in the offline pack** (abuse cases 3, 4, 10, 17 and new 39): the pack carries only prices the engine resolved for that animal, valid for `pos.offline.max_hours` at most, each issue audited with the count of animals priced; the server prices every synced line again; the price charged posts and what the cash count expects is the price charged (abuse case 17); every difference is on the exception report's source with what the server priced from, URGENT outside the band or beyond the cashier's limit; a difference the till gave no reason for is no longer a refusal that hides a sale. Tested in `offline-animal-price`.
- **No cost reaches the device** (the pack test's no-cost check still passes with the new fields).
- **The TIN** (DC-25, E-1): now in full only on the document and its archive (A-285 (f)); masked in the counter sale's answer, its stored copy, BIL's audit and a refused sale's evidence; in no event, order, sync row or sync answer (tested by SQL).
- **Database:** one lookup row; the grants schema test is unchanged.
- **Findings:** [accepted, recorded] `OFFLINE_PACK_PRICE` usable online as a label (A-286 (f), BL-107); [accepted, recorded] a weight recorded between the sale and its sync is used (A-286 (e)).
- **Not applicable, with reason:** no upload, webhook, export, login, payment provider call or new endpoint; cookies, CSRF and CORS unchanged.

## Deferred

- BL-107 (ORD refusing `OFFLINE_PACK_PRICE` online).
- B11: the receipt SMS, and the server-made link for a refused or revoked sale.
- BL-106, BL-100 to BL-105, BL-082 and BL-087 to BL-089 stand.

## Tests

On this machine. `main` had not moved from `f413ecc`, so no rebase was needed and none was made.

| Layer | Result |
| --- | --- |
| Unit | 162 files, 1,893 tests passed. `pos/domain/animal-price.ts` is under a new 100 percent gate and meets it. |
| Integration | **Full suite, once, at `244d5f1`** (every code commit): 169 files, 2,056 tests, **1 failed**: `mdm/reference-data`'s fixed count of reason codes (68), stale since migration 0306 adds the 69th. A stale expectation, not a flake: fixed in its own `test(mdm)` commit, after which that spec passes (34 tests). Nothing was re-run to turn red green. Before it: the POS and LIV folders with the rollback walk (30 files, 319 tests, all passed; the rollback walk now starts at 0306, so it also proves 0306's `migrate:down`); the new specs: animal price 8, buyer TIN 8. |
| Contract | 55 files, 137 tests passed, at the head of the code (after A-285 (f)). `contract:generate` is up to date and Redocly is clean. |
| Lint (boundaries, fixtures, placement, schema names), typecheck | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.28.0:**
  - **An animal at the till:** read `stockUnits[].priceBand` for the animal's own band (keep the agreed price inside its floor and ceiling), `priceListEntryId`, and `unpricedReason` when it has none (`MISSING_GRADE_OR_WEIGHT`: weigh it in the back office; `QUOTE_ONLY`: sold through quotes; `NOT_SELLABLE`). Show `lastWeightKg` with `lastWeighedAt` and `lastWeightSource`. A lot still sells at its product's band.
  - **Re-weighed at the sale:** send `weightKg` and `weightSource` on the line; the server prices from that weight. The till may keep charging the pack's price; the difference is raised for a supervisor, never refused.
  - **The buyer's TIN** in `completeCounterSale`'s answer is now masked (`*******0042`); print the receipt from the document if the full TIN is needed.

## CI

- **Merge slot:** taken at 12:50Z. `main` was still `f413ecc` (lane B idle), so there was nothing to rebase. Migration 0306 sits above main's 0305. The branch was pushed plainly, with no force.
- **Pull request #126.**
  - **`1bf447d`** (the code, contract and docs commits before the version fix):
    - push run 45178189913: success;
    - pull_request run 45178240253: **failure**. Its contract job's versioning step (which compares with `main` and runs only on the pull request) said "the contract changed but info.version stayed 2.27.0": `main` was already at 2.27.0 (lane B's B11 continued) and this phase had written its change as 2.27.0, so the version was unchanged. Every other job in the run passed. A real failure, not a flake; nothing was re-run.
  - **Fixed** in its own commit `fix(contract)` (`0d38295`): the contract is 2.28.0, its changelog entry and read-first line sit above main's 2.27.0, and every reference this phase wrote names 2.28.0. The versioning script was then run locally against main's contract (ok), with the contract suite (55 files, 137 tests).
  - **`0d38295`** (every code, contract and docs commit; the head before this report):
    - push run 45180540810: **success**;
    - pull_request run 45180553981: **success**.
  - In each of the two runs every job passed: lint and type check; contract; the setup script; the image build and scan; the secret scan, dependency audit and static analysis; unit and integration shards 1, 2 and 3 of 3; and the merged coverage gate.
  - **The final head** carries this report. Its runs (push and pull_request, with the three shards and the merged gate) are named in the closing message to the parent session. The pull request merges only when every one is green.

## Next session

B09c, copied from `docs/prompts/session-openers.md` on `main` (unchanged by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09b5c-pos-animal-price.md, the last of B9b's
splits, A-273 (a), A-285 (a)).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the PAY requirement block of docs/SRS.md, docs/data-model/pay.md, ADR-0063, A-210 and A-218, and
the reports of B09a continued and B09a continued 2 (the sandbox run). Load hakorem-money, hakorem-ledger,
hakorem-security-review, hakorem-endpoint and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09c only, on branch b09c-card-payment, branched from main: card as an online payment method through the
existing provider port (Paystack's hosted or inline card flow, so no card number reaches the server), every edge case
test-first against the fake, then the card cases in the sandbox suite (never in CI) with the key the proxy injects;
fix the fake to match what the sandbox really returns. No secret in the repository.
Unit names and CR-040 moved to B09u, lane B (owner, 2026-11-17, F10g and F10h).
Stop at the gate, write docs/sessions/B09c-card-payment.md, and merge into main when every run on the pull request is
green.
```
