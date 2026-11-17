# B09e continued 2: reasons for goods rejected at the door, breakage in store, the last price paid

Date: 2026-11-17 · Branch `b09e3-eggs-claims`, from `main` (`bf4e41d`) · Pull request #90 (the dependency audit turned red on an upstream advisory with no fix; the owner approved a 30-day waiver, pull request #91, and the pull request merged once every run was green; see CI) · Status: **phase split** (A-271). The rejection reasons, the breakage reasons and the last price paid reached their part of the gate. The claim moves to **B09e continued 3**, which runs next.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-269 | **The reasons as built.** (a) The receipt's wrong-item reason is **`WRONG_ITEM_DELIVERED`**. A-260 names `WRONG_ITEM`, but a code is `mdm.reason_code`'s key and `WRONG_ITEM` has been the REFUND domain's since migration 0024. (b) `CRACKED`, `BROKEN`, `DIRTY` and `SHORT` need no note; `WRONG_ITEM_DELIVERED` and `QUALITY_REJECTED` do. (c) `BREAKAGE` (no note) and `RODENT_DAMAGE` (a note) are `STOCK_ADJUSTMENT` reasons in the `WASTAGE` loss group. (d) The database holds the presence rules: a reason exactly when something was rejected, and a note only beside a reason. The domain and the note a reason requires are the handler's rules, as for a transfer's variance reason. (e) Supplier scoring reads `qty_rejected` unchanged. | Owner |
| A-270 | **The last price paid as built.** "Paid" is a posted record: the unit price on the latest invoice line for the order's supplier, the same product **and the same unit**. The invoice must be approved for payment (`APPROVED` or `PAID`). The latest is chosen by invoice date, then approval time, then id. A draft, an unapproved, mismatched or cancelled invoice, and a credit note, never count. A price that is sent is always kept. A line in another unit gets no default: a crate's price is never derived from an egg's. With no price paid, the line is refused with `PRICE_REQUIRED`. | Owner |
| A-271 | **The phase split before the claim** (ADR-0026 Amendments). The claim moves unchanged to B09e continued 3 (`b09e4-eggs-claim`). It carries one open design point that phase must decide first (below, under "Deferred"). | Owner |

**No ADR conflict.** ADR-0018 and ADR-0075 are untouched: no cost or issue rule changed, and the breakage write-off below issues at ADR-0075's schedule value.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09e continued 2 (`b09e3-eggs-claims`, from `main` at `bf4e41d`).
2. **Scope:** the owner's decisions 5 (rejection reasons, breakage reasons, the claim; CR-035, CR-036) and 7 (the last price paid), each test-first.
3. **Gate:** as the opener states it. Built: the reasons, breakage and the last price paid. **Split:** the claim (below).

## Contract changes

**2.3.0, minor and additive.** The changelog entry and its cold-read line are written.
- **`GoodsReceiptLineInput.rejectionReasonCode`** and **`rejectionNote`**: optional.
- **`GoodsReceiptLine.rejectionReasonCode`** and **`rejectionNote`**: required in the answer, null when nothing was rejected.
- **New details on `GOODS_RECEIPT_INVALID`:** `REJECTION_REASON_REQUIRED`, `REASON_NOT_ALLOWED` and `NOTE_REQUIRED`. **The one tightening is loud:** a rejected quantity sent without a reason is now refused. CR-035 asked for this; a client that rejects nothing sees no change.
- **`listReasonCodes`:**
  - The `domain` filter takes `GOODS_RECEIPT_REJECTION`.
  - The example adds `BREAKAGE` and `CRACKED`.
  - The description says the example shows only part of the list (CR-035 point 1).
- **`PurchaseOrderLineInput.unitPricePesewas`:** now optional (no longer required).
- **New detail on `PURCHASE_ORDER_INVALID`:** `PRICE_REQUIRED`.
- **Checks:**
  - `contract:generate`: 422 operations from code, 214 planned.
  - Redocly: clean.
  - `scripts/contract/versioning.ts` against `main`: `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Migration 0220 (MDM) | Adds the domain `GOODS_RECEIPT_REJECTION`: `CRACKED`, `BROKEN`, `DIRTY`, `SHORT`, `WRONG_ITEM_DELIVERED`, `QUALITY_REJECTED`. Adds `BREAKAGE` and `RODENT_DAMAGE` (`STOCK_ADJUSTMENT`, `WASTAGE`). The rollback is tested. |
| Migration 0221 (INV) | Adds `inv.goods_receipt_line.rejection_reason_code` (FK `mdm.reason_code`) and `rejection_note`. Adds the checks `ck_goods_receipt_line_rejection` (a reason exactly when `qty_rejected > 0`) and `ck_goods_receipt_line_rejection_note`. The rollback keeps the data. |
| INV domain | New `checkRejection`: a reason on every rejection, none on nothing rejected, the right domain, a note where the reason asks. |
| INV application | `GoodsReceipts`: <ul><li>checks each line's rejection against the reasons from MDM's `MasterDataRefs.reasonCodesIn`;</li><li>keeps and answers the reason and the note;</li><li>re-checks them at posting.</li></ul> `inv.GoodsReceiptPosted` carries `rejectionReasonCode` (additive). |
| PUR | `PurchaseOrders.pricedLines`: a line with no price takes the store's new `lastPricesPaid`, or is refused `PRICE_REQUIRED`. This applies to create, update and a requisition's conversion. |
| Tests | <ul><li>New: `inv/rejection-reasons` (9), `pur/last-price-paid` (6) and the unit spec `inv/domain/rejection.spec` (5).</li><li>The rollback walk lists 0220 and 0221.</li><li>Four existing specs that reject goods now name a reason.</li></ul> |
| Docs | <ul><li>A-269 to A-271 and the changelog.</li><li>`docs/data-model/inv.md`, `mdm.md` and `pur.md`.</li><li>API.md, the INV and PUR cards, and ADR-0026 Amendments.</li><li>The openers: B09e continued 3 is inserted and B9b reads its report.</li></ul> |

## The gate, proved by running it

**A rejected quantity carries its reason from the `GOODS_RECEIPT_REJECTION` domain, refused without one and refused on nothing rejected.** `inv/rejection-reasons`, 9 tests:
- **The domain:** it lists exactly the six reasons, with `requiresNote` as in A-269.
- **A crate rejected as `CRACKED` with a note:**
  - the line keeps `qtyRejected 1.000` in crates and `qtyRejectedBase 30.000`;
  - it answers its reason and note on create, post and read;
  - the database row holds `30.000`, `CRACKED` and the note;
  - the accepted value is unchanged at 42,750.
- **A line that rejects nothing** answers `rejectionReasonCode: null` and `rejectionNote: null`. `BROKEN` is taken without a note.
- **Seven refusals, each 422 `GOODS_RECEIPT_INVALID` with its detail, and nothing written:**
  - a rejection without a reason (`REJECTION_REASON_REQUIRED`);
  - a reason with nothing rejected, both when the quantity is left out and when it is `0.000` (`REASON_NOT_ALLOWED`);
  - a note with nothing rejected (`REASON_NOT_ALLOWED` on `/rejectionNote`);
  - the REFUND domain's `WRONG_ITEM` (`REASON_NOT_ALLOWED`);
  - the adjustment reason `BREAKAGE` (`REASON_NOT_ALLOWED`);
  - `QUALITY_REJECTED` without a note (`NOTE_REQUIRED`).
- **`updateGoodsReceipt`** refuses the same rules and accepts a `DIRTY` rejection.
- **The database itself refuses** (23514): a rejected quantity without its reason, a reason with nothing rejected, and a note with nothing rejected. An unknown code is refused too (23503).
- **The Cashier** is refused a receipt with a rejection, with 403, and nothing is written.

**Breakage reasons exist for stock adjustments** (CR-035 point 1). In the same spec:
- `BREAKAGE` and `RODENT_DAMAGE` are listed as `STOCK_ADJUSTMENT` reasons in the `WASTAGE` loss group.
- A loss of 3 eggs from a fresh crate at 4,750 is written off with `BREAKAGE` and no note. It posts one movement of `3.000` at exactly **475** pesewas, which is `half_up(4,750 x 3 / 30)` under ADR-0075.

**Supplier scoring reads the same field** (CR-035 point 4):
- `pur/supplier-scores` now rejects 2 birds with a reason. Somanya's rejection rate and score are unchanged at 75.00.
- The rate reads `qty_rejected`, the quantity the reason explains.

**A purchase order line defaults to the last price paid to that supplier for that product.** `pur/last-price-paid`, 6 tests. The seed of the spec:
- **Day one:** Awutu is invoiced at 4,751 and then 4,800 a crate, both approved. Kpone is invoiced at 5,000, approved last.
- **Day two:** two more Awutu invoices with later invoice dates, so either would win if it counted:
  - one matched at 9,999 but never approved;
  - one at 6,100, approved and then cancelled.

The results:
- An Awutu order of 3 crates with no price is priced at **4,800**, net **14,400**. It does not take Kpone's 5,000, the unapproved 9,999 or the cancelled 6,100.
- A Kpone order is priced at **5,000**, net 10,000.
- An entered price of 4,700 is kept.
- `updatePurchaseOrder` defaults the price too (4,800).
- A line in eggs, where only crates were paid, and a product never bought from Kpone are both refused with `PRICE_REQUIRED`. Nothing is written.
- The Cashier is refused with 403 and nothing is written. The Cashier is also refused the order list.

**Every write refuses the wrong role.**
- **New writes:** none. `createGoodsReceipt`, `updateGoodsReceipt`, `createPurchaseOrder` and `updatePurchaseOrder` take new optional fields; the Cashier's 403 is tested above for receipts and orders.
- **New reads:** none. The identifier walk is unchanged.

**The claim: not built here (split, A-271).** Nothing in the claim's part of the gate was started.

## Mutation checks (each applied alone, the targeted spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The handler's rejection check discarded | red: 2 of 9 (`inv/rejection-reasons`) |
| 2 | The last price ignores the supplier | red: 2 of 6 (`pur/last-price-paid`) |
| 3 | A matched, unapproved invoice counts as paid | red: 2 of 6 |
| 4 | A cancelled invoice counts as paid | red: 2 of 6 |

Mutations 3 and 4 first stayed green. With every invoice dated on the same day, the ordering by approval time hid the unapproved one. The spec now dates those two invoices a day later, so either would win if it counted. Both mutations are then red.

## Test first, as it honestly happened

- **`inv/rejection-reasons`:** written before any code and seen red, 9 of 9 failed (the fields were refused as unknown, and the domain filter as invalid). It passed only after the migrations and the handler were in place.
- **`inv/domain/rejection.spec`:** written immediately before `checkRejection` and run after it. It is proved by mutation 1 and by the integration spec's red run, not by a red run of its own.
- **`pur/last-price-paid`:** written before the code and seen red, 5 of 6 failed (`unitPricePesewas` required). The sixth test, a price entered, passed before the code, as it should.
- **Changed expectations:** four existing specs sent a rejected quantity without a reason. They now name one (`QUALITY_REJECTED` with a note, or `CRACKED`). No assertion changed and nothing was skipped.

## Decisions

- **No new ADR.** The new codes and columns follow the existing pattern of migration 0051 for a transfer's variance reason.
- **The split** is recorded in ADR-0026 Amendments.

## Security review (hakorem-security-review)

- **Boundary:** TB2 (back office receiving and purchasing).
- **Standards:**
  - SC-01: strict zod. The reason is `^[A-Z][A-Z_]{1,39}$` and the note is 1 to 500 characters.
  - SC-02: no new operation. Authorisation is unchanged and the wrong role is tested.
  - SC-03/04: parameterised SQL only.
  - No new table, grant, function or permission.
- **Abuse considered:**
  - **A storekeeper inflates rejections.** A rejection moves no stock or money in this phase: the receipt's value is the accepted cost, entered and three-way matched as before. It only lowers the supplier's score, under a reason from the fixed list and on the audit trail. It becomes a money path with the claim. B09e continued 3's gate therefore carries the exception report item for inflated rejections.
  - **The last price paid is poisoned.** A price becomes the default only from an invoice approved for payment. An approved invoice has passed the three-way match, or a second person approved its variance. The defaulted order line still goes through the `PURCHASE_ORDER` approval limit and is shown to its maker.
  - **No new exception report item in this phase.**

## Deferred

- **The claim (CR-036, the rest of decision 5) moves to B09e continued 3** (`b09e4-eggs-claim`, A-271). Its opener in `docs/prompts/session-openers.md` carries every point of the parent's brief:
  - allocate at 4,751 with 7 of 30 rejected, and with a rejection entered in crates;
  - no amount keyed by hand;
  - no stock moved and nothing posted until approval;
  - the maker, the receiver and the approver as three people, and the claim's maker refused as approver;
  - the mutation check, the exception report item and the trial balance.
- **The design point that phase must decide first:**
  - An invoice is matched only up to the accepted quantity (`QTY_EXCEEDS_RECEIVED`, which a variance approval cannot cover).
  - A credit note must reduce an approved invoice (FR-PUR-011). With no goods sent back, it posts the payable down against purchase price variance.
  - So a credit note drafted from a claim against an invoice that charged only the accepted eggs would credit the rejected eggs a second time.
  - The claim must say which invoice may carry the rejected quantity, for example a match that allows an open claim's quantity, or how else it is settled. If it changes the three-way match or a posting, it is an ADR.
- **Why the split:** the claim is its own sub-domain: a new PUR document, its links, a change to how a credit note names its invoice, its maker-checker proof and its exception report path. Starting it without the context to reach its gate is worse than stopping here at a green commit.

## Contract requests

I fetched the frontend's `main` at `5a44d38` at the start and again before writing this report. It holds CR-001 to CR-036, with nothing new.
- **CR-035 (breakage and rejection reasons): implemented in 2.3.0.**
  - **Point 1:** `BREAKAGE` ("Broken or cracked in store", no note, `WASTAGE`) and `RODENT_DAMAGE`. The reason list's example names `BREAKAGE`, and its description says the example shows only part of the list.
  - **Point 2:** the `GOODS_RECEIPT_REJECTION` domain with the owner's codes (A-260). `BROKEN_ON_ARRIVAL` is answered by `CRACKED` and `BROKEN`, `SHORT_DELIVERED` by `SHORT`, and `WRONG_ITEM` by `WRONG_ITEM_DELIVERED` (A-269).
  - **Point 3:** `rejectionReasonCode` and `rejectionNote` on the input and the answer, with the three details exactly as requested. `valuePesewas` stays the accepted cost.
  - **Point 4:** the rejection rate reads the same field.
- **CR-036 (a claim from a receipt's rejected lines): not built here. Scheduled to B09e continued 3** (A-271), the next phase, with the design point above.
- **Requests that stay with later phases:**
  - CR-031 and CR-032 stay with B9b.
  - CR-033 stays with B9b (points 1 and 2) and B11 (point 3).
  - CR-018 stays with B12.
- **Everything else:** CR-034 was answered by 2.0.0, and the other requests were answered in earlier phases, as B09e continued listed. Nothing small or examples-only is left open for this phase's modules.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`) | **3,120 passed**, 256 files, exit 0. Statements 94.22 percent, branches 84.55 (the gate is 80), functions 97.68, lines 96.85. Every 100 percent gate held. **The first merged run was red:** `mdm/reference-data` expected 55 reason codes and listed 63, because migration 0220 adds eight. It was fixed in its own commit (`test(mdm)`, `9747b73`), and the second run is the one above. Nothing was re-run to turn red into green. |
| Contract | **118 passed**, 44 files. |
| Lint (including the module boundaries), typecheck, Redocly, `contract:generate`, versioning against `main` | Clean |
| End to end, setup, and the last migration rolled back and applied again | Run in CI |

## Gate

**Phase split (A-271).**
- **Passed for what was built:**
  - A rejected quantity carries its reason from the `GOODS_RECEIPT_REJECTION` domain. It is refused without one, and a reason on nothing rejected is refused, by the handler and by the database.
  - Breakage reasons exist for stock adjustments.
  - A purchase order line defaults to the last price paid to that supplier for that product.
  - Every write refuses the wrong role.
- **Not built:** the claim and its credit note, maker and checker apart. It moves to B09e continued 3.

## Notes for the frontend track

- **2.3.0 is additive.** A receiving screen sends `rejectionReasonCode` (from `listReasonCodes?domain=GOODS_RECEIPT_REJECTION`) with any `qtyRejected`, and `rejectionNote` where `requiresNote` is true. It shows both from the answer.
- **Breakage:** a shop writes off broken eggs with `reasonCode: BREAKAGE` and no note.
- **Purchase orders:** a screen may leave `unitPricePesewas` out to take the last price paid, which the answer then shows. `PRICE_REQUIRED` means nothing has been paid for that product in that unit.
- **The claim screen** waits for B09e continued 3.

## CI

- **`9747b73`** (the code and docs head, pushed before pull request #90 was opened): run **44134426749 (push)** **succeeded**. Its jobs: lint and type check; unit and integration with the coverage gate; contract; the setup script with end to end, smoke and the last migration rolled back and applied again; the image build and scan; and security. No `pull_request` run exists for `9747b73`, because the pull request was opened after that push.
- **`51a1dd3`** (this report's first commit): run **44135873247 (push)** **failed**. One job failed: "secret scan, dependency audit, static analysis (SEC-034)", at its step "dependency audit, high and critical block" (`pnpm audit --audit-level high`). Every other job succeeded. No `pull_request` run exists for `51a1dd3`.
- **What failed, and why it is not this phase's change:**
  - The audit now reports a **high** advisory, GHSA-fc5q-39xc-vjpf: picomatch ReDoS through repeated extglobs, all versions up to 4.0.7, **no patched version** ("<0.0.0").
  - It reaches the repository only through development tooling: `eslint-import-resolver-typescript > tinyglobby > picomatch` and `eslint-plugin-boundaries > micromatch > picomatch`. `pnpm audit --audit-level high --prod` reports no high finding.
  - The same job passed on `9747b73` half an hour earlier with the same lockfile, so the advisory's rating changed in between. `main` will fail the same job on its next run.
  - 4.0.7 is the latest picomatch on npm, so no override can reach a fixed version (unlike A-076's multer and handlebars).
- **Not fixed, and the pull request is not merged.** The ways out are an owner's security decision, not a reversible choice this phase may make on its own:
  - accept the risk with a time-limited `pnpm.auditConfig.ignoreGhsas` entry and its assumption;
  - run the CI audit over production dependencies only;
  - drop or replace the two eslint dependencies.

  Nothing was re-run, skipped or quarantined. The runs on this report's final commit are named in the session's closing message.

- **The owner's decision, and what the parent session did (2026-11-17):**
  - **The owner's decision:** a waiver for GHSA-fc5q-39xc-vjpf alone, on the two lint tools' paths only, approved 2026-11-17, expiring 2026-12-17 (`docs/security/dependency-waivers.json`).
  - **Pull request #91:** CI's audit step now runs `scripts/check/audit-waivers.ts`, which blocks any high or critical advisory outside a live waiver, the same advisory reached by any other path, and an expired, malformed or unused waiver. CI's gate self-test proves an expired copy fails.
  - **Merged into `main`** as `f37011a`, once runs 44146025711 (push) and 44146078217 (pull_request) on its head `e605e3c` succeeded. `main`'s run 44147238689 (push) on `f37011a` succeeded.
- **`e25a1b9`** (the parent session merged `main` into this branch to clear a conflict in ADR-0026's Amendments with the receipt token rules, pull request #89): run **44138862069 (push)** and run **44138874031 (pull_request)** **failed**, in the same security job's audit step only. Every other job succeeded. No `pull_request` run existed for `118748d` or `51a1dd3`, because the pull request did not merge cleanly with `main` until `e25a1b9`.
- **`6f33e77`** (`main` merged in again, bringing the waiver; the last commit with code): run **44147294565 (push)** and run **44147307805 (pull_request)** **succeeded**, every job. Nothing was re-run.

## Next session

B09e continued 3, copied from `docs/prompts/session-openers.md` (inserted this session by the split; B9b follows it and now reads its report).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09e3-eggs-claims.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decision 5 below, CR-036 as committed on the frontend's main, ADR-0075, A-260,
A-269 and A-271, docs/data-model/inv.md and pur.md (the credit notes, FR-PUR-011, and the three-way match), and the
INV, PUR and FIN cards in docs/MODULE_BOUNDARIES.md. Load hakorem-money, hakorem-ledger, hakorem-migration,
hakorem-endpoint, hakorem-security-review and hakorem-tests. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09e continued 3 only, on branch b09e4-eggs-claim, branched from main. The owner's decision
(2026-11-17), test-first with exact pesewa assertions:
5. (The claim.) A claim raised from the posted receipt drafts the supplier credit note from the rejected lines and
   their cost (from the purchase order line's price, split exactly with the kernel's allocate between accepted and
   rejected, so accepted plus rejected equals the line exactly: test it at a price that does not divide evenly, a
   crate at 4,751 with 7 of 30 eggs rejected, and with a rejection entered in crates), never keyed by hand, linked both
   ways (the receipt answers its claims; the claim names its receipt, purchase order and the credit note or invoice
   that settles it), moving no stock, posting nothing until the credit note is approved, on the supplier's account
   until settled; the credit note keeps its existing approval, maker and checker apart, mutation-checked with test
   data where the maker, the receiver and the approver are three different people, plus the claim's maker refused
   as approver (CR-036). The claim's quantities and cost come from the base quantities (`qty_rejected`,
   `qtyRejectedBase`, A-263) and the line's `rejectionReasonCode` (A-269), never from a factor of the claim's own.
   Decide first, and record as an ADR if it changes the three-way match or a posting (A-271): an invoice is matched
   only up to the accepted quantity, and a credit note reduces an approved invoice, so say which invoice may carry the
   rejected quantity, or how else the claim is settled, without crediting the same eggs twice. If the claim's cost
   would need arithmetic other than ADR-0075's half-up or floor, stop and report. The trial balance still sums to 0
   on the seeded day.
Answer CR-036 in the report. Every new read is authorised and joins the contract-generated identifier walk
(B09q continued). Additive contract changes only, unless one is unavoidable and recorded loudly.
Stop at the gate, write docs/sessions/B09e4-eggs-claim.md, and merge into main when every run on the pull request is
green.
```
